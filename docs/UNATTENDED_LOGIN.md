# Unattended login & session keepalive (overnight vKVM runs)

Intersight browser sessions expire (idle timeout, and an absolute lifetime). For an agent running tests overnight, that means it silently goes **blind** to every server console partway through the night. This feature lets the server log itself back in via Cisco ID, so a human only has to be present if automation genuinely fails.

Two mechanisms work together:

1. **Keepalive** — a periodic authenticated API ping (default every 240s) counts as activity against the idle timeout.
2. **Automatic re-login** — when the ping comes back 401, the server drives the Cisco ID (Okta) SSO flow itself: username → password → TOTP → account chooser. Also runs on demand.

Both are off unless credentials are configured. Nothing changes for interactive use.

## Configuration

Everything is configurable. **Prefer the credentials file** — environment variables leak into process listings and inherit into child processes.

```bash
export INTERSIGHT_SSO_CREDENTIALS_FILE=/secure/path/intersight-sso.json
```

```json
{
  "username": "you@example.com",
  "password": "your-cisco-id-password",
  "totp": "otpauth://totp/id.cisco.com:you%40example.com?secret=YOURBASE32SECRET&issuer=Cisco",
  "accountName": "CHG-LAB-Intersight"
}
```

See [`intersight-sso.example.json`](../intersight-sso.example.json). `intersight-sso*.json` is gitignored (the `.example` template is the only tracked one). Restrict the file so only you can read it:

```powershell
icacls C:\secure\intersight-sso.json /inheritance:r /grant:r "$env:USERNAME:(R)"
```

Equivalent individual variables (any of these override the file):

| Variable | Purpose |
|---|---|
| `INTERSIGHT_SSO_USERNAME` | Cisco ID email |
| `INTERSIGHT_SSO_PASSWORD` | Cisco ID password |
| `INTERSIGHT_SSO_TOTP` | `otpauth://totp/...` URI **or** a bare base32 secret |
| `INTERSIGHT_SSO_ACCOUNT_NAME` | Account to pick when the multi-account chooser appears |
| `INTERSIGHT_SSO_AUTO_LOGIN` | `false` disables auto-login even when credentials exist |
| `INTERSIGHT_SESSION_KEEPALIVE_SECONDS` | Keepalive interval, default `240`; `0` disables |
| `INTERSIGHT_SSO_DEBUG` | `true` adds step-by-step login diagnostics (e.g. an account-chooser screenshot). Default off — failures screenshot themselves regardless. Also settable as `"debug": true` in the credentials file. |

The `totp` value is exactly the `otpauth://` URI your authenticator app was enrolled with — `secret`, `algorithm`, `digits` and `period` are all parsed from it (defaults: SHA1 / 6 digits / 30s). Codes are generated locally per RFC 6238; the implementation is verified against the RFC's official SHA1/SHA256/SHA512 test vectors.

## Usage

- `browser_open` — logs in automatically when credentials are configured, then starts the keepalive. Its result includes an `autoLogin` block (see below).
- `browser_login {force?}` — ensure a session on demand; `force: true` re-runs the flow even if the session still looks valid.
- `browser_status` — includes the same `autoLogin` block: `configured`, `enabled`, `credentialSource`, masked `username`, `totpConfigured`, `accountName`, `keepaliveSeconds`, `keepaliveRunning`, `logins`, `lastLoginAt`, `lastKeepalive`.
- `launch_vkvm_session` — if the session has expired it now **self-heals** (re-login) instead of failing, so an overnight run recovers on its own.

A typical overnight setup: configure the credentials file, start the run, and the agent calls `browser_open` once. No human step required. Without credentials the behavior is unchanged — a human logs in in the visible window and the session persists in the browser profile.

## Secrets handling

- Credentials are only ever typed into the login form. They are **never** returned in tool output, logged, or written to disk by this server.
- `browser_status` masks the username (`d***@quali.com`) and reports only *whether* a TOTP secret is configured.
- On login failure a screenshot is saved to `~/.intersight-mcp/screenshots/login-failure-*.png` for diagnosis. It shows the login page at the point of failure — a password field renders masked, but treat these images as sensitive and delete them when done.
- Storing the password and TOTP seed together on one machine means that machine is a single point of compromise — it reduces MFA to one factor in practice. That is an accepted trade-off for unattended automation on a lab account; don't reuse this pattern for a privileged production identity, and rotate if the host is ever exposed.

## Session lifetimes (this account)

From `GET /api/v1/iam/SessionLimits`:

| Setting | Value | Meaning |
|---|---|---|
| `IdleTimeOut` | 18000s = **5 hours** | an idle session expires; the 240s keepalive comfortably prevents this |
| `SessionTimeOut` | 90000s = **25 hours** | absolute lifetime — even a kept-alive session eventually dies, so the re-login path matters for multi-day runs, not just idle ones |
| `PerUserLimit` | 32 | concurrent sessions per user |

Note that `isLoggedIn()` is itself an API call, so **any polling of it resets the idle timer**. That is useful in production (it is how the keepalive works) but it means instrumentation can mask an expiry you are trying to observe.

## Session persistence across a browser restart

The session **can** survive the browser exiting: after an MCP server restart that killed the old browser, a fresh browser on the same persistent profile came up `loggedIn: true` with `logins: 0` — the cookies were restored from disk and no re-authentication happened.

(An earlier note here claimed the opposite. That was wrong: the profiles it was based on had been through many logins and deliberate session terminations during testing, so their sessions were genuinely dead — not evidence that cookies fail to persist.)

Two caveats still hold:
- Restoring only works if the session is still valid server-side (within the 5h idle / 25h absolute limits, and not terminated).
- Detection depends on the redirect to the **regional** host landing before `isLoggedIn()` is checked — `open()` waits for it, because testing the bare origin always 401s and would force a needless re-login.

## One-time codes cannot be shared: never log in twice at once

A TOTP code is valid once. Two processes authenticating within the same 30-second window generate the *same* code, and the second is rejected — surfacing as the generic "no valid Intersight session was detected". Two harnesses starting ~15s apart reproduced this reliably, while sequential logins never failed.

Mitigations in place:
- Multiple MCP server instances **share one browser** (CDP attach), so normally only one login happens at all.
- A failed login is retried once after waiting into a **fresh TOTP window** (`loginWithTotpRetry`). The pair counts as a single attempt against the lockout breaker, since it is one login intent.

If you script your own logins against the same credentials, stagger them by more than 30s.

## Account-lockout guard

A keepalive loop retrying a wrong password every few minutes all night would lock the Cisco ID account. So auto-login **self-disables after 3 consecutive failures**: the keepalive stops, and `browser_status` reports `consecutiveFailures` and `autoLoginDisabledReason`. Fix the credentials and call `browser_login` with `force: true` (or log in manually) to re-arm — a successful login also resets the counter.

## Hard-won details of the Cisco ID flow (validated live 2026-07-28)

The full cold login was validated end to end from a brand-new browser profile: `Sign In with Cisco ID` → username → password → TOTP → account chooser → lands authenticated on the regional host (`us-east-1.intersight.com/an/infrastructure-service/...`). Four non-obvious traps, all now handled — do not "simplify" these away:

1. **The account chooser's card centre is the "Sign Out" link.** The chooser (`www.intersight.com/onboarding/selectaccount/`, titled *Select Account and Role*) renders each account asynchronously behind a spinner. Matching a *container* (`li:has-text(...)`, `tr:has-text(...)`, a card) and clicking it makes Playwright click the element's **centre**, which on that page is `Sign Out of Intersight` — silently signing out while reporting a successful selection. Always click the **smallest element containing the account name** (`getByText(name).first()`), and wait for that text to render (up to 60s) rather than for the page.
2. **Okta remounts its inputs while hydrating.** A value typed too early is truncated (observed: only `da` of an email survived), which fails validation and leaves the submit button *disabled* — so the flow appears to hang on a dead button. `typeField()` therefore lets the widget settle, sets the value, **reads it back**, and retries with real keystrokes.
3. **Never click a control matched only by visibility.** Cisco ID's submit starts disabled; `firstEnabled()` waits for visible *and* enabled, and `submitStep()` reports whether it actually clicked so callers can't assume progress.
4. **The session lives on a REGIONAL host.** After SSO, Intersight redirects to e.g. `us-east-1.intersight.com`; the bare `intersight.com` API returns 401 (`X-Starship-Token invalid`). Never navigate to the bare app route while the redirect chain is completing — that bounces to `?redirectTo=…` login and destroys the session being established. `waitForSession()` therefore polls without navigating, and account selection can close/replace the tab, so work from `ensureLivePage()` rather than a remembered page.

Diagnostics: every login records a URL trail in `stepsCompleted`, and a failure always saves a `login-failure-*.png`. Setting `INTERSIGHT_SSO_DEBUG=true` adds an account-chooser screenshot per login (off by default — it isn't needed once the flow works). That URL trail is what made the Sign Out trap findable, so keep it unconditional.

## Robustness notes

- The flow matches form fields from **candidate selector lists** (Okta variants: `input[name="identifier"]`, `#okta-signin-username`, `input[type="email"]`, …) rather than one hardcoded selector, and falls back to pressing Enter when no submit button matches. Cisco's login UI still changes; if a step stops matching, the debug screenshot shows where, and the fix is to add a selector to the relevant list in `performCiscoIdLogin()`.
- If a TOTP code is rejected as already-used, it waits for the next 30s window and retries once.
- After a re-login, vKVM tabs from the dead session are closed automatically (their consoles are useless), so the agent relaunches instead of screenshotting a dead console.
- Concurrent callers share a single in-flight login attempt (no double submission).
- The keepalive timer is `unref`'d, so it never keeps the process alive on its own.

**Status:** validated live 2026-07-28 — a cold automated login from a fresh browser profile completed the whole Cisco ID chain (including TOTP and the 3-account chooser) and ended authenticated on the regional host. TOTP generation is verified against the RFC 6238 test vectors; credential loading, masking, the no-credentials path, and the lockout guard are verified too.
