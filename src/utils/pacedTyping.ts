/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { pressSpecsForText } from './keyboardText.js';

/**
 * How fast a vKVM console can be typed at, and why it is so much slower than a
 * browser can dispatch.
 *
 * Every keystroke crosses the KVM client's WebSocket to the BMC as a HID report.
 * That pipe has a modest sustained rate, and when it stalls with a key DOWN, the
 * guest's own keyboard auto-repeat fills the gap. Field evidence: at a 25ms gap
 * (~27 chars/s) an agent's `autoinstall` reached an Ubuntu prompt as
 * `autoiiiiiiiiiiiiiiiiiiiiinstaaaaaaaaaaaaaaaaaaaaall`, with runs of 20 to 50
 * characters across 62 transcript lines.
 *
 * Measured locally, the BROWSER is not the bottleneck: down->up gaps stay at
 * ~15ms even with a screenshot loop running on the same page (p90 16ms, max
 * 49ms). So the remedy is not a faster keyup, it is a slower cadence.
 *
 * 100ms is 10 characters a second. The only rate with evidence attached is the
 * old 25ms gap, which broke badly, and these clients are built for HUMAN typing —
 * 40wpm is about 3 chars/s, a fast typist about 10. So the default sits at the top
 * of the human range rather than just below the one rate known to fail, and the
 * retry ladder covers the case where even this is too quick for a given BMC. A
 * long command costs a few seconds; a mangled one costs a rerun, or worse.
 */
export const PASTE_CHAR_DELAY_MS = 100;

/** How long a key is held down. Long enough to register, far below any repeat delay. */
export const KEY_HOLD_MS = 12;

/** Each retry types slower, because the previous cadence has just been disproved. */
export const RETRY_SLOWDOWN = 1.75;

/** No retry types slower than this; past here the problem is not cadence. */
export const MAX_CHAR_DELAY_MS = 400;

/** Where keystrokes go. Implemented over Playwright in production, recorded in tests. */
export interface TypingSink {
  press(spec: string, holdMs: number): Promise<void>;
  wait(ms: number): Promise<void>;
}

/** Cadence for a given attempt (1-based): slower every time, capped. */
export function delayForAttempt(attempt: number, baseMs = PASTE_CHAR_DELAY_MS): number {
  const scaled = baseMs * RETRY_SLOWDOWN ** Math.max(0, attempt - 1);
  return Math.min(MAX_CHAR_DELAY_MS, Math.round(scaled));
}

/**
 * Type text one key at a time, pausing between keys.
 *
 * NOT keyboard.type(): the console derives its HID modifier byte from real Shift
 * keydown/keyup events, which type() never emits — `Cisco123!` arrived as
 * `cisco1231` (field-verified). pressSpecsForText replays what a human's keyboard
 * actually sends.
 */
export async function typePaced(
  sink: TypingSink,
  text: string,
  delayMs: number,
  holdMs = KEY_HOLD_MS
): Promise<{ presses: number; estimatedMs: number }> {
  const specs = pressSpecsForText(text);
  for (let i = 0; i < specs.length; i++) {
    await sink.press(specs[i], holdMs);
    // Gap AFTER each key including the last: the caller may press Enter next, and
    // that keystroke deserves the same spacing as any other.
    await sink.wait(delayMs);
  }
  return { presses: specs.length, estimatedMs: specs.length * (holdMs + delayMs) };
}

/** How long typing this text will take at a given cadence, for a busy-state ETA. */
export function estimateTypingMs(text: string, delayMs: number, holdMs = KEY_HOLD_MS): number {
  return pressSpecsForText(text).length * (holdMs + delayMs);
}

/** One attempt's record, as reported back to the caller. */
export interface PasteAttempt {
  attempt: number;
  charDelayMs: number;
  presses: number;
  matched?: boolean;
  repeatDamage?: Array<{ char: string; count: number }>;
}

export interface PasteAttemptsResult {
  attempts: PasteAttempt[];
  /** null when verification was not asked for. */
  verified: boolean | null;
  observed: string | null;
  problem?: string;
}

/**
 * Type text, read it back, and retry slower until it matches.
 *
 * The policy, kept separate from Playwright so it can be tested as policy:
 *   - every retry types SLOWER, because the previous cadence has been disproved;
 *   - a retry CLEARS the line first, or it appends to the damage;
 *   - the caller is told which attempt succeeded and what the console showed.
 *
 * Submitting is deliberately not part of this: whoever calls it decides, and can
 * only decide safely once `verified` is known.
 */
export async function runPasteAttempts(io: {
  text: string;
  maxAttempts: number;
  baseDelayMs: number;
  verify: boolean;
  /** Types the text at the given cadence. */
  type: (text: string, charDelayMs: number) => Promise<{ presses: number }>;
  /** Reads the console back; null when it cannot be read. */
  read?: () => Promise<string | null>;
  /** Checks what was read against what was typed. */
  check?: (intended: string, observed: string) => { matched: boolean; repeatDamage: Array<{ char: string; count: number }>; reason: string };
  /** Clears a bad line before a retry. Absent means the target has no line editor. */
  clear?: () => Promise<void>;
}): Promise<PasteAttemptsResult> {
  const attempts: PasteAttempt[] = [];
  let observed: string | null = null;
  let problem: string | undefined;
  let matched: boolean | null = io.verify ? false : null;

  for (let attempt = 1; attempt <= Math.max(1, io.maxAttempts); attempt++) {
    const charDelayMs = delayForAttempt(attempt, io.baseDelayMs);
    if (attempt > 1 && io.clear) {
      await io.clear();
    }
    const typed = await io.type(io.text, charDelayMs);
    if (!io.verify || !io.read || !io.check) {
      attempts.push({ attempt, charDelayMs, presses: typed.presses });
      break;
    }
    observed = await io.read();
    const verdict = io.check(io.text, observed ?? '');
    matched = verdict.matched;
    problem = verdict.matched ? undefined : verdict.reason;
    attempts.push({
      attempt,
      charDelayMs,
      presses: typed.presses,
      matched: verdict.matched,
      ...(verdict.repeatDamage.length ? { repeatDamage: verdict.repeatDamage.slice(0, 6) } : {}),
    });
    if (verdict.matched) {
      break;
    }
  }

  return { attempts, verified: matched, observed, ...(problem ? { problem } : {}) };
}
