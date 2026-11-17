/**
 * When may the daemon perform a Cisco ID web login at all?
 *
 * Every web login is a liability now. Twice in a month the account was locked
 * out of Intersight after bursts of automated logins — 2026-09-26 (~1,050
 * attempts from several processes logging in against each other) and again on
 * 2026-10-21 — and each time the fix was an administrator removing and re-adding
 * the user, which also revokes every API key and costs a day of work. The
 * safest login is the one that never happens, so the policy is:
 *
 *   1. One attempt per need, never a retry. A failed attempt DISARMS automatic
 *      login until a human (or an agent on their behalf) explicitly asks again.
 *   2. After a success, no login until the session is PROVEN gone. A failed API
 *      ping is not proof; the sign-in page is.
 *   3. No recorder needing a console, no login. Not from the keepalive, not from
 *      an idle daemon, not from browser_open.
 *
 * The policy is pure so every rule can be pinned here without a browser.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LoginPolicy } from '../src/services/loginPolicy.js';

function policyWith(opts: { recorders?: number; now?: () => number } = {}) {
  let recorders = opts.recorders ?? 1;
  const policy = new LoginPolicy({ activeRecorders: () => recorders, now: opts.now });
  return { policy, setRecorders: (n: number) => (recorders = n) };
}

const failed = (trigger: 'recorder' | 'explicit' = 'recorder') =>
  ({ outcome: 'failed', trigger, error: 'Could not find the username field', failureKind: 'mechanical' }) as const;

describe('rule 1: one attempt per need, never a retry', () => {
  it('allows the first attempt when a recorder needs a console and the session is proven gone', () => {
    const { policy } = policyWith();
    const d = policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' });
    assert.equal(d.verdict, 'attempt');
  });

  it('disarms automatic login after ONE failed attempt, whatever kind of failure it was', () => {
    // The old three-strike guard exempted "mechanical" failures (no credential
    // sent) and let them retry freely. ~950 of the 26-Sep attempts were exactly
    // that kind. Intersight's lockout counts them all the same.
    const { policy } = policyWith();
    policy.recordAttempt(failed());
    const d = policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' });
    assert.equal(d.verdict, 'refused');
    assert.match(d.reason, /failed/i);
    assert.match(d.reason, /browser_login/, 'the way back must be named');
    assert.equal(policy.state().armed, false);
  });

  it('keeps refusing recorder-driven attempts no matter how often they ask', () => {
    const { policy } = policyWith();
    policy.recordAttempt(failed());
    for (let i = 0; i < 50; i++) {
      assert.equal(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }).verdict, 'refused');
    }
  });

  it('lets an explicit request try exactly once more', () => {
    const { policy } = policyWith();
    policy.recordAttempt(failed());
    assert.equal(policy.decide({ trigger: 'explicit', evidence: 'proven-logged-out' }).verdict, 'attempt');
    policy.recordAttempt(failed('explicit'));
    // Still disarmed for the automatic path: the explicit attempt failed too.
    assert.equal(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }).verdict, 'refused');
  });

  it('re-arms on success', () => {
    const { policy } = policyWith();
    policy.recordAttempt(failed());
    policy.recordAttempt({ outcome: 'succeeded', trigger: 'explicit' });
    assert.equal(policy.state().armed, true);
    assert.equal(policy.state().failuresSinceSuccess, 0);
  });
});

describe('rule 2: after a success, no login until the session is proven gone', () => {
  it('needs no login while the session is valid, whoever asks', () => {
    const { policy } = policyWith();
    for (const trigger of ['recorder', 'explicit'] as const) {
      const d = policy.decide({ trigger, evidence: 'valid' });
      assert.equal(d.verdict, 'no-login-needed');
    }
  });

  it('refuses to log in over a session whose state is merely unknown', () => {
    // A network blip, a 5xx, a timeout: none of these prove the session is dead,
    // and logging in over a live session is a second login for nothing.
    const { policy } = policyWith();
    for (const trigger of ['recorder', 'explicit'] as const) {
      const d = policy.decide({ trigger, evidence: 'unknown' });
      assert.equal(d.verdict, 'refused', `${trigger} must not log in on inconclusive evidence`);
      assert.match(d.reason, /inconclusive|not proven|unknown/i);
    }
  });

  it('allows a login again once the session is proven gone after a success', () => {
    const { policy } = policyWith();
    policy.recordAttempt({ outcome: 'succeeded', trigger: 'recorder' });
    assert.equal(policy.decide({ trigger: 'recorder', evidence: 'valid' }).verdict, 'no-login-needed');
    assert.equal(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }).verdict, 'attempt');
  });

  it('a valid session wins over every other consideration', () => {
    // Disarmed and no recorders: still nothing to do, and nothing to refuse.
    const { policy } = policyWith({ recorders: 0 });
    policy.recordAttempt(failed());
    assert.equal(policy.decide({ trigger: 'explicit', evidence: 'valid' }).verdict, 'no-login-needed');
  });
});

describe('rule 3: no recorder needing a console, no login', () => {
  it('refuses every trigger while no recorder is active', () => {
    const { policy } = policyWith({ recorders: 0 });
    for (const trigger of ['recorder', 'explicit'] as const) {
      const d = policy.decide({ trigger, evidence: 'proven-logged-out' });
      assert.equal(d.verdict, 'refused');
      assert.match(d.reason, /recorder/i);
      assert.match(d.reason, /vkvm_record_start|launch_vkvm_session/, 'say how a login does get to happen');
    }
  });

  it('allows a login as soon as a recorder needs one', () => {
    const { policy, setRecorders } = policyWith({ recorders: 0 });
    assert.equal(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }).verdict, 'refused');
    setRecorders(1);
    assert.equal(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }).verdict, 'attempt');
  });
});

/**
 * browser_login is an agent asking for a session for its own needs (an API call
 * through the browser session, say), with no console in sight. It gets ONE
 * login, under every rule but the recorder one — and nothing it does may lead
 * to another login by itself: no recorder needs a console, so no other trigger
 * may log in when that session later expires or is logged out.
 */
describe('an on-demand login (browser_login) needs no recorder', () => {
  const ON_DEMAND = 'on-demand' as const;

  it('is allowed with no recorder when the session is proven gone', () => {
    const { policy } = policyWith({ recorders: 0 });
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'attempt');
  });

  it('still never logs in over a valid or merely unknown session', () => {
    const { policy } = policyWith({ recorders: 0 });
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'valid' }).verdict, 'no-login-needed');
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'unknown' }).verdict, 'refused');
  });

  it('does not open the door for any other trigger after it succeeds', () => {
    // The one-time login must not become a standing licence: once that session
    // is gone, nothing but another explicit request (or a recorder) logs in.
    const { policy } = policyWith({ recorders: 0 });
    policy.recordAttempt({ outcome: 'succeeded', trigger: ON_DEMAND });
    for (const trigger of ['recorder', 'explicit'] as const) {
      const d = policy.decide({ trigger, evidence: 'proven-logged-out' });
      assert.equal(d.verdict, 'refused', `${trigger} must not log in after a one-time login`);
    }
  });

  it('mentions itself as the way to a login when there is no recorder', () => {
    // browser_open with no recorder refuses; the agent must learn it has a door.
    const { policy } = policyWith({ recorders: 0 });
    assert.match(policy.decide({ trigger: 'explicit', evidence: 'proven-logged-out' }).reason, /browser_login/);
  });

  it('cools down after a failed attempt, so an agent looping on it cannot burn logins', () => {
    let t = 1_700_000_000_000;
    const { policy } = policyWith({ recorders: 0, now: () => t });
    policy.recordAttempt({ ...failed(), trigger: ON_DEMAND });
    for (let i = 0; i < 20; i++) {
      const d = policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' });
      assert.equal(d.verdict, 'refused');
    }
    const d = policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' });
    assert.match(d.reason, /failed/i);
    const retryAt = new Date(t + LoginPolicy.ON_DEMAND_COOLDOWN_MS).toISOString();
    assert.ok(d.reason.includes(retryAt), `say when it may try again (${retryAt}): ${d.reason}`);
    assert.ok(policy.state().onDemandRetryAfter, 'browser_status must show the cooldown too');

    t += LoginPolicy.ON_DEMAND_COOLDOWN_MS - 1;
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'refused');
    t += 1;
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'attempt');
    assert.equal(policy.state().onDemandRetryAfter, null);
  });

  it('cools down after a failure of any trigger, not only its own', () => {
    // Intersight counts every login against the user, whoever made it.
    const { policy } = policyWith({ recorders: 0, now: () => 1_700_000_000_000 });
    policy.recordAttempt(failed('recorder'));
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'refused');
  });

  it('has no cooldown after a success', () => {
    // The proof rule already stops a login over a valid session; a session that
    // really did end deserves its one login.
    const { policy } = policyWith({ recorders: 0 });
    policy.recordAttempt(failed('recorder'));
    policy.recordAttempt({ outcome: 'succeeded', trigger: 'recorder' });
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'attempt');
  });

  it('with a recorder active, keeps the explicit re-arm with no cooldown', () => {
    const { policy } = policyWith({ recorders: 1 });
    policy.recordAttempt(failed());
    assert.equal(policy.decide({ trigger: ON_DEMAND, evidence: 'proven-logged-out' }).verdict, 'attempt');
  });
});

describe('what the policy reports', () => {
  it('explains every refusal, because a silent refusal looks like a hang', () => {
    const { policy } = policyWith({ recorders: 0 });
    const refusals = [
      policy.decide({ trigger: 'recorder', evidence: 'unknown' }),
      policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }),
    ];
    policy.recordAttempt(failed());
    refusals.push(policy.decide({ trigger: 'recorder', evidence: 'proven-logged-out' }));
    for (const d of refusals) {
      assert.equal(d.verdict, 'refused');
      assert.ok(d.reason.length > 30, `a refusal needs a usable reason, got "${d.reason}"`);
    }
  });

  it('records when and why the last attempt happened, so a lockout can be traced', () => {
    let t = 1_700_000_000_000;
    const { policy } = policyWith({ now: () => t });
    policy.recordAttempt(failed());
    const s = policy.state();
    assert.equal(s.attempts, 1);
    assert.equal(s.failuresSinceSuccess, 1);
    assert.equal(s.lastAttempt?.at, new Date(t).toISOString());
    assert.equal(s.lastAttempt?.outcome, 'failed');
    assert.match(String(s.lastAttempt?.error), /username field/);
    assert.match(String(s.disabledReason), /username field/, 'the reason must carry the error');
    t += 60_000;
    policy.recordAttempt({ outcome: 'succeeded', trigger: 'explicit' });
    assert.equal(policy.state().attempts, 2);
    assert.equal(policy.state().lastAttempt?.outcome, 'succeeded');
    assert.equal(policy.state().disabledReason, null);
  });

  it('counts the recorders it was told about', () => {
    const { policy, setRecorders } = policyWith({ recorders: 3 });
    assert.equal(policy.state().activeRecorders, 3);
    setRecorders(0);
    assert.equal(policy.state().activeRecorders, 0);
  });
});
