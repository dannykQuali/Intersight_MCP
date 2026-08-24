/**
 * The Intersight sign-in page changed shape, and the login flow was built for the
 * old one.
 *
 * Captured from the live page on 2026-08-24 (a failure screenshot plus a
 * shadow-DOM dump), the page now asks for the email FIRST:
 *
 *   ucs-input             > div#component-wrapper > div > input#input[name="Email"][type="text"]
 *   ucs-button#submitButton  "Sign In with Cisco ID"   <- disabled: true
 *   ---- Or ----
 *   ucs-input#ssoEmail    > div#component-wrapper > div > input#input[name="sso-email"]
 *   ucs-button               "Sign In with SSO"
 *
 * Three consequences, all of which bit:
 *
 *  1. "Sign In with Cisco ID" is disabled until a valid email is typed. It is not
 *     "still booting", so waiting for it to enable itself waits forever — the
 *     email has to be filled first.
 *  2. The old selectors miss the field entirely: it is `name="Email"` (capital E)
 *     with `type="text"`, while the flow looked for `name="email"` and
 *     `type="email"`. CSS attribute values are case-sensitive, so neither matched,
 *     which is why the log said "Could not find the username field".
 *  3. There are now TWO email boxes. Typing the Cisco ID address into the SSO one
 *     would start the wrong flow, so the choice has to be deliberate.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CISCO_ID_EMAIL_SELECTORS,
  isSsoEmailField,
  pickCiscoIdEmailField,
} from '../src/utils/intersightLoginForm.js';

/** The live page, as dumped over CDP. */
const LIVE_FIELDS = [
  { name: 'Email', type: 'text', placeholder: 'Email', id: 'input' },
  { name: 'sso-email', type: 'text', placeholder: 'Email', id: 'input' },
];

describe('choosing the Cisco ID email field', () => {
  it('picks the Cisco ID box from the live page, not the SSO one', () => {
    assert.equal(pickCiscoIdEmailField(LIVE_FIELDS), 0);
  });

  it('still picks it when the SSO box comes first in the DOM', () => {
    // Order is not a contract; the page may render either first.
    assert.equal(pickCiscoIdEmailField([LIVE_FIELDS[1], LIVE_FIELDS[0]]), 1);
  });

  it('never picks the SSO box, even when it is the only email on the page', () => {
    // Typing a Cisco ID address there starts a different login entirely, so
    // guessing is worse than failing.
    assert.equal(pickCiscoIdEmailField([LIVE_FIELDS[1]]), null);
    assert.equal(isSsoEmailField({ name: 'sso-email' }), true);
  });

  it('matches the field whatever case the page uses for the name', () => {
    // The break was exactly this: `name="Email"` against a selector for "email".
    for (const name of ['Email', 'email', 'EMAIL', 'userEmail']) {
      assert.equal(pickCiscoIdEmailField([{ name, type: 'text' }]), 0, name);
    }
  });

  it('falls back to a plain email input for the older page layout', () => {
    // The previous design had a single `input[type=email]`; that must keep working.
    assert.equal(pickCiscoIdEmailField([{ type: 'email' }]), 0);
    assert.equal(pickCiscoIdEmailField([{ name: 'identifier' }]), 0);
  });

  it('ignores boxes that are plainly not an email field', () => {
    assert.equal(pickCiscoIdEmailField([{ name: 'modalFocusableEndpoints', type: 'text' }]), null);
    assert.equal(pickCiscoIdEmailField([]), null);
  });

  it('offers selectors that reach INTO the shadow root and exclude the SSO box', () => {
    // The input lives inside ucs-input's shadow root; Playwright's css engine
    // pierces open shadow roots, so an attribute selector is enough — but it must
    // not also match name="sso-email".
    assert.ok(CISCO_ID_EMAIL_SELECTORS.length > 0);
    const joined = CISCO_ID_EMAIL_SELECTORS.join(' ');
    assert.match(joined, /name=.Email. i|name="Email"/, 'must target the real attribute');
    assert.ok(
      CISCO_ID_EMAIL_SELECTORS.every((s) => !/sso-email/.test(s) || /:not/.test(s)),
      `no selector may target the SSO box: ${joined}`
    );
  });
});
