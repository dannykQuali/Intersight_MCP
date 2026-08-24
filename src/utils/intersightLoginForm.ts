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
 * The Intersight sign-in page, as it is now — email FIRST, then the button.
 *
 * Captured live on 2026-08-24 after a login sat doing nothing:
 *
 *   ucs-input            > … > input#input[name="Email"][type="text"]
 *   ucs-button#submitButton  "Sign In with Cisco ID"    <- disabled until filled
 *   ---- Or ----
 *   ucs-input#ssoEmail   > … > input#input[name="sso-email"]
 *   ucs-button               "Sign In with SSO"
 *
 * Everything about the old flow was wrong for this page. It clicked the button
 * before typing anything, so the button was disabled and the click could never
 * land; and its username selectors looked for `name="email"` / `type="email"`,
 * neither of which matches `name="Email"` / `type="text"` — CSS attribute values
 * are case-sensitive, which is why the failure read "Could not find the username
 * field" and pointed at the wrong thing.
 *
 * There are also TWO email boxes now. Typing a Cisco ID address into the SSO one
 * starts a different login, so the choice is made deliberately here rather than
 * by taking the first match.
 */

/** What is known about a candidate input, from the DOM or from Playwright. */
export interface EmailFieldLike {
  name?: string | null;
  id?: string | null;
  type?: string | null;
  placeholder?: string | null;
}

/** The "Sign In with SSO" box — a different flow, never the one we want. */
export function isSsoEmailField(field: EmailFieldLike): boolean {
  return /sso/i.test(field.name ?? '') || /sso/i.test(field.id ?? '');
}

/** Does this look like an email/username box at all? */
function looksLikeEmailField(field: EmailFieldLike): boolean {
  if ((field.type ?? '').toLowerCase() === 'email') {
    return true;
  }
  const hints = `${field.name ?? ''} ${field.placeholder ?? ''}`;
  // 'identifier' is Okta's name for it, kept for the id.cisco.com pages.
  return /email|username|identifier/i.test(hints);
}

/**
 * Index of the box to type the Cisco ID address into, or null.
 *
 * Returns null rather than guessing: with no recognisable Cisco ID field, failing
 * loudly beats starting the SSO flow with the wrong address.
 */
export function pickCiscoIdEmailField(fields: readonly EmailFieldLike[]): number | null {
  const index = fields.findIndex((f) => looksLikeEmailField(f) && !isSsoEmailField(f));
  return index >= 0 ? index : null;
}

/**
 * Selectors for that box, most specific first.
 *
 * Playwright's CSS engine pierces open shadow roots, so an attribute selector
 * reaches the input inside `ucs-input` without naming the shadow path. The `i`
 * flag is what makes `name="Email"` match — the previous list did not.
 */
export const CISCO_ID_EMAIL_SELECTORS = [
  'input[name="Email" i]:not([name*="sso" i])',
  'ucs-input:not(#ssoEmail) input[type="text"]',
  'input[name="identifier"]',
  'input[type="email"]:not([name*="sso" i])',
  '#okta-signin-username',
];
