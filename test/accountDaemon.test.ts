/**
 * ONE daemon per account owns the browser, the login and every recorder.
 *
 * It used to be one daemon per SERVER, each carrying its own copy of the login
 * machinery and its own session keepalive. They all attached to the same shared
 * browser, so they shared one cookie jar — and drove the Cisco ID login in it
 * concurrently. Each login overwrote the others' OIDC state cookie, so every
 * callback was rejected with "OIDC state parameter is invalid", the half-done
 * flows navigated each other's tabs away ("Could not find the password field"),
 * and the thrash ran all night: ~950 failed logins in one morning, ending in
 * Intersight refusing to mint more sessions (tokenlimit_reached). Dormant
 * daemons, which had already released their consoles, kept logging in too.
 *
 * A single process makes that impossible by construction: one browser, one
 * login in flight, one keepalive. The only lock left is the daemon's listening
 * port, which the OS releases when the process dies — nothing to go stale, no
 * pid to be reused, nothing a client can delete.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { AccountDaemon } from '../src/recorder/accountDaemon.js';
import { callAccount, callServer, fakeBrowser, waitForPhase } from './helpers/daemonHarness.js';

const daemons: AccountDaemon[] = [];
const httpServers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.shutdown('test cleanup').catch(() => undefined);
  }
  for (const s of httpServers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-daemon-test-'));
  roots.push(root);
  return root;
}

const liveConsole = () => fakeBrowser({ launch: { videoSurface: 'kvm-ui console mounted' } });

async function startAccountDaemon(
  fake: ReturnType<typeof fakeBrowser>,
  opts: { port?: number; root?: string; tickMs?: number; idleExitMs?: number; onExit?: (r: string) => void } = {}
) {
  let browsersMade = 0;
  const daemon = new AccountDaemon({
    port: opts.port ?? 0,
    baseUrl: 'https://intersight.example/api/v1',
    recordingRoot: opts.root ?? tempRoot(),
    browserFactory: () => {
      browsersMade++;
      return fake.browser;
    },
    tickMs: opts.tickMs ?? 3_600_000,
    idleExitMs: opts.idleExitMs,
    onExit: opts.onExit ?? (() => {}),
  });
  daemons.push(daemon);
  const started = await daemon.start();
  return { daemon, started, port: started.port!, browsersMade: () => browsersMade };
}

describe('one daemon per account', () => {
  it('refuses to start a second daemon while the first holds the port', async () => {
    const first = await startAccountDaemon(liveConsole());
    assert.equal(first.started.started, true);

    const second = await startAccountDaemon(liveConsole(), { port: first.port });
    assert.equal(second.started.started, false, 'two daemons would drive two logins in one browser');
    assert.match(second.started.reason, /already running/i);
    assert.match(second.started.reason, new RegExp(`pid ${process.pid}`), 'and say which process holds it');
  });

  it('says so plainly when the port belongs to some other program', async () => {
    const foreign = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from something else');
    });
    httpServers.push(foreign);
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
    const port = (foreign.address() as AddressInfo).port;

    const d = await startAccountDaemon(liveConsole(), { port });
    assert.equal(d.started.started, false);
    assert.match(d.started.reason, /another program/i);
    assert.match(d.started.reason, /INTERSIGHT_DAEMON_PORT/, 'the way out must be named');
  });

  it('can take the port again once the previous daemon is gone', async () => {
    const first = await startAccountDaemon(liveConsole());
    await first.daemon.shutdown('done');
    const second = await startAccountDaemon(liveConsole(), { port: first.port });
    assert.equal(second.started.started, true, 'a dead daemon must never leave a lock behind');
  });

  it('introduces itself, so a client can tell it from a stranger on the port', async () => {
    const { port } = await startAccountDaemon(liveConsole());
    const hello = await callAccount(port, 'hello');
    assert.equal(hello.service, 'intersight-mcp-daemon');
    assert.equal(hello.pid, process.pid);
    assert.equal(typeof hello.protocol, 'number');
  });
});

describe('recorders for many servers in one daemon', () => {
  it('records two servers through ONE browser, so there is one login and one keepalive', async () => {
    const fake = liveConsole();
    const { port, browsersMade } = await startAccountDaemon(fake);

    await Promise.all([
      callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' }),
      callAccount(port, 'ensureRecorder', { serverMoid: 'server-b' }),
    ]);
    assert.equal((await waitForPhase(port, 'server-a')).phase, 'active');
    assert.equal((await waitForPhase(port, 'server-b')).phase, 'active');

    assert.equal(browsersMade(), 1, 'every recorder must share the daemon\'s single browser');
    assert.deepEqual([...fake.calls.launchedMoids].sort(), ['server-a', 'server-b']);
  });

  it('does not create a second recorder for a server that already has one', async () => {
    const fake = liveConsole();
    const { port } = await startAccountDaemon(fake);
    const first = await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });
    await waitForPhase(port, 'server-a');
    const again = await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });

    assert.equal(first.created, true);
    assert.equal(again.created, false, 'a second recorder would fight the first for the session slot');
    assert.equal(fake.calls.launches, 1);
  });

  it('stopping one server leaves the other recording and the browser attached', async () => {
    const fake = liveConsole();
    const { port } = await startAccountDaemon(fake);
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-b' });
    await waitForPhase(port, 'server-a');
    await waitForPhase(port, 'server-b');

    await callServer(port, 'server-a', 'stop', { force: true });
    await waitFor(async () => !(await listedMoids(port)).includes('server-a'), 3000);

    assert.deepEqual(await listedMoids(port), ['server-b']);
    assert.equal((await callServer(port, 'server-b', 'status')).phase, 'active');
    assert.equal(fake.calls.browserClosed, 0, 'one server stopping must not detach everyone\'s browser');
  });

  it('answers a call for a server it is not recording with a clear refusal', async () => {
    const { port } = await startAccountDaemon(liveConsole());
    await assert.rejects(() => callServer(port, 'server-z', 'status'), /no recorder.*server-z/i);
  });

  it('marks only the affected server busy during a Tunneled vKVM reset', async () => {
    // The reset takes ~90s. Blocking input to EVERY console for that long, because
    // they now share a process, would be a regression the old design never had.
    const fake = liveConsole();
    let releaseReset!: () => void;
    (fake.browser as any).resetTunneledVkvmViaSession = () =>
      new Promise((resolve) => (releaseReset = () => resolve({ reset: true })));
    const { port } = await startAccountDaemon(fake);
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-b' });
    await waitForPhase(port, 'server-a');
    await waitForPhase(port, 'server-b');

    const resetting = fake.resetter()!('server-b');
    await assert.rejects(() => callServer(port, 'server-b', 'sendKeys', { text: 'x' }), /Tunneled vKVM/i);
    assert.equal((await callServer(port, 'server-a', 'sendKeys', { text: 'x' })).sent, true);

    releaseReset();
    await resetting;
  });
});

describe('browser and login work goes through the daemon', () => {
  it('logs in with the daemon\'s browser, not a second one', async () => {
    const fake = liveConsole();
    const { port, browsersMade } = await startAccountDaemon(fake);
    const r = await callAccount(port, 'login', { force: true });
    assert.equal(r.loggedIn, true);
    assert.equal(fake.calls.logins, 1);
    assert.deepEqual(fake.calls.loginForced, [true], 'force must reach the login');
    assert.equal(browsersMade(), 1);
  });

  it('reports browser status with the daemon it came from', async () => {
    const { port } = await startAccountDaemon(liveConsole());
    const s = await callAccount(port, 'browserStatus');
    assert.equal(s.daemon.pid, process.pid);
  });
});

describe('the daemon\'s own lifetime', () => {
  it('exits once it has no recorders and nobody has called for a while', async () => {
    let exited: string | null = null;
    await startAccountDaemon(liveConsole(), { tickMs: 20, idleExitMs: 100, onExit: (r) => (exited = r) });
    await waitFor(async () => exited !== null, 3000);
    assert.match(String(exited), /idle/i);
  });

  it('stays up while any recorder exists, however idle', async () => {
    let exited: string | null = null;
    const { port } = await startAccountDaemon(liveConsole(), {
      tickMs: 20,
      idleExitMs: 100,
      onExit: (r) => (exited = r),
    });
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(exited, null, 'a recorder is a reason to live, even a dormant one');
  });

  it('refuses a plain shutdown while recorders exist, but honours force', async () => {
    let exited: string | null = null;
    const { port } = await startAccountDaemon(liveConsole(), { onExit: (r) => (exited = r) });
    await callAccount(port, 'ensureRecorder', { serverMoid: 'server-a' });
    await waitForPhase(port, 'server-a');

    await assert.rejects(() => callAccount(port, 'shutdown', {}), /recording/i);
    await callAccount(port, 'shutdown', { force: true });
    await waitFor(async () => exited !== null, 3000);
    assert.notEqual(exited, null);
  });
});

/**
 * Daemons from builds before this change are one-per-server and would keep
 * logging in against the new one. They are found by the lock files they left
 * beside their frames, and asked to stop; their frames stay on disk.
 */
describe('per-server daemons from older builds', () => {
  it('asks a live legacy daemon to stop when the account daemon starts', async () => {
    const root = tempRoot();
    const stops: any[] = [];
    const legacy = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/stop') {
          stops.push(JSON.parse(body || '{}'));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { stopping: true } }));
      });
    });
    httpServers.push(legacy);
    await new Promise<void>((r) => legacy.listen(0, '127.0.0.1', () => r()));
    const legacyPort = (legacy.address() as AddressInfo).port;
    const dir = path.join(root, 'legacy-server');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'recorder.lock'),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), controlPort: legacyPort })
    );
    fs.writeFileSync(path.join(dir, 'f-000001.png'), 'a frame');

    await startAccountDaemon(liveConsole(), { root });
    await waitFor(async () => stops.length > 0, 3000);

    assert.equal(stops.length, 1);
    assert.equal(stops[0].force, true, 'a legacy daemon nobody can reach any more must not be able to refuse');
    assert.ok(fs.existsSync(path.join(dir, 'f-000001.png')), 'its frames are evidence and must be kept');
  });

  it('tidies away a lock whose process is long gone', async () => {
    const root = tempRoot();
    const dir = path.join(root, 'dead-server');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'recorder.lock'),
      JSON.stringify({ pid: 999_999_998, acquiredAt: new Date().toISOString(), controlPort: 1 })
    );

    await startAccountDaemon(liveConsole(), { root });
    await waitFor(async () => !fs.existsSync(path.join(dir, 'recorder.lock')), 3000);
    assert.equal(fs.existsSync(path.join(dir, 'recorder.lock')), false);
  });
});

async function listedMoids(port: number): Promise<string[]> {
  const s = await callAccount(port, 'status');
  return (s.recorders as Array<{ serverMoid: string }>).map((r) => r.serverMoid).sort();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
