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
 * When may the daemon perform a Cisco ID web login at all?
 *
 * Every web login is a liability. Twice in a month bursts of automated logins
 * locked the account out of Intersight: on 2026-09-26 (~1,050 attempts in one
 * morning, from a retry in a fresh TOTP window, a keepalive that re-logged-in
 * with `force`, and "mechanical" failures that never counted against the old
 * three-strike guard) and again on 2026-10-21. Each time the only fix was an
 * administrator removing and re-adding the user, which also revokes every API
 * key and costs a day of work. The safest login is the one that never happens,
 * so this policy allows one only when all three rules agree:
 *
 *   1. One attempt per need, NEVER a retry. A failed attempt — of any kind;
 *      Intersight's lockout does not care whether a credential was sent —
 *      disarms automatic login until an explicit `browser_login` asks for
 *      exactly one more attempt.
 *   2. After a success, no login again until the session is PROVEN gone: the
 *      Intersight sign-in page is showing. A failed API ping is not proof (a
 *      blip, a 5xx, a timeout, the bare origin that always 401s), and logging in
 *      over a live session is a second login for nothing.
 *   3. No recorder needing a console, no login. Not from the keepalive, not from
 *      an idle daemon, not from `browser_open`. A login only ever happens because
 *      a recorder needs its console.
 *
 * Pure — no browser, no clock unless injected — so every rule is pinned by unit
 * tests, and BrowserService.ensureLoggedIn is the one place that consults it.
 */

/** Who is asking for a login. Only an explicit request may re-arm after a failure. */
export type LoginTrigger = 'recorder' | 'explicit';

/**
 * What is known about the browser's Intersight session. Only
 * 'proven-logged-out' (the sign-in page was seen) can justify a login.
 */
export type SessionEvidence = 'valid' | 'proven-logged-out' | 'unknown';

export type LoginVerdict = 'attempt' | 'no-login-needed' | 'refused';

export interface LoginDecision {
  verdict: LoginVerdict;
  /** Always filled: a silent refusal looks like a hang to the agent reading it. */
  reason: string;
}

export interface LoginAttemptOutcome {
  outcome: 'succeeded' | 'failed';
  trigger: LoginTrigger;
  error?: string;
  /** 'mechanical' = no credential was submitted. Reported, but disarms all the same. */
  failureKind?: 'credential' | 'mechanical';
}

export interface LoginPolicyState {
  armed: boolean;
  disabledReason: string | null;
  lastAttempt: {
    at: string;
    outcome: 'succeeded' | 'failed';
    trigger: LoginTrigger;
    error?: string;
    failureKind?: string;
  } | null;
  /** Every attempt recorded since the process started, so a lockout can be traced. */
  attempts: number;
  failuresSinceSuccess: number;
  /** Recorders needing a console at the time of the call. */
  activeRecorders: number;
}

export class LoginPolicy {
  private readonly activeRecorders: () => number;
  private readonly now: () => number;
  private armed = true;
  private disabledReason: string | null = null;
  private lastAttempt: LoginPolicyState['lastAttempt'] = null;
  private attempts = 0;
  private failuresSinceSuccess = 0;

  constructor(opts: { activeRecorders: () => number; now?: () => number }) {
    this.activeRecorders = opts.activeRecorders;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Decide whether a login may happen now. The order matters: a valid session
   * needs nothing whatever else holds; inconclusive evidence is refused before
   * anything else is considered, because logging in over a possibly valid
   * session is exactly the needless login this exists to prevent.
   */
  decide(input: { trigger: LoginTrigger; evidence: SessionEvidence }): LoginDecision {
    if (input.evidence === 'valid') {
      return { verdict: 'no-login-needed', reason: 'the session is valid; no login is needed' };
    }
    if (input.evidence === 'unknown') {
      return {
        verdict: 'refused',
        reason:
          'The Intersight session state is inconclusive: the API ping failed, but a failed ping is not proof that the ' +
          'session is gone, and the sign-in page was not seen. No web login is made over a possibly valid session. ' +
          'Check browser_status, or retry later.',
      };
    }
    if (this.activeRecorders() <= 0) {
      return {
        verdict: 'refused',
        reason:
          'No recorder needs a console, so no web login is made: a login only ever happens for a recorder. ' +
          'Start one with vkvm_record_start or launch_vkvm_session, and it will log in once if the session is proven gone.',
      };
    }
    if (!this.armed && input.trigger === 'recorder') {
      return {
        verdict: 'refused',
        reason: this.disabledReason ?? 'Automatic login is disabled. Call browser_login to try exactly once more.',
      };
    }
    // An explicit request is allowed while disarmed: that IS the re-arm, and it
    // gets exactly one attempt — recordAttempt decides what follows.
    return { verdict: 'attempt', reason: `a ${input.trigger} login is allowed: the session is proven gone` };
  }

  /** Record what an attempt did. A failure disarms; a success re-arms. */
  recordAttempt(outcome: LoginAttemptOutcome): void {
    const at = new Date(this.now()).toISOString();
    this.attempts++;
    this.lastAttempt = {
      at,
      outcome: outcome.outcome,
      trigger: outcome.trigger,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.failureKind !== undefined ? { failureKind: outcome.failureKind } : {}),
    };
    if (outcome.outcome === 'succeeded') {
      this.armed = true;
      this.failuresSinceSuccess = 0;
      this.disabledReason = null;
      return;
    }
    this.armed = false;
    this.failuresSinceSuccess++;
    this.disabledReason =
      `Automatic login is disabled after a failed attempt at ${at} ` +
      `(${outcome.failureKind ?? 'unknown'} failure: ${outcome.error ?? 'no error message'}). ` +
      'Every web login is a single attempt now — bursts of them have locked this account out of Intersight — so ' +
      'nothing retries by itself. Call browser_login to try exactly once more, or log in manually in the browser window.';
  }

  state(): LoginPolicyState {
    return {
      armed: this.armed,
      disabledReason: this.disabledReason,
      lastAttempt: this.lastAttempt ? { ...this.lastAttempt } : null,
      attempts: this.attempts,
      failuresSinceSuccess: this.failuresSinceSuccess,
      activeRecorders: this.activeRecorders(),
    };
  }
}
