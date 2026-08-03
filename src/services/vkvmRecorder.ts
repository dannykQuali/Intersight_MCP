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

export interface RecordedFrame {
  seq: number;
  /** Capture time (epoch ms). */
  at: number;
  path: string;
  bytes: number;
  /** Fraction of sampled pixels that differed from the previously stored frame. */
  changeRatio: number;
  reason: 'first' | 'change' | 'heartbeat';
}

/** A notable non-frame occurrence (console death, recovery), for the timeline. */
export interface RecorderEvent {
  at: number;
  kind: 'console-dead' | 'recovering' | 'recovered' | 'recovery-failed' | 'vkvm-reset' | 'stopped';
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
  /** Last change big enough to store: real console output. */
  lastChangeAt: number;
  lastNudgeAt: number;
  startedAt: number;
  /** Consecutive pixel-identical samples, i.e. how long the screen has sat still. */
  stillSamples: number;
}

/**
 * Consecutive identical samples that mean "the screen is at rest right now".
 *
 * This is what separates a console that is WORKING from one that merely has a
 * clock on it. A spinner or progress bar repaints on essentially every sample
 * and never accumulates a still run; a taskbar clock repaints once a minute and
 * sits still for the other 59 samples.
 */
export const STILL_SAMPLES_BEFORE_NUDGE = 3;

/**
 * Decide whether an idle console is due for an anti-blank nudge.
 *
 * Idleness is measured from real console OUTPUT (above-threshold changes), not
 * from any pixel movement at all. Keying off every sub-threshold repaint looked
 * safer but silently disabled anti-blank on every booted OS: a Windows taskbar
 * clock ticks forever, so the console never accrued the 240s of stillness the
 * nudge required and blanked anyway (verified live - 0 nudges in 11 minutes on
 * a Windows console, while a static UEFI console nudged on schedule). A console
 * blanks on INPUT idle and does not care what repaints itself.
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
  const idleSince = Math.max(d.lastChangeAt, d.lastNudgeAt, d.startedAt);
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
  /**
   * Sampled-pixel fraction that counts as a real change. Default 0.0005.
   *
   * Calibrated against measurements on a 1600x900 console: a single character
   * (e.g. a blinking cursor) moves ~0.0003 of the frame, while a whole new line
   * of text moves 0.001-0.0026. A 0.0005 threshold therefore ignores cursor
   * blink but captures every new line of output. Do NOT raise this to the
   * "obviously safe" 1% - that silently discards real console activity.
   */
  threshold?: number;
  /** Store a frame at least this often even when nothing changes. Default 60s. */
  heartbeatSeconds?: number;
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
  private lastChangeAt = 0;
  /**
   * Consecutive pixel-identical samples: how long the screen has sat perfectly
   * still. Used to tell a console that is WORKING (spinner, progress bar - never
   * accumulates a still run) from one that merely has a clock on it (still for
   * 59 samples out of 60). Frame STORAGE stays threshold-gated as before.
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
      threshold: opts?.threshold ?? 0.0005,
      heartbeatSeconds: opts?.heartbeatSeconds ?? 60,
      deadCheckEveryTicks: Math.max(1, opts?.deadCheckEveryTicks ?? 10),
      apiCheckEveryTicks: Math.max(5, opts?.apiCheckEveryTicks ?? 60),
      antiBlankSeconds: opts?.antiBlankSeconds ?? 240,
      antiBlankMode: opts?.antiBlankMode ?? 'mouse',
      shortLivedRecoveryMs: Math.max(1, opts?.shortLivedRecoveryMs ?? 60000),
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
    // Clear frames left by a previous session so disk use stays bounded. The
    // in-memory index must be reset with it, or it would reference files that
    // were just deleted. (Recovery keeps history via attachPage(), not start().)
    for (const file of fs.readdirSync(this.dir)) {
      if (file.endsWith('.png')) {
        fs.unlinkSync(path.join(this.dir, file));
      }
    }
    this.frames = [];
    this.seq = 0;
    this.lastViewedSeq = 0;
    this.lastHash = null;
    this.lastPng = null;
    this.startedAt = Date.now();
    this.state = 'recording';
    this.needsInitialNudge = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
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
  }

  private addEvent(kind: RecorderEvent['kind'], detail?: string): void {
    this.events.push({ at: Date.now(), kind, detail });
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
          this.store(buf, now, 0, 'heartbeat');
        }
      } else {
        // Something repainted. That may be real output or just a clock digit;
        // the still-run is what tells those apart over time.
        this.stillSamples = 0;
        const png = this.decode(buf);
        if (png) {
          const ratio = this.sampledDiff(this.lastPng, png);
          this.lastHash = hash;
          this.lastPng = png;

          if (this.frames.length === 0) {
            this.store(buf, now, 0, 'first');
            this.lastChangeAt = now;
          } else if (ratio > this.opts.threshold) {
            this.store(buf, now, ratio, 'change');
            this.lastChangeAt = now;
          } else if (heartbeatDue) {
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
      lastChangeAt: this.lastChangeAt,
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
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - this.opts.retentionMinutes * 60000;
    while (this.frames.length > 0 && (this.frames.length > this.opts.maxFrames || this.frames[0].at < cutoff)) {
      const dropped = this.frames.shift()!;
      try {
        fs.unlinkSync(dropped.path);
      } catch {
        // already gone
      }
    }
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
      threshold: this.opts.threshold,
      heartbeatSeconds: this.opts.heartbeatSeconds,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      framesStored: this.frames.length,
      changeFrames: this.frames.filter((f) => f.reason === 'change').length,
      diskBytes: totalBytes,
      diskMB: Math.round((totalBytes / 1048576) * 10) / 10,
      oldestFrameAt: this.frames.length ? new Date(this.frames[0].at).toISOString() : null,
      newestFrameAt: this.frames.length ? new Date(this.frames[this.frames.length - 1].at).toISOString() : null,
      newChangesSinceLastView: this.newFramesSinceLastView(),
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
