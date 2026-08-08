/**
 * Drive a real RecorderDaemon the way an MCP server does — over its control
 * port — with only BrowserService faked.
 *
 * The daemon's lock file, control server, input arbiter and lifetime rules are
 * the real ones; Intersight is not, because nothing here is a question about
 * Intersight.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecorderDaemon } from '../../src/recorder/recorderDaemon.js';
import type { BrowserService } from '../../src/services/browserService.js';

const roots: string[] = [];
const running: Array<{ port: number }> = [];

/** Stop every daemon started by a test and delete its recordings. */
export async function cleanUpDaemons(): Promise<void> {
  for (const d of running.splice(0)) {
    await callDaemon(d.port, 'stop', { force: true }).catch(() => undefined);
  }
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
}

export async function callDaemon(
  port: number,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'test-client', ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.result;
}

export interface FakeBrowserOpts {
  launch: Record<string, unknown>;
  recorderRunning?: boolean;
  recorderRefuses?: boolean;
}

export function fakeBrowser(opts: FakeBrowserOpts) {
  const calls = { launches: 0, startRecording: 0, resets: 0, keys: 0, endedSessions: [] as string[] };
  const browser = {
    setTunneledVkvmResetter: () => {},
    ensureLoggedIn: async () => ({ loggedIn: true }),
    activeKvmSessions: async () => [],
    currentSessionIdentity: async () => ({ iamSessionMoid: 'iam-1', userIdOrEmail: 'me@example.com' }),
    hasOpenConsoleTab: () => false,
    endKvmSession: async (moid: string) => {
      calls.endedSessions.push(moid);
      return { ended: true };
    },
    launchVkvm: async () => {
      calls.launches++;
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
    close: async () => ({ closed: false, detached: true }),
  };
  return { browser: browser as unknown as BrowserService, calls };
}

/**
 * Start a daemon on a throwaway recording root.
 *
 * Returns its control port and its recording directory, so a test can inspect
 * the files it publishes there (lock, dormancy marker, frames).
 */
export async function startDaemon(
  fake: ReturnType<typeof fakeBrowser>,
  opts: { root?: string } = {}
): Promise<{ port: number; dir: string }> {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-daemon-test-'));
  roots.push(root);
  const daemon = new RecorderDaemon(
    // A tick far in the future: retries in these tests are driven by an explicit
    // client request, so nothing races the lifecycle timer.
    { serverMoid: 'server-1', serverName: 'test-server', tickMs: 3_600_000, onStopped: () => {} },
    'https://intersight.example/api/v1',
    root,
    fake.browser
  );
  const started = await daemon.start();
  assert.equal(started.started, true, 'the daemon itself must come up even when the console does not');
  assert.ok(started.controlPort, 'a daemon must be reachable even while degraded');
  running.push({ port: started.controlPort! });
  return { port: started.controlPort!, dir: path.join(root, 'server-1') };
}

/** A recording root a test can plant files in before the daemon starts. */
export function freshRoot(): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-daemon-test-'));
  const dir = path.join(root, 'server-1');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
