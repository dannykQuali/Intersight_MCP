/**
 * The daemon's control endpoint, exercised over a real socket.
 *
 * Frames and status travel by filesystem (no protocol needed); only ACTIONS come
 * through here. The rules it must enforce: console-mutating actions require the
 * input lease, refusals explain themselves, and reads are always allowed so a
 * status check never blocks behind another agent's typing.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { ControlServer } from '../src/recorder/controlServer.js';
import { InputArbiter } from '../src/recorder/inputLease.js';

const servers: ControlServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
  }
});

async function start(overrides: Partial<ConstructorParameters<typeof ControlServer>[0]> = {}) {
  const arbiter = overrides.arbiter ?? new InputArbiter();
  const contacts: string[] = [];
  const typed: string[] = [];
  const server = new ControlServer({
    arbiter,
    onClientContact: (id) => contacts.push(id),
    readActions: { status: async () => ({ state: 'recording' }) },
    inputActions: {
      sendKeys: async (p) => {
        typed.push(String(p?.text ?? ''));
        return { sent: p?.text ?? '' };
      },
      boom: async () => {
        throw new Error('handler exploded');
      },
    },
    ...overrides,
  });
  servers.push(server);
  const port = await server.listen();
  const call = async (action: string, payload: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { server, port, call, arbiter, contacts, typed };
}

describe('ControlServer', () => {
  it('binds a loopback port the OS chooses', async () => {
    const { port } = await start();
    assert.ok(port > 0, 'a real port must be reported so clients can discover it');
  });

  it('performs a read action without needing a lease', async () => {
    const { call } = await start();
    const r = await call('status', { clientId: 'agent-a' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result, { state: 'recording' });
  });

  it('performs an input action and grants the lease implicitly', async () => {
    const { call, typed, arbiter } = await start();
    const r = await call('sendKeys', { clientId: 'agent-a', text: 'hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(typed, ['hello']);
    assert.equal(arbiter.holder(), 'agent-a');
  });

  it('refuses a second client\'s input with 409 and an explanation', async () => {
    const { call } = await start();
    await call('sendKeys', { clientId: 'agent-a', text: 'first' });
    const r = await call('sendKeys', { clientId: 'agent-b', text: 'second' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /agent-a/);
    assert.ok(r.body.retryAfterMs >= 0, 'the caller must be told when to retry');
  });

  it('still answers reads while another client holds the lease', async () => {
    // A status check must never block behind someone else's typing.
    const { call } = await start();
    await call('sendKeys', { clientId: 'agent-a', text: 'x' });
    const r = await call('status', { clientId: 'agent-b' });
    assert.equal(r.status, 200);
  });

  it('refuses input while the daemon is busy, naming the task', async () => {
    const arbiter = new InputArbiter();
    arbiter.setBusy('resetting Tunneled vKVM', 90_000);
    const { call } = await start({ arbiter });
    const r = await call('sendKeys', { clientId: 'agent-a', text: 'x' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /resetting Tunneled vKVM/);
    assert.equal(r.body.busy.what, 'resetting Tunneled vKVM');
  });

  it('reports unknown actions as 404 rather than hanging', async () => {
    const { call } = await start();
    const r = await call('doTheThing', { clientId: 'agent-a' });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /unknown action/i);
  });

  it('turns a handler failure into a 500 with the message, not a dropped connection', async () => {
    const { call } = await start();
    const r = await call('boom', { clientId: 'agent-a' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /exploded/);
  });

  it('records every client contact, which is what keeps a recorder awake', async () => {
    const { call, contacts } = await start();
    await call('status', { clientId: 'agent-a' });
    await call('sendKeys', { clientId: 'agent-b', text: 'x' });
    assert.deepEqual(contacts, ['agent-a', 'agent-b']);
  });

  it('survives a malformed body', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 200, 'a garbled payload must not take the daemon down');
  });

  it('stops listening after close', async () => {
    const { server, port } = await start();
    await server.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/status`, { method: 'POST', body: '{}' }));
  });

});
