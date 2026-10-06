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

import type { LaunchOptions } from 'playwright-core';

/**
 * The browser belongs to the account daemon alone.
 *
 * It used to be a detached browser on a shared profile, published through a
 * DevTools port file so that any process could attach to it. That openness is
 * what let a second party into the daemon's cookie jar: an MCP server still
 * running an old build stayed attached with its own login and keepalive, and
 * its Cisco ID login collided with the daemon's ("OIDC state parameter is
 * invalid") even with only one daemon running. The shared design also carried a
 * long tail of attach hazards — a wedged page stalling every attach, a spawn
 * deleting a live browser's port file, a launch onto a held profile donating a
 * blank tab and exiting.
 *
 * Now the daemon launches the browser itself and drives it over a pipe. There
 * is no port and no port file, so there is nothing to attach to, and the one
 * daemon per account (enforced by its own listening port) is the only process
 * that ever holds this profile. The browser lives exactly as long as the daemon.
 */

/** The daemon's private profile, beside the recordings in ~/.intersight-mcp. */
export const DAEMON_PROFILE_DIR = 'daemon-browser-profile';

/**
 * The shared profile older builds attach to. Never used by the daemon: an old
 * MCP server still running would find the daemon's browser through it.
 */
export const LEGACY_SHARED_PROFILE_DIR = 'browser-profile';

/** Options for `chromium.launchPersistentContext` on the daemon's own browser. */
export function ownedBrowserLaunchOptions(
  executablePath: string,
  size: { width: number; height: number } = { width: 1600, height: 900 }
): LaunchOptions & { viewport: null } {
  return {
    executablePath,
    // Visible: the vKVM client renders into it, and a human may need to finish
    // an MFA prompt when automatic login cannot.
    headless: false,
    // The real window size, not an emulated viewport, so a screenshot and a
    // mouse coordinate mean the same thing.
    viewport: null,
    // Playwright would otherwise mark the browser as automated. The detached
    // browser this replaces was an ordinary one to every page it loaded,
    // including the SSO pages, and that is kept.
    ignoreDefaultArgs: ['--enable-automation'],
    // NO --remote-debugging-port: Playwright drives it over a pipe, which is the
    // whole point.
    args: [
      '--disable-blink-features=AutomationControlled',
      `--window-size=${size.width},${size.height}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
}

/** Is this the URL of a vKVM console page? */
export function isConsoleUrl(url: string): boolean {
  return /\/cisco-vkvm\//i.test(url ?? '');
}

/**
 * Which existing tab may be navigated, if any.
 *
 * Never a console: navigating one away raises `beforeunload` ("Leave site?"),
 * which wedges that renderer until a human clicks — and if the click is "Leave",
 * it destroys a console another agent may be mid-installation on. A blank tab is
 * preferred as the cheapest thing to reuse. null means "open a new tab".
 */
export function pickNavigablePage(urls: string[]): number | null {
  const blank = urls.findIndex((u) => u === 'about:blank' || u === '');
  if (blank >= 0) {
    return blank;
  }
  const other = urls.findIndex((u) => !isConsoleUrl(u));
  return other >= 0 ? other : null;
}
