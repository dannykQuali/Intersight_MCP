/**
 * Start an account daemon, talk to it like an MCP server would, stop its only
 * recorder — then fall off the end WITHOUT process.exit().
 *
 * Whether this process terminates is the whole question. It sends a keystroke
 * first, deliberately: that takes the input lease, which is what used to make
 * `stop` fail with 409 and leave a daemon running with a live console that only
 * a pid kill could end. With the last recorder gone, the daemon must idle out
 * on its own and leave nothing behind that holds the event loop open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountDaemon } from '../../src/recorder/accountDaemon.js';
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
  sendKeys: async () => ({ sent: true }),
  closeKvm: async () => ({ closed: true }),
  isServerPoweredOn: async () => true,
  close: async () => ({ closed: false, detached: true }),
} as unknown as BrowserService;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-exit-fixture-'));
let stopped = false;
const daemon = new AccountDaemon({
  port: 0,
  baseUrl: 'https://intersight.example/api/v1',
  recordingRoot: root,
  browserFactory: () => browser,
  tickMs: 50,
  idleExitMs: 300,
  onExit: () => (stopped = true),
});

const started = await daemon.start();
const port = started.port!;
const call = async (route: string, payload: Record<string, unknown> = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'mcp-fixture', ...payload }),
  });
  return res.json();
};

await call('ensureRecorder', { serverMoid: 'server-1' });
// Several calls, so the client's connection pool is holding sockets open — the
// state a long-lived MCP server leaves a daemon in.
await call('server/server-1/status');
await call('server/server-1/status', { clientId: 'mcp-other' });
// Takes the input lease under a DIFFERENT client, the state that used to make
// the stop below impossible.
await call('server/server-1/sendKeys', { clientId: 'mcp-other', text: 'x' });
await call('server/server-1/stop', { force: true });

// Give the idle exit time to fire, then report and simply return.
const deadline = Date.now() + 5000;
while (!stopped && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.log(`DAEMON_STOPPED=${stopped}`);
fs.rmSync(root, { recursive: true, force: true });
