/**
 * The console tab must be opened the way the Intersight UI opens it.
 *
 * 2026-09-30: every launch through `context.newPage()` + `goto` answered 408 on
 * POST kvm/Tunnels, while two launches from the UI's own "Launch Tunneled vKVM"
 * action in the same browser got 200 and rendered. The UI opens the client with
 * `window.open` from the Intersight page (opener, Referer, sessionStorage copy
 * with the identity accessToken) at a URL of exactly this shape.
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { openConsoleTab, tunneledClientUrl } from '../src/services/consoleTab.js';

const ORIGIN = 'https://us-east-1.intersight.com';

/** A minimal Playwright Page: a URL, window.open, and the popup event. */
class FakePage extends EventEmitter {
  closed = false;
  navigatedTo: string | null = null;
  windowOpenCalls: string[] = [];
  constructor(
    public currentUrl: string,
    private readonly world: FakeContext,
    private readonly popupBehaviour: 'opens' | 'refused' | 'never-appears' = 'opens'
  ) {
    super();
  }
  url(): string {
    return this.currentUrl;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async evaluate(_fn: unknown, url: string): Promise<boolean> {
    this.windowOpenCalls.push(url);
    if (this.popupBehaviour === 'refused') {
      return false;
    }
    if (this.popupBehaviour === 'opens') {
      const popup = new FakePage(url, this.world);
      this.world.pagesList.push(popup);
      setImmediate(() => this.emit('popup', popup));
    }
    return true;
  }
  waitForEvent(event: string, opts: { timeout: number }): Promise<FakePage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), opts.timeout);
      this.once(event, (p: FakePage) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  }
  async waitForLoadState(): Promise<void> {}
  async goto(url: string): Promise<void> {
    this.navigatedTo = url;
    this.currentUrl = url;
  }
}

class FakeContext {
  pagesList: FakePage[] = [];
  newPages: FakePage[] = [];
  pages(): FakePage[] {
    return this.pagesList;
  }
  async newPage(): Promise<FakePage> {
    const page = new FakePage('about:blank', this);
    this.pagesList.push(page);
    this.newPages.push(page);
    return page;
  }
  asContext(): BrowserContext {
    return this as unknown as BrowserContext;
  }
}

describe('tunneledClientUrl', () => {
  it('matches the URL the UI opens for a server with a profile', () => {
    assert.equal(
      tunneledClientUrl(ORIGIN, { moid: '6a54ef07617675340148428b', name: 'CHG-UCSX-2-1-4' }, 'MGMT2-BM-A'),
      `${ORIGIN}/cisco-vkvm/tunneled?selectedServerMoid=6a54ef07617675340148428b&selectedServerName=CHG-UCSX-2-1-4&serverProfileName=MGMT2-BM-A`
    );
  });

  it('omits serverProfileName when no profile is assigned, as the UI does', () => {
    assert.equal(
      tunneledClientUrl(ORIGIN, { moid: '6a4f04026176753401bd5dcb', name: 'CHGLAB-UCSX-1-5-1' }, undefined),
      `${ORIGIN}/cisco-vkvm/tunneled?selectedServerMoid=6a4f04026176753401bd5dcb&selectedServerName=CHGLAB-UCSX-1-5-1`
    );
  });
});

describe('openConsoleTab', () => {
  const clientUrl = tunneledClientUrl(ORIGIN, { moid: 'srv', name: 'S' });

  it('opens the client with window.open from the Intersight page, like the UI', async () => {
    const world = new FakeContext();
    const spa = new FakePage(`${ORIGIN}/an/infrastructure-service/an/compute/physical-summaries`, world);
    world.pagesList.push(spa);

    const opened = await openConsoleTab(world.asContext(), clientUrl);

    assert.equal(opened.via, 'window.open');
    assert.deepEqual(spa.windowOpenCalls, [clientUrl]);
    assert.equal((opened.page as unknown as FakePage).url(), clientUrl);
    assert.equal(world.newPages.length, 0, 'no bare tab may be opened when the UI path works');
  });

  it('never opens it from another console, or from another origin', async () => {
    const world = new FakeContext();
    const otherConsole = new FakePage(`${ORIGIN}/cisco-vkvm/tunneled?selectedServerMoid=other`, world);
    const otherOrigin = new FakePage('https://intersight.com/an/whatever', world);
    world.pagesList.push(otherConsole, otherOrigin);

    const opened = await openConsoleTab(world.asContext(), clientUrl);

    assert.equal(opened.via, 'new-tab');
    assert.match(opened.fallbackReason ?? '', /no Intersight page/);
    assert.deepEqual(otherConsole.windowOpenCalls, []);
    assert.deepEqual(otherOrigin.windowOpenCalls, []);
    assert.equal(world.newPages[0]?.navigatedTo, clientUrl);
  });

  it('falls back to a bare tab, and says why, when the popup is refused', async () => {
    const world = new FakeContext();
    world.pagesList.push(new FakePage(`${ORIGIN}/an/home`, world, 'refused'));

    const opened = await openConsoleTab(world.asContext(), clientUrl);

    assert.equal(opened.via, 'new-tab');
    assert.match(opened.fallbackReason ?? '', /refused/);
    assert.equal(world.newPages[0]?.navigatedTo, clientUrl);
  });

  it('falls back when the popup never appears', async () => {
    const world = new FakeContext();
    world.pagesList.push(new FakePage(`${ORIGIN}/an/home`, world, 'never-appears'));

    const opened = await openConsoleTab(world.asContext(), clientUrl, { popupTimeoutMs: 50 });

    assert.equal(opened.via, 'new-tab');
    assert.match(opened.fallbackReason ?? '', /did not produce a tab/);
    assert.equal(world.newPages.length, 1);
  });
});
