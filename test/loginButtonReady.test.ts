/**
 * The "Sign In with Cisco ID" button must not be clicked before the login page
 * is ready.
 *
 * Live failure, 2026-08-24 15:09, from a recorder daemon's own log:
 *
 *   waiting for locator(':text("Sign In with Cisco ID")').first()
 *     - locator resolved to <ucs-button disabled ... id="submitButton" ...>
 *   - attempting click action
 *     57 x waiting for element to be visible, enabled and stable
 *        - <div class="login-container">...</div> intercepts pointer events
 *      - retrying click action
 *   locator.click: Timeout 30000ms exceeded.
 *
 * Two things went wrong at once, and both are visible in that log:
 *
 *  1. The button carried a `disabled` ATTRIBUTE while the widget booted. It is a
 *     custom element (`ucs-button`), and Playwright's "enabled" actionability
 *     check only understands native form controls and `aria-disabled` — so it
 *     believed the button was clickable.
 *  2. The page's own loading overlay, `div.login-container`, sat on top of it, so
 *     every hit test failed and Playwright burned its whole 30s click timeout
 *     retrying. The operator saw this as "the Sign in with Cisco ID button showed
 *     a loading icon for about a minute", and the login attempt died.
 *
 * So readiness is decided here, before clicking, and every blocker is NAMED —
 * "not ready" alone would leave the next person reading a 57-line Playwright
 * retry log to work out why.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isLoginButtonReady,
  loginButtonBlockers,
  loginButtonClickPageScript,
  loginButtonStatePageScript,
} from '../src/utils/loginButtonReady.js';

describe('is the Cisco ID button ready to click', () => {
  it('accepts a live, uncovered button', () => {
    const state = { disabled: false, ariaDisabled: null, coveredBy: null };
    assert.equal(isLoginButtonReady(state), true);
    assert.deepEqual(loginButtonBlockers(state), []);
  });

  it('rejects a button that still carries the disabled attribute', () => {
    // The exact live case: <ucs-button disabled id="submitButton">.
    const state = { disabled: true, ariaDisabled: null, coveredBy: null };
    assert.equal(isLoginButtonReady(state), false);
    assert.match(loginButtonBlockers(state).join(' '), /disabled/i);
  });

  it('rejects aria-disabled, which is how a custom element usually says it', () => {
    const state = { disabled: false, ariaDisabled: 'true', coveredBy: null };
    assert.equal(isLoginButtonReady(state), false);
    assert.match(loginButtonBlockers(state).join(' '), /aria-disabled/i);
  });

  it('rejects a button under an overlay, and names the overlay', () => {
    // Naming it is the point: "div.login-container" told us the page was still
    // booting rather than that the selector was wrong.
    const state = { disabled: false, ariaDisabled: null, coveredBy: 'div.login-container' };
    assert.equal(isLoginButtonReady(state), false);
    assert.match(loginButtonBlockers(state).join(' '), /login-container/);
  });

  it('reports every blocker at once, not just the first', () => {
    // Both were true simultaneously in the field, and fixing one would have left
    // the other to burn the next attempt.
    const blockers = loginButtonBlockers({
      disabled: true,
      ariaDisabled: 'true',
      coveredBy: 'div.login-container',
    });
    assert.equal(blockers.length, 3, blockers.join(' | '));
  });

  it('treats a missing button as not ready rather than throwing', () => {
    assert.equal(isLoginButtonReady(null), false);
    assert.match(loginButtonBlockers(null).join(' '), /not (found|present)/i);
  });
});

describe('the in-page readiness probe', () => {
  it('parses, and hit-tests the button rather than trusting its bounding box', () => {
    const script = loginButtonStatePageScript('#submitButton');
    assert.doesNotThrow(() => new Function(`return ${script}`), 'the page script must parse');
    assert.match(script, /elementFromPoint/, 'coverage can only be decided by a hit test');
    assert.match(script, /#submitButton/);
    assert.doesNotMatch(script, /import |require\(/, 'a page script cannot import anything');
  });

  it('finds the button by id OR by its label, mirroring the Playwright selectors', () => {
    // The caller locates it with `:text("Sign In with Cisco ID")`, which is not
    // valid DOM CSS, so the probe cannot simply reuse that selector.
    const script = loginButtonStatePageScript();
    assert.match(script, /#submitButton/);
    assert.match(script, /Sign In with Cisco ID/);
    assert.doesNotThrow(() => new Function(`return ${script}`));
  });

  it('treats the button’s own descendants as the button, not as a cover', () => {
    // A custom element paints its own inner div; that inner div being on top is
    // normal and must not read as an overlay.
    const script = loginButtonStatePageScript('#submitButton');
    assert.match(script, /contains|composedPath|shadowRoot/, 'must account for the element’s own subtree');
  });
});

describe('the in-page click fallback', () => {
  it('parses, and refuses to click a disabled button', () => {
    // Clicking a disabled button does nothing while looking like success, which
    // would turn a blocked login into a silent one.
    const script = loginButtonClickPageScript();
    assert.doesNotThrow(() => new Function(`return ${script}`));
    assert.match(script, /hasAttribute\('disabled'\)/);
  });

  it('clicks the inner control of a custom element, which is where it listens', () => {
    // ucs-button paints a div[role=button] in its shadow root; clicking only the
    // host can go unheard.
    const script = loginButtonClickPageScript();
    assert.match(script, /shadowRoot/);
    assert.match(script, /role=button/);
  });

  it('reports whether it actually clicked', () => {
    const script = loginButtonClickPageScript();
    assert.match(script, /return true/);
    assert.match(script, /return false/);
  });
});
