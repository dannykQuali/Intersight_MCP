/**
 * How to get hold of the shared browser — the decision that went wrong in
 * production and cost an agent its console.
 *
 * Observed chain, all of it evidenced:
 *
 *  1. Two vKVM renderers were wedged by a `beforeunload` dialog, so Playwright's
 *     connectOverCDP (which attaches to EVERY page) hung and hit its 5s timeout.
 *  2. A failed attach fell through to "spawn a browser", which began by DELETING
 *     the profile's DevToolsActivePort — the live browser's own port file, the
 *     only way anyone discovers it.
 *  3. Edge, launched onto a profile already in use, handed its `about:blank` to
 *     the running browser and exited without writing a new port file.
 *  4. So the spawn threw `Browser started but never published DevToolsActivePort`,
 *     and every retry repeated steps 2-4: discovery stayed broken, and the tab
 *     count grew by one blank tab per attempt (five of them by the time it was
 *     noticed).
 *
 * The rule that was missing: a browser that ANSWERS must never be treated as
 * absent, and a port file must never be deleted while something is listening on
 * it. A hung attach is evidence of a browser, not of its absence.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decideBrowserAcquisition, isConsoleUrl, pickNavigablePage } from '../src/services/browserAcquisition.js';

describe('deciding how to acquire the shared browser', () => {
  it('attaches when the endpoint answers', () => {
    const d = decideBrowserAcquisition({ endpointFromFile: 'http://127.0.0.1:40110', endpointAnswers: true });
    assert.equal(d.action, 'attach');
  });

  it('retries the attach instead of spawning when the endpoint answers but attaching failed', () => {
    // This is the exact production case: CDP is up, but one wedged page makes
    // Playwright's attach time out. Spawning here is what caused the damage.
    const d = decideBrowserAcquisition({
      endpointFromFile: 'http://127.0.0.1:40110',
      endpointAnswers: true,
      attachFailed: true,
    });
    assert.equal(d.action, 'retry-attach');
    assert.match(d.reason, /answer|running|listening/i);
  });

  it('never deletes a port file while something is listening on it', () => {
    const d = decideBrowserAcquisition({
      endpointFromFile: 'http://127.0.0.1:40110',
      endpointAnswers: true,
      attachFailed: true,
    });
    assert.equal(d.removeStalePortFile, false, 'deleting this file orphans a healthy browser');
  });

  it('spawns when there is no port file at all', () => {
    const d = decideBrowserAcquisition({ endpointFromFile: null, endpointAnswers: false });
    assert.equal(d.action, 'spawn');
  });

  it('treats a port file nobody answers on as stale, and clears it', () => {
    const d = decideBrowserAcquisition({ endpointFromFile: 'http://127.0.0.1:40110', endpointAnswers: false });
    assert.equal(d.action, 'spawn');
    assert.equal(d.removeStalePortFile, true, 'a dead port file must not make the next attach race');
  });

  it('attaches rather than spawning when the profile is already in use', () => {
    // Launching onto a locked profile is what silently added a blank tab per
    // attempt: Edge hands the URL to the running browser and exits.
    const d = decideBrowserAcquisition({
      endpointFromFile: null,
      endpointAnswers: false,
      profileInUse: true,
    });
    assert.equal(d.action, 'retry-attach');
    assert.equal(d.removeStalePortFile, false);
    assert.match(d.reason, /in use|already/i);
  });

  it('explains itself in every branch, because this failed silently for hours', () => {
    const cases = [
      { endpointFromFile: null, endpointAnswers: false },
      { endpointFromFile: 'http://127.0.0.1:1', endpointAnswers: false },
      { endpointFromFile: 'http://127.0.0.1:1', endpointAnswers: true },
      { endpointFromFile: null, endpointAnswers: false, profileInUse: true },
    ];
    for (const c of cases) {
      const d = decideBrowserAcquisition(c);
      assert.ok(d.reason.length > 15, `every verdict needs a usable reason, got "${d.reason}"`);
    }
  });
});

describe('choosing a page to navigate', () => {
  it('recognises a vKVM console URL', () => {
    assert.equal(
      isConsoleUrl('https://us-east-1.intersight.com/cisco-vkvm/tunneled?selectedServerMoid=abc'),
      true
    );
    assert.equal(isConsoleUrl('https://intersight.com/'), false);
    assert.equal(isConsoleUrl('about:blank'), false);
    assert.equal(isConsoleUrl(''), false);
  });

  it('never picks a live console tab to navigate', () => {
    // Navigating a console away is what raised "Leave site?" on someone else's
    // session and wedged the renderer. It also destroys their console outright.
    const urls = [
      'https://us-east-1.intersight.com/cisco-vkvm/tunneled?selectedServerMoid=abc',
      'https://intersight.com/',
    ];
    assert.equal(pickNavigablePage(urls), 1);
  });

  it('prefers a blank tab, which is the cheapest thing to navigate', () => {
    const urls = ['https://intersight.com/', 'about:blank'];
    assert.equal(pickNavigablePage(urls), 1);
  });

  it('returns null when every tab is a console, so the caller opens a new one', () => {
    const urls = [
      'https://us-east-1.intersight.com/cisco-vkvm/tunneled?selectedServerMoid=a',
      'https://us-east-1.intersight.com/cisco-vkvm/tunneled?selectedServerMoid=b',
    ];
    assert.equal(pickNavigablePage(urls), null);
  });

  it('returns null for no tabs at all', () => {
    assert.equal(pickNavigablePage([]), null);
  });
});
