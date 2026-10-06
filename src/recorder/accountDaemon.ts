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

import path from 'path';
import { BrowserService } from '../services/browserService.js';
import { RecorderOptions } from '../services/vkvmRecorder.js';
import { ControlServer } from './controlServer.js';
import { InputArbiter } from './inputLease.js';
import { DAEMON_PROTOCOL, DAEMON_SERVICE, DaemonHello, foreignPortMessage, probeDaemon } from './daemonProtocol.js';
import { stopLegacyDaemons } from './legacyDaemons.js';
import { ServerRecorder } from './serverRecorder.js';

/**
 * The ONE long-lived process for an Intersight account: it owns the browser,
 * the login, the session keepalive, and a recorder for every server being
 * watched. MCP servers are thin clients of it.
 *
 * MCP servers come and go with every chat, fork and code reload, so consoles
 * must live somewhere that does not. That used to be one daemon per SERVER —
 * and each of them carried its own copy of the login machinery. They shared one
 * browser, therefore one cookie jar, and drove Cisco ID logins in it at the same
 * time: each overwrote the others' OIDC state, every callback was rejected
 * ("OIDC state parameter is invalid"), and the retries never stopped. One
 * process per account makes that impossible by construction.
 *
 * The only lock is the listening port (see daemonProtocol.ts): whoever binds it
 * is the daemon, the OS frees it when the process dies, and a second daemon
 * simply fails to bind and goes away.
 */

export interface AccountDaemonOptions {
  /** Fixed loopback port, which is also the lock. Tests pass 0. */
  port: number;
  baseUrl: string;
  /** Recordings live in <recordingRoot>/<serverMoid>/. */
  recordingRoot: string;
  /** Injectable so recorder and daemon rules can be tested without Intersight. */
  browserFactory?: () => BrowserService;
  /** How often recorders evaluate their lifetime and health. */
  tickMs?: number;
  /** With no recorders, how long without any client contact before exiting. */
  idleExitMs?: number;
  /**
   * What to do once teardown is complete. The process exits by default; tests
   * pass their own so a shutdown does not take the test runner with it.
   */
  onExit?: (reason: string) => void;
}

/**
 * An idle daemon keeps the session alive and costs nothing much, but a daemon
 * that never goes away is how zombies accumulate. An hour covers an agent
 * logging in and then taking its time before opening a console.
 */
const DEFAULT_IDLE_EXIT_MS = 60 * 60 * 1000;

export class AccountDaemon {
  private readonly control: ControlServer;
  private readonly recorders = new Map<string, ServerRecorder>();
  private browser: BrowserService | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private boundPort: number | null = null;
  private readonly startedAt = new Date();
  private lastClientContactAt = Date.now();
  private stopping = false;

  constructor(private readonly opts: AccountDaemonOptions) {
    this.control = new ControlServer({
      arbiter: new InputArbiter(),
      serverScope: (moid) => this.recorders.get(moid)?.scope() ?? null,
      onClientContact: (clientId, moid) => {
        this.lastClientContactAt = Date.now();
        if (moid) {
          this.recorders.get(moid)?.touch(clientId);
        }
      },
      inputActions: {},
      readActions: {
        hello: async () => this.hello(),
        status: async () => this.status(),
        ensureRecorder: async (p) => this.ensureRecorder(p ?? {}),
        shutdown: async (p) => this.shutdownRequested(p ?? {}),
        // Browser and login work for the MCP server's own tools. They run here
        // because this is the one process with the browser: an MCP server that
        // logged in by itself would be a second login in the same cookie jar.
        login: async (p) => this.requireBrowser().ensureLoggedIn({ force: !!p?.force }),
        browserOpen: async (p) =>
          this.requireBrowser().open(
            p?.url,
            p?.width && p?.height ? { width: Number(p.width), height: Number(p.height) } : undefined
          ),
        browserStatus: async () => ({ ...(await this.requireBrowser().status()), daemon: this.status() }),
        browserGoto: async (p) => this.requireBrowser().goto(String(p?.url ?? ''), !!p?.newPage),
        browserEvaluate: async (p) => this.requireBrowser().evaluate(String(p?.script ?? ''), p?.serverMoid),
        sessionApi: async (p) => this.requireBrowser().sessionApi(String(p?.method ?? 'GET'), String(p?.path ?? ''), p?.body),
      },
    });
  }

  /**
   * Bind the port — which is the whole of "take the lock" — then open for
   * business. A daemon that loses the bind explains who has the port and exits,
   * without ever touching the browser.
   */
  async start(): Promise<{ started: boolean; reason: string; port?: number }> {
    try {
      this.boundPort = await this.control.listen(this.opts.port);
    } catch (error) {
      return { started: false, reason: await this.explainBindFailure(error) };
    }

    this.browser = this.opts.browserFactory ? this.opts.browserFactory() : new BrowserService(this.opts.baseUrl);
    // A console that keeps coming back dead gets a Tunneled vKVM reset. Only
    // THAT server is marked busy for its ~90s: every other console shares this
    // process, and blocking their input for a reset elsewhere would be new harm.
    this.browser.setTunneledVkvmResetter(async (moid) => {
      const reset = () => this.requireBrowser().resetTunneledVkvmViaSession(moid);
      const recorder = this.recorders.get(moid);
      return recorder ? recorder.withBusy('resetting Tunneled vKVM on the server', 120_000, reset) : reset();
    });

    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? 60_000);
    this.tickTimer.unref?.();
    this.log(`listening on 127.0.0.1:${this.boundPort}`);

    // In the background: an unreachable legacy daemon must not delay the first
    // client, and its outcome is only ever logged.
    void stopLegacyDaemons(this.opts.recordingRoot, (m) => this.log(m)).catch(() => undefined);
    return { started: true, reason: 'listening', port: this.boundPort };
  }

  private async explainBindFailure(error: unknown): Promise<string> {
    const port = this.opts.port;
    if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
      return `could not listen on 127.0.0.1:${port}: ${(error as Error)?.message ?? error}`;
    }
    const probe = await probeDaemon(port, 3000);
    if (probe.state === 'ours') {
      return `an account daemon is already running on port ${port} (pid ${probe.hello.pid})`;
    }
    if (probe.state === 'absent') {
      // Freed between our bind and the probe: the holder just exited. The
      // client that spawned us will spawn again.
      return `port ${port} was busy and has just been released; try again`;
    }
    return foreignPortMessage(port, probe.detail);
  }

  private hello(): DaemonHello {
    return {
      service: DAEMON_SERVICE,
      protocol: DAEMON_PROTOCOL,
      pid: process.pid,
      port: this.boundPort ?? this.opts.port,
      startedAt: this.startedAt.toISOString(),
    };
  }

  private status(): any {
    return {
      pid: process.pid,
      port: this.boundPort,
      startedAt: this.startedAt.toISOString(),
      lastClientContactAt: new Date(this.lastClientContactAt).toISOString(),
      recorders: [...this.recorders.entries()].map(([serverMoid, r]) => ({ serverMoid, phase: r.currentPhase() })),
    };
  }

  /**
   * Record a server: create its recorder if there is none, otherwise wake the
   * one there is. Never two per server — a second would fight the first for the
   * server's single vKVM session slot and wipe its frames.
   *
   * Returns at once; the console comes up in the background and the caller
   * polls the recorder's phase.
   */
  private async ensureRecorder(p: Record<string, any>): Promise<{ created: boolean; phase: string }> {
    const serverMoid = String(p.serverMoid ?? '').trim();
    if (!serverMoid || /[\\/]/.test(serverMoid) || serverMoid.startsWith('.')) {
      throw new Error(`a valid serverMoid is required, got "${p.serverMoid ?? ''}"`);
    }
    const clientId = String(p.clientId ?? 'unknown-client');
    const existing = this.recorders.get(serverMoid);
    if (existing) {
      existing.noteInterest();
      // A dormant recorder wakes rather than being replaced, so its frames and
      // history survive. A failed wake leaves it degraded, which the phase says.
      await existing.resume().catch(() => undefined);
      return { created: false, phase: existing.currentPhase() };
    }
    if (this.stopping) {
      throw new Error('the daemon is shutting down; retry to have a fresh one started');
    }
    // Checked and set with no await in between, so two clients asking at once
    // still get one recorder.
    const recorder = new ServerRecorder(
      {
        serverMoid,
        serverName: p.serverName,
        objectType: p.objectType,
        recording: (p.recording ?? undefined) as RecorderOptions | undefined,
        diskBudgetBytes: p.diskBudgetBytes,
      },
      this.requireBrowser(),
      path.join(this.opts.recordingRoot, serverMoid),
      {
        onStopped: (moid) => {
          if (this.recorders.get(moid) === recorder) {
            this.recorders.delete(moid);
          }
        },
        daemonInfo: () => ({ pid: process.pid, port: this.boundPort }),
      }
    );
    this.recorders.set(serverMoid, recorder);
    this.log(`recording ${serverMoid}${p.serverName ? ` (${p.serverName})` : ''} for ${clientId}`);
    recorder.begin();
    return { created: true, phase: recorder.currentPhase() };
  }

  private tick(): void {
    if (this.stopping) {
      return;
    }
    // Each recorder ticks on its own: a retry that spends a minute logging in
    // for one server must not delay the others' health checks.
    for (const recorder of this.recorders.values()) {
      void recorder.lifecycleTick().catch((error) => this.log(`recorder tick failed: ${(error as Error)?.message}`));
    }
    const idleMs = Date.now() - this.lastClientContactAt;
    const limit = this.opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    if (this.recorders.size === 0 && idleMs > limit) {
      void this.shutdown(`idle: no recorders and no client contact for ${Math.round(idleMs / 1000)}s`);
    }
  }

  private shutdownRequested(p: Record<string, unknown>): { stopping: boolean } {
    if (this.recorders.size > 0 && !p.force) {
      throw new Error(
        `${this.recorders.size} server(s) are still recording (${[...this.recorders.keys()].join(', ')}); ` +
          'stopping the daemon would end every one of those consoles. Pass force:true to stop it anyway.'
      );
    }
    // Answer before exiting, so the caller does not see a dropped socket.
    setTimeout(() => void this.shutdown(`client ${String(p.clientId ?? 'unknown')} asked the daemon to stop`), 50);
    return { stopping: true };
  }

  /** Release every console, close the port, close the browser, and exit. */
  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.log(`shutting down: ${reason}`);
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const recorder of [...this.recorders.values()]) {
      await recorder.shutdown(`daemon shutting down: ${reason}`).catch(() => undefined);
    }
    await this.control.close().catch(() => undefined);
    // The browser is the daemon's own and goes with it; the profile keeps the
    // login cookies for the next daemon.
    await this.browser?.close().catch(() => undefined);
    (this.opts.onExit ?? (() => process.exit(0)))(reason);
  }

  private requireBrowser(): BrowserService {
    if (!this.browser) {
      throw new Error('the daemon has not started');
    }
    return this.browser;
  }

  private log(message: string): void {
    console.error(`${new Date().toISOString()} [daemon pid ${process.pid}] ${message}`);
  }
}
