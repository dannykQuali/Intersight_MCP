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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import type { Page } from 'playwright-core';
import { writeRecorderState } from './recorderState.js';
import { TileTracker } from './tileNovelty.js';

export interface RecordedFrame {
  seq: number;
  /** Capture time (epoch ms). */
  at: number;
  path: string;
  bytes: number;
  /** Fraction of sampled pixels that differed from the previously stored frame. */
  changeRatio: number;
  /** 'adopted' = inherited from a previous recorder's files, so its change ratio is unknown. */
  reason: 'first' | 'change' | 'heartbeat' | 'adopted';
}

/** A notable non-frame occurrence (console death, recovery), for the timeline. */
export interface RecorderEvent {
  at: number;
  kind:
    | 'console-dead'
    | 'recovering'
    | 'recovered'
    | 'recovery-failed'
    | 'vkvm-reset'
    | 'adopted-frames'
    | 'stopped';
  detail?: string;
}

/** Everything the anti-blank decision depends on. See {@link shouldNudge}. */
export interface NudgeDecision {
  now: number;
  antiBlankSeconds: number;
  mode: 'mouse' | 'key' | 'none';
  state: string;
  /** Attached to a console we have not nudged yet - it may already be blanked. */
  needsInitialNudge: boolean;
  /** Last NOVEL change: new content appearing, as classified by the tile tracker. */
  lastNoveltyAt: number;
  lastNudgeAt: number;
  startedAt: number;
  /**
   * Consecutive samples with the screen at rest — pixel-identical, or moving
   * only by a blink (an oscillating tile returning to a known state).
   */
  stillSamples: number;
}

/**
 * Consecutive at-rest samples that mean "the screen is quiet right now".
 *
 * This is what separates a console that is WORKING from one that merely has a
 * clock or a cursor on it. A spinner or progress bar produces novel or rhythmic
 * tiles on essentially every sample and never accumulates a still run; a clock
 * sits still for 59 samples out of 60, and a blinking cursor counts as rest
 * outright (its tile only ever returns to a known state).
 */
export const STILL_SAMPLES_BEFORE_NUDGE = 3;

/** Console text transcript, one JSON line per text change, beside the frames. */
export const OCR_TEXT_FILENAME = 'text.jsonl';

/**
 * Frames allowed to queue for recognition before the backlog is trimmed.
 *
 * Recognition (~1s) is about as slow as sampling (1s), so sustained activity
 * would grow an unbounded queue over a multi-hour install. Trimming the OLDEST
 * keeps the transcript current — which is what a stall check needs — and
 * anything dropped is counted rather than quietly skipped.
 */
const MAX_OCR_QUEUE = 300;

/** Transcript lines kept before the file is compacted to its newest half. */
const MAX_TRANSCRIPT_LINES = 5000;

/**
 * Alphanumeric characters a frame must yield before its text is believed.
 *
 * OCR engines do not reliably return "nothing" for a screen with no text — they
 * can hallucinate. Measured on real frames of a console page still loading
 * (just an animated spinner, no text at all): every frame produced a DIFFERENT
 * single character ("<", "a", "A)", "(", "~", "C"), so every frame looked like
 * a text change. The frames are lossless PNG, so it was not compression noise —
 * the engine read the ANTIALIASED EDGES of vector graphics as glyph strokes.
 * That inverts the signal exactly where it matters most: a frozen textless
 * screen is a classic wedge, and "the text keeps changing" is the opposite of
 * the truth. The current engine benchmarks clean on that same frame, but this
 * floor stays as engine-independent insurance.
 *
 * Real console text yields dozens of characters, so a floor separates the two
 * cleanly. Below it, the frame is treated as having no readable text at all.
 */
const MIN_MEANINGFUL_TEXT_CHARS = 5;

/**
 * The text of a frame, or '' when there is nothing legible on it.
 * Exported for testing the rule directly.
 */
export function meaningfulText(text: string | null): string {
  if (!text) {
    return '';
  }
  const alnum = text.replace(/[^a-z0-9]/gi, '');
  return alnum.length >= MIN_MEANINGFUL_TEXT_CHARS ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Decide whether an idle console is due for an anti-blank nudge.
 *
 * Idleness is measured from NOVELTY - new content appearing, as classified by
 * the tile tracker - not from pixel movement. This rule has been wrong twice:
 * keying off stored changes missed slow output, and keying off any pixel
 * movement silently disabled anti-blank on every booted OS (a taskbar clock
 * ticks forever, so the console never looked idle - verified live, 0 nudges in
 * 11 minutes on a Windows console). A console blanks on INPUT idle; a clock
 * repainting itself is not input, and the tracker knows the difference.
 *
 * The original intent - never inject input into a console that is busy - is
 * preserved by `stillSamples`, which requires the screen to be quiet at the
 * moment we act rather than for the whole window.
 */
export function shouldNudge(d: NudgeDecision): boolean {
  if (d.mode === 'none' || d.antiBlankSeconds <= 0 || d.state !== 'recording') {
    return false;
  }
  // The very first nudge is not gated on idleness: the console may already be
  // blanked when we attach, and the agent should not have to wait out the whole
  // idle timeout to discover what is on screen.
  if (d.needsInitialNudge) {
    return true;
  }
  const idleSince = Math.max(d.lastNoveltyAt, d.lastNudgeAt, d.startedAt);
  if (d.now - idleSince < d.antiBlankSeconds * 1000) {
    return false;
  }
  return d.stillSamples >= STILL_SAMPLES_BEFORE_NUDGE;
}

/**
 * Hooks the recorder uses to survive a session timeout. Supplied by
 * BrowserService, which owns login and vKVM launching.
 */
export interface RecorderHooks {
  /** True when the page no longer shows a live console (e.g. "KVM session has ended"). */
  isConsoleDead?: (page: Page) => Promise<boolean>;
  /**
   * Authoritative, wording-independent liveness check (asks the API whether an
   * Active session still exists). Returns null when unknown. Used as a slower
   * backstop to the text probe, which can only match death dialogs we have
   * actually seen.
   */
  isSessionDeadViaApi?: () => Promise<boolean | null>;
  /**
   * True while the console shows the "No Signal / connection dropped" screen.
   * DEGRADED rather than dead — the client frequently reconnects on its own, so
   * the recorder only acts if it persists.
   */
  isConsoleDisconnected?: (page: Page) => Promise<'inactivity' | 'dropped' | null>;
  /**
   * Wake a console asleep from user inactivity (sends a harmless key). Relaunching
   * does NOT fix that state; the screen asks for a keypress.
   */
  wakeConsole?: () => Promise<boolean>;
  /**
   * Recognise the text of a stored frame, or null if OCR is unavailable.
   *
   * Supplied by BrowserService so every recorder shares ONE OCR worker rather
   * than each loading its own copy of the recognition models.
   */
  ocrFrame?: (framePath: string) => Promise<string | null>;
  /** Re-establish the console (re-login + relaunch) and return the new page. */
  recover?: () => Promise<Page | null>;
  /**
   * Disable and re-enable Tunneled vKVM on the server (~60s).
   *
   * Escalation for the Intersight bug where every freshly launched console is
   * born dead. Relaunching cannot fix that state, so without this the recorder
   * just relaunches forever; this is the only thing that does fix it.
   */
  resetTunneledVkvm?: () => Promise<void>;
  /**
   * Send a harmless input to stop the console blanking. Returns false if the
   * owner declined (e.g. the agent is interacting right now, or has just sent
   * real input, which already reset the blank timer). The owner decides whether
   * it is SAFE to nudge; the recorder only decides when a nudge is WANTED.
   */
  nudge?: () => Promise<boolean>;
}

export interface RecorderOptions {
  /** How often to sample the console. Default 1000ms. */
  intervalMs?: number;
  /**
   * Drop frames older than this. Default 240 minutes (4h) so a long OS install
   * fits in the buffer — a 3-hour Windows install overflowed the previous 120m
   * default and lost its early history. Costs ~40MB/server for an idle console.
   */
  retentionMinutes?: number;
  /** Hard cap on retained frames (protects disk). Default 3000. */
  maxFrames?: number;
  /** Store a frame at least this often even when nothing changes. Default 60s. */
  heartbeatSeconds?: number;
  /**
   * Heartbeat cadence while the screen is BYTE-IDENTICAL to the frame already
   * stored. Backed right off, because such a frame carries nothing the record
   * does not already hold.
   */
  identicalHeartbeatSeconds?: number;
  /**
   * How often (in capture ticks) to verify the console is still alive rather
   * than showing a dead "KVM session has ended" screen. Default 10 (~10s).
   */
  deadCheckEveryTicks?: number;
  /**
   * How often (in capture ticks) to run the authoritative API liveness check.
   * Slower than the text probe because it costs a REST call. Default 60 (~60s).
   */
  apiCheckEveryTicks?: number;
  /**
   * Nudge the console this often (seconds) while it is IDLE, to stop the screen
   * blanking into a screensaver and hiding the machine's state. Default 240
   * (under the usual 10-minute blank timeout); 0 disables.
   */
  antiBlankSeconds?: number;
  /**
   * How to nudge:
   *  - 'mouse'  (default) a 1px mouse move. Safe everywhere: no clicks, and
   *             bootloaders ignore pointer motion.
   *  - 'key'    additionally taps Shift. More reliable at waking a blanked
   *             Linux text console (tty blanking resets on KEYBOARD input),
   *             but NOT universally safe: holding/pressing Shift during early
   *             boot drops some distros (e.g. Ubuntu) into the GRUB menu, which
   *             would stall an unattended install. Opt in deliberately.
   *  - 'none'   never send input.
   */
  antiBlankMode?: 'mouse' | 'key' | 'none';
  /**
   * A recovered console that dies again within this long was never really
   * alive. Default 60000ms. Exposed mainly so tests can compress the timings.
   */
  shortLivedRecoveryMs?: number;
  /**
   * Recognise the text of every stored frame into a transcript beside them
   * (default true when an OCR hook is available).
   *
   * Costs ~1s of CPU per stored frame — nothing on an idle console (one
   * heartbeat a minute), real work during an install. Buys the only signal that
   * separates a wedged machine from a slow one.
   */
  ocrText?: boolean;
  /**
   * Give up on a single frame's recognition after this long (default 30000ms).
   * Recognition normally takes ~0.4-1.4s; the cap exists because the worker has
   * been seen not to come back, and a stalled queue is worse than a lost frame.
   */
  ocrTimeoutMs?: number;
}

/**
 * Continuously records a vKVM console to an on-disk ring buffer.
 *
 * Why this exists: a single screenshot is a point sample of a continuous
 * process. An agent that looks every few minutes cannot tell whether a screen
 * that reads "Memory testing" both times sat still or rebooted in between, and
 * it will miss short-lived prompts and errors entirely. Recording decouples
 * *observation* (cheap, constant, machine-timed) from *inspection* (whenever
 * the agent gets around to it), so nothing is lost to think-latency.
 *
 * Design notes:
 * - Frames are stored ONLY when the screen actually changes (plus a periodic
 *   heartbeat). An idle console costs almost nothing; a boot sequence keeps
 *   every distinct state.
 * - Unchanged frames are detected by hashing the PNG bytes, which skips image
 *   decoding entirely in the common idle case.
 * - The capture loop deliberately does NOT call bringToFront(): stealing focus
 *   every second would make the operator's desktop unusable. Chromium is
 *   launched with background throttling disabled, so background tabs keep
 *   painting.
 */
export class VkvmRecorder {
  private page: Page;
  private readonly dir: string;
  private readonly opts: Required<RecorderOptions>;
  private readonly hooks: RecorderHooks;

  private timer: NodeJS.Timeout | null = null;
  private capturing = false;
  private seq = 0;
  private frames: RecordedFrame[] = [];
  private lastHash: string | null = null;
  private lastPng: PNG | null = null;
  private lastStoredAt = 0;
  private startedAt = 0;
  private captureErrors = 0;
  private lastError: string | null = null;
  /**
   * Consecutive failed captures. A page can break WITHOUT closing and WITHOUT
   * showing a death dialog (renderer crash, hung tab), in which case neither
   * liveness signal fires and recording would stall silently for the rest of
   * the night. Persistent capture failure is itself evidence the console needs
   * re-establishing.
   */
  private consecutiveCaptureErrors = 0;
  private static readonly CAPTURE_ERRORS_BEFORE_RECOVERY = 10;
  /** Highest seq the agent has actually been shown, for "what did I miss". */
  private lastViewedSeq = 0;
  /** Frames dropped by the ring buffer, i.e. evidence that no longer exists. */
  private framesEvicted = 0;
  /** Hash of the most recently STORED frame, distinct from the last sample. */
  private lastStoredHash: string | null = null;
  private heartbeatsSuppressed = 0;
  private framesAdopted = 0;
  private adoptedFramesEvicted = 0;
  private evictionStartedAt = 0;

  // Self-healing state. An unattended overnight run WILL hit the Intersight
  // session timeout; when it does, the console dies and the recorder would
  // otherwise keep capturing a static "KVM session has ended" screen - which
  // reads as "nothing is changing" and silently blinds the agent.
  private state: 'recording' | 'recovering' | 'failed' | 'stopped' = 'stopped';
  private events: RecorderEvent[] = [];
  private recovering = false;
  private recoveryFailures = 0;
  private nextRecoveryAt = 0;
  private recoveries = 0;
  private ticksSinceDeadCheck = 0;
  private ticksSinceApiCheck = 0;
  /**
   * Consecutive "no Active session" readings from the API backstop. A freshly
   * relaunched console takes a few seconds to register as Active, so a single
   * negative reading right after a recovery is a race, not a death - requiring
   * two in a row stops the backstop from triggering a recovery of its own
   * recovery (observed live: a spurious second relaunch 1s after the first).
   */
  private apiDeadStreak = 0;
  /** Consecutive dead-checks seeing the "No Signal / reconnecting" screen. */
  private disconnectedStreak = 0;
  /** Times a sleeping console was woken with a keypress (rather than relaunched). */
  private wakes = 0;
  /** ~4 checks x 10s: long enough for a genuine self-reconnect, short enough to matter. */
  private static readonly DISCONNECTED_CHECKS_BEFORE_RECOVERY = 4;
  /**
   * When a recovered console was last handed back to us. A console that dies
   * again within shortLivedRecoveryMs of this was born dead, which relaunching
   * cannot fix - see triggerRecovery().
   */
  private lastRecoveredAt = 0;
  /** Consecutive recoveries whose console died almost immediately. */
  private shortLivedRecoveries = 0;
  /** Tunneled vKVM disable/re-enable cycles run for the current bad streak. */
  private tunneledResets = 0;
  /** Two quick deaths is a pattern, not a coincidence; escalate then. */
  private static readonly SHORT_LIVED_BEFORE_RESET = 2;
  /** Resetting twice without it sticking means the problem is something else. */
  private static readonly MAX_TUNNELED_RESETS = 2;
  /** Surviving this many short-lived windows (10 min by default) means healthy. */
  private static readonly HEALTHY_RECOVERY_FACTOR = 10;
  /**
   * Ceiling on the Tunneled vKVM reset, which is a multi-minute REST + workflow
   * round trip running inside the recovery critical section. Without it a hung
   * request would leave the recorder stuck in `recovering` - not capturing, not
   * retrying - for the rest of the night.
   */
  private static readonly TUNNELED_RESET_TIMEOUT_MS = 300000;
  /** Last time NEW content appeared, as classified by the tile tracker. */
  private lastNoveltyAt = 0;
  /** Classifies changes by screen region; replaces the magnitude threshold. */
  private tracker = new TileTracker();
  /** Suppressed-noise counters, for observability of the classifier. */
  private oscillatingSuppressed = 0;
  private rhythmicSuppressed = 0;
  /**
   * Consecutive at-rest samples: pixel-identical, or blink-only churn. Used to
   * tell a console that is WORKING (spinner, progress bar - never accumulates a
   * still run) from one that merely has a clock or a cursor on it.
   */
  private stillSamples = 0;
  private lastNudgeAt = 0;
  private nudges = 0;
  private nudging = false;
  /**
   * Wake the console at the FIRST opportunity rather than after the idle
   * timeout. A console is very often already blanked when we attach to it
   * (verified live: a blanked Windows desktop showed as a black screen), and
   * waiting antiBlankSeconds would leave the agent staring at black for
   * minutes. Set again after a recovery, since the new console may also be
   * asleep.
   */
  private needsInitialNudge = false;

  constructor(page: Page, dir: string, opts?: RecorderOptions, hooks?: RecorderHooks) {
    this.page = page;
    this.dir = dir;
    this.hooks = hooks ?? {};
    this.opts = {
      intervalMs: Math.max(250, opts?.intervalMs ?? 1000),
      retentionMinutes: opts?.retentionMinutes ?? 240,
      maxFrames: opts?.maxFrames ?? 3000,
      heartbeatSeconds: opts?.heartbeatSeconds ?? 60,
      identicalHeartbeatSeconds: opts?.identicalHeartbeatSeconds ?? 1800,
      deadCheckEveryTicks: Math.max(1, opts?.deadCheckEveryTicks ?? 10),
      apiCheckEveryTicks: Math.max(5, opts?.apiCheckEveryTicks ?? 60),
      antiBlankSeconds: opts?.antiBlankSeconds ?? 240,
      antiBlankMode: opts?.antiBlankMode ?? 'mouse',
      shortLivedRecoveryMs: Math.max(1, opts?.shortLivedRecoveryMs ?? 60000),
      ocrText: opts?.ocrText ?? true,
      ocrTimeoutMs: Math.max(100, opts?.ocrTimeoutMs ?? 30000),
    };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  antiBlankMode(): 'mouse' | 'key' | 'none' {
    return this.opts.antiBlankMode;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.seq = 0;
    this.lastViewedSeq = 0;
    this.lastHash = null;
    this.lastPng = null;
    this.tracker.reset();
    // ADOPT whatever a previous run left here rather than deleting it. Runs after
    // the reset above so nothing it establishes gets clobbered.
    //
    // Deleting was defensible when the MCP server owned the recorder, but under
    // per-server daemons it became a data-loss path reachable by a READ: with no
    // daemon live, searching last night's campaign spawned one, and its first act
    // was to delete the frames being searched. One recorder per server is
    // guaranteed by the lock file, so continuing the series is safe — and
    // retention, not deletion-on-start, is what actually bounds disk.
    this.adoptExistingFrames();
    this.startedAt = Date.now();
    this.state = 'recording';
    this.needsInitialNudge = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
    this.publishState();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastPng = null;
    if (this.state !== 'stopped') {
      this.state = 'stopped';
      this.addEvent('stopped');
    }
    // Publish the final state so a reader in another process sees "stopped"
    // rather than a state file that simply went quiet.
    this.publishState();
  }

  /**
   * Publish status next to the frames for other processes to read.
   *
   * Called on every stored frame and every notable event, so a watcher polling
   * the file sees changes within a second rather than waiting for a heartbeat.
   */
  private publishState(): void {
    const ok = writeRecorderState(this.dir, {
      serverMoid: path.basename(this.dir),
      ...this.status(),
    });
    if (ok) {
      this.statePublishFailures = 0;
    } else {
      // Counted, and reported by the next successful publish. A state file that
      // stops advancing reads as idle, so a watcher must be able to tell "the
      // console is quiet" from "nobody has updated this in a while" - which is
      // what the reader's `stale` flag is for.
      this.statePublishFailures++;
    }
  }
  private statePublishFailures = 0;

  // --- Console text transcript -------------------------------------------------
  // Pixel change answers "did the screen move"; only text answers "did anything
  // happen". A parked installer moves no pixels, and a healthy one may move
  // barely any, so the two questions need separate signals.
  private ocrQueue: RecordedFrame[] = [];
  private ocrBusy = false;
  private ocrFramesRead = 0;
  private ocrSkipped = 0;
  private ocrFailures = 0;
  private textChanges = 0;
  private transcriptLines = 0;
  private lastText: string | null = null;
  private lastTextChangeAt = 0;
  /** Frames whose text differed from the previous one, for the timeline. */
  private textChangedSeqs = new Set<number>();

  private addEvent(kind: RecorderEvent['kind'], detail?: string): void {
    this.events.push({ at: Date.now(), kind, detail });
    // Every event is a state transition worth publishing immediately: a death,
    // a recovery, a wake or a reset is exactly what a watcher waits for.
    setImmediate(() => this.publishState());
    if (this.events.length > 200) {
      this.events.splice(0, this.events.length - 200);
    }
  }

  /**
   * Swap in a freshly launched console page, keeping all recorded history so
   * the timeline spans the outage rather than starting over.
   */
  attachPage(page: Page): void {
    this.page = page;
    this.lastHash = null;
    this.lastPng = null;
    this.stillSamples = 0;
    // The relaunched console starts a fresh visual history: stale tile rhythms
    // from the old session must not classify the new console's first changes.
    this.tracker.reset();
    // A freshly relaunched console may itself be blanked - wake it immediately.
    this.needsInitialNudge = true;
    // Give the new session time to register as Active before the API backstop
    // may speak again, and discard any dead readings from the old session.
    this.ticksSinceApiCheck = 0;
    this.apiDeadStreak = 0;
    this.ticksSinceDeadCheck = 0;
  }

  /**
   * The console is gone (tab closed, or showing "KVM session has ended").
   * Drive recovery: re-login if needed, relaunch the vKVM session, re-attach.
   * Guarded so only one recovery runs at a time, with escalating backoff so a
   * persistently broken console cannot spin.
   */
  private async triggerRecovery(reason: string): Promise<void> {
    if (this.recovering || !this.timer) {
      return;
    }
    if (!this.hooks.recover) {
      if (this.state !== 'failed') {
        this.state = 'failed';
        this.addEvent('console-dead', `${reason} (no recovery hook configured)`);
      }
      return;
    }
    if (Date.now() < this.nextRecoveryAt) {
      return; // backing off
    }

    this.recovering = true;
    // A console that dies again seconds after being re-established was never
    // really alive: Intersight's tunneled-vKVM bug makes every fresh session
    // born dead, and it mounts looking healthy before the death dialog appears,
    // so the relaunch "succeeds" every time. Counting these separately from
    // failed relaunches is what stops the ~9-second relaunch loop that ran all
    // night on CHG-UCSX-2-2-5.
    const sinceRecovered = this.lastRecoveredAt > 0 ? Date.now() - this.lastRecoveredAt : Infinity;
    if (sinceRecovered < this.opts.shortLivedRecoveryMs) {
      this.shortLivedRecoveries++;
    } else if (sinceRecovered >= this.opts.shortLivedRecoveryMs * VkvmRecorder.HEALTHY_RECOVERY_FACTOR) {
      // The console lived a good long while, so whatever was wrong has cleared:
      // an ordinary overnight session timeout must never look like the bug.
      this.shortLivedRecoveries = 0;
      this.tunneledResets = 0;
    }
    // In between the two, counters are left alone: a console that lasted a
    // couple of minutes is not proof of health, and clearing on it would let a
    // genuinely broken server churn through fresh reset cycles all night.
    const wasState = this.state;
    this.state = 'recovering';
    if (wasState !== 'recovering') {
      this.addEvent('console-dead', reason);
    }
    this.addEvent('recovering', `attempt ${this.recoveryFailures + 1}`);
    try {
      if (this.shortLivedRecoveries >= VkvmRecorder.SHORT_LIVED_BEFORE_RESET) {
        await this.resetTunneledVkvm();
      }
      const page = await this.hooks.recover();
      if (!page) {
        throw new Error('recovery did not produce a console page');
      }
      this.attachPage(page);
      this.recoveryFailures = 0;
      this.nextRecoveryAt = 0;
      this.recoveries++;
      this.lastRecoveredAt = Date.now();
      this.state = 'recording';
      this.addEvent('recovered', 'console re-established; recording resumed');
    } catch (error) {
      this.recoveryFailures++;
      // 30s, 60s, 120s ... capped at 5 minutes. Keeps trying all night without
      // hammering (the login circuit breaker separately guards the account).
      const backoff = Math.min(300000, 30000 * 2 ** (this.recoveryFailures - 1));
      this.nextRecoveryAt = Date.now() + backoff;
      this.state = 'failed';
      this.addEvent(
        'recovery-failed',
        `${(error as Error).message?.slice(0, 140)} - retrying in ${Math.round(backoff / 1000)}s`
      );
    } finally {
      this.recovering = false;
    }
  }

  /**
   * Every relaunch has produced a console that died immediately. Relaunching
   * again cannot help - the fix is to disable and re-enable Tunneled vKVM on
   * the server. Throws once that has been tried and the console STILL comes
   * back dead, which hands control to the caller's backoff ladder rather than
   * letting the loop run all night.
   */
  private async resetTunneledVkvm(): Promise<void> {
    const windowSec = Math.round(this.opts.shortLivedRecoveryMs / 1000);
    if (!this.hooks.resetTunneledVkvm) {
      throw new Error(
        `console died within ${windowSec}s of each of the last ${this.shortLivedRecoveries} relaunches ` +
          `and no Tunneled vKVM reset is available - run reset_tunneled_vkvm for this server`
      );
    }
    if (this.tunneledResets >= VkvmRecorder.MAX_TUNNELED_RESETS) {
      throw new Error(
        `console still dies within ${windowSec}s of every relaunch after ${this.tunneledResets} ` +
          `Tunneled vKVM reset(s) - the server needs attention`
      );
    }
    this.tunneledResets++;
    this.addEvent(
      'vkvm-reset',
      `console died within ${windowSec}s of ${this.shortLivedRecoveries} relaunches in a row; ` +
        `disabling and re-enabling Tunneled vKVM (reset ${this.tunneledResets}/${VkvmRecorder.MAX_TUNNELED_RESETS})`
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.hooks.resetTunneledVkvm(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Tunneled vKVM reset timed out')),
            VkvmRecorder.TUNNELED_RESET_TIMEOUT_MS
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    // Give the reset a fair chance: judge the next console on its own merits.
    this.shortLivedRecoveries = 0;
  }

  /** Capture one sample; store it only if the console changed (or heartbeat is due). */
  private async tick(): Promise<void> {
    if (this.capturing || this.recovering) {
      return; // previous capture/recovery still running - skip rather than pile up
    }
    // The tab is gone (session timeout closed it, or the login flow cleaned it
    // up). Recover rather than silently stopping.
    if (this.page.isClosed()) {
      await this.triggerRecovery('vKVM tab was closed');
      return;
    }
    this.capturing = true;
    try {
      // Periodically confirm the console is actually LIVE. A dead console
      // ("KVM session has ended") is a perfectly static image, so change
      // detection alone would report a calm, idle machine forever.
      if (this.hooks.isConsoleDead && ++this.ticksSinceDeadCheck >= this.opts.deadCheckEveryTicks) {
        this.ticksSinceDeadCheck = 0;
        if (await this.hooks.isConsoleDead(this.page).catch(() => false)) {
          this.capturing = false;
          await this.triggerRecovery('console displayed a session-ended/terminated dialog');
          return;
        }
        // Degraded: the tunnel dropped and the client is retrying. Give it a
        // few checks to reconnect by itself before relaunching, but do not wait
        // for the terminal dialog - that cost ~2 minutes of blindness live.
        if (this.hooks.isConsoleDisconnected) {
          const state = await this.hooks.isConsoleDisconnected(this.page).catch(() => null);
          if (state === 'inactivity') {
            // The host video is asleep, not disconnected. Relaunching would not
            // help; send the keypress the screen is asking for.
            this.disconnectedStreak = 0;
            if (this.hooks.wakeConsole) {
              const woke = await this.hooks.wakeConsole().catch(() => false);
              if (woke) {
                this.wakes++;
                this.addEvent('recovered', 'console was asleep (user inactivity) - sent a key to wake it');
              }
            }
          } else if (state === 'dropped') {
            this.disconnectedStreak++;
            if (this.disconnectedStreak >= VkvmRecorder.DISCONNECTED_CHECKS_BEFORE_RECOVERY) {
              this.disconnectedStreak = 0;
              this.capturing = false;
              await this.triggerRecovery('console stuck on "No Signal / connection dropped" and did not self-reconnect');
              return;
            }
          } else {
            this.disconnectedStreak = 0;
          }
        }
      }
      // Authoritative backstop: the client can die in ways whose wording we have
      // never seen (the session-expired dialog in particular), so periodically
      // ask Intersight whether an Active session still exists.
      if (this.hooks.isSessionDeadViaApi && ++this.ticksSinceApiCheck >= this.opts.apiCheckEveryTicks) {
        this.ticksSinceApiCheck = 0;
        const deadViaApi = await this.hooks.isSessionDeadViaApi().catch(() => null);
        if (deadViaApi === true) {
          this.apiDeadStreak++;
        } else if (deadViaApi === false) {
          this.apiDeadStreak = 0;
        }
        // Two consecutive readings required - see apiDeadStreak.
        if (this.apiDeadStreak >= 2) {
          this.apiDeadStreak = 0;
          this.capturing = false;
          await this.triggerRecovery('Intersight reports no Active kvm.Session for this server (two consecutive checks)');
          return;
        }
      }
      // No bringToFront() - see class docs.
      const buf = await this.page.screenshot({ timeout: 15000 });
      this.consecutiveCaptureErrors = 0;
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      const now = Date.now();
      const heartbeatDue = now - this.lastStoredAt >= this.opts.heartbeatSeconds * 1000;

      if (hash === this.lastHash) {
        // Pixel-identical: no decode needed at all. NOTE: this is the idle path,
        // which is exactly when an anti-blank nudge is due - so it must fall
        // through to maybeNudge() rather than returning early.
        this.stillSamples++;
        if (heartbeatDue) {
          // A heartbeat whose image is byte-identical to the stored one adds no
          // information at all. Six of nine recorded servers were found powered
          // OFF, their consoles a static green "Host power is off" — and the
          // minute-by-minute heartbeat had stored that same image 1193 times,
          // 57MB, each one also queued for OCR. So the cadence backs off rather
          // than switching off: an occasional anchor still proves capture is
          // alive and keeps newestFrameAt moving, which the dormancy and
          // data-expiry clocks are judged on.
          if (hash === this.lastStoredHash && now - this.lastStoredAt < this.opts.identicalHeartbeatSeconds * 1000) {
            this.heartbeatsSuppressed++;
          } else {
            this.store(buf, now, 0, 'heartbeat');
          }
        }
      } else {
        // Something repainted. WHERE and WHAT decide whether it matters: the
        // tile tracker classifies each changed region as novel content, a
        // blink returning to a known state, or a rhythmic repaint (clock,
        // spinner). Magnitude is recorded as metadata but decides nothing - a
        // password dot and a cursor blink measure identically (~0.0003), so no
        // magnitude ever could.
        const png = this.decode(buf);
        if (png) {
          const novelty = this.tracker.update(png, now);
          this.oscillatingSuppressed += novelty.oscillatingTiles;
          this.rhythmicSuppressed += novelty.rhythmicTiles;
          // A screen whose only motion is a blink is AT REST: without this, a
          // blinking cursor on an idle login prompt resets the still-run every
          // second and anti-blank never fires on exactly the console most
          // likely to blank.
          if (novelty.changedTiles === novelty.oscillatingTiles) {
            this.stillSamples++;
          } else {
            this.stillSamples = 0;
          }
          const ratio = this.sampledDiff(this.lastPng, png);
          this.lastHash = hash;
          this.lastPng = png;

          if (this.frames.length === 0) {
            this.store(buf, now, 0, 'first');
          } else if (novelty.novelTiles > 0) {
            this.store(buf, now, ratio, 'change');
            this.lastNoveltyAt = now;
          } else if (heartbeatDue) {
            // Blink- or rhythm-only churn: kept visible via the heartbeat, so
            // a clock or spinner still appears in the record about once a
            // minute without flooding it.
            this.store(buf, now, ratio, 'heartbeat');
          }
        }
        // an undecodable grab is skipped, never stored as garbage
      }
      await this.maybeNudge(now);
    } catch (error) {
      this.captureErrors++;
      this.consecutiveCaptureErrors++;
      this.lastError = (error as Error).message?.slice(0, 160) ?? String(error);
      // A page that keeps failing to screenshot is broken even if it is neither
      // closed nor showing a death dialog - recover rather than stall silently.
      if (this.consecutiveCaptureErrors >= VkvmRecorder.CAPTURE_ERRORS_BEFORE_RECOVERY) {
        this.consecutiveCaptureErrors = 0;
        this.capturing = false;
        await this.triggerRecovery(`capture failed ${VkvmRecorder.CAPTURE_ERRORS_BEFORE_RECOVERY}x in a row: ${this.lastError}`);
      }
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Keep an idle console awake so it does not blank into a screensaver and hide
   * the machine's state. Only fires when the screen has genuinely been still:
   * if output is flowing the console will not blank anyway, and staying passive
   * during activity avoids any chance of disturbing what is happening (or the
   * agent's own interaction). The owner has final say via the nudge hook.
   */
  private async maybeNudge(now: number): Promise<void> {
    if (this.nudging || !this.hooks.nudge) {
      return;
    }
    const due = shouldNudge({
      now,
      antiBlankSeconds: this.opts.antiBlankSeconds,
      mode: this.opts.antiBlankMode,
      state: this.state,
      needsInitialNudge: this.needsInitialNudge,
      lastNoveltyAt: this.lastNoveltyAt,
      lastNudgeAt: this.lastNudgeAt,
      startedAt: this.startedAt,
      stillSamples: this.stillSamples,
    });
    if (!due) {
      return;
    }
    this.nudging = true;
    // Cleared on attempt, not on success: if the owner declines (the agent is
    // interacting) the console is being used anyway, and the normal idle rule
    // takes over from here.
    this.needsInitialNudge = false;
    try {
      const done = await this.hooks.nudge();
      // Record the attempt either way, so a declined nudge (agent busy) does not
      // cause us to retry every single tick.
      this.lastNudgeAt = Date.now();
      if (done) {
        this.nudges++;
      }
    } catch {
      this.lastNudgeAt = Date.now();
    } finally {
      this.nudging = false;
    }
  }

  private decode(buf: Buffer): PNG | null {
    try {
      return PNG.sync.read(buf);
    } catch {
      return null;
    }
  }

  /**
   * Change ratio over a strided sample of pixels (1/16 the work of a full
   * comparison). Stride 4 rather than 8: console text is thin, and coarser
   * sampling loses so much of a one-line change that it becomes
   * indistinguishable from noise.
   */
  private sampledDiff(a: PNG | null, b: PNG): number {
    if (!a || a.width !== b.width || a.height !== b.height) {
      return 1;
    }
    const stride = 4;
    let differing = 0;
    let total = 0;
    for (let y = 0; y < b.height; y += stride) {
      for (let x = 0; x < b.width; x += stride) {
        const i = (y * b.width + x) * 4;
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 24) {
          differing++;
        }
        total++;
      }
    }
    return total ? differing / total : 0;
  }

  /**
   * Take ownership of frames a previous run left on disk.
   *
   * Their capture times come from file mtimes (the only record left once the
   * writing process is gone), which is enough for everything a reader does:
   * retention, the timeline, `framesAt` and OCR search all work off `at`. Change
   * ratios are NOT invented — those lived in the previous recorder's memory, and
   * a fabricated 0 would be indistinguishable from a measured one. `reason:
   * 'adopted'` says exactly what these are.
   */
  private adoptExistingFrames(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^f-\d+\.png$/.test(f));
    } catch {
      return;
    }
    const adopted: RecordedFrame[] = [];
    for (const file of files) {
      const full = path.join(this.dir, file);
      try {
        const stat = fs.statSync(full);
        adopted.push({
          seq: Number(file.slice(2, -4)),
          at: stat.mtimeMs,
          path: full,
          bytes: stat.size,
          changeRatio: 0,
          reason: 'adopted',
        });
      } catch {
        // Vanished between listing and stat: nothing to adopt.
      }
    }
    adopted.sort((a, b) => a.seq - b.seq);
    this.frames = adopted;
    this.framesAdopted = adopted.length;
    // Continue the series, so a new capture can never overwrite an old frame.
    this.seq = adopted.reduce((max, f) => Math.max(max, f.seq), 0);
    // lastViewedSeq stays at 0: nobody in this process has looked at these yet,
    // so they legitimately count as changes the caller has not seen.
    if (adopted.length > 0) {
      this.addEvent('adopted-frames', `${adopted.length} frame(s) from a previous recorder in this directory`);
      // Only the frame cap can act on them here — never the age clock, which
      // would delete the inherited history at the moment of attaching.
      this.prune();
    }
  }

  private store(buf: Buffer, at: number, changeRatio: number, reason: RecordedFrame['reason']): void {
    const seq = ++this.seq;
    const file = path.join(this.dir, `f-${String(seq).padStart(6, '0')}.png`);
    try {
      fs.writeFileSync(file, buf);
    } catch {
      return;
    }
    this.frames.push({
      seq,
      at,
      path: file,
      bytes: buf.length,
      changeRatio: Math.round(changeRatio * 10000) / 10000,
      reason,
    });
    this.lastStoredAt = at;
    this.lastStoredHash = crypto.createHash('sha1').update(buf).digest('hex');
    this.prune();
    this.enqueueOcr(this.frames[this.frames.length - 1]);
    this.publishState();
  }

  /**
   * Queue a stored frame for text recognition.
   *
   * EVERY stored frame, including heartbeats — deliberately not gated on change
   * magnitude. A one-line error moves 0.001-0.0026 of the screen and may only
   * ever appear on a heartbeat frame; whereas the frames with huge change
   * ratios (full-screen repaints) carry the least readable text. Gating on
   * magnitude would read the wrong frames.
   */
  private enqueueOcr(frame: RecordedFrame | undefined): void {
    if (!frame || !this.hooks.ocrFrame || !this.opts.ocrText) {
      return;
    }
    this.ocrQueue.push(frame);
    while (this.ocrQueue.length > MAX_OCR_QUEUE) {
      this.ocrQueue.shift();
      this.ocrSkipped++;
    }
    void this.pumpOcr();
  }

  /**
   * Read queued frames one at a time, appending to the transcript whenever the
   * text actually changed.
   *
   * Serial by design: recognition is CPU-heavy and several recorders share one
   * worker. Failures are counted and never propagate — OCR enriches the
   * recording, it must not be able to stop it.
   */
  private async pumpOcr(): Promise<void> {
    if (this.ocrBusy || !this.hooks.ocrFrame) {
      return;
    }
    this.ocrBusy = true;
    try {
      while (this.ocrQueue.length > 0 && this.timer) {
        const frame = this.ocrQueue.shift()!;
        // The ring buffer may have deleted it while it waited.
        if (!fs.existsSync(frame.path)) {
          this.ocrSkipped++;
          continue;
        }
        let raw: string | null = null;
        try {
          // Bounded deliberately: a previous engine was observed to fail to
          // settle. An unbounded await here would park the queue permanently -
          // no transcript, no text signal, and no error - leaving the recorder
          // looking healthy while its most useful signal silently stopped.
          raw = await this.withOcrTimeout(this.hooks.ocrFrame(frame.path));
        } catch {
          this.ocrFailures++;
          continue;
        }
        if (raw === null) {
          this.ocrFailures++;
          continue;
        }
        this.ocrFramesRead++;
        // A screen with no legible text reads as '' rather than as whatever
        // character OCR imagined this time - see MIN_MEANINGFUL_TEXT_CHARS.
        const text = meaningfulText(raw);
        if (text === this.lastText) {
          continue; // pixels moved, words did not
        }
        if (text === '' && this.lastText === null) {
          this.lastText = ''; // first frame is blank: that is the baseline, not news
          continue;
        }
        this.lastText = text;
        if (text === '') {
          // The text going away IS an event (a screen clearing, a blank), but
          // there is nothing to transcribe.
          this.textChanges++;
          this.lastTextChangeAt = frame.at;
          this.textChangedSeqs.add(frame.seq);
          continue;
        }
        this.textChanges++;
        this.lastTextChangeAt = frame.at;
        this.textChangedSeqs.add(frame.seq);
        this.appendTranscript(frame, text);
      }
    } finally {
      this.ocrBusy = false;
    }
  }

  /** Reject rather than hang if recognition does not come back. */
  private async withOcrTimeout(work: Promise<string | null>): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR timed out')), this.opts.ocrTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private appendTranscript(frame: RecordedFrame, text: string): void {
    const file = path.join(this.dir, OCR_TEXT_FILENAME);
    try {
      fs.appendFileSync(
        file,
        `${JSON.stringify({
          seq: frame.seq,
          at: new Date(frame.at).toISOString(),
          frame: path.basename(frame.path),
          changeRatio: frame.changeRatio,
          text,
        })}\n`
      );
      // Bounded like everything else that grows on a timer: keep the newest half
      // rather than letting a long run fill the disk unnoticed.
      if (++this.transcriptLines > MAX_TRANSCRIPT_LINES) {
        const kept = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .slice(-Math.floor(MAX_TRANSCRIPT_LINES / 2));
        fs.writeFileSync(file, `${kept.join('\n')}\n`);
        this.transcriptLines = kept.length;
      }
    } catch {
      // A transcript we cannot write must not stop recording.
    }
  }

  /**
   * Bound the buffer: age for frames THIS recorder captured, the frame cap for
   * everything.
   *
   * Inherited (`adopted`) frames are deliberately exempt from the age clock. A
   * field report caught the alternative: an agent attached to a console, adopted
   * 56 frames from the previous run, and watched every one evicted against the
   * new session's 4-hour window — destroying the history it had attached to
   * inspect. Retention exists to bound a capture that keeps GROWING; an inherited
   * set is finite and is the only record of what the machine did before anyone
   * was watching.
   *
   * The cap is the safety valve, because exemption cannot mean unbounded disk:
   * every restart converts that run's live frames into inherited ones, so with no
   * cap a restart loop would grow the exempt set forever.
   */
  private prune(): void {
    const cutoff = Date.now() - this.opts.retentionMinutes * 60000;
    for (let i = 0; i < this.frames.length; ) {
      const frame = this.frames[i];
      if (frame.reason !== 'adopted' && frame.at < cutoff) {
        this.frames.splice(i, 1);
        this.evictFrame(frame);
      } else {
        i++;
      }
    }
    while (this.frames.length > this.opts.maxFrames) {
      this.evictFrame(this.frames.shift()!);
    }
  }

  private evictFrame(dropped: RecordedFrame): void {
    // Counted and surfaced: a long campaign silently lost ~60% of its console
    // evidence to the ring buffer, and the first sign was frames simply not
    // being there when they were wanted. The buffer starting to roll is worth
    // knowing about while there is still time to raise retention or export.
    this.framesEvicted++;
    if (dropped.reason === 'adopted') {
      // Reported separately: losing inherited evidence is the more serious loss,
      // and it can only happen at the frame cap.
      this.adoptedFramesEvicted++;
    }
    if (!this.evictionStartedAt) {
      this.evictionStartedAt = Date.now();
    }
    try {
      fs.unlinkSync(dropped.path);
    } catch {
      // already gone
    }
  }

  /** Every retained frame, oldest first. A copy, so callers cannot mutate the buffer. */
  allFrames(): RecordedFrame[] {
    return [...this.frames];
  }

  /** Frames whose seq is newer than the last batch handed to the agent. */
  newFramesSinceLastView(): number {
    return this.frames.filter((f) => f.seq > this.lastViewedSeq && f.reason === 'change').length;
  }

  markViewed(upToSeq?: number): void {
    const target = upToSeq ?? (this.frames.length ? this.frames[this.frames.length - 1].seq : this.lastViewedSeq);
    this.lastViewedSeq = Math.max(this.lastViewedSeq, target);
  }

  /**
   * Frames to search over, NEWEST FIRST so a text scan hits recent events soonest
   * and can stop early. Heartbeats are included: a parked installer produces no
   * changes, so its telltale text may only exist on a heartbeat frame.
   */
  framesForSearch(lastN?: number, sinceMs?: number): RecordedFrame[] {
    let pool = this.frames;
    if (typeof sinceMs === 'number') {
      pool = pool.filter((f) => f.at >= sinceMs);
    }
    const newestFirst = [...pool].reverse();
    return typeof lastN === 'number' && lastN > 0 ? newestFirst.slice(0, lastN) : newestFirst;
  }

  /** The most recent frames, newest last. `changesOnly` skips heartbeats. */
  recent(count: number, changesOnly = false): RecordedFrame[] {
    const pool = changesOnly ? this.frames.filter((f) => f.reason !== 'heartbeat') : this.frames;
    return pool.slice(-Math.max(1, count));
  }

  /** The frame nearest `at`, plus neighbours on each side (temporal context). */
  around(at: number, before: number, after: number): { frames: RecordedFrame[]; centerSeq: number | null } {
    if (this.frames.length === 0) {
      return { frames: [], centerSeq: null };
    }
    let idx = 0;
    let best = Number.POSITIVE_INFINITY;
    this.frames.forEach((f, i) => {
      const d = Math.abs(f.at - at);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    const from = Math.max(0, idx - Math.max(0, before));
    const to = Math.min(this.frames.length, idx + Math.max(0, after) + 1);
    return { frames: this.frames.slice(from, to), centerSeq: this.frames[idx].seq };
  }

  /**
   * Text-only change log - lets an agent locate a moment without spending image
   * tokens. Console outages and recoveries are interleaved with the frames, so
   * a gap in the recording is explicit rather than looking like a quiet machine.
   */
  timeline(sinceMs?: number, minChangeRatio?: number): Array<{
    seq?: number;
    at: string;
    sinceStartSec: number;
    changeRatio?: number;
    reason: string;
    detail?: string;
    path?: string;
  }> {
    const from = sinceMs ?? 0;
    // minChangeRatio filters out progress-bar noise (installs emit dozens of
    // ~0.001 ticks) so the big structural events — reboot, mode switch, error
    // dialog — stand out. 'first' frames are always kept as anchors, and
    // heartbeats are dropped when filtering since they carry no change.
    const frameRows = this.frames
      .filter((f) => f.at >= from)
      .filter((f) => {
        if (minChangeRatio === undefined || minChangeRatio <= 0) {
          return true;
        }
        return f.reason === 'first' || f.changeRatio >= minChangeRatio;
      })
      .map((f) => ({
        seq: f.seq,
        at: f.at,
        changeRatio: f.changeRatio,
        reason: f.reason as string,
        detail: undefined as string | undefined,
        // The PNG on disk, so a frame can be opened directly without spending
        // image tokens to retrieve it through a tool.
        path: f.path as string | undefined,
      }));
    const eventRows = this.events
      .filter((e) => e.at >= from)
      .map((e) => ({
        seq: undefined as number | undefined,
        at: e.at,
        changeRatio: undefined as number | undefined,
        reason: e.kind as string,
        detail: e.detail,
        path: undefined as string | undefined,
      }));
    return [...frameRows, ...eventRows]
      .sort((a, b) => a.at - b.at)
      .map((row) => ({
        ...(row.seq !== undefined ? { seq: row.seq } : {}),
        at: new Date(row.at).toISOString(),
        sinceStartSec: Math.round((row.at - this.startedAt) / 100) / 10,
        ...(row.changeRatio !== undefined ? { changeRatio: row.changeRatio } : {}),
        reason: row.reason,
        // The frames where the WORDS changed, not just the pixels. A tiny
        // changeRatio with textChanged is a new line of output; a large one
        // without it is usually a repaint.
        ...(row.seq !== undefined && this.textChangedSeqs.has(row.seq) ? { textChanged: true } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.path ? { path: row.path } : {}),
      }));
  }

  status(): any {
    const totalBytes = this.frames.reduce((sum, f) => sum + f.bytes, 0);
    const staleSeconds = this.frames.length
      ? Math.round((Date.now() - this.frames[this.frames.length - 1].at) / 1000)
      : null;
    return {
      running: this.isRunning(),
      state: this.state,
      consoleLive: this.state === 'recording',
      recoveries: this.recoveries,
      recoveryFailures: this.recoveryFailures,
      /** Relaunches whose console died immediately - the Intersight born-dead bug. */
      shortLivedRecoveries: this.shortLivedRecoveries,
      tunneledVkvmResets: this.tunneledResets,
      wakes: this.wakes,
      antiBlank: {
        mode: this.opts.antiBlankMode,
        afterIdleSeconds: this.opts.antiBlankSeconds,
        nudgesSent: this.nudges,
        lastNudgeAt: this.lastNudgeAt ? new Date(this.lastNudgeAt).toISOString() : null,
      },
      nextRecoveryAttemptAt: this.nextRecoveryAt ? new Date(this.nextRecoveryAt).toISOString() : null,
      /** Seconds since the last stored frame; if this exceeds the heartbeat, capture is not healthy. */
      secondsSinceLastFrame: staleSeconds,
      recentEvents: this.events.slice(-8).map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, detail: e.detail })),
      intervalMs: this.opts.intervalMs,
      retentionMinutes: this.opts.retentionMinutes,
      heartbeatSeconds: this.opts.heartbeatSeconds,
      // WHEN something genuinely new last appeared on the console — the wedge
      // predicate. Blink and clock/spinner repaints are classified out, so a
      // machine doing nothing reads as idle even with a clock on screen.
      novelty: {
        lastNoveltyAt: this.lastNoveltyAt ? new Date(this.lastNoveltyAt).toISOString() : null,
        secondsSinceNovelty: this.lastNoveltyAt ? Math.round((Date.now() - this.lastNoveltyAt) / 1000) : null,
        oscillatingSuppressed: this.oscillatingSuppressed,
        rhythmicSuppressed: this.rhythmicSuppressed,
      },
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      framesStored: this.frames.length,
      changeFrames: this.frames.filter((f) => f.reason === 'change').length,
      diskBytes: totalBytes,
      diskMB: Math.round((totalBytes / 1048576) * 10) / 10,
      oldestFrameAt: this.frames.length ? new Date(this.frames[0].at).toISOString() : null,
      newestFrameAt: this.frames.length ? new Date(this.frames[this.frames.length - 1].at).toISOString() : null,
      newChangesSinceLastView: this.newFramesSinceLastView(),
      ...(this.statePublishFailures > 0 ? { statePublishFailures: this.statePublishFailures } : {}),
      // Content-stillness, as distinct from pixel-stillness. `pending` and
      // `skipped` exist so "the transcript shows no error" can never be mistaken
      // for "every frame was read".
      ocr: {
        enabled: !!this.hooks.ocrFrame && this.opts.ocrText,
        framesRead: this.ocrFramesRead,
        textChanges: this.textChanges,
        lastTextChangeAt: this.lastTextChangeAt ? new Date(this.lastTextChangeAt).toISOString() : null,
        secondsSinceTextChange: this.lastTextChangeAt
          ? Math.round((Date.now() - this.lastTextChangeAt) / 1000)
          : null,
        pending: this.ocrQueue.length,
        skipped: this.ocrSkipped,
        failures: this.ocrFailures,
        transcript: path.join(this.dir, OCR_TEXT_FILENAME),
      },
      heartbeatsSuppressed: this.heartbeatsSuppressed,
      ...(this.heartbeatsSuppressed > 0
        ? {
            heartbeatNote:
              `${this.heartbeatsSuppressed} heartbeat frame(s) were skipped because the screen was ` +
              `byte-identical to the frame already stored — a powered-off or parked console is recorded once, ` +
              `then anchored every ${Math.round(this.opts.identicalHeartbeatSeconds / 60)} minutes instead of every ` +
              `${this.opts.heartbeatSeconds}s. Any real change is still captured on the tick it happens.`,
          }
        : {}),
      framesEvicted: this.framesEvicted,
      framesAdopted: this.framesAdopted,
      ...(this.framesAdopted > 0
        ? {
            adoptionNote:
              `${this.framesAdopted} frame(s) were inherited from a previous recorder in this directory ` +
              `and are kept OUTSIDE the ${this.opts.retentionMinutes}-minute retention window — they are the only ` +
              `record of what this console did before now, so the age clock does not touch them. ` +
              (this.adoptedFramesEvicted > 0
                ? `WARNING: ${this.adoptedFramesEvicted} of them have already been deleted to stay under the ` +
                  `maxFrames cap (${this.opts.maxFrames}); raise maxFrames or vkvm_export the rest now.`
                : `They are dropped only if the maxFrames cap (${this.opts.maxFrames}) is reached, oldest first.`),
          }
        : {}),
      ...(this.adoptedFramesEvicted > 0 ? { adoptedFramesEvicted: this.adoptedFramesEvicted } : {}),
      evictionStartedAt: this.evictionStartedAt ? new Date(this.evictionStartedAt).toISOString() : null,
      ...(this.framesEvicted > 0
        ? {
            evictionNote:
              `The ring buffer is rolling: ${this.framesEvicted} frame(s) have been deleted and cannot be ` +
              `recovered — ${this.framesEvicted - this.adoptedFramesEvicted} for being older than ` +
              `${this.opts.retentionMinutes} minutes` +
              (this.adoptedFramesEvicted > 0
                ? `, and ${this.adoptedFramesEvicted} INHERITED from a previous recorder, dropped at the ` +
                  `maxFrames cap (${this.opts.maxFrames}) — that history is irreplaceable, so raise maxFrames`
                : '') +
              `. For a run longer than the window, raise retentionMinutes (settable on launch_vkvm_session ` +
              `and vkvm_record_start) or archive frames with vkvm_export.`,
          }
        : {}),
      captureErrors: this.captureErrors,
      lastError: this.lastError,
    };
  }

  /** Read a frame from disk, optionally box-downscaled to control image-token cost. */
  static readFrame(frame: RecordedFrame, scale = 1): Buffer | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(frame.path);
    } catch {
      return null;
    }
    if (scale >= 0.999) {
      return buf;
    }
    try {
      const src = PNG.sync.read(buf);
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const dst = new PNG({ width: w, height: h });
      const bx = src.width / w;
      const by = src.height / h;
      // Box average: keeps thin console text far more legible than nearest-neighbour.
      for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * by);
        const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * by)));
        for (let x = 0; x < w; x++) {
          const x0 = Math.floor(x * bx);
          const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * bx)));
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let sy = y0; sy < y1; sy++) {
            for (let sx = x0; sx < x1; sx++) {
              const i = (sy * src.width + sx) * 4;
              r += src.data[i];
              g += src.data[i + 1];
              b += src.data[i + 2];
              n++;
            }
          }
          const o = (y * w + x) * 4;
          dst.data[o] = Math.round(r / n);
          dst.data[o + 1] = Math.round(g / n);
          dst.data[o + 2] = Math.round(b / n);
          dst.data[o + 3] = 255;
        }
      }
      return PNG.sync.write(dst);
    } catch {
      return buf;
    }
  }
}
