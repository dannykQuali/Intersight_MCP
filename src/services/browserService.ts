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

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { loadSsoConfig, SsoConfig } from '../utils/config.js';
import { VkvmRecorder, RecordedFrame, RecorderHooks, RecorderOptions } from './vkvmRecorder.js';
import { FrameOcr } from './frameOcr.js';
import { AgentInputTracker } from './agentInputTracker.js';
import {
  classifyNoSignal,
  noSignalGreenFraction,
  NoSignalState,
  NO_SIGNAL_GREEN_THRESHOLD,
} from './consoleSignals.js';
import { fromScaledFrame } from '../utils/frameCoords.js';
import { consoleFocusPageScript } from '../utils/consoleFocus.js';
import { normalizeKeyCombo, pressSpecsForText } from '../utils/keyboardText.js';

/** What focusConsole managed to focus, named so a failure is diagnosable. */
type ConsoleFocusResult = { focused: boolean; target: string | null; isConsoleCanvas: boolean };
import { generateTotp, parseTotpConfig, secondsRemainingInWindow, TotpParams } from '../utils/totp.js';

export interface SessionApiResult {
  status: number;
  ok: boolean;
  body: any;
}

export interface MouseInput {
  x: number;
  y: number;
  action?: 'click' | 'doubleclick' | 'move' | 'down' | 'up';
  button?: 'left' | 'right' | 'middle';
  relativeTo?: 'canvas' | 'page';
}

/**
 * Manages a single visible (non-headless) browser with a persistent profile.
 *
 * Intersight refuses to create kvm.Session/kvm.Tunnel objects with API-key
 * authentication ("Create operation is not allowed using an API key. Use a
 * valid user session."). The workaround implemented here: a human logs into
 * intersight.com once in this browser window (SSO/MFA), and all vKVM
 * operations then run with the resulting session cookies.
 */
export class BrowserService {
  private context: BrowserContext | null = null;
  private kvmPages = new Map<string, Page>(); // serverMoid -> KVM client page
  private readonly origin: string;
  private readonly profileDir: string;
  private readonly screenshotDir: string;
  // Last screenshot per page, so browser_screenshot can report net change since the previous look.
  private lastShot = new WeakMap<Page, { buf: Buffer; t: number }>();
  // Automatic Cisco ID login / session keepalive (for unattended overnight runs).
  private sso: SsoConfig;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private loginInFlight: Promise<any> | null = null;
  private lastLoginAt: number | null = null;
  private loginCount = 0;
  private lastKeepalive: { at: number; ok: boolean; reloggedIn?: boolean } | null = null;
  // Consecutive auto-login failures. Repeatedly submitting a bad password would
  // risk locking the Cisco ID account, so auto-login self-disables after a few.
  private loginFailures = 0;
  private static readonly MAX_LOGIN_FAILURES = 3;
  private loginDisabledReason: string | null = null;
  // The shared browser is a DETACHED OS process owned by no MCP instance: every
  // instance attaches to it over CDP (a profile can only be owned by one
  // Chromium process), and none of them can take it down by exiting. This
  // handle is our CDP connection to it.
  private attachedBrowser: Browser | null = null;
  private adoptedKvmTabs: string[] = [];
  // Continuous console recorders, one per server MOID.
  private recorders = new Map<string, VkvmRecorder>();
  private readonly recordingDir: string;
  /** Lazy OCR over recorded frames; shared cache across searches. */
  private frameOcr = new FrameOcr();
  // Server descriptors for consoles we have launched, so a recorder can
  // relaunch the same console after a session timeout without the caller.
  private kvmServers = new Map<string, { moid: string; objectType: string; name?: string }>();
  // Deliberate input from the agent (keys/mouse). The background anti-blank
  // nudge must never overlap or race with it - but only on the console the
  // agent is actually using, which is why this is tracked per server.
  private agentInput = new AgentInputTracker();
  /**
   * Disable/re-enable Tunneled vKVM on a server. Injected by the MCP server,
   * which owns the API client; the recorder escalates to it when a relaunched
   * console keeps coming back dead.
   */
  private tunneledVkvmResetter: ((serverMoid: string) => Promise<unknown>) | null = null;

  constructor(intersightBaseUrl: string) {
    // baseUrl is e.g. https://intersight.com/api/v1 -> keep the origin only
    this.origin = new URL(intersightBaseUrl).origin;
    const home = path.join(os.homedir(), '.intersight-mcp');
    this.profileDir = path.join(home, 'browser-profile');
    this.screenshotDir = path.join(home, 'screenshots');
    this.recordingDir = path.join(home, 'recordings');
    this.sso = loadSsoConfig();
  }

  isOpen(): boolean {
    return this.context !== null;
  }

  /**
   * The CDP endpoint of a browser already running on our profile, if any.
   * Chromium writes DevToolsActivePort into the user-data-dir when launched
   * with --remote-debugging-port=0 (line 1 = OS-assigned port).
   */
  private devtoolsEndpoint(): string | null {
    try {
      const raw = fs.readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      const port = Number(raw[0]);
      return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
    } catch {
      return null;
    }
  }

  /**
   * Attach to a browser already running on this profile instead of launching a
   * competing one. A profile can only be owned by one Chromium process, so
   * without this a second MCP server instance would fail with "Opening in
   * existing browser session" (and must NEVER kill the running browser — it may
   * be driving someone's live console). The file can also be stale, so a failed
   * connect simply falls through to launching.
   */
  private async tryAttach(): Promise<BrowserContext | null> {
    const endpoint = this.devtoolsEndpoint();
    if (!endpoint) {
      return null;
    }
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      const ctx = browser.contexts()[0];
      if (!ctx) {
        await browser.close().catch(() => {});
        return null;
      }
      this.attachedBrowser = browser;
      return ctx;
    } catch {
      return null;
    }
  }

  /**
   * Re-register vKVM tabs opened by another instance, so an attached instance
   * can address existing consoles by serverMoid instead of treating them as
   * unknown tabs.
   */
  private adoptExistingKvmTabs(context: BrowserContext): string[] {
    const adopted: string[] = [];
    for (const page of context.pages()) {
      try {
        const url = new URL(page.url());
        if (!/\/cisco-vkvm\//i.test(url.pathname)) {
          continue;
        }
        const moid = url.searchParams.get('selectedServerMoid');
        if (!moid || this.kvmPages.has(moid)) {
          continue;
        }
        this.kvmPages.set(moid, page);
        // Remember enough to relaunch this console if its session later dies.
        if (!this.kvmServers.has(moid)) {
          this.kvmServers.set(moid, {
            moid,
            objectType: 'compute.RackUnit',
            name: url.searchParams.get('selectedServerName') ?? undefined,
          });
        }
        adopted.push(moid);
        page.on('close', () => {
          if (this.kvmPages.get(moid) === page) {
            this.kvmPages.delete(moid);
          }
        });
      } catch {
        // ignore non-URL pages
      }
    }
    return adopted;
  }

  private async ensureContext(viewport?: { width: number; height: number }): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.screenshotDir, { recursive: true });

    // 1. Reuse a browser another MCP server instance already has open on this
    //    profile (shared login + shared consoles), rather than competing for it.
    const attached = await this.tryAttach();
    if (attached) {
      this.context = attached;
      this.adoptedKvmTabs = this.adoptExistingKvmTabs(attached);
      this.context.on('close', () => {
        this.context = null;
        this.kvmPages.clear();
      });
      return this.context;
    }

    // 2. Otherwise spawn a browser DETACHED and attach to it over CDP, exactly
    //    as if another instance had launched it.
    //
    //    Not launchPersistentContext: Playwright closes a browser it launched
    //    when its Node process exits, and this MCP server restarts every time
    //    its code is reloaded. With several MCP instances sharing one browser,
    //    whichever instance happened to launch it became a hidden single point
    //    of failure — verified painfully: another agent's live console sessions
    //    died mid-use, twice, each time this server's window was restarted.
    //    A detached OS process is owned by nobody; every instance (including
    //    this one) is just an attacher, and restarts kill nothing.
    await this.spawnDetachedBrowser(viewport);
    const spawned = await this.tryAttach();
    if (!spawned) {
      throw new Error(
        'Spawned a browser but could not attach to it (DevToolsActivePort never became connectable).'
      );
    }
    this.context = spawned;
    this.context.on('close', () => {
      this.context = null;
      this.kvmPages.clear();
    });
    return this.context;
  }

  /**
   * Start the shared browser as a detached OS process on our profile, with a
   * CDP port published in DevToolsActivePort, and wait until it is attachable.
   */
  private async spawnDetachedBrowser(viewport?: { width: number; height: number }): Promise<void> {
    const exe = findBrowserExecutable();
    if (!exe) {
      throw new Error(
        'No Edge or Chrome installation found to launch. Install one, or start a browser on the profile manually.'
      );
    }
    // A stale port file would make the post-spawn attach race against the old
    // dead port; remove it and wait for the NEW browser to write a fresh one.
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    try {
      fs.unlinkSync(portFile);
    } catch {
      /* none there */
    }
    const size = viewport ?? { width: 1600, height: 900 };
    const child = spawn(
      exe,
      [
        `--user-data-dir=${this.profileDir}`,
        '--remote-debugging-port=0',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${size.width},${size.height}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore' }
    );
    // Fully disown it: the whole point is that it outlives this process.
    child.unref();

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (this.devtoolsEndpoint()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Browser started (${path.basename(exe)}) but never published DevToolsActivePort.`);
  }

  /** Open the browser window and navigate to the Intersight login page. */
  async open(url?: string, viewport?: { width: number; height: number }): Promise<any> {
    const context = await this.ensureContext(viewport);
    const page = context.pages()[0] ?? (await context.newPage());
    const target = url ?? this.origin;
    // Navigate FIRST: on a warm profile this lets a still-valid session redirect
    // to the regional host, so isLoggedIn() can see it and we skip logging in
    // entirely. (Checking before navigating tests the bare origin, which always
    // 401s, and made every warm start perform a needless full re-login.)
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // A still-valid session makes the bare host redirect into the app on the
    // REGIONAL host. Give that redirect a moment to land: activeOrigin() can
    // only spot a regional host from an open page, so checking too early tests
    // the bare origin (which always 401s) and re-logs-in despite good cookies.
    await page
      .waitForURL(
        (u) => {
          const h = new URL(u.toString()).hostname.toLowerCase();
          return /\.intersight\.com$/.test(h) && h !== 'www.intersight.com';
        },
        { timeout: 8000 }
      )
      .catch(() => {});
    let loggedIn = await this.isLoggedIn();
    let autoLoginResult: any;

    // Unattended mode: log in automatically if credentials are configured.
    if (!loggedIn && this.sso.autoLogin) {
      autoLoginResult = await this.ensureLoggedIn();
      loggedIn = !!autoLoginResult?.loggedIn;
    }
    if (loggedIn) {
      // Keep the session alive (and self-heal on expiry) for long runs.
      this.startKeepalive();
    }

    return {
      browser: 'open',
      url: page.url(),
      loggedIn,
      autoLogin: this.autoLoginStatus(),
      ...(autoLoginResult ? { autoLoginResult } : {}),
      instructions: loggedIn
        ? this.sso.autoLogin
          ? 'Logged in. Automatic Cisco ID re-login and session keepalive are active, so the session should survive unattended runs.'
          : 'Already logged in - the existing session cookies are valid.'
        : this.sso.configured
          ? 'Automatic login did not succeed - see autoLoginResult. You can log in manually in the open browser window.'
          : 'A browser window is now open. Ask the user to complete the Intersight login (SSO/MFA) in it, then call browser_status to verify loggedIn=true. For unattended runs, configure INTERSIGHT_SSO_CREDENTIALS_FILE so the server can log in by itself.',
    };
  }

  /**
   * The origin actually in use. Intersight redirects to a regional host after
   * login (e.g. us-east-1.intersight.com), and the session/CSRF cookies live
   * on that host — so we must use it rather than the configured base origin.
   */
  private activeOrigin(): string {
    if (this.context) {
      const origins: string[] = [];
      for (const page of this.context.pages()) {
        try {
          const host = new URL(page.url()).hostname;
          if (/intersight\.com$/i.test(host)) {
            origins.push(new URL(page.url()).origin);
          }
        } catch {
          // ignore about:blank etc.
        }
      }
      // Prefer a regional API host (e.g. us-east-1.intersight.com) over the
      // bare/www onboarding hosts, since the session lives on the regional one.
      const regional = origins.find((o) => {
        const h = new URL(o).hostname.toLowerCase();
        return h !== 'intersight.com' && h !== 'www.intersight.com';
      });
      if (regional) {
        return regional;
      }
      if (origins.length > 0) {
        return origins[0];
      }
    }
    return this.origin;
  }

  /** True if the given origin is the bare/www host rather than a regional one. */
  private isBareOrigin(origin: string): boolean {
    const h = new URL(origin).hostname.toLowerCase();
    return h === 'intersight.com' || h === 'www.intersight.com';
  }

  /**
   * Ensure a regional origin (e.g. us-east-1.intersight.com) is known. The
   * session and the vKVM app live on the regional host; the bare intersight.com
   * only redirects there. If we only have the bare origin, navigate an app
   * route once and let Intersight redirect us to the regional host.
   */
  private async ensureRegionalOrigin(): Promise<string> {
    let origin = this.activeOrigin();
    if (!this.isBareOrigin(origin) || !this.context) {
      return origin;
    }
    const page = this.context.pages()[0] ?? (await this.context.newPage());
    await page
      .goto(`${origin}/an/infrastructure-service/an/compute/physical-summaries`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      .catch(() => {});
    // Wait for the redirect to a regional host to settle.
    for (let i = 0; i < 20; i++) {
      origin = this.activeOrigin();
      if (!this.isBareOrigin(origin)) {
        break;
      }
      await page.waitForTimeout(250);
    }
    return origin;
  }

  /** True when the browser's cookies form a valid Intersight user session. */
  async isLoggedIn(): Promise<boolean> {
    if (!this.context) {
      return false;
    }
    try {
      const url = `${this.activeOrigin()}/api/v1/iam/Accounts?$top=1`;
      const response = await this.context.request.get(url, {
        headers: await this.sessionHeaders(url),
      });
      return response.ok();
    } catch {
      return false;
    }
  }

  async status(): Promise<any> {
    if (!this.context) {
      return {
        browserOpen: false,
        loggedIn: false,
        pages: [],
        kvmSessions: [],
        autoLogin: this.autoLoginStatus(),
      };
    }
    const pages = await Promise.all(
      this.context.pages().map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => '') }))
    );
    return {
      browserOpen: true,
      loggedIn: await this.isLoggedIn(),
      pages,
      kvmSessions: [...this.kvmPages.keys()],
      browserOwnership:
        'detached (the browser is a shared OS process owned by no MCP instance; it survives every instance restart, and browser_close only detaches)',
      ...(this.adoptedKvmTabs.length ? { adoptedKvmTabs: this.adoptedKvmTabs } : {}),
      autoLogin: this.autoLoginStatus(),
    };
  }

  /** Non-secret view of the auto-login/keepalive configuration and state. */
  private autoLoginStatus(): any {
    return {
      configured: this.sso.configured,
      enabled: this.sso.autoLogin,
      credentialSource: this.sso.source,
      username: this.sso.username ? this.maskUser(this.sso.username) : null,
      totpConfigured: !!this.sso.totp,
      accountName: this.sso.accountName ?? null,
      keepaliveSeconds: this.sso.keepaliveSeconds,
      keepaliveRunning: this.keepaliveTimer !== null,
      debug: this.sso.debug,
      logins: this.loginCount,
      consecutiveFailures: this.loginFailures,
      autoLoginDisabledReason: this.loginDisabledReason,
      lastLoginAt: this.lastLoginAt ? new Date(this.lastLoginAt).toISOString() : null,
      lastKeepalive: this.lastKeepalive
        ? { at: new Date(this.lastKeepalive.at).toISOString(), ok: this.lastKeepalive.ok, reloggedIn: !!this.lastKeepalive.reloggedIn }
        : null,
    };
  }

  /** a***@domain — enough to confirm which account without echoing it fully. */
  private maskUser(user: string): string {
    const [local, domain] = user.split('@');
    const head = local?.slice(0, 1) ?? '';
    return domain ? `${head}***@${domain}` : `${head}***`;
  }

  private totpParams(): TotpParams | null {
    if (!this.sso.totp) {
      return null;
    }
    try {
      return parseTotpConfig(this.sso.totp);
    } catch (error) {
      console.error(`Warning: TOTP config is invalid: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * A usable page in the context: the last open non-KVM tab, else a new one.
   * The SSO/account-chooser flow can close or replace tabs, so callers must not
   * assume the page they started with is still alive.
   */
  private async ensureLivePage(): Promise<Page> {
    const context = await this.ensureContext();
    const kvmSet = new Set(this.kvmPages.values());
    const candidates = context.pages().filter((p) => !p.isClosed() && !kvmSet.has(p));
    return candidates[candidates.length - 1] ?? (await context.newPage());
  }

  /** Try a list of candidate selectors, returning the first that becomes visible. */
  private async firstVisible(page: Page, selectors: string[], timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const visible = await page
          .locator(sel)
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          return sel;
        }
      }
      await page.waitForTimeout(300);
    }
    return null;
  }

  /**
   * Like firstVisible, but also requires the element to be ENABLED. Cisco ID
   * renders its submit button disabled until client-side validation passes, so
   * matching on visibility alone finds a dead button and the click silently
   * fails (leaving the flow stuck on the same page).
   */
  private async firstEnabled(page: Page, selectors: string[], timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        const ok = await loc
          .isVisible()
          .then((v) => (v ? loc.isEnabled() : false))
          .catch(() => false);
        if (ok) {
          return sel;
        }
      }
      await page.waitForTimeout(250);
    }
    return null;
  }

  /**
   * Set a form field and VERIFY it holds the value.
   *
   * Cisco ID's Okta widget remounts its inputs while hydrating, which silently
   * truncates a value typed too early (observed: only "da" of an email address
   * survived, so validation reported an invalid address and kept the submit
   * button disabled). So: let the widget settle, set the value, read it back,
   * and retry with real keystrokes if it was clobbered. Returns false if the
   * field could not be set — callers must not pretend the step succeeded.
   */
  private async typeField(page: Page, selector: string, value: string): Promise<boolean> {
    const loc = page.locator(selector).first();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await loc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      // Let hydration/remounting finish before typing (longer on each retry).
      await page.waitForTimeout(attempt === 1 ? 900 : 1500);
      await loc.click({ timeout: 8000 }).catch(() => {});
      await loc.fill('').catch(() => {});
      await loc.fill(value).catch(() => {});
      let got = await loc.inputValue().catch(() => '');
      if (got !== value) {
        // fill() was clobbered - retry with real keystrokes.
        await loc.fill('').catch(() => {});
        await loc.pressSequentially(value, { delay: 30 }).catch(() => {});
        got = await loc.inputValue().catch(() => '');
      }
      if (got === value) {
        await loc
          .evaluate((el: any) => {
            for (const type of ['input', 'change', 'blur']) {
              el.dispatchEvent(new Event(type, { bubbles: true }));
            }
          })
          .catch(() => {});
        return true;
      }
    }
    return false;
  }

  /**
   * Ensure a valid Intersight session, logging in automatically via Cisco ID if
   * credentials are configured. Safe to call before any session-dependent
   * operation; concurrent callers share one login attempt.
   */
  async ensureLoggedIn(opts?: { force?: boolean }): Promise<any> {
    if (opts?.force) {
      // An explicit forced login re-arms the failure circuit breaker.
      this.loginFailures = 0;
      this.loginDisabledReason = null;
    }
    if (!opts?.force && (await this.isLoggedIn())) {
      return { loggedIn: true, action: 'none' };
    }
    if (!this.sso.autoLogin) {
      return {
        loggedIn: false,
        action: 'none',
        reason: this.sso.configured
          ? 'Auto-login is disabled (INTERSIGHT_SSO_AUTO_LOGIN=false).'
          : 'No SSO credentials configured. Set INTERSIGHT_SSO_CREDENTIALS_FILE (or INTERSIGHT_SSO_USERNAME/PASSWORD/TOTP) to enable unattended login, or log in manually in the browser window.',
      };
    }
    // Circuit breaker: never keep retrying a failing credential all night.
    if (this.loginDisabledReason) {
      return { loggedIn: false, action: 'none', reason: this.loginDisabledReason };
    }
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    this.loginInFlight = this.loginWithTotpRetry().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /**
   * Run the login flow, retrying once in a FRESH TOTP window if it fails.
   *
   * A one-time code can only be used once: if anything else authenticated with
   * the same secret in the same 30s window (a second MCP instance, a person
   * logging in), Okta rejects ours and the flow dies with the generic "no valid
   * Intersight session was detected". For an unattended overnight run that
   * single collision would otherwise leave the agent blind until morning, so it
   * is worth one patient retry. Counted as ONE logical attempt against the
   * lockout breaker, since it is the same login intent.
   */
  private async loginWithTotpRetry(): Promise<any> {
    const first = await this.performCiscoIdLogin();
    if (first?.loggedIn || !this.sso.totp) {
      return first;
    }
    // Undo the failure that performCiscoIdLogin recorded; the retry decides.
    this.loginFailures = Math.max(0, this.loginFailures - 1);
    this.loginDisabledReason = null;

    let waitMs = 35000;
    try {
      const params = parseTotpConfig(this.sso.totp);
      // Land in the middle of the next window, well clear of both edges.
      waitMs = secondsRemainingInWindow(params) * 1000 + Math.floor((params.periodSeconds * 1000) / 2);
    } catch {
      /* fall back to the default wait */
    }
    console.error(`Intersight login failed; retrying in ${Math.round(waitMs / 1000)}s with a fresh TOTP code...`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const second = await this.performCiscoIdLogin();
    if (!second?.loggedIn) {
      return {
        ...second,
        retriedWithFreshTotp: true,
        firstAttemptError: String(first?.error ?? '').slice(0, 200),
      };
    }
    return { ...second, retriedWithFreshTotp: true };
  }

  /**
   * Drive the Cisco ID (Okta) SSO login in the visible browser: email ->
   * password -> TOTP -> optional account chooser. Selectors are matched from
   * candidate lists because Cisco's login UI varies; on failure a screenshot is
   * saved so the flow can be diagnosed without re-running blind.
   */
  private async performCiscoIdLogin(): Promise<any> {
    const context = await this.ensureContext();
    const steps: string[] = [];
    // Never hijack a vKVM console tab for the login flow (navigating it away
    // would kill that console). Use a non-KVM tab, or open a fresh one.
    const kvmSet = new Set(this.kvmPages.values());
    const page = context.pages().find((p) => !kvmSet.has(p) && !p.isClosed()) ?? (await context.newPage());
    await page.bringToFront().catch(() => {});

    try {
      await page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
      steps.push('opened intersight.com');

      // Already authenticated (cookies still valid)?
      if (await this.isLoggedIn()) {
        steps.push('session already valid');
        return this.finishLogin(true, steps, /* reused */ true);
      }

      // Cisco ID may ALREADY have us authenticated - most often on a retry,
      // where the first attempt completed SSO but failed to finish establishing
      // the Intersight session. Intersight then jumps straight to the account
      // chooser and there is no login form at all. Blindly hunting for the
      // username field in that state throws "Could not find the username field"
      // and wastes the retry, so detect it and skip ahead to account selection.
      const atChooser =
        /selectaccount|onboarding/i.test(page.url()) ||
        ((await page
          .evaluate(`/Select Account and Role/i.test(document.body ? document.body.innerText : '')`)
          .catch(() => false)) as boolean);

      if (atChooser) {
        steps.push('already authenticated with Cisco ID - at the account chooser, skipping the login form');
      } else {
      // 1. "Sign In with Cisco ID" on the Intersight landing page.
      const ciscoIdBtn = await this.firstVisible(
        page,
        [
          'button:has-text("Sign In with Cisco ID")',
          'a:has-text("Sign In with Cisco ID")',
          ':text("Sign In with Cisco ID")',
        ],
        10000
      );
      if (ciscoIdBtn) {
        await page.locator(ciscoIdBtn).first().click();
        steps.push('clicked "Sign In with Cisco ID"');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }

      // 2. Username/email.
      const userSel = await this.firstVisible(
        page,
        [
          'input[name="identifier"]',
          '#okta-signin-username',
          'input#idp-discovery-username',
          'input[name="username"]',
          'input[name="email"]',
          'input[type="email"]',
        ],
        20000
      );
      if (!userSel) {
        throw new Error('Could not find the username field on the Cisco ID login page');
      }
      if (!(await this.typeField(page, userSel, this.sso.username!))) {
        throw new Error('Could not reliably set the username field (the login widget kept resetting it)');
      }
      steps.push('entered username');
      await this.submitStep(page, ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Next")', 'button:has-text("Sign In")', '#okta-signin-submit', '#idp-discovery-submit']);

      // 3. Password (may be on the same or the next screen).
      const passSel = await this.firstVisible(
        page,
        ['input[type="password"]', 'input[name="credentials.passcode"]', '#okta-signin-password', 'input[name="password"]'],
        20000
      );
      if (!passSel) {
        throw new Error('Could not find the password field on the Cisco ID login page');
      }
      if (!(await this.typeField(page, passSel, this.sso.password!))) {
        throw new Error('Could not reliably set the password field (the login widget kept resetting it)');
      }
      steps.push('entered password');
      await this.submitStep(page, ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Verify")', 'button:has-text("Sign In")', 'button:has-text("Next")', '#okta-signin-submit']);
      steps.push(`url after password: ${page.url().slice(0, 100)}`);

      // 4. MFA / TOTP, if challenged.
      await this.handleTotpChallenge(page, steps);
      steps.push(`url after MFA: ${page.url().slice(0, 100)}`);
      } // end of the login-form path (skipped when already at the chooser)

      // 5. Account chooser, if it appears.
      await this.handleAccountChooser(page, steps);

      // 6. Get onto the REGIONAL host, where the session cookies live.
      //
      //    The account chooser normally redirects there by itself, so WAIT for
      //    that rather than navigating. Navigating to the bare-host app route
      //    before the session has propagated bounces to the login page
      //    (?redirectTo=...) and throws away the login we just completed - an
      //    intermittent failure that only shows up on a cold profile.
      //    Account selection can also close/replace the tab, so always work
      //    from whatever page is alive now.
      const isRegional = (u: string): boolean => {
        try {
          const h = new URL(u).hostname.toLowerCase();
          return /\.intersight\.com$/.test(h) && h !== 'www.intersight.com' && !/onboarding|selectaccount/i.test(u);
        } catch {
          return false;
        }
      };
      let appPage = await this.ensureLivePage();
      const settleBy = Date.now() + 45000;
      while (Date.now() < settleBy) {
        appPage = await this.ensureLivePage();
        if (isRegional(appPage.url())) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      // Only if it never got there on its own, nudge it (and tolerate a bounce).
      if (!isRegional(appPage.url())) {
        steps.push('regional handoff did not happen on its own - navigating explicitly');
        for (let attempt = 0; attempt < 2 && !isRegional(appPage.url()); attempt++) {
          appPage = await this.ensureLivePage();
          await appPage
            .goto(`${this.origin}/an/infrastructure-service/an/compute/physical-summaries`, {
              waitUntil: 'domcontentloaded',
              timeout: 60000,
            })
            .catch(() => {});
          await appPage
            .waitForURL((url) => isRegional(url.toString()), { timeout: 25000 })
            .catch(() => {});
        }
      }
      steps.push(`url after regional handoff: ${appPage.url().slice(0, 120)}`);

      // 7. Confirm the session is real.
      const ok = await this.waitForSession(60000);
      if (!ok) {
        const probe = await this.ensureLivePage();
        const visible = ((await probe
          .evaluate(`(document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,300)`)
          .catch(() => '')) as string).trim();
        throw new Error(
          `Login flow completed but no valid Intersight session was detected. Final URL: ${probe.url().slice(0, 160)} | page text: "${visible}"`
        );
      }
      return this.finishLogin(true, steps);
    } catch (error) {
      // Save a screenshot to diagnose which step failed (no secrets included).
      let debugShot: string | undefined;
      try {
        debugShot = this.saveFrame(await page.screenshot(), 'login-failure');
      } catch {
        // ignore
      }
      const message = (error as Error).message;
      this.loginFailures++;
      if (this.loginFailures >= BrowserService.MAX_LOGIN_FAILURES) {
        this.loginDisabledReason =
          `Automatic login is disabled after ${this.loginFailures} consecutive failures (last error: ${message}). ` +
          'This guard exists so a wrong password is not retried until the Cisco ID account locks out. ' +
          'Fix the credentials, then call browser_login with force:true to re-arm, or log in manually in the browser window.';
        this.stopKeepalive();
        console.error(`Intersight auto-login disabled after ${this.loginFailures} consecutive failures.`);
      } else {
        console.error(`Intersight auto-login failed (${this.loginFailures}/${BrowserService.MAX_LOGIN_FAILURES}): ${message}`);
      }
      return {
        loggedIn: false,
        action: 'login-failed',
        error: message,
        consecutiveFailures: this.loginFailures,
        autoLoginDisabled: !!this.loginDisabledReason,
        stepsCompleted: steps,
        debugScreenshot: debugShot,
        hint: 'Cisco ID login UIs change; inspect the debug screenshot. You can always log in manually in the open browser window — the session then persists in the browser profile.',
      };
    }
  }

  /**
   * Click a submit control, waiting for it to become ENABLED (Cisco ID keeps it
   * disabled until validation passes). Falls back to pressing Enter. Reports
   * whether it actually managed to submit so callers don't assume progress.
   */
  private async submitStep(page: Page, selectors: string[]): Promise<boolean> {
    const sel = await this.firstEnabled(page, selectors, 15000);
    let clicked = false;
    if (sel) {
      clicked = await page
        .locator(sel)
        .first()
        .click({ timeout: 10000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) {
      // Fall back to pressing Enter in the focused field.
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
    return clicked;
  }

  /** Fill the TOTP code if an MFA challenge is presented. */
  private async handleTotpChallenge(page: Page, steps: string[]): Promise<void> {
    // Some tenants show a factor chooser first; prefer an authenticator/TOTP option.
    const factorSel = await this.firstVisible(
      page,
      [
        'a:has-text("Enter a code")',
        'button:has-text("Enter a code")',
        ':text("Google Authenticator")',
        ':text("Authenticator app")',
        'a:has-text("Select")',
      ],
      3000
    );
    if (factorSel) {
      await page.locator(factorSel).first().click().catch(() => {});
      steps.push('selected authenticator factor');
      await page.waitForTimeout(1500);
    }

    const codeSel = await this.firstVisible(
      page,
      [
        'input[name="credentials.passcode"]',
        'input[autocomplete="one-time-code"]',
        'input[name="answer"]',
        'input[name="passCode"]',
        'input[name="otp"]',
        'input[id*="otp" i]',
        'input[placeholder*="code" i]',
      ],
      8000
    );
    if (!codeSel) {
      steps.push('no MFA challenge presented');
      return;
    }

    const params = this.totpParams();
    if (!params) {
      throw new Error('An MFA code is required but no valid TOTP secret is configured (set INTERSIGHT_SSO_TOTP to the otpauth:// URI)');
    }

    // Avoid submitting a code that is about to expire (or was just used).
    if (secondsRemainingInWindow(params) < 5) {
      await page.waitForTimeout(secondsRemainingInWindow(params) * 1000 + 500);
    }
    if (!(await this.typeField(page, codeSel, generateTotp(params)))) {
      throw new Error('Could not reliably set the MFA code field');
    }
    steps.push('entered TOTP code');
    await this.submitStep(page, [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Sign In")',
      '#okta-signin-submit',
    ]);

    // If the code was rejected as already-used, retry once in the next window.
    const stillChallenged = await this.firstVisible(page, [codeSel], 3000);
    if (stillChallenged) {
      await page.waitForTimeout(secondsRemainingInWindow(params) * 1000 + 1000);
      await this.typeField(page, codeSel, generateTotp(params));
      steps.push('retried TOTP code in next window');
      await this.submitStep(page, ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Verify")', '#okta-signin-submit']);
    }
  }

  /** Pick the configured account if Intersight shows the multi-account chooser. */
  private async handleAccountChooser(page: Page, steps: string[]): Promise<void> {
    const onChooser = /selectaccount|onboarding/i.test(page.url());
    if (!onChooser) {
      return;
    }
    // Optional diagnostic: capture the chooser before touching it. Off unless
    // INTERSIGHT_SSO_DEBUG=true - a failed login screenshots itself anyway.
    if (this.sso.debug) {
      try {
        steps.push(`account chooser screenshot: ${this.saveFrame(await page.screenshot(), 'account-chooser')}`);
      } catch {
        // best effort
      }
    }
    if (!this.sso.accountName) {
      steps.push('account chooser shown but INTERSIGHT_SSO_ACCOUNT_NAME is not set');
      return;
    }
    // The account list loads asynchronously behind a spinner, so wait for the
    // account's own text to render (not just for the page).
    //
    // Click the SMALLEST element containing the name — never a container. A
    // container match (li/tr/card) is clicked at its centre, and on this page the
    // card's centre is the "Sign Out of Intersight" link: that silently signed us
    // out and looked like a successful selection.
    const nameLoc = page.getByText(this.sso.accountName, { exact: false }).first();
    const appeared = await nameLoc
      .waitFor({ state: 'visible', timeout: 60000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      // Dump what IS on the chooser so the next failure is self-diagnosing.
      const options = await page
        .evaluate(`(() => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          return [...document.querySelectorAll('a,button,[role="button"],[role="row"],tr,li')]
            .filter(vis).map(el => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60))
            .filter(Boolean).slice(0, 15);
        })()`)
        .catch(() => []);
      steps.push(
        `account "${this.sso.accountName}" never appeared on the chooser. Visible options: ${JSON.stringify(options)}`
      );
      return;
    }

    await nameLoc.scrollIntoViewIfNeeded().catch(() => {});
    await nameLoc.click({ timeout: 15000 }).catch(() => {});
    steps.push(`clicked account text "${this.sso.accountName}"`);

    // Wait for the chooser to hand off (the app drives its own redirect chain).
    await page
      .waitForURL((url) => !/selectaccount/i.test(url.toString()), { timeout: 30000 })
      .catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(4000);

    if (page.isClosed()) {
      steps.push('url right after account click: (tab closed)');
      return;
    }
    steps.push(`url right after account click: ${page.url().slice(0, 120)}`);

    // Guard against the failure mode above: if we are back on a sign-in page, the
    // click landed on Sign Out (or the session was rejected) - say so plainly
    // instead of reporting a successful selection.
    const signedOut = await page
      .evaluate(`/Sign In with Cisco ID|Welcome to Intersight/i.test(document.body ? document.body.innerText : '')`)
      .catch(() => false);
    if (signedOut) {
      throw new Error(
        `Account selection left the browser signed out (landed on ${page.url().slice(0, 80)}). The clicked element was not the account entry.`
      );
    }
  }

  /**
   * Poll until the session is valid. Deliberately does NOT navigate while
   * polling: after SSO the app performs its own redirect chain (ending on the
   * regional host), and navigating during it knocks the flow back to the login
   * page. Only if the session still isn't visible near the end do we nudge it
   * once into an app route.
   */
  private async waitForSession(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isLoggedIn()) {
        return true;
      }
      // Deliberately no navigation here. Intersight completes SSO by redirecting
      // to a REGIONAL host (e.g. us-east-1.intersight.com) where the session
      // cookies live; navigating to the bare intersight.com app route mid-flow
      // bounces straight back to the login page (?redirectTo=...) and destroys
      // the session we are waiting for.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  /**
   * @param reused true when an existing session was found valid and no
   *   credentials were actually submitted. Counting that as a "login" makes
   *   overnight statistics lie about how often we really authenticate.
   */
  private async finishLogin(loggedIn: boolean, steps: string[], reused = false): Promise<any> {
    if (!reused) {
      this.loginCount++;
      this.lastLoginAt = Date.now();
    }
    // Success re-arms the circuit breaker.
    this.loginFailures = 0;
    this.loginDisabledReason = null;
    // Any vKVM tab from a previous (now-dead) session is useless; drop them so
    // the agent relaunches instead of screenshotting a dead console.
    for (const [moid, p] of [...this.kvmPages]) {
      if (p.isClosed() || (await this.isConsoleEnded(p).catch(() => false))) {
        await p.close().catch(() => {});
        this.kvmPages.delete(moid);
      }
    }
    this.startKeepalive();
    return {
      loggedIn,
      action: reused ? 'session-reused' : 'logged-in',
      logins: this.loginCount,
      stepsCompleted: steps,
    };
  }

  /**
   * Keep the Intersight session alive and self-heal when it expires: a periodic
   * authenticated API ping counts as activity against the idle timeout, and a
   * 401 triggers an automatic re-login. This is what lets an unattended
   * overnight run keep vKVM access.
   */
  startKeepalive(): void {
    if (this.keepaliveTimer || this.sso.keepaliveSeconds <= 0) {
      return;
    }
    const intervalMs = Math.max(30, this.sso.keepaliveSeconds) * 1000;
    this.keepaliveTimer = setInterval(async () => {
      if (!this.context) {
        return;
      }
      try {
        const ok = await this.isLoggedIn();
        if (ok) {
          this.lastKeepalive = { at: Date.now(), ok: true };
          return;
        }
        if (!this.sso.autoLogin) {
          this.lastKeepalive = { at: Date.now(), ok: false };
          return;
        }
        console.error('Intersight session expired - attempting automatic re-login...');
        const result = await this.ensureLoggedIn({ force: true });
        this.lastKeepalive = { at: Date.now(), ok: !!result?.loggedIn, reloggedIn: true };
      } catch {
        this.lastKeepalive = { at: Date.now(), ok: false };
      }
    }, intervalMs);
    // Don't hold the process open just for the keepalive.
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Call the Intersight REST API authenticated by the browser's user session
   * (cookies + X-Requested-With header) instead of an API key. This is the only way to
   * invoke operations that Intersight forbids for API keys, such as creating
   * kvm.Session / kvm.Tunnel objects.
   */
  async sessionApi(method: string, apiPath: string, body?: any): Promise<SessionApiResult> {
    if (!this.context) {
      throw new Error('Browser is not open. Call browser_open first.');
    }
    const url = apiPath.startsWith('http') ? apiPath : `${this.activeOrigin()}${apiPath}`;
    const response = await this.context.request.fetch(url, {
      method: method.toUpperCase(),
      headers: await this.sessionHeaders(url),
      data: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed: any;
    const text = await response.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status(), ok: response.ok(), body: parsed };
  }

  private async sessionHeaders(forUrl?: string): Promise<Record<string, string>> {
    const origin = forUrl ? new URL(forUrl).origin : this.activeOrigin();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: `${origin}/`,
      // Intersight's CSRF protection simply requires this custom header on
      // API calls (a header that cross-site requests cannot set without a CORS
      // preflight). Verified: its absence is the "iam_csrf_header_is_missing"
      // 401; its presence returns 200 for the browser session.
      'X-Requested-With': 'XMLHttpRequest',
    };
    return headers;
  }

  /**
   * True if a page is closed or its console is dead.
   *
   * The Intersight console renders entirely inside OPEN shadow roots
   * (<ucs-session-mgr>, <ucs-router>, <kvm-ui>), and neither innerText nor
   * outerHTML pierces them — document.body.innerText is literally empty. An
   * earlier version walked the shadow roots but only collected text when the
   * node was an Element, which a ShadowRoot never is, so it always saw nothing
   * and this check silently never fired.
   *
   * Uses textContent (which does work on a ShadowRoot) and tests for the phrase
   * per-root with early exit, rather than concatenating everything — the full
   * text is ~477KB, mostly inlined CSS.
   */
  /**
   * True when the console is showing the green "No Signal" screen, i.e. the
   * tunnel dropped and the client is trying to reconnect.
   *
   * This is DEGRADED, not dead: the client often reconnects by itself, so the
   * caller must require it to persist before relaunching. Observed live: two
   * consoles dropped simultaneously (an Intersight-side event, not an idle
   * timeout) and sat green for ~2 minutes before the terminal dialog appeared,
   * which is what finally triggered recovery. Detecting the green state
   * directly cuts that dead time.
   */
  private async isConsoleDisconnected(page: Page): Promise<'inactivity' | 'dropped' | null> {
    const state = await this.consoleNoSignal(page);
    return state.kind === 'inactivity' || state.kind === 'dropped' ? state.kind : null;
  }

  /**
   * Read the console's green "No Signal" screen, if any, and say what it means.
   *
   * Richer than isConsoleDisconnected, which only reports the two states the
   * recorder can act on. A third exists - "Reason: Host power is off" - that
   * needs no remedy but must not be reported as a healthy console: a recorder
   * was observed sitting on it for hours while everything looked fine.
   */
  private async consoleNoSignal(page: Page, frame?: Buffer): Promise<NoSignalState> {
    if (page.isClosed()) {
      return {
        blanked: true,
        kind: 'dropped',
        reason: 'the vKVM tab is closed',
        remedy: 'Relaunch with launch_vkvm_session.',
      };
    }
    const buf = frame ?? (await page.screenshot().catch(() => null));
    const png = buf ? this.decodePng(buf) : null;
    if (!png) {
      return { blanked: false, kind: null, reason: null, remedy: null };
    }
    // PIXELS first, not the DOM. The placeholder is painted into the video
    // surface: a live console showing "No Signal" has that phrase nowhere in
    // the document or any shadow root (verified live), so a text search can
    // never see it. A flat CSS-green fill over most of the console region is
    // the signature, and it costs a strided pixel scan.
    const green = noSignalGreenFraction(png);
    if (green < NO_SIGNAL_GREEN_THRESHOLD) {
      return { blanked: false, kind: null, reason: null, remedy: null };
    }
    // Only now spend OCR (~1s), and only once per distinct green screen: the
    // REASON line is the part that decides the remedy, and it too is pixels.
    const hash = crypto.createHash('sha1').update(buf!).digest('hex');
    const cached = this.noSignalCache.get(hash);
    if (cached) {
      return cached;
    }
    const text = await this.frameOcr.textOfBuffer(buf!).catch(() => null);
    const state = classifyNoSignal(text, { blanked: true });
    if (this.noSignalCache.size > 32) {
      this.noSignalCache.clear();
    }
    this.noSignalCache.set(hash, state);
    return state;
  }
  /** Classified green screens, keyed by frame hash — a blanked console repeats. */
  private noSignalCache = new Map<string, NoSignalState>();

  /**
   * Wake a console that is asleep from user inactivity. Sends a bare modifier
   * key: it types nothing and activates nothing, but counts as the keyboard
   * input the "Press a key to wake up the system" screen is asking for.
   * A mouse move is NOT enough here - verified live.
   */
  private async wakeConsole(serverMoid: string): Promise<boolean> {
    // Unlike the anti-blank nudge, a wake is still WANTED shortly after agent
    // input: if the console is asleep, that input evidently did not wake it.
    // Only an in-flight interaction is a reason to hold off.
    if (this.agentInput.isInputInFlight(serverMoid)) {
      return false;
    }
    const page = this.kvmPages.get(serverMoid);
    if (!page || page.isClosed()) {
      return false;
    }
    try {
      await this.focusConsole(page);
      await page.keyboard.press('Shift');
      this.agentInput.markInput(serverMoid);
      return true;
    } catch {
      return false;
    }
  }

  private async isConsoleEnded(page: Page): Promise<boolean> {
    if (page.isClosed()) {
      return true;
    }
    const dead = await page
      .evaluate(
        // Observed death dialogs (each discovered the hard way, live):
        //   "KVM session has ended. Please close the window."            (born dead)
        //   "KVM session has been disconnected due to: Network ..."      (tunnel drop)
        //   "Session Terminated / ... terminated by an Administrator"    (admin kill)
        // The component also ships an unseen session-EXPIRED dialog (i18n keys
        // ucsSessionMgr.expired.* are present in the DOM), whose rendered
        // wording is unknown - which is exactly why isSessionDeadViaApi() below
        // exists as a wording-independent backstop. Note those i18n keys are in
        // the DOM even on a healthy console, so patterns must require the
        // spaced, human-readable phrasing or they will false-positive.
        `(() => {
          // ONLY terminal, blocking states belong here. Transient TOASTS such as
          // "KVM session has been disconnected due to: Network connection has
          // been dropped" describe a PAST event and linger on a freshly
          // relaunched console - matching them made every recovery look like a
          // new death and produced a relaunch loop (observed live: 4 recoveries
          // from a single termination). Genuine disconnects still surface via
          // the blocking dialog below, or via the API backstop.
          const RE = /KVM session has ended|session has been terminated|session terminated|session has expired/i;
          const test = (root) => {
            if (!root) return false;
            const t = root.textContent;
            if (t && RE.test(t)) return true;
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of all) { if (el.shadowRoot && test(el.shadowRoot)) return true; }
            return false;
          };
          return document.body ? test(document.body) : false;
        })()`
      )
      .catch(() => false);
    return !!dead;
  }

  /** Count OPEN vKVM tabs for servers other than the given one. */
  private otherOpenKvmCount(excludeMoid: string): number {
    let n = 0;
    for (const [moid, p] of this.kvmPages) {
      if (moid !== excludeMoid && !p.isClosed()) {
        n++;
      }
    }
    return n;
  }

  /**
   * Launch a tunneled vKVM console for a server by opening the Intersight
   * vKVM web app (`/cisco-vkvm/tunneled`) in a new tab. That app creates and
   * manages the kvm.Tunnel/kvm.Session itself using the logged-in session, so
   * we only need to hand it the server identity via query parameters — exactly
   * what the "Launch Tunneled vKVM" action in the UI does.
   *
   * A server allows only ONE live tunneled session, so launching a duplicate
   * while one is still connected produces a born-dead "KVM session has ended"
   * page. This method is therefore idempotent: it REUSES an already-open live
   * session for the server (unless forceNew), and closes a dead/old one and lets
   * the server free the slot before opening a fresh tab.
   */
  async launchVkvm(
    server: { moid: string; objectType: string; name?: string },
    opts?: { forceNew?: boolean; skipAutoRecord?: boolean; recording?: RecorderOptions }
  ): Promise<any> {
    if (!this.context) {
      throw new Error('Browser is not open. Call browser_open first.');
    }
    // Remember how to relaunch this console so a recorder can self-heal later.
    this.kvmServers.set(server.moid, server);
    if (!(await this.isLoggedIn())) {
      // Self-heal an expired session when auto-login is configured, so an
      // unattended run isn't blinded by a session timeout.
      const relogin = await this.ensureLoggedIn();
      if (!relogin?.loggedIn) {
        throw new Error(
          `Not logged into Intersight in the browser. ${relogin?.reason ?? relogin?.error ?? ''} Call browser_open and complete the login first, or configure automatic login (see docs/VKVM_BROWSER.md).`.trim()
        );
      }
    }

    const result: any = { server: { Moid: server.moid, ObjectType: server.objectType, Name: server.name } };

    // Handle any existing session for THIS server BEFORE opening a new tab.
    //
    // Scanned LIVE from the shared browser, not read from the adoption snapshot
    // taken when we attached. Tabs opened by another process afterwards were
    // invisible, so a launch opened a SECOND tab for a server that already had
    // one — reproduced live, and the reason four tabs accumulated on one server
    // while its session slot stayed occupied by the first.
    const existing = this.kvmPages.get(server.moid) ?? this.adoptConsoleTab(server.moid);
    if (existing && !existing.isClosed()) {
      if (!opts?.forceNew && !(await this.isConsoleEnded(existing))) {
        // Reuse the live session instead of launching a born-dead duplicate.
        await existing.bringToFront().catch(() => {});
        const liveRecorder = this.recorders.get(server.moid);
        return {
          server: result.server,
          reused: true,
          clientUrl: existing.url(),
          pageTitle: await existing.title().catch(() => ''),
          videoSurface:
            'Reused the already-open live vKVM session for this server (a server allows only one live tunneled session). Pass forceNew:true to force a fresh session.',
          ...(liveRecorder
            ? { recording: { started: true, reused: true, retentionMinutes: liveRecorder.status().retentionMinutes } }
            : {}),
          // Say so rather than no-op silently: the recorder belongs to the
          // session that is being reused, and changing its settings would mean
          // restarting it, which clears the frames already captured.
          ...(opts?.recording
            ? {
                recordingOptionsIgnored:
                  'The existing session and its recorder were reused, so the recording options you passed were NOT applied. To change them, call vkvm_record_stop then vkvm_record_start with the new options — that discards the frames captured so far, so vkvm_export first if you need them.',
              }
            : {}),
        };
      }
      // Dead session, or forceNew requested: close it and let the server free
      // the single session slot before we open a new tab.
      await existing.close().catch(() => {});
      this.kvmPages.delete(server.moid);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const origin = await this.ensureRegionalOrigin();

    // Resolve the assigned server-profile name (the UI includes it; best-effort).
    let profileName: string | undefined;
    try {
      const profResp = await this.sessionApi(
        'GET',
        `/api/v1/server/Profiles?$filter=AssignedServer.Moid eq '${server.moid}'&$select=Name`
      );
      profileName = profResp.ok ? profResp.body?.Results?.[0]?.Name : undefined;
    } catch {
      // profile is optional
    }

    const params = new URLSearchParams({ selectedServerMoid: server.moid });
    if (server.name) {
      params.set('selectedServerName', server.name);
    }
    if (profileName) {
      params.set('serverProfileName', profileName);
    }
    const clientUrl = `${origin}/cisco-vkvm/tunneled?${params.toString()}`;
    result.clientUrl = clientUrl;

    // Open the vKVM app. Poll for either the console mounting (<kvm-ui>) or the
    // born-dead banner, so we bail fast instead of waiting the full timeout.
    const page = await this.context.newPage();
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 45000;
    let mounted = false;
    let ended = false;
    while (Date.now() < deadline) {
      ended = await this.isConsoleEnded(page);
      if (ended) {
        break;
      }
      mounted = await page
        .$('kvm-ui')
        .then((h) => !!h)
        .catch(() => false);
      if (mounted) {
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (mounted) {
      // Give the tunnel a moment to connect and paint the first frame.
      await page.waitForTimeout(3000);
      result.videoSurface = 'kvm-ui console mounted - take a screenshot to see the server display.';
    } else if (ended) {
      result.videoSurface = 'The vKVM page reports "KVM session has ended".';
    } else {
      result.videoSurface =
        'The kvm-ui console did not mount within 45s - take a screenshot to inspect the page (it may be an error or a "click to connect" prompt).';
    }

    // A server can report TunneledKvmState "Ready" and still serve an
    // authorization error for this user/org. Without this check the recorder
    // happily records the error page and reports a healthy console - an
    // unattended agent would watch "Forbidden" all night believing it had eyes.
    // Shadow-DOM aware, like the liveness probe: innerText does not pierce
    // shadow roots (on the console page document.body.innerText is empty), so
    // use textContent and walk any shadow roots, testing per-root with early
    // exit rather than concatenating a large string.
    const accessDenied = await page
      .evaluate(
        `(() => {
          const RE = /Forbidden|not authorized to access this resource/i;
          const test = (root) => {
            if (!root) return false;
            const t = root.textContent;
            if (t && RE.test(t)) return true;
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of all) { if (el.shadowRoot && test(el.shadowRoot)) return true; }
            return false;
          };
          return document.body ? test(document.body) : false;
        })()`
      )
      .catch(() => false);
    if (accessDenied) {
      result.accessDenied = true;
      result.hint =
        'The vKVM page returned an authorization error (Forbidden) for this server, so there is no console to record. ' +
        'TunneledKvmState can read "Ready" and still be inaccessible to this user/organization - check permissions or pick another server.';
    }

    if (ended) {
      result.sessionEnded = true;
      const others = this.otherOpenKvmCount(server.moid);
      result.hint =
        others > 0
          ? `The KVM session ended immediately, and ${others} other vKVM tab(s) are open in this browser. A server allows only one live tunneled session, so one of those may be holding the slot — they belong to other servers' recorders, so they are left alone here.`
          : 'The KVM session ended immediately (known Intersight bug). The recorder daemon retries and escalates to a Tunneled vKVM reset on its own after a second born-dead launch; reset_tunneled_vkvm by hand is only needed if that escalation is exhausted.';
    }
    result.pageTitle = await page.title().catch(() => '');

    this.kvmPages.set(server.moid, page);
    page.on('close', () => {
      if (this.kvmPages.get(server.moid) === page) {
        this.kvmPages.delete(server.moid);
      }
    });

    // Start recording immediately so nothing that happens on this console is
    // lost between the agent's looks (disable with INTERSIGHT_VKVM_AUTORECORD=false).
    if (
      process.env.INTERSIGHT_VKVM_AUTORECORD !== 'false' &&
      !result.sessionEnded &&
      !result.accessDenied &&
      !opts?.skipAutoRecord
    ) {
      try {
        this.recorders.get(server.moid)?.stop();
        this.recorders.delete(server.moid);
        // Options come through from launch_vkvm_session: getting a longer
        // retention used to require knowing to stop and restart the recorder,
        // which is how a 10-hour campaign ended up on the 4-hour default.
        const rec = this.startRecording(server.moid, opts?.recording);
        result.recording = {
          started: true,
          intervalMs: rec.intervalMs,
          retentionMinutes: rec.retentionMinutes,
          note: `Console is being recorded continuously, keeping ${rec.retentionMinutes} minutes of frames. For a run longer than that pass recording:{retentionMinutes:N} here, or frames will be silently evicted.`,
        };
      } catch (error) {
        result.recording = { started: false, error: (error as Error).message };
      }
      // The launch response is the one message every operator reads, so the
      // monitoring path goes here: a field report showed an operator hand-rolling
      // workarounds for three tools that already existed, having never found them.
      result.howToMonitor = {
        cheapFirst:
          'vkvm_timeline (text only, no image tokens) -> vkvm_find_text (OCR search for "ERROR|FAILED|press any key") -> vkvm_recent (images, only once you know something happened)',
        input: 'browser_send_keys / browser_mouse for single actions; vkvm_press_until to repeat a key until the screen reacts (e.g. F2 during POST)',
        waiting: 'vkvm_wait {mode:"stable", untilText:"login:"} to sleep through healthy phases; vkvm_watch for a bounded window',
        rediscover: 'vkvm_record_status with NO serverMoid lists every recorder, e.g. after losing track of what you launched',
        // Every tool here is PULL: you find out when you next ask. On a long run
        // that means checking on your own timer and learning about a wedged
        // installer at the next tick rather than when it wedged.
        beNotifiedInsteadOfPolling: {
          stateFile: `${path.join(this.recordingDir, server.moid, 'state.json')} — this recorder republishes its status there on every stored frame and every event (state, consoleLive, novelty.lastNoveltyAt, ocr.lastTextChangeAt, noSignal, wakes, recoveries, framesEvicted). Readable from any process, including while this MCP server is busy.`,
          ifYourHarnessCanRunBackgroundCommands:
            'Launch a shell command in the background that polls that file and EXITS when your condition is met, then let your harness notify you when it exits. That converts pull into push: you are woken when something happens instead of asking repeatedly. Example wedge condition: novelty.lastNoveltyAt AND ocr.lastTextChangeAt both older than 20 minutes.',
          ifNot: 'Fall back to vkvm_timeline / vkvm_find_text on your own schedule, and keep the interval short enough that a stalled install is caught in time.',
          caveat:
            'novelty.lastNoveltyAt already ignores cursor blink and clock/spinner repaints (changes are classified per screen region, not measured in pixels), so it is safe to treat as "when the machine last did something". For a wedge verdict still cross-check ocr.lastTextChangeAt: text is the strongest evidence either way.',
        },
      };
    }
    return result;
  }

  /**
   * Resolve which page to act on. With a serverMoid, the exact vKVM page. Without
   * one, prefer the most-recently-launched OPEN vKVM console (so console input /
   * screenshots don't accidentally target an unrelated tab such as a browser_goto
   * page); only if no vKVM page is open do we fall back to the last opened tab.
   */
  private resolvePage(serverMoid?: string): Page {
    if (!this.context) {
      throw new Error('Browser is not open. Call browser_open first.');
    }
    if (serverMoid) {
      const page = this.kvmPages.get(serverMoid);
      if (!page || page.isClosed()) {
        throw new Error(`No open vKVM page for server ${serverMoid}. Call launch_vkvm_session first.`);
      }
      return page;
    }
    // Most recently inserted still-open KVM page wins (Map preserves insertion order).
    let kvmPage: Page | undefined;
    for (const p of this.kvmPages.values()) {
      if (!p.isClosed()) {
        kvmPage = p;
      }
    }
    if (kvmPage) {
      return kvmPage;
    }
    const pages = this.context.pages();
    if (pages.length === 0) {
      throw new Error('No open pages in the browser.');
    }
    return pages[pages.length - 1];
  }

  private round4(n: number): number {
    return Math.round(n * 10000) / 10000;
  }

  /** Decode a PNG buffer, or null if it can't be parsed (e.g. a partial/zero-byte grab). */
  private decodePng(buf: Buffer): PNG | null {
    try {
      return PNG.sync.read(buf);
    } catch {
      return null;
    }
  }

  /**
   * Fraction of pixels that differ between two decoded frames (0..1).
   * Returns -1 when either frame is undecodable (caller should treat as
   * "unknown", NOT as a full-screen change), and 1 when dimensions differ.
   */
  private diffParsed(a: PNG | null, b: PNG | null): number {
    if (!a || !b) {
      return -1;
    }
    if (a.width !== b.width || a.height !== b.height) {
      return 1;
    }
    const total = a.width * a.height;
    if (!total) {
      return 0;
    }
    return pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) / total;
  }

  /** Convenience buffer-to-buffer diff (decodes both). Returns -1 if either can't be decoded. */
  private frameDiffRatio(a: Buffer, b: Buffer): number {
    return this.diffParsed(this.decodePng(a), this.decodePng(b));
  }

  /**
   * Focus the vKVM console so key events reach the remote server. The console
   * renders inside a <kvm-ui> custom element; focusing only the host does not
   * forward keys unless its shadow root sets delegatesFocus, so we reach into
   * the shadow DOM for a genuinely focusable element (canvas/video/[tabindex]).
   */
  private async focusConsole(page: Page): Promise<ConsoleFocusResult> {
    // The traversal lives in a tested module and is serialised into the page,
    // rather than being an inline string nobody could exercise. The previous
    // inline version could not cross a nested shadow boundary and quietly
    // focused a header div, so every keystroke was dispatched into the chrome.
    const result = (await page.evaluate(consoleFocusPageScript()).catch(() => null)) as ConsoleFocusResult | null;
    return result ?? { focused: false, target: null, isConsoleCanvas: false };
  }

  /** Grab a raw PNG screenshot buffer of a (foregrounded) page. */
  private async grab(page: Page): Promise<Buffer> {
    await page.bringToFront().catch(() => {});
    return page.screenshot();
  }

  /**
   * Shared sample-compare loop for the time-sensitive tools. Grabs a baseline,
   * then samples every intervalMs, diffing each frame (decoded once) against the
   * baseline ('change') or the previous frame ('stable'/'window'):
   *  - 'change': stop as soon as the frame differs from baseline.
   *  - 'stable': stop once the frame has been quiet for stablePeriodMs. Reports
   *    'stable' only if activity was observed first, else 'quiet' — so a screen
   *    that never moved is not mistaken for "settled after an action".
   *  - 'window': never stops early; runs the whole duration, calling onChange.
   * Returns the DECISIVE frame (the one that satisfied the condition), never a
   * frame re-grabbed afterward. Undecodable grabs are skipped, not scored.
   */
  private async sampleLoop(
    page: Page,
    opts: {
      mode: 'change' | 'stable' | 'window';
      timeoutMs: number;
      intervalMs: number;
      threshold: number;
      stablePeriodMs?: number;
      beforeEachSample?: () => Promise<void>;
      onChange?: (info: { atMs: number; ratio: number; buf: Buffer }) => void;
    }
  ): Promise<{
    outcome: 'changed' | 'stable' | 'quiet' | 'window' | 'timeout';
    elapsedMs: number;
    maxChangeRatio: number;
    sawChange: boolean;
    samples: number;
    baselineBuf: Buffer;
    finalBuf: Buffer;
  }> {
    const stablePeriodMs = opts.stablePeriodMs ?? 3000;
    const start = Date.now();
    const baselineBuf = await this.grab(page);
    const baselineParsed = this.decodePng(baselineBuf);
    let prevParsed = baselineParsed;
    let lastBuf = baselineBuf;
    let decisiveBuf: Buffer | null = null;
    let lastActivityAt = start;
    let sawChange = false;
    let maxRatio = 0;
    let samples = 0;
    let outcome: 'changed' | 'stable' | 'quiet' | 'window' | 'timeout' =
      opts.mode === 'window' ? 'window' : 'timeout';

    while (Date.now() - start < opts.timeoutMs) {
      if (opts.beforeEachSample) {
        await opts.beforeEachSample();
      }
      await page.waitForTimeout(opts.intervalMs);
      const curBuf = await this.grab(page);
      const curParsed = this.decodePng(curBuf);
      if (!curParsed) {
        continue; // undecodable grab: skip, do not score as a change
      }
      samples++;
      lastBuf = curBuf;

      if (opts.mode === 'change') {
        const r = this.diffParsed(baselineParsed, curParsed);
        if (r >= 0) {
          maxRatio = Math.max(maxRatio, r);
          if (r > opts.threshold) {
            outcome = 'changed';
            sawChange = true;
            decisiveBuf = curBuf;
            break;
          }
        }
      } else {
        const r = this.diffParsed(prevParsed, curParsed);
        if (r >= 0) {
          maxRatio = Math.max(maxRatio, r);
          if (r > opts.threshold) {
            sawChange = true;
            lastActivityAt = Date.now();
            if (opts.onChange) {
              opts.onChange({ atMs: Date.now() - start, ratio: r, buf: curBuf });
            }
          } else if (opts.mode === 'stable' && Date.now() - lastActivityAt >= stablePeriodMs) {
            outcome = sawChange ? 'stable' : 'quiet';
            decisiveBuf = curBuf;
            break;
          }
        }
        prevParsed = curParsed;
      }
    }

    return {
      outcome,
      elapsedMs: Date.now() - start,
      maxChangeRatio: this.round4(maxRatio),
      sawChange,
      samples,
      baselineBuf,
      finalBuf: decisiveBuf ?? lastBuf,
    };
  }

  private saveFrame(buffer: Buffer, label = 'screenshot'): string {
    const fileName = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filePath = path.join(this.screenshotDir, fileName);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /** Screenshot a page (PNG). Also reports how much changed since the previous screenshot of this page. */
  async screenshot(opts: { serverMoid?: string; fullPage?: boolean } = {}): Promise<{
    path: string;
    base64: string;
    url: string;
    changeSinceLastShot?: { ratio: number; changed: boolean; secondsAgo: number };
  }> {
    const page = this.resolvePage(opts.serverMoid);
    // Background tabs throttle rendering; make sure the KVM canvas is being painted
    await page.bringToFront().catch(() => {});
    const buffer = await page.screenshot({ fullPage: !!opts.fullPage });
    const now = Date.now();
    const filePath = this.saveFrame(buffer);

    let changeSinceLastShot: { ratio: number; changed: boolean; secondsAgo: number } | undefined;
    const prev = this.lastShot.get(page);
    if (prev && !opts.fullPage) {
      const ratio = this.frameDiffRatio(prev.buf, buffer);
      if (ratio >= 0) {
        changeSinceLastShot = {
          ratio: this.round4(ratio),
          changed: ratio > 0.01,
          secondsAgo: Math.round((now - prev.t) / 100) / 10,
        };
      }
    }
    // Store viewport shots only (full-page shots have different dimensions).
    if (!opts.fullPage) {
      this.lastShot.set(page, { buf: buffer, t: now });
    }

    // If this console is being recorded, tell the caller how much it did NOT
    // see, so a single screenshot can't be mistaken for the whole story.
    let missedChanges: any;
    if (opts.serverMoid) {
      const recorder = this.recorders.get(opts.serverMoid);
      if (recorder?.isRunning()) {
        const missed = recorder.newFramesSinceLastView();
        if (missed > 0) {
          missedChanges = {
            count: missed,
            hint: `${missed} console change(s) were recorded since your previous look and are NOT visible in this single screenshot. Call vkvm_recent to see them.`,
          };
        }
      }
    }
    // A green placeholder is not the machine's state. Say so explicitly, so a
    // screensaver or a powered-off server is never reasoned about as though it
    // were what the server is doing.
    const noSignal = await this.consoleNoSignal(page, opts.fullPage ? undefined : buffer);
    return {
      path: filePath,
      base64: buffer.toString('base64'),
      url: page.url(),
      changeSinceLastShot,
      ...(missedChanges ? { missedChanges } : {}),
      ...(noSignal.blanked ? { noSignal } : {}),
      ...this.describeTarget(page, opts.serverMoid),
    };
  }

  /**
   * Block until the console frame changes (mode 'change') or goes quiet
   * (mode 'stable'), or until timeout. Returns the decisive frame. This lets an
   * agent act at the right instant without its own think-latency: e.g. "wait
   * until the screen stabilizes, then screenshot" instead of polling by hand.
   */
  async waitForFrame(opts: {
    serverMoid?: string;
    mode?: 'change' | 'stable';
    timeoutMs?: number;
    intervalMs?: number;
    stablePeriodMs?: number;
    threshold?: number;
    /** Keep waiting until the settled screen's text matches this regex (OCR). */
    untilText?: string;
    /** Keep waiting until the settled screen differs from this reference frame. */
    differentFromPath?: string;
  }): Promise<any> {
    const page = this.resolvePage(opts.serverMoid);
    const mode = opts.mode ?? 'change';
    const deadline = Date.now() + (opts.timeoutMs ?? 60000);

    let textRe: RegExp | null = null;
    if (opts.untilText) {
      try {
        textRe = new RegExp(opts.untilText, 'i');
      } catch (error) {
        throw new Error(`Invalid untilText pattern: ${(error as Error).message}`);
      }
    }
    const referenceBuf = opts.differentFromPath
      ? await fs.promises.readFile(opts.differentFromPath).catch(() => null)
      : null;
    if (opts.differentFromPath && !referenceBuf) {
      throw new Error(`Could not read reference frame: ${opts.differentFromPath}`);
    }

    // With a predicate, "settled" is not enough: keep sampling until the screen
    // ALSO satisfies it. This is what lets an agent sleep through healthy
    // phases — a boot that pauses repeatedly no longer wakes it each time.
    let r: Awaited<ReturnType<typeof this.sampleLoop>> | null = null;
    let rounds = 0;
    let predicateMet = !textRe && !referenceBuf;
    let ocrText: string | null = null;
    let refDiff: number | null = null;

    while (Date.now() < deadline) {
      rounds++;
      r = await this.sampleLoop(page, {
        mode,
        timeoutMs: Math.max(1000, deadline - Date.now()),
        intervalMs: opts.intervalMs ?? 500,
        threshold: opts.threshold ?? 0.01,
        stablePeriodMs: opts.stablePeriodMs ?? 3000,
      });
      if (!textRe && !referenceBuf) {
        break; // no predicate: original behaviour
      }
      if (r.outcome === 'timeout') {
        break;
      }
      let ok = true;
      if (referenceBuf) {
        refDiff = this.frameDiffRatio(referenceBuf, r.finalBuf);
        ok = ok && refDiff > (opts.threshold ?? 0.01);
      }
      if (ok && textRe) {
        ocrText = await this.frameOcr.textOfBuffer(r.finalBuf);
        ok = ocrText !== null && textRe.test(ocrText);
      }
      if (ok) {
        predicateMet = true;
        break;
      }
    }

    const finalBuf = r!.finalBuf;
    const filePath = this.saveFrame(finalBuf, `wait-${mode}`);
    this.lastShot.set(page, { buf: finalBuf, t: Date.now() });
    return {
      mode,
      outcome: predicateMet ? r!.outcome : 'timeout',
      predicate: textRe || referenceBuf ? { met: predicateMet, rounds } : undefined,
      ...(textRe ? { untilText: opts.untilText, ocrSample: (ocrText ?? '').slice(0, 200) } : {}),
      ...(referenceBuf ? { differenceFromReference: refDiff } : {}),
      ...(textRe && this.frameOcr.isUnavailable() ? { ocrUnavailable: this.frameOcr.isUnavailable() } : {}),
      elapsedMs: r!.elapsedMs,
      maxChangeRatio: r!.maxChangeRatio,
      sawChange: r!.sawChange,
      samples: r!.samples,
      path: filePath,
      base64: finalBuf.toString('base64'),
      url: page.url(),
    };
  }

  /**
   * Press key(s) repeatedly at a fixed interval until the console changes
   * (stopOn 'change', the default) or stabilizes (stopOn 'stable'), or until
   * timeout. This is the machine-timed way to catch a boot prompt — e.g. spam
   * F2/Del to enter BIOS setup — with no agent latency between frames.
   */
  async pressUntil(opts: {
    serverMoid?: string;
    keys: string[];
    intervalMs?: number;
    timeoutMs?: number;
    stopOn?: 'change' | 'stable';
    stablePeriodMs?: number;
    threshold?: number;
  }): Promise<any> {
    if (!opts.keys || opts.keys.length === 0) {
      throw new Error('pressUntil requires at least one key (e.g. ["F2"]).');
    }
    const page = this.resolvePage(opts.serverMoid);
    await page.bringToFront().catch(() => {});
    await this.focusConsole(page);

    // Same normalisation as browser_send_keys: "C" or "Shift+C" must become
    // Shift+c or the console receives the base key (or nothing).
    const keys = opts.keys.map(normalizeKeyCombo);
    const stopOn = opts.stopOn ?? 'change';
    let presses = 0;

    // Held for the whole loop so the anti-blank nudge cannot inject a stray
    // event between key presses.
    const r = await this.withAgentInput(page, () =>
      this.sampleLoop(page, {
        mode: stopOn,
        timeoutMs: opts.timeoutMs ?? 60000,
        intervalMs: opts.intervalMs ?? 300,
        threshold: opts.threshold ?? 0.02,
        stablePeriodMs: opts.stablePeriodMs ?? 2500,
        beforeEachSample: async () => {
          for (const key of keys) {
            await page.keyboard.press(key);
            presses++;
          }
        },
      })
    );

    const filePath = this.saveFrame(r.finalBuf, 'press-until');
    this.lastShot.set(page, { buf: r.finalBuf, t: Date.now() });
    return {
      keys,
      presses,
      stopOn,
      outcome: r.outcome,
      elapsedMs: r.elapsedMs,
      maxChangeRatio: r.maxChangeRatio,
      sawChange: r.sawChange,
      path: filePath,
      base64: r.finalBuf.toString('base64'),
      url: page.url(),
    };
  }

  /**
   * Watch the console for a fixed window, sampling at an interval, and report
   * every time the frame changed (with timestamps). Answers "did anything
   * happen / did it reboot while I wasn't looking" in a single call, instead of
   * comparing two manually-spaced screenshots.
   */
  async watch(opts: {
    serverMoid?: string;
    durationMs?: number;
    intervalMs?: number;
    threshold?: number;
    saveChangeFrames?: boolean;
  }): Promise<any> {
    const page = this.resolvePage(opts.serverMoid);
    const durationMs = Math.min(opts.durationMs ?? 30000, 300000);
    const intervalMs = opts.intervalMs ?? 1000;
    const changes: Array<{ atMs: number; ratio: number; path?: string }> = [];

    const r = await this.sampleLoop(page, {
      mode: 'window',
      timeoutMs: durationMs,
      intervalMs,
      threshold: opts.threshold ?? 0.01,
      onChange: ({ atMs, ratio, buf }) => {
        const entry: { atMs: number; ratio: number; path?: string } = { atMs, ratio: this.round4(ratio) };
        if (opts.saveChangeFrames) {
          entry.path = this.saveFrame(buf, 'watch-change');
        }
        changes.push(entry);
      },
    });

    const firstBuf = r.baselineBuf;
    const lastBuf = r.finalBuf;
    const firstPath = this.saveFrame(firstBuf, 'watch-first');
    const lastPath = this.saveFrame(lastBuf, 'watch-last');
    this.lastShot.set(page, { buf: lastBuf, t: Date.now() });
    const netRatio = this.frameDiffRatio(firstBuf, lastBuf);
    return {
      durationMs,
      intervalMs,
      samples: r.samples,
      changeCount: changes.length,
      changes,
      netChangeRatio: netRatio < 0 ? 0 : this.round4(netRatio),
      quiet: changes.length === 0,
      firstFramePath: firstPath,
      lastFramePath: lastPath,
      firstBase64: firstBuf.toString('base64'),
      lastBase64: lastBuf.toString('base64'),
      url: page.url(),
    };
  }

  /**
   * Send keyboard input. `text` is typed literally; `keys` are pressed one by
   * one and accept Playwright key names and combos ("Enter", "F6",
   * "Control+Alt+Delete").
   */
  async sendKeys(opts: {
    serverMoid?: string;
    text?: string;
    keys?: string[];
    verifyMs?: number;
  }): Promise<any> {
    const page = this.resolvePage(opts.serverMoid);
    const target = this.describeTarget(page, opts.serverMoid);
    // 0 disables the check for callers deliberately sending blind input (a key
    // that is not expected to draw anything, e.g. a modifier).
    const verifyMs = opts.verifyMs ?? 1500;
    return this.withAgentInput(page, async () => {
      await page.bringToFront().catch(() => {});
      const focus = await this.focusConsole(page);
      const before = verifyMs > 0 ? await page.screenshot().catch(() => null) : null;

      // NOT keyboard.type(): the console forwards input to the BMC as HID
      // scancode + modifier byte, deriving the modifier byte from REAL Shift
      // keydown/keyup events — which type() never emits, so every shifted
      // character arrived as its base key ("Cisco123!" landed as "cisco1231",
      // field-verified). Explicit Shift+<base> presses replay what a human's
      // keyboard actually sends.
      if (opts.text) {
        for (const spec of pressSpecsForText(opts.text)) {
          await page.keyboard.press(spec, { delay: 12 });
          // Small inter-key gap: BMCs drop keystrokes delivered back-to-back.
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      for (const key of opts.keys ?? []) {
        await page.keyboard.press(normalizeKeyCombo(key), { delay: 12 });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Did anything actually happen? "sent" only means Playwright dispatched
      // the event; it says nothing about whether the BMC received it. A live
      // session whose input channel had quietly died reported success for every
      // keystroke while the screen never moved, which took hours to diagnose.
      const delivery = before ? await this.awaitEcho(page, before, verifyMs) : null;
      const noSignal = await this.consoleNoSignal(page, delivery?.finalFrame ?? before ?? undefined);

      return {
        sent: { text: opts.text ?? null, keys: opts.keys ?? [] },
        ...target,
        // Names the element, because "consoleFocused: true" about the wrong
        // element is exactly what hid keys being dispatched into page chrome.
        consoleFocused: focus.focused && focus.isConsoleCanvas,
        focusedElement: focus.target,
        ...(focus.focused && !focus.isConsoleCanvas
          ? {
              focusWarning: `Focused "${focus.target}" rather than the console canvas — the client listens for keys on canvas#kvmCanvas, so input sent now is likely to be dropped.`,
            }
          : {}),
        ...(!focus.focused
          ? {
              focusWarning:
                'Could not focus the console canvas at all; keyboard input will not reach the server. Relaunch with launch_vkvm_session forceNew:true.',
            }
          : {}),
        ...(delivery
          ? {
              // finalFrame is an internal Buffer - never serialize it into the
              // response, which is JSON handed to a model.
              echo: {
                changed: delivery.changed,
                changeRatio: delivery.changeRatio,
                withinMs: delivery.withinMs,
                afterMs: delivery.afterMs,
              },
              ...(delivery.changed
                ? {}
                : {
                    warning:
                      `The console did not change within ${verifyMs}ms of this input. It may not have been ` +
                      `delivered. Checks, cheapest first: consoleFocused above; noSignal below; retry with ` +
                      `vkvm_press_until (repeats the key and reports when the screen reacts); then relaunch ` +
                      `the session with launch_vkvm_session forceNew:true, which rebuilds the input channel. ` +
                      `Note some input legitimately draws nothing (a modifier, a key an idle prompt ignores).`,
                  }),
            }
          : {}),
        ...(noSignal.blanked ? { noSignal } : {}),
        url: page.url(),
      };
    });
  }

  /**
   * Watch for the console to react to input we just sent, and report what we
   * saw. Best-effort by construction: a pixel change proves delivery, while no
   * change is only evidence, not proof (a modifier key draws nothing).
   */
  private async awaitEcho(
    page: Page,
    before: Buffer,
    withinMs: number
  ): Promise<{
    changed: boolean;
    changeRatio: number;
    withinMs: number;
    afterMs: number;
    finalFrame?: Buffer;
  }> {
    const started = Date.now();
    const baseline = this.decodePng(before);
    let best = 0;
    let last: Buffer | undefined;
    while (Date.now() - started < withinMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const shot = await page.screenshot().catch(() => null);
      if (!shot) {
        continue;
      }
      last = shot;
      const ratio = this.diffParsed(baseline, this.decodePng(shot));
      if (ratio > best) {
        best = ratio;
      }
      // ANY pixel difference is proof the far end reacted - these are
      // deterministic canvas captures, not camera frames, so there is no noise
      // floor to filter. A magnitude threshold here declared password entry
      // undelivered three times running: ten masked-field dots measure ~0.0004,
      // which sat just under the old 0.0005 cutoff.
      if (best > 0) {
        break;
      }
    }
    return {
      changed: best > 0,
      changeRatio: this.round4(best),
      withinMs,
      afterMs: Date.now() - started,
      // Reused by the caller so the no-signal check costs no extra screenshot.
      finalFrame: last,
    };
  }

  /**
   * Name the console a call actually landed on. With several sessions open, the
   * "most recently opened tab" default silently targets the wrong server - a
   * real field mistake - so the answer is echoed rather than left implicit in
   * the returned URL.
   */
  private describeTarget(page: Page, requestedMoid?: string): Record<string, unknown> {
    const moid = this.moidForPage(page);
    const open = [...this.kvmPages.entries()].filter(([, p]) => !p.isClosed());
    const name = moid ? this.kvmServers.get(moid)?.name : undefined;
    const targeted = moid ? { targeted: { serverMoid: moid, ...(name ? { serverName: name } : {}) } } : {};
    if (requestedMoid || open.length <= 1) {
      return targeted;
    }
    return {
      ...targeted,
      targetWarning:
        `No serverMoid was given and ${open.length} vKVM sessions are open, so this defaulted to the ` +
        `most recently opened one${name ? ` (${name})` : ''}. Pass serverMoid to be sure.`,
    };
  }

  /**
   * Send mouse input. Coordinates default to PAGE (viewport) pixels, which match
   * exactly what browser_screenshot shows — the Intersight console renders in a
   * shadow-DOM web component with no accessible canvas. Pass relativeTo:'canvas'
   * only for pages that expose a real <canvas> and you want canvas-relative
   * coordinates.
   */
  async mouse(opts: MouseInput & { serverMoid?: string; fromScale?: number }): Promise<any> {
    const page = this.resolvePage(opts.serverMoid);
    const target = this.describeTarget(page, opts.serverMoid);
    return this.withAgentInput(page, async () => {
      await page.bringToFront().catch(() => {});
      // Coordinates read off a downscaled recorded frame are not page pixels.
      const scaled = fromScaledFrame(opts.x, opts.y, opts.fromScale);
      let x = scaled.x;
      let y = scaled.y;
      const scaleApplied = x !== Math.round(opts.x) || y !== Math.round(opts.y);
      let canvasOffsetApplied = false;
      if (opts.relativeTo === 'canvas') {
        const box = await page.locator('canvas').first().boundingBox().catch(() => null);
        if (box) {
          x += box.x;
          y += box.y;
          canvasOffsetApplied = true;
        }
      }
      const button = opts.button ?? 'left';
      switch (opts.action ?? 'click') {
        case 'move':
          await page.mouse.move(x, y);
          break;
        case 'doubleclick':
          await page.mouse.dblclick(x, y, { button });
          break;
        case 'down':
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
          break;
        case 'up':
          await page.mouse.move(x, y);
          await page.mouse.up({ button });
          break;
        default:
          await page.mouse.click(x, y, { button });
      }
      return {
        action: opts.action ?? 'click',
        x,
        y,
        button,
        canvasOffsetApplied,
        ...(scaleApplied ? { fromScale: opts.fromScale, requested: { x: opts.x, y: opts.y } } : {}),
        ...target,
        url: page.url(),
      };
    });
  }

  /** Navigate the current (or a new) tab to a URL. */
  async goto(url: string, newPage = false): Promise<any> {
    const context = await this.ensureContext();
    const page = newPage ? await context.newPage() : this.resolvePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  /** Evaluate a JavaScript expression in a page and return its JSON-serializable result. */
  async evaluate(script: string, serverMoid?: string): Promise<any> {
    const page = this.resolvePage(serverMoid);
    return page.evaluate(script);
  }

  // ---------------------------------------------------------------------------
  // Continuous console recording
  //
  // A single screenshot is a point sample: an agent that looks every few minutes
  // cannot tell a frozen screen from one that rebooted in between, and misses
  // short-lived prompts entirely. The recorder samples every second in the
  // background and keeps every CHANGED frame, so inspection is decoupled from
  // observation and the agent can always retrieve what it did not witness.
  // ---------------------------------------------------------------------------

  /**
   * Authoritative liveness check: ask Intersight whether this server still has
   * an Active kvm.Session. Independent of whatever wording the client happens
   * to show, so it catches death modes we have never seen (notably the
   * session-EXPIRED dialog, which is the overnight case).
   *
   * Returns null when the answer is unknown (API error, logged out) so the
   * caller does not mistake "cannot tell" for "dead".
   */
  /**
   * The Active vKVM sessions on a server, with the facts needed to judge whose
   * they are.
   *
   * `Session` is the iam.Session that created the kvm.Session — the closest
   * thing to provenance the API offers, though two agents sharing one browser
   * share one iam.Session, so it can never be the only input.
   */
  async activeKvmSessions(serverMoid: string): Promise<
    Array<{ moid: string; iamSessionMoid: string | null; userIdOrEmail: string | null; createdAt: number }>
  > {
    const resp = await this.sessionApi(
      'GET',
      `/api/v1/kvm/Sessions?$filter=Server.Moid eq '${serverMoid}' and Status eq 'Active'` +
        `&$select=Moid,CreateTime,UserIdOrEmail,Session`
    );
    if (!resp.ok || !Array.isArray(resp.body?.Results)) {
      return [];
    }
    return resp.body.Results.map((r: any) => ({
      moid: String(r.Moid),
      iamSessionMoid: r.Session?.Moid ? String(r.Session.Moid) : null,
      userIdOrEmail: r.UserIdOrEmail ? String(r.UserIdOrEmail) : null,
      createdAt: Date.parse(r.CreateTime ?? '') || 0,
    }));
  }

  /** Our browser login's identity, for comparing against a session's provenance. */
  async currentSessionIdentity(): Promise<{ iamSessionMoid: string | null; userIdOrEmail: string | null } | null> {
    const resp = await this.sessionApi('GET', '/api/v1/iam/Sessions?$select=Moid,UserIdOrEmail&$top=1');
    const row = resp.ok ? resp.body?.Results?.[0] : null;
    if (!row) {
      return null;
    }
    return {
      iamSessionMoid: row.Moid ? String(row.Moid) : null,
      userIdOrEmail: row.UserIdOrEmail ? String(row.UserIdOrEmail) : null,
    };
  }

  /**
   * End a vKVM session server-side, freeing the server's only session slot.
   *
   * It is a PATCH, not a DELETE: DELETE on kvm.Session returns
   * 403 "Operation not supported" (verified live), which is why this remedy was
   * so hard to discover — and why reset_tunneled_vkvm looked like the only
   * option while never being able to help.
   */
  async endKvmSession(sessionMoid: string): Promise<any> {
    const resp = await this.sessionApi('PATCH', `/api/v1/kvm/Sessions/${sessionMoid}`, { Status: 'Ended' });
    if (!resp.ok) {
      throw new Error(`could not end kvm.Session ${sessionMoid}: ${resp.status} ${JSON.stringify(resp.body)?.slice(0, 200)}`);
    }
    return { ended: true, sessionMoid, status: resp.body?.Status ?? 'Ended', endTime: resp.body?.EndTime ?? null };
  }

  /**
   * Is a console tab for this server open in the SHARED browser right now?
   *
   * A live scan, not the adoption snapshot taken at attach: tabs opened by
   * another process after we attached are otherwise invisible, which made a
   * launch open a second tab for a server that already had one (reproduced
   * live, and the cause of four accumulated tabs on one server).
   */
  hasOpenConsoleTab(serverMoid: string): boolean {
    return this.findConsoleTabs(serverMoid).length > 0;
  }

  /**
   * Register the newest open console tab for a server as ours to drive.
   *
   * Called at launch time so a tab another process opened after we attached is
   * still found. Extra tabs for the same server are closed: they are leftovers
   * that hold nothing (only one session can be live) and they accumulate — four
   * were found on a single server after days of MCP restarts.
   */
  private adoptConsoleTab(serverMoid: string): Page | null {
    const tabs = this.findConsoleTabs(serverMoid);
    if (tabs.length === 0) {
      return null;
    }
    const keep = tabs[tabs.length - 1];
    for (const extra of tabs.slice(0, -1)) {
      void extra.close().catch(() => {});
    }
    this.kvmPages.set(serverMoid, keep);
    if (!this.kvmServers.has(serverMoid)) {
      try {
        const url = new URL(keep.url());
        this.kvmServers.set(serverMoid, {
          moid: serverMoid,
          objectType: 'compute.RackUnit',
          name: url.searchParams.get('selectedServerName') ?? undefined,
        });
      } catch {
        /* keep going: the descriptor is only used for relaunch */
      }
    }
    keep.on('close', () => {
      if (this.kvmPages.get(serverMoid) === keep) {
        this.kvmPages.delete(serverMoid);
      }
    });
    return keep;
  }

  /** Every open console tab for a server, found by scanning the shared browser. */
  private findConsoleTabs(serverMoid: string): Page[] {
    if (!this.context) {
      return [];
    }
    const tabs: Page[] = [];
    for (const page of this.context.pages()) {
      if (page.isClosed()) {
        continue;
      }
      try {
        const url = new URL(page.url());
        if (/\/cisco-vkvm\//i.test(url.pathname) && url.searchParams.get('selectedServerMoid') === serverMoid) {
          tabs.push(page);
        }
      } catch {
        /* not a URL we care about */
      }
    }
    return tabs;
  }

  /**
   * Disable and re-enable Tunneled vKVM using the BROWSER session.
   *
   * The recorder daemon needs this to escalate when every relaunched console is
   * born dead, and it holds no API key — it authenticates with the browser's
   * cookies like everything else it does. Same two PATCHes and settle time as
   * the API-key path, without the credential dependency.
   */
  async resetTunneledVkvmViaSession(serverMoid: string): Promise<void> {
    const settings = await this.sessionApi(
      'GET',
      `/api/v1/compute/ServerSettings?$filter=Server.Moid eq '${serverMoid}'&$select=Moid`
    );
    const settingMoid = settings.ok ? settings.body?.Results?.[0]?.Moid : null;
    if (!settingMoid) {
      throw new Error(`no compute.ServerSetting found for server ${serverMoid}`);
    }
    for (const state of ['Disable', 'Enable'] as const) {
      const resp = await this.sessionApi('PATCH', `/api/v1/compute/ServerSettings/${settingMoid}`, {
        TunneledKvmState: state,
      });
      if (!resp.ok) {
        throw new Error(`Tunneled vKVM ${state} failed: ${resp.status}`);
      }
      // Each PATCH spawns an "Update Tunneled vKVM" workflow (~15s).
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
    // Relaunching the instant Enable completes still yields a dead session; the
    // KVM service needs settle time (measured).
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }

  /** Power state, used to release a console nobody can watch anyway. */
  async isServerPoweredOn(serverMoid: string): Promise<boolean> {
    const resp = await this.sessionApi(
      'GET',
      `/api/v1/compute/PhysicalSummaries?$filter=Moid eq '${serverMoid}'&$select=OperPowerState`
    );
    const state = resp.ok ? resp.body?.Results?.[0]?.OperPowerState : null;
    // Unknown counts as ON: never release a console on a guess.
    return typeof state === 'string' ? state.toLowerCase() === 'on' : true;
  }

  private async isSessionDeadViaApi(serverMoid: string): Promise<boolean | null> {
    try {
      const resp = await this.sessionApi(
        'GET',
        `/api/v1/kvm/Sessions?$filter=Server.Moid eq '${serverMoid}' and Status eq 'Active'&$select=Moid&$top=1`
      );
      if (!resp.ok || !resp.body || !Array.isArray(resp.body.Results)) {
        return null;
      }
      return resp.body.Results.length === 0;
    } catch {
      return null;
    }
  }

  /**
   * Re-establish a console after a session timeout, for the recorder's
   * self-healing loop: ensure a valid Intersight session (re-logging in if the
   * credentials allow it), then relaunch the vKVM session and return the new
   * page. Skips the launcher's auto-record so it cannot clobber the very
   * recorder that is driving this recovery (which would discard its history).
   */
  private async recoverConsole(serverMoid: string): Promise<Page | null> {
    const server = this.kvmServers.get(serverMoid);
    if (!server) {
      throw new Error(
        `No server descriptor for ${serverMoid}; cannot relaunch its console automatically (it was never launched through launch_vkvm_session).`
      );
    }
    if (!(await this.isLoggedIn())) {
      const login = await this.ensureLoggedIn();
      if (!login?.loggedIn) {
        throw new Error(`Intersight session is not valid: ${login?.reason ?? login?.error ?? 'login failed'}`);
      }
    }
    const launched = await this.launchVkvm(server, { forceNew: true, skipAutoRecord: true });
    if (launched?.sessionEnded) {
      throw new Error(
        'relaunched console was born dead ("KVM session has ended") - reset_tunneled_vkvm may be required for this server'
      );
    }
    const page = this.kvmPages.get(serverMoid);
    return page && !page.isClosed() ? page : null;
  }

  /**
   * Run a deliberate agent interaction (keys, mouse) under a marker so the
   * background anti-blank nudge stays out of its way, and so real input counts
   * as activity (it already resets the console's blank timer).
   */
  private async withAgentInput<T>(target: Page | string | null, fn: () => Promise<T>): Promise<T> {
    const moid = typeof target === 'string' ? target : target ? this.moidForPage(target) : null;
    return this.agentInput.run(moid, fn);
  }

  /** Which console a page belongs to, or null if it is not a vKVM tab. */
  private moidForPage(page: Page): string | null {
    for (const [moid, p] of this.kvmPages) {
      if (p === page) {
        return moid;
      }
    }
    return null;
  }

  /**
   * Send a harmless nudge to keep an idle console from blanking. Declines when
   * the agent is interacting or has just interacted — its input already reset
   * the blank timer, and injecting a stray event mid-interaction risks
   * disturbing whatever the agent is doing.
   *
   * A pointer move is used rather than a keystroke: it cannot type, cannot
   * activate anything, and bootloaders ignore it (a Shift tap would be more
   * reliable at waking a blanked Linux tty, but can drop some distros into the
   * GRUB menu during early boot — opt in via antiBlankMode: 'key').
   */
  private async nudgeConsole(serverMoid: string): Promise<boolean> {
    // Only THIS console's activity matters. Judging by any console's activity
    // let one busy server hold off every other server's anti-blank.
    if (this.agentInput.isBusy(serverMoid)) {
      return false; // the agent's own input already counted as activity
    }
    const page = this.kvmPages.get(serverMoid);
    if (!page || page.isClosed()) {
      return false;
    }
    const recorder = this.recorders.get(serverMoid);
    const mode = recorder?.antiBlankMode() ?? 'mouse';
    if (mode === 'none') {
      return false;
    }
    try {
      // Small move well inside the console area (clear of the vKVM toolbar),
      // alternating so consecutive nudges are always a real movement delta.
      // Tracked PER CONSOLE: a single shared toggle let two consoles nudging on
      // the same cadence flip it for each other, so one of them could be sent
      // the same coordinates twice running - a no-op move that wakes nothing.
      const toggled = !this.nudgeToggles.get(serverMoid);
      this.nudgeToggles.set(serverMoid, toggled);
      const drift = toggled ? 3 : -3;
      await page.mouse.move(820 + drift, 500 + drift);
      if (mode === 'key') {
        // Modifier only: produces no character and submits nothing.
        await page.keyboard.press('Shift');
      }
      return true;
    } catch {
      return false;
    }
  }
  /** serverMoid -> which way the last anti-blank nudge drifted the pointer. */
  private nudgeToggles = new Map<string, boolean>();

  /**
   * Supply the Tunneled vKVM disable/re-enable routine (owned by the MCP
   * server, which has the API client). Without it the recorder can still
   * recover, but cannot fix a server whose every console is born dead.
   */
  setTunneledVkvmResetter(reset: (serverMoid: string) => Promise<unknown>): void {
    this.tunneledVkvmResetter = reset;
  }

  private async resetTunneledVkvmFor(serverMoid: string): Promise<void> {
    if (!this.tunneledVkvmResetter) {
      throw new Error('No Tunneled vKVM reset is wired up');
    }
    await this.tunneledVkvmResetter(serverMoid);
  }

  /**
   * Everything a recorder needs from the browser to keep one console healthy.
   *
   * Built in one place deliberately: these were assembled inline at the call
   * site and `wakeConsole` was simply left out, which silently disabled the
   * "User Inactivity - press a key to wake" remedy. Nothing failed loudly; the
   * recorder just kept recording a green screen with `wakes` stuck at 0.
   */
  private recorderHooks(serverMoid: string): RecorderHooks {
    return {
      // A dead console is a perfectly static image, so change detection alone
      // would report a calm machine forever - check the page explicitly.
      isConsoleDead: (p) => this.isConsoleEnded(p),
      isConsoleDisconnected: (p) => this.isConsoleDisconnected(p),
      isSessionDeadViaApi: () => this.isSessionDeadViaApi(serverMoid),
      // A console asleep from user inactivity needs a KEY, not a relaunch.
      wakeConsole: () => this.wakeConsole(serverMoid),
      // One shared OCR worker across every recorder, not one each.
      ocrFrame: (framePath) => this.frameOcr.textOf(framePath),
      // Session timeouts are expected on long runs: re-login and relaunch the
      // console, then hand the new page back so recording continues.
      recover: () => this.recoverConsole(serverMoid),
      // Keep an idle console awake, but never while the agent is interacting.
      nudge: () => this.nudgeConsole(serverMoid),
      // Escalation when relaunching alone cannot revive the console.
      ...(this.tunneledVkvmResetter
        ? { resetTunneledVkvm: () => this.resetTunneledVkvmFor(serverMoid) }
        : {}),
    };
  }

  /** Start recording a server's console. Idempotent. */
  startRecording(serverMoid: string, opts?: RecorderOptions): any {
    const page = this.resolvePage(serverMoid);
    const existing = this.recorders.get(serverMoid);
    if (existing && existing.isRunning()) {
      return { recording: true, alreadyRunning: true, serverMoid, ...existing.status() };
    }
    const recorder = new VkvmRecorder(
      page,
      path.join(this.recordingDir, serverMoid),
      opts,
      this.recorderHooks(serverMoid)
    );
    recorder.start();
    this.recorders.set(serverMoid, recorder);
    return { recording: true, serverMoid, ...recorder.status() };
  }

  stopRecording(serverMoid: string): any {
    const recorder = this.recorders.get(serverMoid);
    if (!recorder) {
      return { recording: false, reason: `No recorder for server ${serverMoid}` };
    }
    recorder.stop();
    return { recording: false, stopped: true, serverMoid, ...recorder.status() };
  }

  /**
   * Status of the recorder running IN THIS PROCESS.
   *
   * Only a recorder daemon has one: an MCP server owns no consoles and asks
   * daemons over their control endpoint instead. Cross-process discovery lives
   * in RecorderClient, which reads the lock and state files beside the frames.
   */
  /**
   * One server's recording status. Listing "all recorders" is no longer a
   * question for this class: recorders live one-per-process now, and the answer
   * across the machine comes from RecorderClient reading the lock files.
   */
  recordingStatus(serverMoid: string): any {
    const recorder = this.recorders.get(serverMoid);
    return recorder
      ? { serverMoid, ...recorder.status() }
      : { serverMoid, running: false, reason: 'this process holds no recorder for that server' };
  }

  /**
   * Copy recorded frames out of the ring buffer so they survive it.
   *
   * Frame paths are already returned everywhere, but archiving them meant
   * shelling into the filesystem — and the buffer deletes them on a timer, so
   * evidence for a long run has to be taken out before it ages away.
   */
  exportFrames(opts: {
    serverMoid: string;
    destDir: string;
    from?: string;
    to?: string;
    minChangeRatio?: number;
  }): any {
    const recorder = this.requireRecorder(opts.serverMoid);
    const parseTime = (v: string | undefined, fallback: number): number => {
      if (!v) {
        return fallback;
      }
      const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(t)) {
        throw new Error(`Unparseable time "${v}" — pass an ISO timestamp or epoch milliseconds`);
      }
      return t;
    };
    const from = parseTime(opts.from, 0);
    const to = parseTime(opts.to, Date.now());
    const minRatio = opts.minChangeRatio ?? 0;

    const frames = recorder
      .allFrames()
      .filter((f) => f.at >= from && f.at <= to && (f.reason === 'first' || f.changeRatio >= minRatio));

    fs.mkdirSync(opts.destDir, { recursive: true });
    const copied: Array<Record<string, unknown>> = [];
    let bytes = 0;
    let missing = 0;
    for (const f of frames) {
      const stamp = new Date(f.at).toISOString().replace(/[:.]/g, '-');
      const dest = path.join(opts.destDir, `${stamp}-seq${f.seq}-r${f.changeRatio}.png`);
      try {
        fs.copyFileSync(f.path, dest);
        bytes += f.bytes;
        copied.push({ seq: f.seq, at: new Date(f.at).toISOString(), changeRatio: f.changeRatio, path: dest });
      } catch {
        // Evicted between listing and copying: the buffer does not stand still.
        missing++;
      }
    }
    return {
      serverMoid: opts.serverMoid,
      destDir: opts.destDir,
      exported: copied.length,
      diskMB: Math.round((bytes / 1048576) * 10) / 10,
      ...(missing ? { evictedDuringExport: missing } : {}),
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      firstFrames: copied.slice(0, 3),
      lastFrames: copied.slice(-3),
      note:
        copied.length === 0
          ? 'Nothing matched. The retention window may already have dropped these frames — check framesEvicted in vkvm_record_status.'
          : `Frames are filenamed by timestamp, so they sort chronologically next to other test evidence.`,
    };
  }

  private requireRecorder(serverMoid: string): VkvmRecorder {
    const recorder = this.recorders.get(serverMoid);
    if (!recorder) {
      throw new Error(
        `No console recording for server ${serverMoid}. Recording starts automatically with launch_vkvm_session; start it explicitly with vkvm_record_start.`
      );
    }
    return recorder;
  }

  /** Build MCP image+label content for a set of frames. */
  private framesToContent(frames: RecordedFrame[], scale: number, header: string): any {
    const content: any[] = [{ type: 'text', text: header }];
    let prevAt: number | null = null;
    for (const frame of frames) {
      const buf = VkvmRecorder.readFrame(frame, scale);
      if (!buf) {
        continue;
      }
      const gap = prevAt === null ? '' : ` (+${Math.round((frame.at - prevAt) / 100) / 10}s)`;
      prevAt = frame.at;
      content.push({
        type: 'text',
        // Include the on-disk path: the image below is for the model, but a
        // human (or any other tool) needs the file to open the exact frame.
        text: `#${frame.seq} ${new Date(frame.at).toISOString()}${gap} change=${frame.changeRatio} ${frame.reason} | ${frame.path}`,
      });
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
    }
    return content;
  }

  /** The most recent recorded frames (a filmstrip of what just happened). */
  getRecentFrames(serverMoid: string, count = 8, scale = 0.7, changesOnly = true): any {
    const recorder = this.requireRecorder(serverMoid);
    const frames = recorder.recent(count, changesOnly);
    const missed = recorder.newFramesSinceLastView();
    recorder.markViewed();
    if (frames.length === 0) {
      return {
        __mcpContent: [
          { type: 'text', text: `No frames recorded yet for ${serverMoid}. ${JSON.stringify(recorder.status())}` },
        ],
      };
    }
    const st = recorder.status();
    // Surface a dead/recovering console loudly: otherwise a static "KVM session
    // has ended" screen reads as a calm, idle machine.
    const warning =
      st.state === 'recording'
        ? ''
        : `\n!! CONSOLE NOT LIVE - recorder state "${st.state}"` +
          `${st.recoveryFailures ? `, ${st.recoveryFailures} failed recovery attempt(s)` : ''}` +
          `${st.nextRecoveryAttemptAt ? `, next attempt ${st.nextRecoveryAttemptAt}` : ''}.` +
          ` Frames below may predate the outage and do NOT reflect the machine now.` +
          ` Recent events: ${JSON.stringify(st.recentEvents.slice(-3))}`;
    const header =
      `Last ${frames.length} recorded console frame(s) for ${serverMoid}, oldest first` +
      `${changesOnly ? ' (changes only)' : ''}, scale=${scale}. ` +
      `${missed} change frame(s) had occurred since your previous look. ` +
      `Last frame is ${st.secondsSinceLastFrame}s old. ` +
      `Use vkvm_timeline for a cheap text history, or vkvm_frames_at to inspect a specific moment at full resolution.` +
      warning;
    return { __mcpContent: this.framesToContent(frames, scale, header) };
  }

  /** Frames around a moment in time, with neighbours on both sides for context. */
  getFramesAt(
    serverMoid: string,
    opts: { at?: string | number; secondsAgo?: number; before?: number; after?: number; scale?: number }
  ): any {
    const recorder = this.requireRecorder(serverMoid);
    let at: number;
    if (typeof opts.secondsAgo === 'number') {
      at = Date.now() - opts.secondsAgo * 1000;
    } else if (typeof opts.at === 'number') {
      at = opts.at;
    } else if (typeof opts.at === 'string') {
      const parsed = Date.parse(opts.at);
      if (Number.isNaN(parsed)) {
        throw new Error(`Could not parse time "${opts.at}" (use an ISO timestamp, epoch ms, or secondsAgo)`);
      }
      at = parsed;
    } else {
      throw new Error('Provide either "at" (ISO timestamp or epoch ms) or "secondsAgo"');
    }

    const scale = opts.scale ?? 0.7;
    const { frames, centerSeq } = recorder.around(at, opts.before ?? 5, opts.after ?? 5);
    if (frames.length === 0) {
      return { __mcpContent: [{ type: 'text', text: `No frames recorded around ${new Date(at).toISOString()}.` }] };
    }
    const header =
      `Console frames around ${new Date(at).toISOString()} for ${serverMoid} ` +
      `(centre frame #${centerSeq}; ${opts.before ?? 5} before / ${opts.after ?? 5} after), oldest first, scale=${scale}.`;
    return { __mcpContent: this.framesToContent(frames, scale, header) };
  }

  /**
   * Search recorded frames for text, WITHOUT spending image tokens.
   *
   * The motivating case: a long install parks on an error or a "press any key"
   * prompt and nothing changes afterwards, so change-detection reports a calm
   * machine while hours are lost. Asking "did FAILED appear in the last hour"
   * answers that in text alone.
   *
   * Scans newest-first and stops at `maxMatches`, so the common "is anything
   * wrong right now" query only OCRs a handful of frames.
   */
  async findTextInFrames(
    serverMoid: string,
    opts: { pattern: string; lastN?: number; minutesAgo?: number; maxFrames?: number; maxMatches?: number; ignoreCase?: boolean }
  ): Promise<any> {
    const recorder = this.requireRecorder(serverMoid);
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, opts.ignoreCase === false ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid search pattern: ${(error as Error).message}`);
    }

    const since = typeof opts.minutesAgo === 'number' ? Date.now() - opts.minutesAgo * 60000 : undefined;
    const candidates = recorder.framesForSearch(opts.lastN, since);
    const cap = Math.max(1, Math.min(opts.maxFrames ?? 25, 80));
    const maxMatches = Math.max(1, opts.maxMatches ?? 5);
    const toScan = candidates.slice(0, cap);

    const started = Date.now();
    const matches: any[] = [];
    let scanned = 0;
    let ocrFailures = 0;

    for (const frame of toScan) {
      const text = await this.frameOcr.textOf(frame.path);
      scanned++;
      if (text === null) {
        ocrFailures++;
        continue;
      }
      const hit = re.exec(text);
      if (hit) {
        const at = Math.max(0, hit.index - 60);
        matches.push({
          seq: frame.seq,
          at: new Date(frame.at).toISOString(),
          secondsAgo: Math.round((Date.now() - frame.at) / 1000),
          matched: hit[0].slice(0, 80),
          context: text.slice(at, at + 200),
          changeRatio: frame.changeRatio,
          reason: frame.reason,
          path: frame.path,
        });
        if (matches.length >= maxMatches) {
          break;
        }
      }
    }

    const unavailable = this.frameOcr.isUnavailable();
    return {
      serverMoid,
      pattern: opts.pattern,
      found: matches.length > 0,
      matches, // newest first
      framesScanned: scanned,
      framesAvailable: candidates.length,
      elapsedMs: Date.now() - started,
      ...(unavailable ? { ocrUnavailable: unavailable } : {}),
      ...(ocrFailures ? { framesOcrFailed: ocrFailures } : {}),
      note:
        matches.length > 0
          ? 'Matches are newest-first. Use vkvm_frames_at with the timestamp to SEE that moment.'
          : `No match in the ${scanned} most recent frame(s) scanned. Widen with lastN/minutesAgo/maxFrames, or the text may be too small for OCR (prominent dialog text reads reliably; small chrome does not).`,
    };
  }

  /** Cheap text-only change history. */
  getTimeline(serverMoid: string, minutesAgo?: number, minChangeRatio?: number): any {
    const recorder = this.requireRecorder(serverMoid);
    const since = typeof minutesAgo === 'number' ? Date.now() - minutesAgo * 60000 : undefined;
    const all = recorder.timeline(since, minChangeRatio);
    // Keep the response cheap: a long run can accumulate thousands of events.
    const MAX_EVENTS = 200;
    const events = all.length > MAX_EVENTS ? all.slice(-MAX_EVENTS) : all;
    return {
      serverMoid,
      ...recorder.status(),
      events,
      ...(all.length > events.length
        ? { truncated: { shown: events.length, total: all.length, note: 'Showing the most recent events; narrow with minutesAgo.' } }
        : {}),
      recordingDir: path.join(this.recordingDir, serverMoid),
      note: 'Text-only history (no image tokens). Each frame row includes its PNG path, so a frame can be opened directly from disk; or pick a timestamp and call vkvm_frames_at to view it inline.',
    };
  }

  /** Close a vKVM page (ends that KVM session client-side). */
  async closeKvm(serverMoid: string): Promise<any> {
    const page = this.kvmPages.get(serverMoid);
    if (!page) {
      return { closed: false, reason: `No open vKVM page for server ${serverMoid}` };
    }
    this.recorders.get(serverMoid)?.stop();
    await page.close().catch(() => {});
    this.kvmPages.delete(serverMoid);
    return { closed: true, serverMoid, recordingStopped: true };
  }

  /**
   * Detach from the shared browser. Never closes it: the browser runs as a
   * detached OS process precisely so that no MCP instance's lifecycle — exit,
   * restart, or this call — can kill a console another agent is using. Truly
   * closing it is a deliberate human action (close the window).
   */
  async close(): Promise<any> {
    this.stopKeepalive();
    for (const recorder of this.recorders.values()) {
      recorder.stop();
    }
    this.recorders.clear();
    if (!this.context) {
      return { closed: false, reason: 'Browser was not open' };
    }
    // Drop our references without touching the browser or its tabs.
    this.context = null;
    this.attachedBrowser = null;
    this.kvmPages.clear();
    this.adoptedKvmTabs = [];
    return {
      closed: false,
      detached: true,
      note: 'Detached. The browser keeps running (it is shared between MCP instances and owned by none); close its window manually to truly quit it. Login cookies persist in the profile either way.',
    };
  }
}

/**
 * A locally installed Edge or Chrome to spawn as the shared browser.
 * Preference order matches what launchPersistentContext used: Edge, then Chrome.
 */
function findBrowserExecutable(): string | null {
  const programFiles = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter(Boolean) as string[];
  const candidates = [
    ...programFiles.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...programFiles.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    // Non-Windows fallbacks, matching the channels Playwright would have tried.
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
