/**
 * A recorder must outlive the MCP server that started it, and be findable by
 * the next one.
 *
 * This is the property the whole daemon design exists for. MCP servers come and
 * go with every chat, fork and code reload; before this, an MCP restart killed
 * the browser and every console session with it — an agent in another window
 * lost its live sessions twice that way. Discovery is by filesystem so that a
 * brand-new MCP process, sharing nothing with the old one, still finds the
 * running recorder.
 *
 * A fake daemon stands in for the real one: what is under test is discovery,
 * liveness, takeover and the client's call path — not Intersight.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { acquireServerLock, readLock, pidAlive } from '../src/recorder/recorderLock.js';
import { RecorderClient, waitUntilNotStarting } from '../src/services/recorderClient.js';

const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A stand-in daemon: takes the lock, publishes its port, answers actions. */
async function fakeDaemon(dir: string, opts: { pid?: number } = {}) {
  const calls: Array<{ action: string; clientId: string }> = [];
  const server = http.createServer((req, res) => {
    const action = (req.url ?? '/').replace(/^\/+/, '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      calls.push({ action, clientId: payload.clientId });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { action, echoed: payload.echo ?? null } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  acquireServerLock(dir, { pid: opts.pid, controlPort: port });
  return { port, calls };
}

function tempRoot(): { root: string; dirFor: (moid: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-daemon-test-'));
  dirs.push(root);
  return { root, dirFor: (moid: string) => path.join(root, moid) };
}

/** The client's discovery rule, exercised directly against a temp root. */
function discover(dir: string): { live: boolean; port: number | null } {
  const lock = readLock(dir);
  if (!lock || !lock.controlPort || !pidAlive(lock.pid)) {
    return { live: false, port: null };
  }
  return { live: true, port: lock.controlPort };
}

const DEAD_PID = 999_999_998;

describe('recorder discovery across processes', () => {
  it('finds a live daemon through the filesystem alone', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-a');
    fs.mkdirSync(dir, { recursive: true });
    const { port } = await fakeDaemon(dir);

    // A brand-new MCP process shares nothing but the disk.
    const found = discover(dir);
    assert.equal(found.live, true);
    assert.equal(found.port, port, 'the port must be discoverable, not remembered');
  });

  it('does not report a daemon whose process is gone', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'recorder.lock'),
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), controlPort: 12345 })
    );
    assert.equal(discover(dir).live, false, 'a dead pid must not look like a live recorder');
  });

  it('lets a NEW daemon take over a dead one\'s server', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-c');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'recorder.lock'),
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), controlPort: 999 })
    );
    const { port } = await fakeDaemon(dir);
    const found = discover(dir);
    assert.equal(found.live, true);
    assert.equal(found.port, port);
    assert.equal(readLock(dir)?.pid, process.pid);
  });

  it('refuses to start a second daemon while one is live', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-d');
    fs.mkdirSync(dir, { recursive: true });
    await fakeDaemon(dir);
    // A second daemon attempt from a different pid must be turned away, or the
    // two would wipe each other's frames on start.
    const second = acquireServerLock(dir, { pid: DEAD_PID + 1 });
    assert.equal(second.acquired, false);
    assert.equal(second.heldByPid, process.pid);
  });

  it('carries a client identity on every call, so input can be arbitrated', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-e');
    fs.mkdirSync(dir, { recursive: true });
    const { port, calls } = await fakeDaemon(dir);

    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'mcp-1234-abc', echo: 'hi' }),
    });
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.result.echoed, 'hi');
    assert.equal(calls[0].clientId, 'mcp-1234-abc', 'the daemon must know which client is asking');
  });

  it('sees a dormant daemon as live and resumable, not as absent', async () => {
    const { dirFor } = tempRoot();
    const dir = dirFor('server-f');
    fs.mkdirSync(dir, { recursive: true });
    await fakeDaemon(dir);
    fs.writeFileSync(
      path.join(dir, 'dormant.json'),
      JSON.stringify({ dormantSince: new Date().toISOString(), resumable: true })
    );
    assert.equal(discover(dir).live, true, 'dormant is a phase of a LIVE daemon, not a dead one');
    assert.equal(fs.existsSync(path.join(dir, 'dormant.json')), true);
  });
});

/**
 * A freshly spawned daemon publishes its control port BEFORE its console is up
 * (deliberately: the port is how a client asks what is happening). So a client
 * that returns the moment the port appears reports "recording" for a console
 * that is still logging in — and its very next keystroke is refused as busy.
 *
 * Waiting for the phase to leave 'starting' is what makes the tool's answer
 * true. Timing out is NOT an error: a console that takes a long time to open is
 * still opening, and the caller gets the phase to prove it.
 */
describe('waiting for a spawned daemon to be ready', () => {
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
    // Between listen() and the first status handler a call can fail outright;
    // that is a reason to keep polling, not to fail the caller's tool call.
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
 * Spawning a daemon logs in, opens a vKVM session and takes the server's only
 * session slot — real side effects on a physical machine, caused by a question
 * about the past. It was worse than rude until recorders learned to adopt
 * existing frames: searching last night's campaign spawned a recorder whose
 * first act was to delete the frames being searched.
 */
describe('reads never spawn a recorder', () => {
  it('refuses, pointing at the frames on disk, when no daemon is live', async () => {
    const { root, dirFor } = tempRoot();
    const dir = dirFor('server-g');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f-000001.png'), 'not really a png');
    fs.writeFileSync(path.join(dir, 'f-000002.png'), 'not really a png');
    const client = new RecorderClient('https://intersight.example/api/v1', root);

    await assert.rejects(() => client.read('server-g', 'findText', { pattern: 'x' }), /2 frame\(s\)/);
    await assert.rejects(() => client.read('server-g', 'findText', { pattern: 'x' }), /vkvm_record_start/);
    assert.equal(fs.existsSync(path.join(dir, 'recorder.lock')), false, 'nothing may have been started');
    assert.equal(fs.existsSync(path.join(dir, 'daemon.log')), false, 'no daemon may have been spawned');
  });

  it('says plainly when there is no history at all', async () => {
    const { root } = tempRoot();
    const client = new RecorderClient('https://intersight.example/api/v1', root);
    await assert.rejects(() => client.read('server-h', 'timeline', {}), /no recorded frames/i);
  });

  it('serves the read from a live daemon when there is one', async () => {
    const { root, dirFor } = tempRoot();
    const dir = dirFor('server-i');
    fs.mkdirSync(dir, { recursive: true });
    const { calls } = await fakeDaemon(dir);
    const client = new RecorderClient('https://intersight.example/api/v1', root);

    const result = await client.read('server-i', 'timeline', { minutesAgo: 5 });
    assert.equal(result.action, 'timeline');
    assert.equal(calls[0].action, 'timeline');
  });
});

/**
 * A lock file is trusted evidence, so it must be self-correcting.
 *
 * Liveness is decided by asking the OS about the holder's pid — which is right
 * until the OS reuses that pid for something else. Then the lock looks live
 * forever, every call is routed to a port nobody is listening on, and that
 * server can never be recorded again: retrying re-reads the same lock and fails
 * the same way. A daemon that is merely BUSY still answers (its control server
 * is async), so a refused connection is good evidence the holder is gone.
 */
describe('a lock that points at nothing', () => {
  it('clears itself when the port refuses a connection, so a retry can start fresh', async () => {
    const { root, dirFor } = tempRoot();
    const dir = dirFor('server-j');
    fs.mkdirSync(dir, { recursive: true });
    // Our own pid, so the liveness check passes — exactly what pid reuse looks
    // like. The port is one nothing is listening on.
    const port = await freePort();
    acquireServerLock(dir, { pid: process.pid, controlPort: port });
    const client = new RecorderClient('https://intersight.example/api/v1', root);
    assert.equal(client.isLive('server-j'), true, 'the lock must look live to begin with');

    await assert.rejects(() => client.call('server-j', 'status'), /not answering|retry/i);
    assert.equal(readLock(dir), null, 'the unusable lock must be cleared');
    assert.equal(client.isLive('server-j'), false, 'so the next call spawns a fresh daemon');
  });

  it('leaves a lock alone when the daemon answers', async () => {
    const { root, dirFor } = tempRoot();
    const dir = dirFor('server-k');
    fs.mkdirSync(dir, { recursive: true });
    await fakeDaemon(dir);
    const client = new RecorderClient('https://intersight.example/api/v1', root);

    await client.call('server-k', 'status');
    assert.notEqual(readLock(dir), null, 'a working daemon must keep its lock');
  });
});

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
