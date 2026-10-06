/**
 * The browser belongs to the account daemon alone.
 *
 * It used to be a detached browser on a shared profile that ANY process could
 * attach to over its published DevTools port. So an MCP server still running an
 * old build — with its own login and keepalive — stayed attached after the
 * account daemon took over, and drove a Cisco ID login in the same cookie jar:
 * "OIDC state parameter is invalid", again, with only one daemon running.
 *
 * Now the daemon launches the browser itself, on a profile of its own, and
 * controls it over a pipe. There is no port, so there is nothing to attach to.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DAEMON_PROFILE_DIR,
  LEGACY_SHARED_PROFILE_DIR,
  isConsoleUrl,
  ownedBrowserLaunchOptions,
  pickNavigablePage,
} from '../src/services/browserAcquisition.js';

describe('the daemon\'s own browser', () => {
  const opts = ownedBrowserLaunchOptions('C:/Edge/msedge.exe', { width: 1600, height: 900 });

  it('publishes no DevTools port, so no other process can attach to it', () => {
    const args = opts.args ?? [];
    assert.equal(
      args.some((a) => /^--remote-debugging-(port|address)/.test(a)),
      false,
      `a debugging port is an open door to the daemon's session: ${args.join(' ')}`
    );
  });

  it('uses a profile no older build knows about', () => {
    // Older builds attach to whatever the shared profile's port file names; a
    // different directory means they can never find this browser.
    assert.notEqual(DAEMON_PROFILE_DIR, LEGACY_SHARED_PROFILE_DIR);
  });

  it('is a visible browser, as the vKVM client and a human-assisted login need', () => {
    assert.equal(opts.headless, false);
    assert.equal(opts.executablePath, 'C:/Edge/msedge.exe');
  });

  it('does not announce itself as automation, like the browser it replaces', () => {
    // The detached browser was never launched by Playwright, so the SSO pages
    // saw an ordinary browser; keep it that way.
    assert.ok((opts.ignoreDefaultArgs as string[]).includes('--enable-automation'));
    assert.ok((opts.args ?? []).includes('--disable-blink-features=AutomationControlled'));
  });

  it('sizes the window instead of emulating a viewport, so screenshots match the real console', () => {
    assert.equal(opts.viewport, null);
    assert.ok((opts.args ?? []).includes('--window-size=1600,900'));
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
    // Navigating a console away is what raised "Leave site?" and wedged the
    // renderer. It also destroys that console outright, mid-installation.
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
