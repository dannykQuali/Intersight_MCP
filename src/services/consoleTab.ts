/**
 * Opening the tunneled vKVM client the way the Intersight UI does.
 *
 * The UI's "Launch Tunneled vKVM" action opens the client with `window.open`
 * from the Intersight page, so the console tab has an opener, a Referer of the
 * Intersight page, and a copy of that page's sessionStorage (which holds the
 * Cisco identity `accessToken` / `accessTokenInfo`). A tab opened with
 * `context.newPage()` + `goto` has none of the three. The client's own code
 * (ckvm-util.js) then sends the same requests either way - GET
 * /iam/currentsessioninfo, GET iam/UserPreferences, GET
 * compute/PhysicalSummaries/{moid}, POST kvm/Tunnels {Server:{Moid,ObjectType}}
 * - but a console that is born with the UI's context cannot differ from one a
 * human launched, which is the property worth having: on 2026-09-30 every
 * launch through `newPage` answered 408 on POST kvm/Tunnels while two UI
 * launches in the same browser minutes later got 200.
 */
import type { BrowserContext, Page } from 'playwright-core';

/** The route the UI's action opens, with the parameters it passes (observed 2026-09-30). */
export function tunneledClientUrl(
  origin: string,
  server: { moid: string; name?: string },
  serverProfileName?: string
): string {
  const params = new URLSearchParams({ selectedServerMoid: server.moid });
  if (server.name) {
    params.set('selectedServerName', server.name);
  }
  // The UI omits it when no profile is assigned, rather than sending it empty.
  if (serverProfileName) {
    params.set('serverProfileName', serverProfileName);
  }
  return `${origin}/cisco-vkvm/tunneled?${params.toString()}`;
}

export interface OpenedConsoleTab {
  page: Page;
  /** How it was opened: like the UI, or a bare tab because no Intersight page was available. */
  via: 'window.open' | 'new-tab';
  /** Why the UI path was not used, when it was not. */
  fallbackReason?: string;
}

function isConsoleUrl(url: string): boolean {
  return /\/cisco-vkvm\//i.test(url ?? '');
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The Intersight page to open the console from: same origin as the client, not
 * itself a console. The last such page is used (the most recently active).
 */
export function pickOpenerPage(pages: Page[], origin: string): Page | null {
  const candidates = pages.filter(
    (p) => !p.isClosed() && originOf(p.url()) === origin && !isConsoleUrl(p.url())
  );
  return candidates[candidates.length - 1] ?? null;
}

/**
 * Open the client tab from an Intersight page with `window.open`, as the UI
 * does; fall back to a bare tab only when there is no Intersight page to open
 * it from or the popup does not appear.
 */
export async function openConsoleTab(
  context: BrowserContext,
  clientUrl: string,
  opts: { popupTimeoutMs?: number; navigationTimeoutMs?: number } = {}
): Promise<OpenedConsoleTab> {
  const popupTimeoutMs = opts.popupTimeoutMs ?? 15000;
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? 60000;
  const origin = originOf(clientUrl);
  const opener = origin ? pickOpenerPage(context.pages(), origin) : null;
  let fallbackReason = 'no Intersight page on the client origin to open it from';
  if (opener) {
    const popup = opener.waitForEvent('popup', { timeout: popupTimeoutMs });
    // A rejected wait must never surface as an unhandled rejection.
    popup.catch(() => {});
    const opened = await opener
      .evaluate((url: string) => window.open(url, '_blank') !== null, clientUrl)
      .catch(() => false);
    if (opened) {
      try {
        const page = await popup;
        await page.waitForLoadState('domcontentloaded', { timeout: navigationTimeoutMs }).catch(() => {});
        return { page, via: 'window.open' };
      } catch (error) {
        fallbackReason = `window.open did not produce a tab: ${(error as Error).message}`;
      }
    } else {
      fallbackReason = 'window.open was refused on the Intersight page';
    }
  }
  const page = await context.newPage();
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  return { page, via: 'new-tab', fallbackReason };
}
