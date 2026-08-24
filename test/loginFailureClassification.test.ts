/**
 * The three-strike auto-login guard exists to protect the CISCO ID ACCOUNT from
 * being locked out by a wrong password retried in a loop. So it must only count
 * failures where an account-associated attempt actually happened.
 *
 * It did not. Field case, 2026-08-24: a daemon failed twice for purely mechanical
 * reasons — `locator.click: Timeout 30000ms exceeded` (the Sign In button was
 * still disabled under a loading overlay) and `Could not find the username field
 * on the Cisco ID login page`. Neither sent a single credential to anyone. The
 * guard counted both, hit its limit, and printed:
 *
 *   Intersight auto-login disabled after 3 consecutive failures.
 *
 * The result was the worst of both worlds: the account was never at risk, and the
 * daemon disarmed the only thing that could have recovered it, so it sat degraded
 * with no console until it gave up.
 *
 * The dividing line is whether a credential was submitted. Anything before that —
 * the page not loading, a button not being clickable, a field not being found,
 * even the username being submitted for IdP discovery — is a mechanical failure:
 * retry it, and leave the lockout budget alone. From the password onwards, count
 * it, because that is what a lockout policy counts.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  countsTowardAccountLockout,
  loginAttemptReach,
  lockoutExemptionReason,
} from '../src/utils/loginFailureClassification.js';

describe('did a login failure put the account at risk', () => {
  it('does not count a page that never got as far as the login form', () => {
    // The exact field case: the click timed out on a disabled button.
    const steps = ['opened intersight.com'];
    assert.equal(loginAttemptReach(steps), 'never-submitted');
    assert.equal(countsTowardAccountLockout(steps), false);
  });

  it('does not count getting as far as clicking Sign In with Cisco ID', () => {
    const steps = ['opened intersight.com', 'clicked "Sign In with Cisco ID"'];
    assert.equal(countsTowardAccountLockout(steps), false);
  });

  it('does not count the username alone, which is identity discovery not authentication', () => {
    // Identifier-first flows submit the username to find the IdP. No credential
    // has been verified, and lockout policies count failed sign-ins, not this.
    const steps = ['opened intersight.com', 'clicked "Sign In with Cisco ID"', 'entered username'];
    assert.equal(loginAttemptReach(steps), 'never-submitted');
    assert.equal(countsTowardAccountLockout(steps), false);
  });

  it('COUNTS a failure once the password has been submitted', () => {
    const steps = ['opened intersight.com', 'entered username', 'entered password'];
    assert.equal(loginAttemptReach(steps), 'password-submitted');
    assert.equal(countsTowardAccountLockout(steps), true);
  });

  it('COUNTS a failure once an MFA code has been submitted', () => {
    // A failed MFA challenge counts against the account under many policies.
    const steps = ['entered username', 'entered password', 'entered TOTP code'];
    assert.equal(loginAttemptReach(steps), 'mfa-submitted');
    assert.equal(countsTowardAccountLockout(steps), true);
  });

  it('COUNTS a retried TOTP in the next window', () => {
    const steps = ['entered password', 'retried TOTP code in next window'];
    assert.equal(countsTowardAccountLockout(steps), true);
  });

  it('does not count a failure with no steps recorded at all', () => {
    assert.equal(countsTowardAccountLockout([]), false);
    assert.equal(loginAttemptReach([]), 'never-submitted');
  });

  it('does not count the account-chooser stage, which is after authentication', () => {
    // Reaching the chooser means Cisco ID already accepted us; a failure there is
    // an Intersight/account-selection problem, not a credential one. It is only
    // counted if a credential was submitted in THIS attempt.
    const steps = ['session already valid', 'clicked account text "CHG-LAB-Intersight"'];
    assert.equal(countsTowardAccountLockout(steps), false);
  });

  it('explains an exemption in terms a log reader can act on', () => {
    const reason = lockoutExemptionReason(['opened intersight.com']);
    assert.ok(reason, 'a mechanical failure must be given a stated exemption');
    assert.match(reason, /credential|account/i);
    assert.ok(reason.length > 25, 'the log line has to stand on its own');
  });

  it('says nothing exempting when the failure does count', () => {
    assert.equal(lockoutExemptionReason(['entered password']), null);
  });

  it('tolerates step wording drifting in case and punctuation', () => {
    // These strings are ours, but they get edited; the classifier must not become
    // silently permissive because a capital letter changed.
    assert.equal(countsTowardAccountLockout(['Entered Password']), true);
    assert.equal(countsTowardAccountLockout(['entered TOTP']), true);
  });
});
