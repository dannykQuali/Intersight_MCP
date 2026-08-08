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
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { LOCK_FILENAME, pidAlive, readLock } from '../recorder/recorderLock.js';
import { readRecorderState } from './recorderState.js';

/**
 * How an MCP server talks to console recorders.
 *
 * No MCP server owns a recorder. Each is a detached process holding one
 * server's console, and any MCP server may attach to it — so two agents can
 * record and watch the same machine, and an MCP restart (which happens on every
 * code reload, chat and fork) costs nothing.
 *
 * Discovery is by filesystem: the daemon publishes its control port in a lock
 * file beside its frames, exactly as Chromium publishes DevToolsActivePort. If
 * no live daemon exists, this spawns one and waits for it to come up.
 */
/**
 * Poll a daemon's status until its console stops being merely 'starting'.
 *
 * A daemon publishes its control port before the console exists, so the port
 * alone does not mean "recording". Timing out is deliberately not an error: a
 * slow console is still a console, and the caller gets the phase to say so.
 */
export async function waitUntilNotStarting(
  getStatus: () => Promise<{ phase?: string; lastError?: string } | null>,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<{ phase: string | null; lastError?: string; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 500;
  let phase: string | null = null;
  let lastError: string | undefined;
  for (;;) {
    try {
      const status = await getStatus();
      phase = status?.phase ?? null;
      lastError = status?.lastError;
      if (phase && phase !== 'starting') {
        return { phase, lastError, timedOut: false };
      }
    } catch {
      // Not answering yet is a reason to keep waiting, not to fail the caller.
    }
    if (Date.now() >= deadline) {
      return { phase, lastError, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Total time a spawn may take before the caller is told what state it is in.
 *
 * Measured live: lock + port ~1s, login and console launch ~8s. Generous enough
 * for a slow login, short enough that a tool call never looks hung.
 */
const STARTUP_BUDGET_MS = 150_000;

export class RecorderClient {
  private readonly root: string;
  /** Identifies THIS MCP server to a daemon's input arbiter. */
  private readonly clientId = `mcp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

  constructor(
    private readonly baseUrl = 'https://intersight.com/api/v1',
    /** Where recordings live. Overridable so tests never touch the real one. */
    root = path.join(os.homedir(), '.intersight-mcp', 'recordings')
  ) {
    this.root = root;
  }

  private dirFor(serverMoid: string): string {
    return path.join(this.root, serverMoid);
  }

  /** The live daemon's control port for a server, or null if none is running. */
  private livePort(serverMoid: string): number | null {
    const lock = readLock(this.dirFor(serverMoid));
    if (!lock || !lock.controlPort || !pidAlive(lock.pid)) {
      return null;
    }
    return lock.controlPort;
  }

  /** Is a recorder daemon currently running for this server? */
  isLive(serverMoid: string): boolean {
    return this.livePort(serverMoid) !== null;
  }

  /**
   * Every server with recorded data, live or not — the answer to "what is being
   * recorded", which used to be unanswerable across processes.
   */
  list(): Array<Record<string, unknown>> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const moid of entries) {
      const dir = this.dirFor(moid);
      try {
        if (!fs.statSync(dir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const lock = readLock(dir);
      const state = readRecorderState(dir);
      const live = !!lock && pidAlive(lock.pid);
      const dormant = fs.existsSync(path.join(dir, 'dormant.json'));
      out.push({
        serverMoid: moid,
        live,
        dormant: live && dormant,
        daemonPid: lock?.pid ?? null,
        controlPort: live ? lock?.controlPort ?? null : null,
        frames: state?.framesStored ?? null,
        newestFrameAt: state?.newestFrameAt ?? null,
        lastNoveltyAt: (state?.novelty as any)?.lastNoveltyAt ?? null,
        note: live
          ? dormant
            ? 'Daemon is alive but dormant: the console was released to stop holding the session slot. It resumes on demand.'
            : 'Live recorder daemon; attach to it for frames or input.'
          : 'No daemon running. Frames are historical; starting a recorder resumes live capture.',
      });
    }
    return out;
  }

  /** Ensure a daemon exists for this server, spawning one if needed. */
  async ensure(
    serverMoid: string,
    opts: { serverName?: string; objectType?: string; recording?: Record<string, unknown> } = {}
  ): Promise<{
    port: number;
    spawned: boolean;
    phase?: string | null;
    lastError?: string;
    stillStarting?: boolean;
  }> {
    const existing = this.livePort(serverMoid);
    if (existing !== null) {
      // A dormant daemon wakes rather than being replaced, so its frames and
      // history survive.
      await this.call(serverMoid, 'resume', {}).catch(() => undefined);
      return { port: existing, spawned: false };
    }
    // ONE budget for the whole startup, not one per step: a login and a console
    // launch take ~10s together, and two serial 120s waits would let a single
    // tool call block for four minutes.
    const deadline = Date.now() + STARTUP_BUDGET_MS;
    await this.spawnDaemon(serverMoid, opts);
    const port = await this.waitForPort(serverMoid, deadline - Date.now());
    // The port answers before the console does. Waiting for the phase to settle
    // is what makes "recording started" a true statement rather than a hopeful
    // one — and it lets a login failure be reported instead of discovered by the
    // caller's next keystroke being refused.
    const ready = await waitUntilNotStarting(() => this.callPort(port, serverMoid, 'status', {}), {
      timeoutMs: Math.max(1000, deadline - Date.now()),
    });
    return { port, spawned: true, phase: ready.phase, lastError: ready.lastError, stillStarting: ready.timedOut };
  }

  /**
   * Spawn the daemon DETACHED, so it survives this MCP server's exit.
   *
   * That is the whole design: a recorder must not die because a chat ended or
   * code reloaded. Its stdio goes to a log beside the frames, since a detached
   * process has nowhere else to speak.
   */
  private async spawnDaemon(
    serverMoid: string,
    opts: { serverName?: string; objectType?: string; recording?: Record<string, unknown> }
  ): Promise<void> {
    const dir = this.dirFor(serverMoid);
    fs.mkdirSync(dir, { recursive: true });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(here, '..', 'recorder', 'daemonMain.js');
    // Passed explicitly so the daemon never depends on inheriting our
    // environment: it authenticates with browser cookies and must not need the
    // MCP server's API-key configuration to start.
    const args = [entry, '--server', serverMoid, '--base-url', this.baseUrl];
    if (opts.serverName) {
      args.push('--name', opts.serverName);
    }
    if (opts.objectType) {
      args.push('--type', opts.objectType);
    }
    const rec = opts.recording ?? {};
    const pass: Array<[string, string]> = [
      ['retention-minutes', 'retentionMinutes'],
      ['interval-ms', 'intervalMs'],
      ['heartbeat-seconds', 'heartbeatSeconds'],
      ['max-frames', 'maxFrames'],
      ['anti-blank-seconds', 'antiBlankSeconds'],
      ['anti-blank-mode', 'antiBlankMode'],
    ];
    for (const [cli, key] of pass) {
      const v = (rec as any)[key];
      if (v !== undefined && v !== null) {
        args.push(`--${cli}`, String(v));
      }
    }
    if ((rec as any).ocrText === false) {
      args.push('--no-ocr');
    }
    const log = fs.openSync(path.join(dir, 'daemon.log'), 'a');
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
    child.unref();
  }

  private async waitForPort(serverMoid: string, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let lastLog = '';
    while (Date.now() < deadline) {
      const port = this.livePort(serverMoid);
      if (port !== null) {
        return port;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      lastLog = this.tailLog(serverMoid);
    }
    throw new Error(
      `Recorder daemon for ${serverMoid} did not come up within ${Math.round(timeoutMs / 1000)}s.` +
        (lastLog ? ` Last log lines:\n${lastLog}` : '')
    );
  }

  /** The daemon's own words, so a startup failure is diagnosable. */
  private tailLog(serverMoid: string, lines = 12): string {
    try {
      const all = fs.readFileSync(path.join(this.dirFor(serverMoid), 'daemon.log'), 'utf8').trim().split('\n');
      return all.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Perform an action on a server's recorder, spawning the daemon if needed.
   *
   * A 409 means another client holds the input lease or the daemon is busy with
   * a login/reset; that is surfaced verbatim rather than retried, because a
   * keystroke delivered late lands on a screen that has changed.
   */
  async request(
    serverMoid: string,
    action: string,
    payload: Record<string, unknown> = {},
    opts: { serverName?: string; objectType?: string; recording?: Record<string, unknown> } = {}
  ): Promise<any> {
    const { port } = await this.ensure(serverMoid, opts);
    return this.callPort(port, serverMoid, action, payload);
  }

  /**
   * Read recorded history WITHOUT starting anything.
   *
   * Reads must never spawn a daemon. Spawning logs in, opens a vKVM session and
   * takes the server's only session slot — real side effects on a physical
   * machine, from a question about the past. It was also destructive until
   * recorders learned to adopt existing frames: searching last night's campaign
   * spawned a recorder whose first act was to delete the frames being searched.
   */
  async read(serverMoid: string, action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const port = this.livePort(serverMoid);
    if (port !== null) {
      return this.callPort(port, serverMoid, action, payload);
    }
    const dir = this.dirFor(serverMoid);
    const frames = this.countFrames(dir);
    if (frames === 0) {
      throw new Error(
        `No recorder for ${serverMoid} and no recorded frames on disk. Start one with vkvm_record_start.`
      );
    }
    throw new Error(
      `No recorder daemon is running for ${serverMoid}, so its history cannot be searched or rendered here. ` +
        `${frames} frame(s) are on disk at ${dir} and can be opened directly. ` +
        `To query them with the vkvm_* tools, call vkvm_record_start — it attaches to these frames rather than discarding them, ` +
        `but it also opens a vKVM console on the server, which is why a read will not do it for you.`
    );
  }

  /**
   * Forget a registration that points at nothing — but only if it still names the
   * port we just failed on, so a daemon that has since restarted keeps its lock.
   */
  private clearStaleLock(serverMoid: string, port: number): void {
    const dir = this.dirFor(serverMoid);
    const lock = readLock(dir);
    if (lock && lock.controlPort === port) {
      try {
        fs.unlinkSync(path.join(dir, LOCK_FILENAME));
      } catch {
        /* already gone, which is the desired state anyway */
      }
    }
  }

  private countFrames(dir: string): number {
    try {
      return fs.readdirSync(dir).filter((f) => /^f-\d+\.png$/.test(f)).length;
    } catch {
      return 0;
    }
  }

  /** Call a daemon we already know is live; no spawn, no resume. */
  async call(serverMoid: string, action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const port = this.livePort(serverMoid);
    if (port === null) {
      throw new Error(`No live recorder daemon for ${serverMoid}.`);
    }
    return this.callPort(port, serverMoid, action, payload);
  }

  private async callPort(port: number, serverMoid: string, action: string, payload: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, clientId: this.clientId }),
      });
    } catch (error) {
      // Nothing is listening, so the lock is lying. Liveness is decided from the
      // holder's pid, and once the OS reuses that pid the lock looks live
      // forever — every call routed to a dead port, that server unrecordable,
      // and retrying re-reading the same lock. A merely BUSY daemon still answers
      // (its control server is async), so a refused connection is good evidence
      // the holder is gone. Clearing the lock is what makes a retry work.
      this.clearStaleLock(serverMoid, port);
      throw new Error(
        `Recorder daemon for ${serverMoid} is not answering on port ${port} (${(error as Error).message}). ` +
          `Its stale registration has been cleared; retry to have a fresh one spawned.`
      );
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status === 409) {
      throw new Error(
        `${body.error ?? 'the console is unavailable right now'}` +
          (body.retryAfterMs ? ` Retry in about ${Math.ceil(body.retryAfterMs / 1000)}s.` : '')
      );
    }
    if (!res.ok || body.ok === false) {
      throw new Error(body.error ?? `recorder action "${action}" failed with ${res.status}`);
    }
    return body.result;
  }
}
