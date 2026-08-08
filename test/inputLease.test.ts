/**
 * Only one client may type into a console at a time, and never during a
 * login/reset/recovery.
 *
 * Several MCP servers can now reach one console, so two agents typing at once
 * is a real hazard. It is NOT solved by queueing: a keystroke that lands 90
 * seconds late arrives on a screen that has changed, which is how a password
 * gets typed into a boot menu. So input fails fast with a reason instead.
 *
 * The busy states matter just as much. Three times this week an agent read "no
 * reaction" as "input is broken" — so a refusal has to say WHY and for how
 * long, rather than looking like silence.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { InputArbiter, LEASE_TTL_MS } from '../src/recorder/inputLease.js';

const NOW = 1_700_000_000_000;

function arbiter(start = NOW) {
  let now = start;
  const a = new InputArbiter(() => now);
  return { a, advance: (ms: number) => (now += ms) };
}

describe('InputArbiter', () => {
  it('grants a lease when the console is free', () => {
    const { a } = arbiter();
    const r = a.acquire('agent-a');
    assert.equal(r.granted, true);
    assert.ok(r.leaseId);
    assert.equal(a.holder(), 'agent-a');
  });

  it('refuses a second client while a lease is held, naming the holder', () => {
    const { a } = arbiter();
    a.acquire('agent-a');
    const r = a.acquire('agent-b');
    assert.equal(r.granted, false);
    assert.match(r.reason!, /agent-a/);
    assert.ok(r.retryAfterMs! > 0, 'a refusal must say when to try again');
  });

  it('re-grants to the SAME client, so a multi-step interaction is not blocked', () => {
    // press_until holds the console across many presses; its own follow-up
    // calls must not deadlock against its own lease.
    const { a } = arbiter();
    const first = a.acquire('agent-a');
    const again = a.acquire('agent-a');
    assert.equal(again.granted, true);
    assert.equal(again.leaseId, first.leaseId, 'the same client keeps one lease');
  });

  it('expires a lease whose holder went away, so one dead agent cannot lock a console forever', () => {
    const { a, advance } = arbiter();
    a.acquire('agent-a');
    advance(LEASE_TTL_MS + 1);
    const r = a.acquire('agent-b');
    assert.equal(r.granted, true);
    assert.equal(a.holder(), 'agent-b');
  });

  it('keeps a lease alive while its holder keeps using it', () => {
    const { a, advance } = arbiter();
    a.acquire('agent-a');
    advance(LEASE_TTL_MS - 100);
    a.acquire('agent-a'); // renews
    advance(LEASE_TTL_MS - 100);
    const r = a.acquire('agent-b');
    assert.equal(r.granted, false, 'an actively renewed lease must not expire under the holder');
  });

  it('releases immediately when the holder is done', () => {
    const { a } = arbiter();
    const { leaseId } = a.acquire('agent-a');
    a.release(leaseId!);
    assert.equal(a.holder(), null);
    assert.equal(a.acquire('agent-b').granted, true);
  });

  it('ignores a release from someone who does not hold the lease', () => {
    const { a } = arbiter();
    a.acquire('agent-a');
    a.release('not-a-real-lease-id');
    assert.equal(a.holder(), 'agent-a', 'a stray release must not free another client\'s lease');
  });

  it('refuses input while busy, saying what and for how long', () => {
    const { a } = arbiter();
    a.setBusy('logging in to Intersight', 30_000);
    const r = a.acquire('agent-a');
    assert.equal(r.granted, false);
    assert.match(r.reason!, /logging in/i);
    assert.ok(r.retryAfterMs! > 0);
    assert.equal(a.busy()?.what, 'logging in to Intersight');
  });

  it('accepts input again once the busy state clears', () => {
    const { a } = arbiter();
    a.setBusy('resetting Tunneled vKVM', 90_000);
    assert.equal(a.acquire('agent-a').granted, false);
    a.clearBusy();
    assert.equal(a.acquire('agent-a').granted, true);
  });

  it('clears a busy state that outlived its estimate rather than blocking forever', () => {
    // A crashed reset must not make a console permanently unusable.
    const { a, advance } = arbiter();
    a.setBusy('resetting Tunneled vKVM', 1000);
    advance(60_000);
    assert.equal(a.acquire('agent-a').granted, true);
    assert.equal(a.busy(), null);
  });
});
