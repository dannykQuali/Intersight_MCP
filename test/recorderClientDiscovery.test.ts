/**
 * An MCP server finds the account daemon by its port alone, and starts one when
 * nothing answers.
 *
 * MCP servers come and go with every chat, fork and code reload, so the daemon
 * must be findable by a brand-new process that shares nothing with the one that
 * started it. Discovery used to be lock files beside each server's frames — and a
 * client that could not reach a daemon DELETED its lock, even while that daemon
 * was alive. The next client then spawned a second daemon for the same server,
 * and a third, each logging in against the others in one shared browser.
 *
 * Now the daemon's listening port is the lock. The OS gives it to one process at
 * a time and takes it back when that process dies, so there is nothing to go
 * stale and nothing for a client to delete. Clients only ever ask "hello?".
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { AccountDaemon } from '../src/recorder/accountDaemon.js';
import { RecorderClient, waitUntilNotStarting } from '../src/services/recorderClient.js';
import { fakeBrowser } from './helpers/daemonHarness.js';

const daemons: AccountDaemon[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.shutdown('test cleanup').catch(() => undefined);
  }
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-client-test-'));
  dirs.push(root);
  return root;
}

const BASE = 'https://intersight.example/api/v1';

/** What a client's spawn would do, in-process: start an account daemon on the port. */
function inProcessSpawner(port: number, root: string, fake = fakeBrowser({ launch: { videoSurface: 'kvm-ui' } })) {
  const attempts = { spawns: 0, daemonsStarted: 0 };
  const spawnDaemon = () => {
    attempts.spawns++;
    const daemon = new AccountDaemon({
      port,
      baseUrl: BASE,
      recordingRoot: root,
      browserFactory: () => fake.browser,
      tickMs: 3_600_000,
      onExit: () => {},
    });
    daemons.push(daemon);
    void daemon.start().then((s) => {
      if (s.started) {
        attempts.daemonsStarted++;
      }
    });
  };
  return { spawnDaemon, attempts, fake };
}

async function runningDaemon(root: string, fake = fakeBrowser({ launch: { videoSurface: 'kvm-ui' } })) {
  const daemon = new AccountDaemon({
    port: 0,
    baseUrl: BASE,
    recordingRoot: root,
    browserFactory: () => fake.browser,
    tickMs: 3_600_000,
    onExit: () => {},
  });
  daemons.push(daemon);
  const s = await daemon.start();
  return { port: s.port!, fake };
}

async function listenOn(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('finding the account daemon', () => {
  it('uses a daemon that is already running, without spawning another', async () => {
    const root = tempRoot();
    const { port } = await runningDaemon(root);
    let spawns = 0;
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => spawns++ });

    const r = await client.ensure('server-a');
    assert.equal(r.spawned, true, 'a recorder is new for this server');
    assert.equal(r.phase, 'active');
    assert.equal(spawns, 0, 'a running daemon must be found, not duplicated');
  });

  it('spawns a daemon when nothing answers on the port', async () => {
    const root = tempRoot();
    const port = await freePort();
    const { spawnDaemon, attempts } = inProcessSpawner(port, root);
    const client = new RecorderClient(BASE, root, { port, spawnDaemon });

    const r = await client.ensure('server-a');
    assert.equal(r.phase, 'active');
    assert.equal(attempts.spawns, 1);
    assert.equal(attempts.daemonsStarted, 1);
  });

  it('ends up with ONE daemon when two MCP servers race to start it', async () => {
    const root = tempRoot();
    const port = await freePort();
    const shared = fakeBrowser({ launch: { videoSurface: 'kvm-ui' } });
    const a = inProcessSpawner(port, root, shared);
    const b = inProcessSpawner(port, root, shared);
    const clientA = new RecorderClient(BASE, root, { port, spawnDaemon: a.spawnDaemon });
    const clientB = new RecorderClient(BASE, root, { port, spawnDaemon: b.spawnDaemon });

    const [ra, rb] = await Promise.all([clientA.ensure('server-a'), clientB.ensure('server-a')]);

    assert.equal(a.attempts.daemonsStarted + b.attempts.daemonsStarted, 1, 'only one daemon may win the port');
    assert.equal(ra.phase, 'active');
    assert.equal(rb.phase, 'active');
    assert.equal([ra.spawned, rb.spawned].filter(Boolean).length, 1, 'and it records the server once');
    assert.equal(shared.calls.launches, 1);
  });

  it('refuses to talk to a program on the port that is not our daemon', async () => {
    const root = tempRoot();
    const port = await listenOn((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>someone else</html>');
    });
    let spawns = 0;
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => spawns++ });

    await assert.rejects(() => client.ensure('server-a'), /another program/i);
    await assert.rejects(() => client.ensure('server-a'), /INTERSIGHT_DAEMON_PORT/);
    assert.equal(spawns, 0, 'a daemon spawned onto a taken port could never bind it');
  });

  it('reports a daemon that stops answering, instead of starting a rival', async () => {
    const root = tempRoot();
    const port = await listenOn(() => {
      /* accepts the connection, never answers */
    });
    let spawns = 0;
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => spawns++, helloTimeoutMs: 200 });

    await assert.rejects(() => client.ensure('server-a'), /not answering/i);
    assert.equal(spawns, 0, 'something holds the port, so a new daemon could not bind it anyway');
  });

  it('refuses a daemon from a build that speaks another protocol, naming it', async () => {
    // A daemon keeps the code it started with across rebuilds; talking to it
    // anyway would send requests it misreads.
    const port = await listenOn((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { service: 'intersight-mcp-daemon', protocol: 999, pid: 4242, port: 1, startedAt: 'earlier' },
        })
      );
    });
    let spawns = 0;
    const client = new RecorderClient(BASE, tempRoot(), { port, spawnDaemon: () => spawns++ });

    await assert.rejects(() => client.ensure('server-a'), /protocol 999.*pid 4242|pid 4242.*protocol 999/s);
    assert.equal(spawns, 0);
  });

  it('carries a client identity on every call, so input can be arbitrated', async () => {
    const seen: Array<{ url: string; clientId: string }> = [];
    const port = await listenOn((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        seen.push({ url: String(req.url), clientId: payload.clientId });
        const result = req.url === '/hello' ? { service: 'intersight-mcp-daemon', protocol: 1, pid: 1 } : { echoed: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    const client = new RecorderClient(BASE, tempRoot(), { port, spawnDaemon: () => {} });

    await client.call('server-a', 'status');
    const call = seen.find((s) => s.url.endsWith('/status'))!;
    assert.match(call.clientId, /^mcp-/, 'the daemon must know which client is asking');
  });
});

/**
 * A freshly created recorder answers before its console is up (deliberately: the
 * daemon is how a client asks what is happening). So a client that returns the
 * moment the recorder exists reports "recording" for a console that is still
 * logging in — and its very next keystroke is refused as busy.
 *
 * Waiting for the phase to leave 'starting' is what makes the tool's answer
 * true. Timing out is NOT an error: a console that takes a long time to open is
 * still opening, and the caller gets the phase to prove it.
 */
describe('waiting for a new recorder to be ready', () => {
  it('returns as soon as the console leaves the starting phase', async () => {
    const phases = ['starting', 'starting', 'active'];
    let calls = 0;
    const res = await waitUntilNotStarting(async () => ({ phase: phases[calls++] }), {
      timeoutMs: 5000,
      pollMs: 1,
    });
    assert.equal(res.phase, 'active');
    assert.equal(res.timedOut, false);
    assert.equal(calls, 3, 'must stop polling once the phase settles');
  });

  it('reports a degraded console instead of waiting for it to become active', async () => {
    // A console that cannot open must surface immediately with its reason; the
    // daemon keeps retrying in the background either way.
    const res = await waitUntilNotStarting(async () => ({ phase: 'degraded' }), {
      timeoutMs: 5000,
      pollMs: 1,
    });
    assert.equal(res.phase, 'degraded');
    assert.equal(res.timedOut, false);
  });

  it('gives up quietly when the console is taking too long', async () => {
    const res = await waitUntilNotStarting(async () => ({ phase: 'starting' }), {
      timeoutMs: 20,
      pollMs: 1,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.phase, 'starting', 'the caller still learns what it was doing');
  });

  it('survives a daemon that is not answering yet', async () => {
    let calls = 0;
    const res = await waitUntilNotStarting(
      async () => {
        if (++calls < 3) {
          throw new Error('ECONNREFUSED');
        }
        return { phase: 'active' };
      },
      { timeoutMs: 5000, pollMs: 1 }
    );
    assert.equal(res.phase, 'active');
    assert.equal(res.timedOut, false);
  });
});

/**
 * Reading recorded history must never START anything.
 *
 * Starting a recorder logs in, opens a vKVM session and takes the server's only
 * session slot — real side effects on a physical machine, caused by a question
 * about the past. It was worse than rude until recorders learned to adopt
 * existing frames: searching last night's campaign started a recorder whose
 * first act was to delete the frames being searched.
 */
describe('reads never start a recorder', () => {
  function plantFrames(root: string, moid: string, n: number): string {
    const dir = path.join(root, moid);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= n; i++) {
      fs.writeFileSync(path.join(dir, `f-${String(i).padStart(6, '0')}.png`), 'not really a png');
    }
    return dir;
  }

  it('refuses, pointing at the frames on disk, when no daemon is running', async () => {
    const root = tempRoot();
    plantFrames(root, 'server-g', 2);
    let spawns = 0;
    const client = new RecorderClient(BASE, root, { port: await freePort(), spawnDaemon: () => spawns++ });

    await assert.rejects(() => client.read('server-g', 'findText', { pattern: 'x' }), /2 frame\(s\)/);
    await assert.rejects(() => client.read('server-g', 'findText', { pattern: 'x' }), /vkvm_record_start/);
    assert.equal(spawns, 0, 'no daemon may have been spawned');
  });

  it('says plainly when there is no history at all', async () => {
    const client = new RecorderClient(BASE, tempRoot(), { port: await freePort(), spawnDaemon: () => {} });
    await assert.rejects(() => client.read('server-h', 'timeline', {}), /no recorded frames/i);
  });

  it('refuses without creating a recorder when the daemon is running but not recording that server', async () => {
    const root = tempRoot();
    plantFrames(root, 'server-g', 3);
    const { port, fake } = await runningDaemon(root);
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => {} });

    await assert.rejects(() => client.read('server-g', 'timeline', {}), /3 frame\(s\)/);
    assert.equal(fake.calls.launches, 0, 'a read must not open a console');
    assert.equal(await client.isLive('server-g'), false);
  });

  it('serves the read from a live recorder', async () => {
    const root = tempRoot();
    const { port, fake } = await runningDaemon(root);
    (fake.browser as any).getTimeline = (moid: string, minutesAgo: number) => ({ moid, minutesAgo });
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => {} });
    await client.ensure('server-i');

    const result = await client.read('server-i', 'timeline', { minutesAgo: 5 });
    assert.deepEqual(result, { moid: 'server-i', minutesAgo: 5 });
  });
});

describe('listing what is being recorded', () => {
  it('shows live recorders and historical frames side by side', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'server-old'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server-old', 'f-000001.png'), 'x');
    const { port } = await runningDaemon(root);
    const client = new RecorderClient(BASE, root, { port, spawnDaemon: () => {} });
    await client.ensure('server-new');

    const list = await client.list();
    const byMoid = new Map(list.map((r) => [r.serverMoid, r]));
    assert.equal(byMoid.get('server-new')?.live, true);
    assert.equal(byMoid.get('server-new')?.daemonPid, process.pid);
    assert.equal(byMoid.get('server-old')?.live, false, 'frames on disk are history, not a recorder');
  });

  it('lists history even when no daemon is running', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'server-old'), { recursive: true });
    const client = new RecorderClient(BASE, root, { port: await freePort(), spawnDaemon: () => {} });
    const list = await client.list();
    assert.deepEqual(
      list.map((r) => [r.serverMoid, r.live]),
      [['server-old', false]]
    );
  });
});
