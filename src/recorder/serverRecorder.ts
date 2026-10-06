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

import fs from 'fs';
import path from 'path';
import type { BrowserService } from '../services/browserService.js';
import { RecorderOptions } from '../services/vkvmRecorder.js';
import type { ControlScope } from './controlServer.js';
import { InputArbiter } from './inputLease.js';
import { classifySession } from './sessionOwnership.js';
import { estimateTypingMs, PASTE_CHAR_DELAY_MS } from '../utils/pacedTyping.js';
import {
  decideLifetime,
  shouldGiveUpDegraded,
  DATA_EXPIRY_MS,
  DORMANCY_AFTER_MS,
} from './lifetimePolicy.js';

/**
 * The recorder for ONE server's console, living inside the account daemon.
 *
 * The daemon owns the browser and the login; this owns everything about one
 * console: getting it open, repairing its session, recording it, arbitrating
 * input to it, and letting it go when nobody wants it.
 *
 * It is the SINGLE AUTHORITY for its server, and that is what makes session
 * repair safe. Previously two parties could act on one server: killing a stale
 * session made someone else's recorder relaunch and then escalate to a
 * ~90-second Tunneled vKVM reset (observed live). The daemon keeps at most one
 * recorder per server, so there is nobody left to fight.
 *
 * Everything a client needs to READ is on the filesystem (frames, state.json,
 * text.jsonl), so readers need no protocol and work even while it is busy.
 */
/** Born-dead launches before escalating to a Tunneled vKVM reset. */
const BORN_DEAD_BEFORE_RESET = 2;
/** Resets are capped: if two did not help, the problem is not the tunnel. */
const MAX_TUNNELED_RESETS = 2;
/**
 * How recently another client must have called for a stop to be refused.
 *
 * Long enough to cover an agent thinking between steps, short enough that a peer
 * that has moved on does not block cleanup forever.
 */
const RECENT_USE_MS = 5 * 60 * 1000;

export interface ServerRecorderOptions {
  serverMoid: string;
  serverName?: string;
  objectType?: string;
  recording?: RecorderOptions;
  /** Total disk allowed across this server's frames before dormant data is dropped. */
  diskBudgetBytes?: number;
}

export interface ServerRecorderHooks {
  /** Called once teardown is complete, so the daemon can forget this recorder. */
  onStopped: (serverMoid: string, reason: string) => void;
  /** Where the daemon itself can be reached, for status reports. */
  daemonInfo: () => { pid: number; port: number | null };
}

export type RecorderPhase = 'starting' | 'active' | 'dormant' | 'degraded' | 'stopped';

export class ServerRecorder {
  private readonly arbiter = new InputArbiter();
  /** A recorder is created because somebody wants it, which is contact in itself. */
  private lastClientContactAt: number | null = Date.now();
  private readonly lastContactByClient = new Map<string, number>();
  private explicitKeepAliveUntil: number | null = null;
  private phase: RecorderPhase = 'starting';
  private lastError: string | null = null;
  private degradedSince: number | null = null;
  private degradedAttempts = 0;
  private nextConsoleAttemptAt = 0;
  private stopping = false;
  /** A tick can take a minute (a retry logs in and launches); ticks must not overlap. */
  private ticking = false;
  /** Consecutive launches that came back already-ended, for reset escalation. */
  private bornDeadLaunches = 0;
  private tunneledResets = 0;
  private readonly controlScope: ControlScope;

  constructor(
    private readonly opts: ServerRecorderOptions,
    private readonly browser: BrowserService,
    private readonly dir: string,
    private readonly hooks: ServerRecorderHooks
  ) {
    const moid = opts.serverMoid;
    this.controlScope = {
      arbiter: this.arbiter,
      readActions: {
        status: async () => this.status(),
        keepAlive: async (p) => this.keepAlive(Number(p?.hours ?? 12)),
        // Reads of recorded frames are served here so a client never has to
        // know the on-disk layout, but they never need the input lease.
        recent: async (p) => this.browser.getRecentFrames(moid, p?.count, p?.scale, p?.changesOnly),
        timeline: async (p) => this.browser.getTimeline(moid, p?.minutesAgo, p?.minChangeRatio),
        framesAt: async (p) => this.browser.getFramesAt(moid, p ?? {}),
        findText: async (p) => this.browser.findTextInFrames(moid, p ?? {}),
        exportFrames: async (p) => this.browser.exportFrames({ ...p, serverMoid: moid }),
        screenshot: async (p) => this.browser.screenshot({ ...p, serverMoid: moid }),
        // A dormant recorder wakes on demand rather than being kept alive.
        resume: async () => {
          await this.resume();
          return this.status();
        },
        // Stopping is NOT console input, so it must never queue behind the input
        // lease: one failed keystroke held the lease for 30s and made every stop
        // in that window fail with 409 — including a forced one — leaving a
        // recorder nobody could kill. Peer etiquette is enforced inside instead.
        stop: async (p) => this.stopRequested(p ?? {}),
      },
      inputActions: {
        sendKeys: async (p) => this.requireConsole().browser.sendKeys({ ...p, serverMoid: moid }),
        // Typing a whole line takes seconds at a safe cadence, and a verify pass
        // adds a screenshot plus OCR — so the lease is held with an ETA rather
        // than leaving a peer to guess why input is refused.
        pasteText: async (p) => {
          const text = String(p?.text ?? '');
          this.arbiter.setBusy(
            `typing ${text.length} character(s) into the console and reading them back`,
            estimateTypingMs(text, Number(p?.charDelayMs) || PASTE_CHAR_DELAY_MS) * 2 + 5000
          );
          try {
            return await this.requireConsole().browser.pasteText({ ...p, text, serverMoid: moid });
          } finally {
            this.arbiter.clearBusy();
          }
        },
        mouse: async (p) => this.requireConsole().browser.mouse({ ...p, serverMoid: moid }),
        pressUntil: async (p) => this.requireConsole().browser.pressUntil({ ...p, serverMoid: moid }),
        wait: async (p) => this.requireConsole().browser.waitForFrame({ ...p, serverMoid: moid }),
        watch: async (p) => this.requireConsole().browser.watch({ ...p, serverMoid: moid }),
        // Rebuild the console from scratch: the remedy when a live console
        // stops accepting input. Session repair happens inside, so the caller
        // never has to reason about orphaned sessions.
        relaunch: async () => {
          this.arbiter.setBusy('rebuilding the vKVM console', 120_000);
          try {
            this.browser.stopRecording(moid);
            await this.browser.closeKvm(moid).catch(() => {});
          } finally {
            this.arbiter.clearBusy();
          }
          try {
            await this.establishConsole();
            this.markActive();
          } catch (error) {
            // The console was just torn down, so a failed rebuild leaves nothing
            // running. Saying 'active' here would be a lie the caller acts on.
            this.markDegraded(error);
            throw error;
          }
          return this.status();
        },
      },
    };
  }

  /** The actions a client may call on this server, with this server's own lease. */
  scope(): ControlScope {
    return this.controlScope;
  }

  currentPhase(): RecorderPhase {
    return this.phase;
  }

  /**
   * Note that a client used this recorder. Per-client, so it can tell "nobody
   * wants me" from "someone else is depending on me right now". Old entries are
   * dropped: every MCP restart mints a new client id, and only recent ones can
   * veto a stop.
   */
  touch(clientId: string): void {
    const now = Date.now();
    this.lastClientContactAt = now;
    this.lastContactByClient.set(clientId, now);
    for (const [id, at] of this.lastContactByClient) {
      if (now - at > RECENT_USE_MS) {
        this.lastContactByClient.delete(id);
      }
    }
  }

  /**
   * Somebody wants this console, so it must not go dormant yet — without naming
   * them as a user of it. Asking for a recorder is not driving its console, and
   * only clients driving it may veto another's stop.
   */
  noteInterest(): void {
    this.lastClientContactAt = Date.now();
  }

  /**
   * Start getting a console, in the background.
   *
   * A failure to establish it must NOT end the recorder. It stays, reports why in
   * its status, and retries on the lifecycle tick — a console waiting on a human
   * login is a recoverable state. Callers poll the phase to learn the outcome.
   */
  begin(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    void this.establishConsole().then(
      () => this.markActive(),
      (error) => this.markDegraded(error)
    );
  }

  /**
   * Run `fn` with this console marked busy, so input is refused with a reason
   * rather than landing on a console being rebuilt underneath it.
   */
  async withBusy<T>(what: string, ms: number, fn: () => Promise<T>): Promise<T> {
    this.arbiter.setBusy(what, ms);
    try {
      return await fn();
    } finally {
      this.arbiter.clearBusy();
    }
  }

  /**
   * Log in, clear anything blocking the server's single session slot, and get a
   * live console recording.
   *
   * Login and repair are marked BUSY so a client's input is refused with a
   * reason rather than being delivered into a half-built console — or, worse,
   * buffered and arriving 90 seconds later on a screen that has changed.
   */
  private async establishConsole(): Promise<void> {
    await this.withBusy('logging in to Intersight', 60_000, async () => {
      const login = await this.browser.ensureLoggedIn();
      if (!login?.loggedIn) {
        throw new Error(`could not establish an Intersight session: ${login?.reason ?? login?.error ?? 'unknown'}`);
      }
    });

    await this.clearBlockingSessions();

    const launch = await this.withBusy('opening the vKVM console', 90_000, () =>
      this.browser.launchVkvm(
        {
          moid: this.opts.serverMoid,
          objectType: this.opts.objectType ?? 'compute.RackUnit',
          name: this.opts.serverName,
        },
        { recording: this.opts.recording }
      )
    );
    await this.verifyConsole(launch);
    // Whatever this directory claimed before, there is a live console now.
    this.clearDormantMarker();
  }

  /**
   * Refuse to call a console "live" unless it really is, and unless something is
   * recording it.
   *
   * launchVkvm reports these failures in its RESULT rather than by throwing, so
   * a recorder that only caught exceptions reported phase 'active' while sitting
   * on a Forbidden page or an already-ended session — an agent would then watch
   * for frames that were never coming. Two of these leave no capture behind at
   * all (autorecord is skipped for a dead console, and a REUSED tab only keeps
   * the capture that tab already had), so capture is asserted explicitly rather
   * than assumed.
   */
  private async verifyConsole(launch: any): Promise<void> {
    if (launch?.accessDenied) {
      throw new Error(
        `the vKVM page returned an authorization error for this server. ${launch.hint ?? ''}`.trim()
      );
    }
    if (launch?.sessionEnded) {
      this.bornDeadLaunches += 1;
      // The same escalation the capture uses for a console that dies right
      // after mounting — reached here because a console that never mounts has
      // no capture to escalate on its behalf.
      if (this.bornDeadLaunches >= BORN_DEAD_BEFORE_RESET && this.tunneledResets < MAX_TUNNELED_RESETS) {
        this.tunneledResets += 1;
        this.log(
          `console was born dead ${this.bornDeadLaunches}x; resetting Tunneled vKVM (${this.tunneledResets}/${MAX_TUNNELED_RESETS})`
        );
        await this.withBusy('resetting Tunneled vKVM on the server', 120_000, () =>
          this.browser.resetTunneledVkvmViaSession(this.opts.serverMoid)
        ).catch((error) => this.log(`Tunneled vKVM reset failed: ${(error as Error).message}`));
      }
      throw new Error(
        `the vKVM session ended immediately after opening. ${launch.hint ?? ''}`.trim()
      );
    }
    this.bornDeadLaunches = 0;

    // Autorecord can be off by environment, and a reused tab carries only the
    // capture it already had, so ask for capture explicitly. startRecording is
    // idempotent: an already-running capture keeps its frames.
    const rec = this.browser.startRecording(this.opts.serverMoid, this.opts.recording);
    if (rec && rec.recording === false) {
      throw new Error(`the console opened but nothing is recording it: ${rec.reason ?? 'unknown reason'}`);
    }
  }

  /**
   * End any Active vKVM session on our server that is holding its only slot for
   * nobody, and leave every other session strictly alone.
   *
   * This is the operation that used to be impossible to do safely. It is safe
   * here only because this recorder is the single authority for the server, so
   * ending an orphan cannot start a fight with another recorder.
   */
  private async clearBlockingSessions(): Promise<void> {
    const sessions = await this.browser.activeKvmSessions(this.opts.serverMoid).catch(() => []);
    if (sessions.length === 0) {
      return;
    }
    const identity = await this.browser.currentSessionIdentity().catch(() => null);
    const adoptable = this.browser.hasOpenConsoleTab(this.opts.serverMoid);
    const now = Date.now();

    for (const s of sessions) {
      const verdict = classifySession({
        sessionMoid: s.moid,
        iamSessionMoid: s.iamSessionMoid,
        userIdOrEmail: s.userIdOrEmail,
        ourIamSessionMoid: identity?.iamSessionMoid ?? null,
        ourUserIdOrEmail: identity?.userIdOrEmail ?? null,
        hasAdoptableTab: adoptable,
        // The daemon keeps one recorder per server and this is it, so a live
        // recorder elsewhere is impossible by construction.
        liveRecorderElsewhere: false,
        weAreTheAuthority: true,
        createdAt: s.createdAt,
        now,
      });
      if (!verdict.mayEnd) {
        this.log(`leaving session ${s.moid} alone: ${verdict.reason}`);
        continue;
      }
      try {
        await this.withBusy('ending an orphaned vKVM session', 30_000, () => this.browser.endKvmSession(s.moid));
        this.log(`ended orphaned session ${s.moid}: ${verdict.reason}`);
      } catch (error) {
        this.log(`could not end session ${s.moid}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Keep trying to get eyes on the console, then give up rather than loop.
   *
   * A login that was impossible a minute ago (no browser session, a human
   * mid-MFA) may be possible now, so retrying is right. Retrying FOREVER is not:
   * every attempt may be a Cisco ID login, and that path locks the account after
   * three failures. Once nobody is asking any more, the recorder stops — the next
   * client to want this console starts a fresh one.
   */
  private async retryDegradedConsole(): Promise<boolean> {
    const now = Date.now();
    const verdict = shouldGiveUpDegraded({
      now,
      degradedSince: this.degradedSince,
      lastClientContactAt: this.lastClientContactAt,
      attempts: this.degradedAttempts,
    });
    if (verdict.giveUp) {
      this.log(`giving up: ${verdict.reason}`);
      // The frames are kept: a client may still want to see how far the console
      // got before it broke.
      await this.shutdown(`no console: ${verdict.reason}`);
      return false;
    }
    if (now < this.nextConsoleAttemptAt) {
      return false;
    }
    try {
      await this.establishConsole();
      this.markActive();
      this.log('console established on retry');
      return true;
    } catch (error) {
      this.markDegraded(error);
      return false;
    }
  }

  private markActive(): void {
    if (this.stopping) {
      return;
    }
    this.phase = 'active';
    this.lastError = null;
    this.degradedSince = null;
    this.degradedAttempts = 0;
    this.nextConsoleAttemptAt = 0;
  }

  private markDegraded(error: unknown): void {
    if (this.stopping) {
      return;
    }
    this.lastError = (error as Error)?.message?.slice(0, 300) ?? String(error);
    this.phase = 'degraded';
    this.degradedAttempts += 1;
    this.degradedSince ??= Date.now();
    const { retryAfterMs } = shouldGiveUpDegraded({
      now: Date.now(),
      degradedSince: this.degradedSince,
      lastClientContactAt: this.lastClientContactAt,
      attempts: this.degradedAttempts,
    });
    this.nextConsoleAttemptAt = Date.now() + retryAfterMs;
    this.log(
      `console not established (attempt ${this.degradedAttempts}): ${this.lastError} — retrying in ${Math.round(
        retryAfterMs / 1000
      )}s`
    );
  }

  /** Evaluate dormancy/expiry, and keep the console healthy while active. */
  async lifecycleTick(): Promise<void> {
    if (this.stopping || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.phase === 'degraded' && !(await this.retryDegradedConsole())) {
      return;
    }
    if (this.phase === 'starting') {
      return; // the first attempt is still running; judge it when it lands
    }

    const rec = this.browser.recordingStatus(this.opts.serverMoid);
    const powered = await this.browser.isServerPoweredOn(this.opts.serverMoid).catch(() => true);
    const decision = decideLifetime({
      now: Date.now(),
      lastClientContactAt: this.lastClientContactAt,
      oldestFrameAt: toMs(rec?.oldestFrameAt),
      newestFrameAt: toMs(rec?.newestFrameAt),
      lastNoveltyAt: toMs(rec?.novelty?.lastNoveltyAt),
      serverPoweredOn: powered,
      explicitKeepAliveUntil: this.explicitKeepAliveUntil,
      diskBytes: Number(rec?.diskBytes ?? 0),
      diskBudgetBytes: this.opts.diskBudgetBytes ?? 2_000_000_000,
    });

    if (decision.deleteData) {
      this.log(`expiring recorded data: ${decision.reason}`);
      await this.shutdown(`data expired: ${decision.reason}`, { deleteData: true });
      return;
    }
    if (decision.releaseConsole && this.phase !== 'dormant') {
      // Dormancy releases the CONSOLE but keeps every frame: an idle recorder
      // otherwise holds the server's only session slot and pokes it with an
      // anti-blank nudge every few minutes, indefinitely.
      this.log(`going dormant: ${decision.reason}`);
      this.phase = 'dormant';
      await this.releaseConsole();
      // Only actual dormancy publishes the marker. Teardown shares this release
      // path, and a marker left by a clean shutdown made the NEXT recorder look
      // dormant while it was recording happily.
      this.writeDormantMarker();
    }
  }

  /** Stop capturing and hand the console back, without losing the frames. */
  private async releaseConsole(): Promise<void> {
    this.browser.stopRecording(this.opts.serverMoid);
    const sessions = await this.browser.activeKvmSessions(this.opts.serverMoid).catch(() => []);
    await this.browser.closeKvm(this.opts.serverMoid).catch(() => {});
    for (const s of sessions) {
      await this.browser.endKvmSession(s.moid).catch(() => {});
    }
  }

  /** Wake a dormant recorder because a client wants live capture again. */
  async resume(): Promise<void> {
    if (this.phase === 'degraded') {
      // A client asking now is the best moment to try again, whatever the
      // backoff said: they may have just fixed what was broken.
      this.nextConsoleAttemptAt = 0;
      await this.retryDegradedConsole();
      return;
    }
    if (this.phase !== 'dormant') {
      return;
    }
    this.log("resuming from dormancy at a client's request");
    try {
      await this.establishConsole();
      this.markActive();
    } catch (error) {
      // A wake that fails must leave the recorder degraded-and-retrying rather
      // than dormant, or nothing will ever try again.
      this.markDegraded(error);
      throw error;
    }
  }

  /**
   * Refuse console actions with the real reason instead of a browser-level
   * "no page" error, which tells a caller nothing about what to do next.
   */
  private requireConsole(): this {
    if (this.phase === 'degraded') {
      throw new Error(
        `this recorder has no live console: ${this.lastError ?? 'unknown reason'}. ` +
          `It is still retrying; check vkvm_record_status, and relaunch once the cause is cleared.`
      );
    }
    return this;
  }

  /**
   * Stop this recorder — unless another agent is in the middle of using it.
   *
   * Nobody owns a recorder, which cuts both ways: it also means nobody gets to
   * unilaterally destroy one. Stopping ends the vKVM session and closes the tab,
   * so doing it under a peer mid-installation causes exactly the outage this
   * architecture was built to end. An unused recorder needs no stopping anyway —
   * it goes dormant on its own and releases the console.
   */
  private stopRequested(p: Record<string, unknown>): { stopping: boolean; reason: string } {
    const asker = String(p.clientId ?? 'unknown-client');
    if (!p.force) {
      const now = Date.now();
      const busiest = [...this.lastContactByClient]
        .filter(([id, at]) => id !== asker && now - at < RECENT_USE_MS)
        .sort((a, b) => b[1] - a[1])[0];
      if (busiest) {
        throw new Error(
          `another client (${busiest[0]}) used this console ${Math.round((now - busiest[1]) / 1000)}s ago; ` +
            `stopping it would take their console away mid-run. Pass force:true to stop it anyway, or just leave it — ` +
            `an unused recorder releases the console on its own after ${Math.round(DORMANCY_AFTER_MS / 3600_000)}h.`
        );
      }
    }
    // Answer before tearing down, so the caller does not see a dropped request.
    const reason = p.force ? `client ${asker} forced a stop` : `client ${asker} asked this recorder to stop`;
    setTimeout(() => void this.shutdown(reason), 50);
    return { stopping: true, reason };
  }

  private keepAlive(hours: number): { keepAliveUntil: string } {
    const capped = Math.min(Math.max(hours, 0), 72);
    this.explicitKeepAliveUntil = Date.now() + capped * 3600_000;
    return { keepAliveUntil: new Date(this.explicitKeepAliveUntil).toISOString() };
  }

  status(): any {
    const rec = this.browser.recordingStatus(this.opts.serverMoid);
    const daemon = this.hooks.daemonInfo();
    return {
      serverMoid: this.opts.serverMoid,
      serverName: this.opts.serverName ?? null,
      daemonPid: daemon.pid,
      phase: this.phase,
      controlPort: daemon.port,
      lastClientContactAt: this.lastClientContactAt ? new Date(this.lastClientContactAt).toISOString() : null,
      dormantAfterHours: Math.round(DORMANCY_AFTER_MS / 3600_000),
      dataExpiresAfterHours: Math.round(DATA_EXPIRY_MS / 3600_000),
      keepAliveUntil: this.explicitKeepAliveUntil ? new Date(this.explicitKeepAliveUntil).toISOString() : null,
      inputLeaseHeldBy: this.arbiter.holder(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.degradedSince
        ? {
            degradedSince: new Date(this.degradedSince).toISOString(),
            consoleAttempts: this.degradedAttempts,
            nextConsoleAttemptAt: new Date(this.nextConsoleAttemptAt).toISOString(),
          }
        : {}),
      busy: this.arbiter.busy(),
      recording: rec,
    };
  }

  private writeDormantMarker(): void {
    // Recorded beside the frames so a client sees "dormant, resumable" rather
    // than a recorder that merely went quiet.
    try {
      const file = path.join(this.dir, 'dormant.json');
      fs.writeFileSync(
        file,
        JSON.stringify({ dormantSince: new Date().toISOString(), pid: process.pid, resumable: true }, null, 2)
      );
    } catch {
      /* observability only */
    }
  }

  private clearDormantMarker(): void {
    try {
      fs.unlinkSync(path.join(this.dir, 'dormant.json'));
    } catch {
      /* not dormant, which is the desired state */
    }
  }

  /**
   * Release this server's console and forget it. Never touches the browser: it
   * belongs to the daemon and every other recorder is using it.
   */
  async shutdown(reason: string, opts: { deleteData?: boolean } = {}): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.log(`stopping: ${reason}`);
    await this.releaseConsole().catch(() => {});
    if (opts.deleteData) {
      try {
        fs.rmSync(this.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    } else {
      // A stopped recorder is gone, not resting; leaving the marker would offer
      // the next client something to resume that does not exist.
      this.clearDormantMarker();
    }
    this.phase = 'stopped';
    this.hooks.onStopped(this.opts.serverMoid, reason);
  }

  /**
   * Timestamped, because the daemon log is the only account of an overnight
   * run: a line reading "went dormant" is useless without knowing when.
   */
  private log(message: string): void {
    console.error(`${new Date().toISOString()} [recorder ${this.opts.serverMoid}] ${message}`);
  }
}

function toMs(iso: unknown): number | null {
  if (typeof iso !== 'string') {
    return null;
  }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
