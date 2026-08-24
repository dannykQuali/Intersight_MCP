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
 * Did a failed login attempt actually put the Cisco ID account at risk?
 *
 * The three-strike auto-login guard exists for exactly one purpose: stop a wrong
 * password being retried until the account locks. It therefore has no business
 * counting failures where no credential was ever sent.
 *
 * It did, and the cost was real. On 2026-08-24 a recorder failed twice for
 * mechanical reasons — `locator.click: Timeout 30000ms exceeded` (the Sign In
 * button was still `disabled` under the page's loading overlay) and then
 * `Could not find the username field` — and the guard disarmed automatic login:
 *
 *   Intersight auto-login disabled after 3 consecutive failures.
 *
 * The account had never been touched, and the daemon had just switched off the
 * one thing that could recover it, so it sat degraded with no console.
 *
 * The dividing line is credential submission. Everything before it (the page not
 * loading, a button not clickable, a field not found, even the username being
 * submitted for IdP discovery) is mechanical: retry freely, spend no budget. From
 * the password onwards, count it — that is what a lockout policy counts.
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
 * Should this failure count against the lockout guard?
 *
 * Only when a credential was submitted in THIS attempt. A failure at the account
 * chooser, for instance, happens after Cisco ID has already accepted us — it is
 * an Intersight problem, not a credential one.
 */
export function countsTowardAccountLockout(steps: readonly string[]): boolean {
  return loginAttemptReach(steps) !== 'never-submitted';
}

/**
 * Why a failure was exempted, for the log line — or null when it does count.
 *
 * Worth spelling out: "auto-login failed (1/3)" next to a click timeout is what
 * made the original behaviour look reasonable.
 */
export function lockoutExemptionReason(steps: readonly string[]): string | null {
  if (countsTowardAccountLockout(steps)) {
    return null;
  }
  return (
    'no credential was submitted, so this failure cannot lock the Cisco ID account ' +
    'and is not counted toward the auto-login lockout guard'
  );
}
