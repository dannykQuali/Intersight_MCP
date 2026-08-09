/**
 * Typing into a vKVM console is rate-limited by the BMC, not by the browser.
 *
 * Every keystroke crosses the KVM client's WebSocket as a HID report, and when
 * that pipe stalls with a key DOWN the guest's own auto-repeat fills the gap.
 * At the old 25ms gap (~27 chars/s) an agent's `autoinstall` reached an Ubuntu
 * prompt as `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll` — runs of 20 to 50 characters
 * across 62 transcript lines.
 *
 * Measured first, so the fix addresses the real bottleneck: with a screenshot
 * loop running on the same page, browser down->up gaps stayed at p90 16ms / max
 * 49ms. The browser was never the problem, so no amount of local tuning would
 * have helped — only a slower cadence.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  delayForAttempt,
  estimateTypingMs,
  typePaced,
  KEY_HOLD_MS,
  MAX_CHAR_DELAY_MS,
  PASTE_CHAR_DELAY_MS,
  RETRY_SLOWDOWN,
  type TypingSink,
} from '../src/utils/pacedTyping.js';

/** Records what a real keyboard would have been asked to do, in order. */
function recordingSink() {
  const events: Array<{ kind: 'press' | 'wait'; value: string | number }> = [];
  const sink: TypingSink = {
    async press(spec, holdMs) {
      events.push({ kind: 'press', value: spec });
      events.push({ kind: 'wait', value: holdMs });
    },
    async wait(ms) {
      events.push({ kind: 'wait', value: ms });
    },
  };
  const presses = () => events.filter((e) => e.kind === 'press').map((e) => e.value as string);
  return { sink, events, presses };
}

describe('paced typing', () => {
  it('presses one key per character, in order', async () => {
    const { sink, presses } = recordingSink();
    await typePaced(sink, 'ls -la', 5);
    // A space is passed through as ' ', which Playwright maps to the Space key.
    assert.deepEqual(presses(), ['l', 's', ' ', '-', 'l', 'a']);
  });

  it('sends a real Shift press for shifted characters', async () => {
    // The reason this cannot be keyboard.type(): the console builds its HID
    // modifier byte from actual Shift keydown/keyup events, so `Cisco123!`
    // arrived as `cisco1231` without them.
    const { sink, presses } = recordingSink();
    await typePaced(sink, 'Cisco123!', 5);
    assert.deepEqual(presses(), ['Shift+c', 'i', 's', 'c', 'o', '1', '2', '3', 'Shift+1']);
  });

  it('waits between every key, including after the last', async () => {
    // The caller may press Enter next, and that keystroke needs the same spacing
    // as any other — submitting immediately after the final character is exactly
    // the burst that stalls the HID queue.
    const { sink, events } = recordingSink();
    await typePaced(sink, 'abc', 40);
    const gaps = events.filter((e) => e.kind === 'wait' && e.value === 40);
    assert.equal(gaps.length, 3, 'one inter-key gap per key, last one included');
    assert.equal(events.at(-1)?.value, 40, 'and the run ends on a gap, not on a keypress');
  });

  it('holds each key briefly, well under any auto-repeat delay', async () => {
    const { sink, events } = recordingSink();
    await typePaced(sink, 'ab', 40);
    const holds = events.filter((e) => e.kind === 'wait' && e.value === KEY_HOLD_MS);
    assert.equal(holds.length, 2);
    assert.ok(KEY_HOLD_MS < 200, 'a hold near the guest repeat delay would cause the very bug this fixes');
  });

  it('defaults to roughly human typing speed, not machine speed', async () => {
    // 27 chars/s produced the damage; the default must be far below that.
    assert.ok(PASTE_CHAR_DELAY_MS >= 50, `expected a human-scale gap, got ${PASTE_CHAR_DELAY_MS}ms`);
    assert.ok(1000 / PASTE_CHAR_DELAY_MS <= 20, 'more than 20 chars/s is what stalled the HID queue');
  });

  it('types newlines and tabs as their keys, not as characters', async () => {
    const { sink, presses } = recordingSink();
    await typePaced(sink, 'a\n\tb\r\nc', 5);
    assert.deepEqual(presses(), ['a', 'Enter', 'Tab', 'b', 'Enter', 'c'], 'CRLF is ONE line ending');
  });

  it('does nothing at all for empty text', async () => {
    const { sink, events } = recordingSink();
    const r = await typePaced(sink, '', 40);
    assert.equal(r.presses, 0);
    assert.deepEqual(events, []);
  });
});

describe('retry cadence', () => {
  it('starts at the default and slows on every retry', () => {
    const first = delayForAttempt(1);
    const second = delayForAttempt(2);
    const third = delayForAttempt(3);
    assert.equal(first, PASTE_CHAR_DELAY_MS);
    assert.ok(second > first, `a retry must be slower: ${first} -> ${second}`);
    assert.ok(third > second, `and slower again: ${second} -> ${third}`);
    assert.equal(second, Math.round(PASTE_CHAR_DELAY_MS * RETRY_SLOWDOWN));
  });

  it('stops slowing down eventually, because past a point cadence is not the problem', () => {
    assert.equal(delayForAttempt(20), MAX_CHAR_DELAY_MS);
    assert.ok(delayForAttempt(99) <= MAX_CHAR_DELAY_MS);
  });

  it('honours a caller-supplied base cadence', () => {
    assert.equal(delayForAttempt(1, 120), 120);
    assert.equal(delayForAttempt(2, 120), Math.round(120 * RETRY_SLOWDOWN));
  });

  it('estimates how long typing will take, so a busy state can carry an ETA', () => {
    // A long command at a human cadence takes seconds; a caller refused for
    // "busy" deserves to be told roughly how many.
    const ms = estimateTypingMs('grep -m3 -riE nocloud /var/log/cloud-init.log', PASTE_CHAR_DELAY_MS);
    assert.ok(ms > 2000, `expected a realistic estimate, got ${ms}ms`);
    assert.ok(ms < 20000);
  });
});
