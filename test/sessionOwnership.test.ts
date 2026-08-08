/**
 * Which vKVM sessions may we end, and which must we never touch?
 *
 * Established live against Intersight:
 *  - Every kvm.Session references the iam.Session that created it, but two
 *    agents sharing one browser produce the SAME iam.Session — so identity
 *    alone cannot separate them. Verified: my session and another agent's both
 *    carried iam.Session 6a761611...
 *  - DELETE on kvm.Session returns 403 "Operation not supported"; the working
 *    call is PATCH {"Status":"Ended"}.
 *  - Killing a session that a LIVE recorder is watching makes it relaunch and
 *    then escalate to a 90-second Tunneled vKVM reset. Observed. So recorder
 *    liveness, not identity, is the decisive input.
 *
 * The daemon is the single authority for its own server, which is what makes
 * ending a session safe at all — there is nobody left to fight with.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifySession, type SessionFacts } from '../src/recorder/sessionOwnership.js';

const OURS = '6a761611756461330102fa8e';
const NOW = 2_000_000_000_000;

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionMoid: '6a7686906e756d3201a7606e',
    iamSessionMoid: OURS,
    userIdOrEmail: 'danny.k@quali.com',
    ourIamSessionMoid: OURS,
    ourUserIdOrEmail: 'danny.k@quali.com',
    hasAdoptableTab: false,
    liveRecorderElsewhere: false,
    weAreTheAuthority: true,
    createdAt: NOW - 60_000,
    now: NOW,
    ...overrides,
  };
}

describe('classifySession', () => {
  it('reuses a session that still has a live client tab', () => {
    const c = classifySession(facts({ hasAdoptableTab: true }));
    assert.equal(c.verdict, 'reuse');
    assert.equal(c.mayEnd, false);
  });

  it('shares rather than kills when another live recorder owns it', () => {
    // Two agents wanting the same server is a SHARING case, never a kill case.
    const c = classifySession(facts({ liveRecorderElsewhere: true, hasAdoptableTab: true }));
    assert.equal(c.verdict, 'share');
    assert.equal(c.mayEnd, false);
    assert.match(c.reason, /another/i);
  });

  it('will not end a session whose recorder is live even without a tab we can see', () => {
    // Its recorder may be mid-relaunch; ending it now starts the storm.
    const c = classifySession(facts({ liveRecorderElsewhere: true, hasAdoptableTab: false }));
    assert.equal(c.mayEnd, false);
  });

  it('ends an orphan: our login, no tab, no live recorder', () => {
    const c = classifySession(facts());
    assert.equal(c.verdict, 'orphan');
    assert.equal(c.mayEnd, true);
    assert.match(c.reason, /no client/i);
  });

  it('treats a session from a PREVIOUS login of ours as an orphan too', () => {
    // A browser restart mints a new iam.Session, so a stale one plus our user
    // and no live client is the classic leftover.
    const c = classifySession(facts({ iamSessionMoid: 'stale-iam-session-from-old-browser' }));
    assert.equal(c.verdict, 'orphan');
    assert.equal(c.mayEnd, true);
  });

  it('never ends another USER\'s session', () => {
    const c = classifySession(facts({ userIdOrEmail: 'someone.else@example.com', iamSessionMoid: 'theirs' }));
    assert.equal(c.verdict, 'foreign');
    assert.equal(c.mayEnd, false);
    assert.match(c.reason, /someone\.else@example\.com/);
  });

  it('never ends anything when we are not the authority for this server', () => {
    // Only the daemon holding the per-server lock may end sessions.
    for (const extra of [{}, { iamSessionMoid: 'stale' }]) {
      const c = classifySession(facts({ weAreTheAuthority: false, ...extra }));
      assert.equal(c.mayEnd, false, 'a non-authority must never end a session');
      assert.match(c.reason, /authority/i);
    }
  });

  it('leaves a very fresh session alone even with no tab yet', () => {
    // A session created seconds ago may belong to a client still mounting its
    // console; killing it would race a legitimate launch.
    const c = classifySession(facts({ createdAt: NOW - 3000 }));
    assert.equal(c.mayEnd, false);
    assert.match(c.reason, /too new/i);
  });
});
