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
import {
  DAEMON_PROTOCOL,
  DaemonHello,
  daemonPort,
  foreignPortMessage,
  probeDaemon,
} from '../recorder/daemonProtocol.js';
import { readRecorderState } from './recorderState.js';

/**
 * How an MCP server talks to the account daemon.
 *
 * No MCP server owns a console, a browser or a login. One detached daemon per
 * account holds all three, and any MCP server may use it — so two agents can
 * record and watch the same machine, and an MCP restart (which happens on every
 * code reload, chat and fork) costs nothing.
 *
 * Discovery is by the daemon's fixed loopback port: say hello, and if nothing is
 * listening, spawn the daemon and say hello again. That is the whole protocol.
 * In particular the client never deletes anything: the per-server lock files
 * this replaced were "cleared" by clients that could not reach a daemon that was
 * in fact alive, and the next client spawned a rival for the same server.
 */
/**
 * Poll a recorder's status until its console stops being merely 'starting'.
 *
 * A recorder answers before its console exists, so its existence alone does not
 * mean "recording". Timing out is deliberately not an error: a slow console is
 * still a console, and the caller gets the phase to say so.
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
 * Total time a new console may take before the caller is told what state it is
 * in. Measured live: login and console launch ~8s. Generous enough for a slow
 * login, short enough that a tool call never looks hung.
 */
const STARTUP_BUDGET_MS = 150_000;

/** How long a freshly spawned daemon may take to answer its first hello. */
const SPAWN_BUDGET_MS = 20_000;

/** Rotate the daemon log at spawn time once it passes this, keeping one old copy. */
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;

export interface RecorderClientOptions {
  /** The daemon's port. Defaults to INTERSIGHT_DAEMON_PORT or the built-in default. */
  port?: number;
  /** How to start a daemon when none answers. Injectable so tests never spawn processes. */
  spawnDaemon?: () => void;
  /** How long to wait for a hello before calling the holder of the port unresponsive. */
  helloTimeoutMs?: number;
}

/** A daemon that is running but has no recorder for the server asked about. */
class NoRecorderError extends Error {}

export class RecorderClient {
  private readonly root: string;
  private readonly port: number;
  private readonly spawnDaemon: () => void;
  private readonly helloTimeoutMs: number;
  /** One spawn at a time from this process; concurrent callers share it. */
  private spawning: Promise<number> | null = null;
  /** Identifies THIS MCP server to a recorder's input arbiter. */
  private readonly clientId = `mcp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

  constructor(
    private readonly baseUrl = 'https://intersight.com/api/v1',
    /** Where recordings live. Overridable so tests never touch the real one. */
    root = path.join(os.homedir(), '.intersight-mcp', 'recordings'),
    opts: RecorderClientOptions = {}
  ) {
    this.root = root;
    this.port = opts.port ?? daemonPort();
    this.spawnDaemon = opts.spawnDaemon ?? (() => this.spawnDetachedDaemon());
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  }

  private dirFor(serverMoid: string): string {
    return path.join(this.root, serverMoid);
  }

  /** The daemon's log: one file for the whole account, beside the recordings. */
  private logPath(): string {
    return path.join(this.root, '..', 'daemon.log');
  }

  /**
   * The daemon's port if our daemon is answering on it; null if nothing is
   * listening and `spawnIfAbsent` is false. Anything else holding the port is
   * an error to report, never a reason to start a rival.
   */
  private async daemon(spawnIfAbsent: boolean): Promise<number | null> {
    const probe = await probeDaemon(this.port, this.helloTimeoutMs);
    if (probe.state === 'ours') {
      return this.compatible(probe.hello);
    }
    if (probe.state === 'foreign') {
      throw new Error(foreignPortMessage(this.port, probe.detail));
    }
    if (probe.state === 'unresponsive') {
      throw new Error(
        `The Intersight MCP daemon on 127.0.0.1:${this.port} is not answering (${probe.detail}). ` +
          'Something holds its port, so a new daemon could not start either. ' +
          `If it stays like this, stop the process listening on port ${this.port}; see ${this.logPath()}.`
      );
    }
    if (!spawnIfAbsent) {
      return null;
    }
    this.spawning ??= this.spawnAndWait().finally(() => {
      this.spawning = null;
    });
    return this.spawning;
  }

  /**
   * A daemon keeps running the code it started with, across rebuilds. One that
   * speaks a different protocol is reported with the way out, rather than sent
   * requests it would misread.
   */
  private compatible(hello: DaemonHello): number {
    if (hello.protocol !== DAEMON_PROTOCOL) {
      throw new Error(
        `The Intersight MCP daemon on port ${this.port} (pid ${hello.pid}, started ${hello.startedAt}) speaks protocol ` +
          `${hello.protocol}, but this MCP server speaks ${DAEMON_PROTOCOL}: one of them is from an older build. ` +
          `Restart this MCP server, or stop the daemon (pid ${hello.pid}) so a current one starts — stopping it ends the consoles it records.`
      );
    }
    return this.port;
  }

  /**
   * Start a daemon and wait for its hello. Two MCP servers doing this at once is
   * fine: only one daemon can bind the port, the other exits, and both clients
   * end up talking to the winner.
   */
  private async spawnAndWait(): Promise<number> {
    this.spawnDaemon();
    const deadline = Date.now() + SPAWN_BUDGET_MS;
    while (Date.now() < deadline) {
      const probe = await probeDaemon(this.port, this.helloTimeoutMs);
      if (probe.state === 'ours') {
        return this.compatible(probe.hello);
      }
      if (probe.state === 'foreign') {
        throw new Error(foreignPortMessage(this.port, probe.detail));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const tail = this.tailLog();
    throw new Error(
      `The Intersight MCP daemon did not come up on port ${this.port} within ${Math.round(SPAWN_BUDGET_MS / 1000)}s.` +
        (tail ? ` Last log lines:\n${tail}` : '')
    );
  }

  /**
   * Spawn the daemon DETACHED, so it survives this MCP server's exit.
   *
   * That is the whole design: a console must not die because a chat ended or
   * code reloaded. Its stdio goes to the daemon log, since a detached process
   * has nowhere else to speak.
   */
  private spawnDetachedDaemon(): void {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(here, '..', 'recorder', 'daemonMain.js');
    // Passed explicitly so the daemon never depends on inheriting our
    // configuration: it authenticates with browser cookies and must not need the
    // MCP server's API-key settings to start. The environment still flows
    // through, for the SSO credentials file and friends.
    const args = [entry, '--port', String(this.port), '--base-url', this.baseUrl];
    const logFile = this.logPath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.rotateLog(logFile);
    const log = fs.openSync(logFile, 'a');
    try {
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }

  private rotateLog(logFile: string): void {
    try {
      if (fs.statSync(logFile).size > LOG_ROTATE_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      /* no log yet, or a running daemon has it open — rotate next time */
    }
  }

  /** The daemon's own words, so a startup failure is diagnosable. */
  private tailLog(lines = 12): string {
    try {
      const all = fs.readFileSync(this.logPath(), 'utf8').trim().split('\n');
      return all.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  /** Is a recorder currently running for this server? Never starts anything. */
  async isLive(serverMoid: string): Promise<boolean> {
    const status = await this.daemonStatus();
    return !!status?.recorders?.some((r: any) => r.serverMoid === serverMoid);
  }

  private async daemonStatus(): Promise<any | null> {
    const port = await this.daemon(false).catch(() => null);
    if (port === null) {
      return null;
    }
    return this.post(port, 'status', {}).catch(() => null);
  }

  /**
   * Every server with a recorder or recorded data — the answer to "what is being
   * recorded". Never starts anything.
   */
  async list(): Promise<Array<Record<string, unknown>>> {
    const daemon = await this.daemonStatus();
    const live = new Map<string, string>(
      (daemon?.recorders ?? []).map((r: any) => [String(r.serverMoid), String(r.phase)])
    );
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.root).filter((moid) => {
        try {
          return fs.statSync(this.dirFor(moid)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      entries = [];
    }
    const moids = [...new Set([...entries, ...live.keys()])].sort();
    return moids.map((moid) => {
      const state = readRecorderState(this.dirFor(moid));
      const phase = live.get(moid) ?? null;
      const isLive = phase !== null;
      const dormant = phase === 'dormant';
      return {
        serverMoid: moid,
        live: isLive,
        dormant,
        phase,
        daemonPid: isLive ? daemon?.pid ?? null : null,
        controlPort: isLive ? daemon?.port ?? null : null,
        frames: state?.framesStored ?? null,
        newestFrameAt: state?.newestFrameAt ?? null,
        lastNoveltyAt: (state?.novelty as any)?.lastNoveltyAt ?? null,
        note: isLive
          ? dormant
            ? 'Recorder is dormant: the console was released to stop holding the session slot. It resumes on demand.'
            : 'Live recorder in the account daemon; attach to it for frames or input.'
          : 'No recorder running. Frames are historical; starting a recorder resumes live capture.',
      };
    });
  }

  /** Ensure a recorder exists for this server, starting the daemon if needed. */
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
    const deadline = Date.now() + STARTUP_BUDGET_MS;
    const port = (await this.daemon(true))!;
    const r = await this.post(port, 'ensureRecorder', {
      serverMoid,
      serverName: opts.serverName,
      objectType: opts.objectType,
      recording: opts.recording,
    });
    if (r.phase !== 'starting') {
      return { port, spawned: !!r.created, phase: r.phase };
    }
    // The recorder answers before its console does. Waiting for the phase to
    // settle is what makes "recording started" a true statement rather than a
    // hopeful one — and it lets a login failure be reported instead of
    // discovered by the caller's next keystroke being refused.
    const ready = await waitUntilNotStarting(() => this.post(port, this.serverRoute(serverMoid, 'status'), {}), {
      timeoutMs: Math.max(1000, deadline - Date.now()),
    });
    return {
      port,
      spawned: !!r.created,
      phase: ready.phase,
      lastError: ready.lastError,
      stillStarting: ready.timedOut,
    };
  }

  /**
   * Perform an action on a server's recorder, starting one if needed.
   *
   * A 409 means another client holds the input lease or the recorder is busy
   * with a login/reset; that is surfaced verbatim rather than retried, because a
   * keystroke delivered late lands on a screen that has changed.
   */
  async request(
    serverMoid: string,
    action: string,
    payload: Record<string, unknown> = {},
    opts: { serverName?: string; objectType?: string; recording?: Record<string, unknown> } = {}
  ): Promise<any> {
    const { port } = await this.ensure(serverMoid, opts);
    return this.post(port, this.serverRoute(serverMoid, action), payload);
  }

  /**
   * Read recorded history WITHOUT starting anything.
   *
   * Reads must never start a recorder. That logs in, opens a vKVM session and
   * takes the server's only session slot — real side effects on a physical
   * machine, from a question about the past. It was also destructive until
   * recorders learned to adopt existing frames: searching last night's campaign
   * started a recorder whose first act was to delete the frames being searched.
   */
  async read(serverMoid: string, action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const port = await this.daemon(false);
    if (port !== null) {
      try {
        return await this.post(port, this.serverRoute(serverMoid, action), payload);
      } catch (error) {
        if (!(error instanceof NoRecorderError)) {
          throw error;
        }
      }
    }
    const dir = this.dirFor(serverMoid);
    const frames = this.countFrames(dir);
    if (frames === 0) {
      throw new Error(
        `No recorder for ${serverMoid} and no recorded frames on disk. Start one with vkvm_record_start.`
      );
    }
    throw new Error(
      `No recorder is running for ${serverMoid}, so its history cannot be searched or rendered here. ` +
        `${frames} frame(s) are on disk at ${dir} and can be opened directly. ` +
        `To query them with the vkvm_* tools, call vkvm_record_start — it attaches to these frames rather than discarding them, ` +
        `but it also opens a vKVM console on the server, which is why a read will not do it for you.`
    );
  }

  private countFrames(dir: string): number {
    try {
      return fs.readdirSync(dir).filter((f) => /^f-\d+\.png$/.test(f)).length;
    } catch {
      return 0;
    }
  }

  /** Call a recorder we expect to be live; never starts a daemon or a recorder. */
  async call(serverMoid: string, action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const port = await this.daemon(false);
    if (port === null) {
      throw new Error(`No live recorder for ${serverMoid}: the account daemon is not running.`);
    }
    try {
      return await this.post(port, this.serverRoute(serverMoid, action), payload);
    } catch (error) {
      if (error instanceof NoRecorderError) {
        throw new Error(`No live recorder for ${serverMoid}.`);
      }
      throw error;
    }
  }

  /**
   * An account-level action: browser and login work, which the daemon performs
   * with the one browser. Returns null when no daemon is running and
   * `spawnIfAbsent` is false, so a status question never starts one.
   */
  async account(action: string, payload: Record<string, unknown> = {}, opts: { spawnIfAbsent: boolean }): Promise<any> {
    const port = await this.daemon(opts.spawnIfAbsent);
    if (port === null) {
      return null;
    }
    return this.post(port, action, payload);
  }

  private serverRoute(serverMoid: string, action: string): string {
    return `server/${encodeURIComponent(serverMoid)}/${action}`;
  }

  private async post(port: number, route: string, payload: Record<string, unknown>): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, clientId: this.clientId }),
      });
    } catch (error) {
      // Nothing is deleted or "cleared" here, ever: whether a daemon exists is
      // decided by the port alone, so the next call's hello simply finds out.
      throw new Error(
        `The Intersight MCP daemon did not answer on port ${port} (${(error as Error).message}). ` +
          'Retry; if it has exited, a fresh one is started automatically.'
      );
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status === 404 && body.code === 'no-recorder') {
      throw new NoRecorderError(body.error);
    }
    if (res.status === 409) {
      throw new Error(
        `${body.error ?? 'the console is unavailable right now'}` +
          (body.retryAfterMs ? ` Retry in about ${Math.ceil(body.retryAfterMs / 1000)}s.` : '')
      );
    }
    if (!res.ok || body.ok === false) {
      throw new Error(body.error ?? `daemon action "${route}" failed with ${res.status}`);
    }
    return body.result;
  }
}
