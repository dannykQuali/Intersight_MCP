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
 * Is the "Sign In with Cisco ID" button actually ready to be clicked?
 *
 * Asked because clicking it too early cost a real login. From a recorder's log,
 * 2026-08-24 15:09:
 *
 *   locator resolved to <ucs-button disabled ... id="submitButton" ...>
 *   57 x ... <div class="login-container">...</div> intercepts pointer events
 *   locator.click: Timeout 30000ms exceeded.
 *
 * Two faults at once. The button carries a `disabled` ATTRIBUTE while the widget
 * boots, and because it is a custom element Playwright's own enabled-check does
 * not see that (it understands native form controls and `aria-disabled`, not a
 * bare attribute on a `ucs-button`). Meanwhile the page's loading overlay,
 * `div.login-container`, covers it, so every hit test fails and the click burns
 * its full 30-second timeout. The operator watching saw a spinner on the button
 * for about a minute; the daemon saw a dead login and retried into a
 * half-initialised page, where the username field never appeared either.
 *
 * Waiting is cheap and clicking early is not, so readiness is decided here and
 * every blocker is NAMED — "not ready" on its own leaves the next person to
 * reverse-engineer a 57-line Playwright retry log.
 */

/** What the page reports about the button. `null` = no such element. */
export interface LoginButtonState {
  /** The `disabled` attribute is present. */
  disabled: boolean;
  /** The `aria-disabled` attribute's value, if any. */
  ariaDisabled: string | null;
  /**
   * What sits on top of the button's centre point, if anything but the button
   * itself, as a readable identity like `div.login-container`.
   */
  coveredBy: string | null;
}

/** Human-readable reasons the button cannot be clicked yet. */
export function loginButtonBlockers(state: LoginButtonState | null): string[] {
  if (!state) {
    return ['the Sign In with Cisco ID button was not found on the page'];
  }
  const blockers: string[] = [];
  if (state.disabled) {
    blockers.push('it still carries a `disabled` attribute (the login widget is still booting)');
  }
  if ((state.ariaDisabled ?? '').toLowerCase() === 'true') {
    blockers.push('it is marked `aria-disabled="true"`');
  }
  if (state.coveredBy) {
    blockers.push(`\`${state.coveredBy}\` covers it, so a click cannot reach it`);
  }
  return blockers;
}

export function isLoginButtonReady(state: LoginButtonState | null): boolean {
  return loginButtonBlockers(state).length === 0;
}

/**
 * Read that state from inside the page.
 *
 * Coverage is decided by a HIT TEST at the button's centre, which is exactly the
 * check Playwright fails on — the difference is that this lets us wait for the
 * overlay to clear instead of spending a click timeout discovering it. The
 * button's own subtree (a custom element paints its own inner div, and may do so
 * in a shadow root) is never treated as a cover.
 */
export function loginButtonStatePageScript(
  domSelector = '#submitButton',
  label = 'Sign In with Cisco ID'
): string {
  return `(() => {
  // Found in the page rather than handed in: the caller locates the button with
  // a Playwright text selector (\`:text("Sign In with Cisco ID")\`), which is not
  // valid DOM CSS, so the same choice is reproduced here — the id the login page
  // uses, then anything that carries the label.
  const el = document.querySelector(${JSON.stringify(domSelector)}) ||
    [...document.querySelectorAll('button, a, ucs-button, [role=button]')]
      .find((n) => new RegExp(${JSON.stringify(label)}, 'i').test((n.textContent || '').trim())) || null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { disabled: true, ariaDisabled: null, coveredBy: 'a zero-sized box (not laid out yet)' };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const name = (n) => {
    if (!n || !n.tagName) return 'something unidentifiable';
    const cls = (n.className && n.className.toString().trim().split(/\s+/)[0]) || '';
    return n.tagName.toLowerCase() + (n.id ? '#' + n.id : cls ? '.' + cls : '');
  };
  // The button itself, an ancestor of it, or anything inside it (including its
  // shadow DOM) all count as "the button".
  let covered = null;
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    const root = el.shadowRoot;
    const mine = root && root.contains(top);
    if (!mine) covered = name(top);
  }
  return {
    disabled: el.hasAttribute('disabled'),
    ariaDisabled: el.getAttribute('aria-disabled'),
    coveredBy: covered,
  };
})()`;
}

/**
 * Click the button from inside the page, as a last resort.
 *
 * A programmatic click cannot be intercepted by an overlay, which is the failure
 * this exists for. It is only ever used AFTER the readiness wait, so the button
 * is enabled and the click means what it says — clicking a disabled button would
 * silently do nothing and look like success.
 *
 * `ucs-button` paints its own `div[role=button]` inside a shadow root and listens
 * there, so the inner control is clicked when present and the host otherwise.
 */
export function loginButtonClickPageScript(
  domSelector = '#submitButton',
  label = 'Sign In with Cisco ID'
): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(domSelector)}) ||
    [...document.querySelectorAll('button, a, ucs-button, [role=button]')]
      .find((n) => new RegExp(${JSON.stringify(label)}, 'i').test((n.textContent || '').trim())) || null;
  if (!el || el.hasAttribute('disabled')) return false;
  const inner = el.shadowRoot && el.shadowRoot.querySelector('[role=button], button, #button');
  const target = inner || el;
  if (typeof target.click !== 'function') return false;
  target.click();
  return true;
})()`;
}
