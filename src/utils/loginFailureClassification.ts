/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * How far did a failed login attempt get — did it submit a credential at all?
 *
 * This is a LABEL, not a budget. It used to drive a three-strike guard that
 * counted only credential failures and let "mechanical" ones (the page not
 * loading, a button not clickable, a field not found) retry freely — the right
 * idea for the Cisco ID password lockout it was designed around, and the wrong
 * one for what actually locked the account: Intersight's own limit on logins,
 * which counts every attempt the same. ~950 of the ~1,050 attempts on
 * 2026-09-26 were mechanical. So now every failure disarms automatic login (see
 * loginPolicy.ts), and the classification only tells the reader where to look:
 * a mechanical failure points at the page (screenshot, stepsCompleted), a
 * credential failure points at the credentials.
 *
 * The dividing line is credential submission. Everything before it, even the
 * username being submitted for IdP discovery, is mechanical: no sign-in was
 * verified and none failed.
 */

/** How far into authentication an attempt actually got. */
export type LoginAttemptReach = 'never-submitted' | 'password-submitted' | 'mfa-submitted';

/** Steps the login flow records as it progresses. Matched loosely on purpose. */
const PASSWORD_STEP = /entered\s+password/i;
const MFA_STEP = /(entered|retried)\s+totp/i;

export function loginAttemptReach(steps: readonly string[]): LoginAttemptReach {
  if (steps.some((s) => MFA_STEP.test(s))) {
    return 'mfa-submitted';
  }
  if (steps.some((s) => PASSWORD_STEP.test(s))) {
    return 'password-submitted';
  }
  // Includes 'entered username': identifier-first flows submit it to discover the
  // identity provider, which verifies no credential and fails no sign-in.
  return 'never-submitted';
}

/**
 * Could this failure have counted against the Cisco ID account's own lockout?
 *
 * Only when a credential was submitted in THIS attempt. A failure at the account
 * chooser, for instance, happens after Cisco ID has already accepted us — it is
 * an Intersight problem, not a credential one.
 */
export function countsTowardAccountLockout(steps: readonly string[]): boolean {
  return loginAttemptReach(steps) !== 'never-submitted';
}

/**
 * Why a failure is labelled mechanical, for the log line — or null when a
 * credential was submitted. The label changes nothing about what happens next
 * (every failure disarms automatic login); it tells the reader where to look.
 */
export function lockoutExemptionReason(steps: readonly string[]): string | null {
  if (countsTowardAccountLockout(steps)) {
    return null;
  }
  return (
    'no credential was submitted, so the Cisco ID account itself was not touched; ' +
    'the failure is in the page or the flow (see the screenshot and stepsCompleted)'
  );
}
