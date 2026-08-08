/**
 * Start a recorder daemon, talk to it like an MCP server would, stop it — then
 * fall off the end WITHOUT process.exit().
 *
 * Whether this process terminates is the whole question. It sends a keystroke
 * first, deliberately: that takes the input lease, which is what used to make
 * `stop` fail with 409 and leave a daemon running with a live console that only
 * a pid kill could end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecorderDaemon } from '../../src/recorder/recorderDaemon.js';
import type { BrowserService } from '../../src/services/browserService.js';

const browser = {
  setTunneledVkvmResetter: () => {},
  ensureLoggedIn: async () => ({ loggedIn: true }),
  activeKvmSessions: async () => [],
  currentSessionIdentity: async () => ({ iamSessionMoid: 'iam-1', userIdOrEmail: 'me@example.com' }),
  hasOpenConsoleTab: () => false,
  endKvmSession: async () => ({ ended: true }),
  launchVkvm: async () => ({ videoSurface: 'kvm-ui console mounted' }),
  resetTunneledVkvmViaSession: async () => ({ reset: true }),
  startRecording: () => ({ recording: true }),
  stopRecording: () => ({ recording: false }),
  recordingStatus: () => ({ running: true, framesStored: 0, consoleLive: true }),
  closeKvm: async () => ({ closed: true }),
  isServerPoweredOn: async () => true,
  close: async () => ({ closed: false, detached: true }),
} as unknown as BrowserService;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-exit-fixture-'));
let stopped = false;
const daemon = new RecorderDaemon(
  { serverMoid: 'server-1', tickMs: 3_600_000, onStopped: () => (stopped = true) },
  'https://intersight.example/api/v1',
  root,
  browser
);

const started = await daemon.start();
const port = started.controlPort!;
const call = async (action: string, payload: Record<string, unknown> = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'mcp-fixture', ...payload }),
  });
  return res.json();
};

// Several calls, so the client's connection pool is holding sockets open — the
// state a long-lived MCP server leaves a daemon in.
await call('status');
await call('status', { clientId: 'mcp-other' });
// Takes the input lease under a DIFFERENT client, the state that used to make
// the stop below impossible.
await call('sendKeys', { clientId: 'mcp-other', text: 'x' });
await call('stop', { force: true });

// Give the deferred shutdown time to run, then report and simply return.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(`DAEMON_STOPPED=${stopped}`);
fs.rmSync(root, { recursive: true, force: true });
