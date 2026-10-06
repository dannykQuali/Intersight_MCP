/**
 * Drive a real AccountDaemon the way an MCP server does — over its control
 * port — with only BrowserService faked.
 *
 * The daemon's control server, per-server recorders, input arbiters and
 * lifetime rules are the real ones; Intersight is not, because nothing here is a
 * question about Intersight.
 *
 * `startDaemon` + `callDaemon` keep the single-server shape most tests want: one
 * account daemon recording one server, 'server-1', addressed by its port.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountDaemon } from '../../src/recorder/accountDaemon.js';
import { waitUntilNotStarting } from '../../src/services/recorderClient.js';
import type { BrowserService } from '../../src/services/browserService.js';

const roots: string[] = [];
const running: AccountDaemon[] = [];
const SERVER = 'server-1';

/** Stop every daemon started by a test and delete its recordings. */
export async function cleanUpDaemons(): Promise<void> {
  for (const d of running.splice(0)) {
    await d.shutdown('test cleanup').catch(() => undefined);
  }
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
}

async function post(port: number, route: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'test-client', ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body.ok === false) {
    throw new Error(res.status === 409 ? `409 ${body.error}` : body.error ?? `HTTP ${res.status}`);
  }
  return body.result;
}

/** An account-level action: hello, status, ensureRecorder, login, browserStatus... */
export function callAccount(port: number, action: string, payload: Record<string, unknown> = {}): Promise<any> {
  return post(port, action, payload);
}

/** An action on one server's recorder. */
export function callServer(
  port: number,
  serverMoid: string,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<any> {
  return post(port, `server/${encodeURIComponent(serverMoid)}/${action}`, payload);
}

/** An action on the single server a `startDaemon` daemon records. */
export function callDaemon(port: number, action: string, payload: Record<string, unknown> = {}): Promise<any> {
  return callServer(port, SERVER, action, payload);
}

/**
 * Wait for a freshly ensured recorder to leave the 'starting' phase.
 *
 * Asked through the ACCOUNT status, so the harness never shows up as a client
 * using the console — that would make every test's own stop look like it was
 * pulling the console out from under a peer.
 */
export async function waitForPhase(port: number, serverMoid: string): Promise<{ phase: string | null }> {
  return waitUntilNotStarting(
    async () => {
      const status = await callAccount(port, 'status');
      return (status.recorders as Array<{ serverMoid: string; phase: string }>).find((r) => r.serverMoid === serverMoid) ?? null;
    },
    { timeoutMs: 5000, pollMs: 10 }
  );
}

export interface FakeBrowserOpts {
  launch: Record<string, unknown>;
  recorderRunning?: boolean;
  recorderRefuses?: boolean;
}

export function fakeBrowser(opts: FakeBrowserOpts) {
  const calls = {
    launches: 0,
    launchedMoids: [] as string[],
    startRecording: 0,
    resets: 0,
    keys: 0,
    logins: 0,
    loginForced: [] as boolean[],
    browserClosed: 0,
    endedSessions: [] as string[],
  };
  let resetter: ((moid: string) => Promise<unknown>) | null = null;
  const browser = {
    setTunneledVkvmResetter: (fn: (moid: string) => Promise<unknown>) => {
      resetter = fn;
    },
    ensureLoggedIn: async (o?: { force?: boolean }) => {
      calls.logins++;
      calls.loginForced.push(!!o?.force);
      return { loggedIn: true };
    },
    status: async () => ({ browserOpen: true, loggedIn: true, pages: [], kvmSessions: [] }),
    activeKvmSessions: async () => [],
    currentSessionIdentity: async () => ({ iamSessionMoid: 'iam-1', userIdOrEmail: 'me@example.com' }),
    hasOpenConsoleTab: () => false,
    endKvmSession: async (moid: string) => {
      calls.endedSessions.push(moid);
      return { ended: true };
    },
    launchVkvm: async (server: { moid: string }) => {
      calls.launches++;
      calls.launchedMoids.push(server?.moid);
      return opts.launch;
    },
    resetTunneledVkvmViaSession: async () => {
      calls.resets++;
      return { reset: true };
    },
    startRecording: () => {
      calls.startRecording++;
      return opts.recorderRefuses
        ? { recording: false, reason: 'no page for this server' }
        : { recording: true, alreadyRunning: opts.recorderRunning ?? false };
    },
    stopRecording: () => ({ recording: false }),
    recordingStatus: () => ({ running: true, framesStored: 0, consoleLive: true }),
    sendKeys: async () => {
      calls.keys++;
      return { sent: true };
    },
    closeKvm: async () => ({ closed: true }),
    isServerPoweredOn: async () => true,
    close: async () => {
      calls.browserClosed++;
      return { closed: false, detached: true };
    },
  };
  return {
    browser: browser as unknown as BrowserService,
    calls,
    /** The Tunneled vKVM resetter the daemon registered with its browser. */
    resetter: () => resetter,
  };
}

/**
 * Start an account daemon on a throwaway recording root, recording 'server-1'.
 *
 * Returns its control port and that server's recording directory, so a test can
 * inspect the files published there (dormancy marker, frames).
 */
export async function startDaemon(
  fake: ReturnType<typeof fakeBrowser>,
  opts: { root?: string } = {}
): Promise<{ port: number; dir: string }> {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-daemon-test-'));
  roots.push(root);
  const daemon = new AccountDaemon({
    port: 0,
    baseUrl: 'https://intersight.example/api/v1',
    recordingRoot: root,
    browserFactory: () => fake.browser,
    // A tick far in the future: retries in these tests are driven by an explicit
    // client request, so nothing races the lifecycle timer.
    tickMs: 3_600_000,
    onExit: () => {},
  });
  running.push(daemon);
  const started = await daemon.start();
  assert.equal(started.started, true, `the daemon must come up: ${started.reason}`);
  await callAccount(started.port!, 'ensureRecorder', { serverMoid: SERVER, serverName: 'test-server' });
  await waitForPhase(started.port!, SERVER);
  return { port: started.port!, dir: path.join(root, SERVER) };
}

/** A recording root a test can plant files in before the daemon starts. */
export function freshRoot(): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-daemon-test-'));
  const dir = path.join(root, SERVER);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
