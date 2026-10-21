# Unattended login & session keepalive (overnight vKVM runs)

Intersight browser sessions expire (idle timeout, and an absolute lifetime). For an agent running tests overnight, that means it silently goes **blind** to every server console partway through the night. This feature lets the server log itself back in via Cisco ID, so a human only has to be present if automation genuinely fails.

Two mechanisms work together:

1. **Keepalive** — a periodic authenticated API ping (default every 240s) counts as activity against the idle timeout. It only pings; it never logs in.
2. **Automatic login** — when a recorder needs its console and the session is proven gone, the daemon drives the Cisco ID (Okta) SSO flow itself, **once**: username → password → TOTP → account chooser.

Both are off unless credentials are configured. Nothing changes for interactive use.

**Every web login is rationed** — see [The login policy](#the-login-policy-one-attempt-proof-and-a-recorder) below. Bursts of automated logins locked this account out of Intersight twice in a month, and each time the way back was an administrator removing and re-adding the user, which also revokes every API key. So: one attempt per need and never a retry; no login until the session is proven gone; no login at all unless a recorder needs a console.

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

- `browser_open` — opens the window at Intersight. It logs in automatically only when a recorder is active and the session is proven gone; otherwise the window is left for a human to log in. Its result includes an `autoLogin` block (see below) and, when a login was attempted or refused, `autoLoginResult` with the reason.
- `browser_login {force?}` — ensure a session on demand: **at most one** Cisco ID attempt per call, and only when a recorder is active and the session is proven gone. After a failed attempt automatic login is disarmed, and this call is the one way to try once more. It never re-logs-in over a valid session — `force` is accepted for compatibility and means the same thing. Do not call it in a loop: if it fails, a human has to look.
- `browser_status` — includes the `autoLogin` block: `configured`, `enabled`, `credentialSource`, masked `username`, `totpConfigured`, `accountName`, `keepaliveSeconds`, `keepaliveRunning`, `logins`, `lastLoginAt`, `lastKeepalive`, `autoLoginDisabledReason`, and `loginPolicy` (`armed`, `lastAttempt`, `attempts`, `failuresSinceSuccess`, `activeRecorders`).
- `launch_vkvm_session` / `vkvm_record_start` — a recorder that finds the session gone logs in **once** on its own; if that fails it reports `consoleProblem` with the policy's reason and keeps the recorder (degraded) without logging in again.

A typical overnight setup: configure the credentials file and start the recorders; the first one to need a console logs in. No human step required. Without credentials the behavior is unchanged — a human logs in in the visible window and the session persists in the browser profile.

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
- Exactly one process ever logs in: the account daemon owns the only browser (see below), so there is nothing to collide with.
- There is **no retry** any more. A failed login used to be retried once in a fresh TOTP window; that retry is gone with the rest of the retries (see the policy below). If a code is rejected as already used, the attempt simply fails and a human decides.

If you script your own logins against the same credentials, stagger them by more than 30s — and know that every login you add is one more toward a lockout.

## The login policy: one attempt, proof, and a recorder

Two lockouts in a month changed what "robust" means here. On 2026-09-26 several processes logged in against each other (~1,050 attempts in a morning, see below); on 2026-10-21 it happened again, with only a handful of attempts. Each time Intersight stopped creating sessions for the user, the way back was an administrator removing and re-adding the user to the account, and that revokes every API key the user had — a day of reconfiguration, and the vKVM tools unusable until then. The lesson is that the number of logins is the risk, so the daemon rations them ([src/services/loginPolicy.ts](../src/services/loginPolicy.ts)):

1. **One attempt per need, never a retry.** Any failed attempt — credential or mechanical, it makes no difference to Intersight — **disarms** automatic login. Recorders keep running (degraded, retrying their console on the usual backoff) but no longer log in; `browser_status` shows `autoLoginDisabledReason` and `loginPolicy.lastAttempt`. The one way to try again is an explicit `browser_login`, which is itself a single attempt. A success re-arms.
2. **No login until the session is proven gone.** Before any attempt the daemon gathers evidence: an authenticated API ping that answers 2xx means *valid* (no login); a 401 is only a candidate, because the bare `intersight.com` origin always 401s — the daemon then navigates a non-console tab to an app route, and only the **sign-in page** showing is *proven-logged-out*. Anything else (a network error, a 5xx, an app page whose API still 401s) is *unknown*, and the daemon refuses to log in over a possibly valid session. `browser_login` returns the `evidence` it found.
3. **No recorder needing a console, no login.** The daemon tells the browser how many recorders are in phase `starting`, `active` or `degraded` (dormant and stopped recorders have released their console). When that is zero, every login — recorder, keepalive, `browser_open`, `browser_login` — is refused with a reason that says how a login does happen: start a recorder. When no browser is even open, the daemon does not launch one to find out.

The keepalive therefore only pings. If a ping fails it is logged once and reported in `lastKeepalive`; the next recorder that needs its console gathers the evidence and, if the session really is gone, logs in once.

What to do when `loginPolicy.armed` is `false`: look at `lastAttempt.error` and the `login-failure-*.png` screenshot, fix the cause, then call `browser_login` once — or log in manually in the daemon's browser window, which the recorders pick up on their next retry without any login of their own.

## Hard-won details of the Cisco ID flow (validated live 2026-07-28)

The full cold login was validated end to end from a brand-new browser profile: `Sign In with Cisco ID` → username → password → TOTP → account chooser → lands authenticated on the regional host (`us-east-1.intersight.com/an/infrastructure-service/...`). Four non-obvious traps, all now handled — do not "simplify" these away:

1. **The account chooser's card centre is the "Sign Out" link.** The chooser (`www.intersight.com/onboarding/selectaccount/`, titled *Select Account and Role*) renders each account asynchronously behind a spinner. Matching a *container* (`li:has-text(...)`, `tr:has-text(...)`, a card) and clicking it makes Playwright click the element's **centre**, which on that page is `Sign Out of Intersight` — silently signing out while reporting a successful selection. Always click the **smallest element containing the account name** (`getByText(name).first()`), and wait for that text to render (up to 60s) rather than for the page.
2. **Okta remounts its inputs while hydrating.** A value typed too early is truncated (observed: only `da` of an email survived), which fails validation and leaves the submit button *disabled* — so the flow appears to hang on a dead button. `typeField()` therefore lets the widget settle, sets the value, **reads it back**, and retries with real keystrokes.
3. **Never click a control matched only by visibility.** Cisco ID's submit starts disabled; `firstEnabled()` waits for visible *and* enabled, and `submitStep()` reports whether it actually clicked so callers can't assume progress.
4. **The session lives on a REGIONAL host.** After SSO, Intersight redirects to e.g. `us-east-1.intersight.com`; the bare `intersight.com` API returns 401 (`X-Starship-Token invalid`). Never navigate to the bare app route while the redirect chain is completing — that bounces to `?redirectTo=…` login and destroys the session being established. `waitForSession()` therefore polls without navigating, and account selection can close/replace the tab, so work from `ensureLivePage()` rather than a remembered page.

Diagnostics: every login records a URL trail in `stepsCompleted`, and a failure always saves a `login-failure-*.png`. Setting `INTERSIGHT_SSO_DEBUG=true` adds an account-chooser screenshot per login (off by default — it isn't needed once the flow works). That URL trail is what made the Sign Out trap findable, so keep it unconditional.

## Robustness notes

- The flow matches form fields from **candidate selector lists** (Okta variants: `input[name="identifier"]`, `#okta-signin-username`, `input[type="email"]`, …) rather than one hardcoded selector, and falls back to pressing Enter when no submit button matches. Cisco's login UI still changes; if a step stops matching, the debug screenshot shows where, and the fix is to add a selector to the relevant list in `performCiscoIdLogin()`.
- After a re-login, vKVM tabs from the dead session are closed automatically (their consoles are useless), so the agent relaunches instead of screenshotting a dead console.
- Concurrent callers share a single in-flight login attempt (no double submission). That guard only works **within one process**, which is why exactly one process ever logs in — see below.
- The keepalive timer is `unref`'d, so it never keeps the process alive on its own.

## Exactly one process logs in: the account daemon

Two logins interleaving in one browser break each other, whatever each does right on its own. The browser is shared, so its cookie jar is too: login B's OIDC state cookie replaces login A's, and A's callback is rejected with **"Invalid Request — OIDC state parameter is invalid."** The flows also navigate each other's tabs away mid-step, which shows up as *"Could not find the password field on the Cisco ID login page"*, `net::ERR_ABORTED`, or *"navigation interrupted by another navigation"*. And two logins in one 30s window generate the same TOTP code, which Okta accepts only once.

That is what happened on 2026-09-26, when every server had its own recorder daemon, each with its own login and keepalive: ~950 failed logins in a morning, never counted by the lockout guard (no credential had been sent), until Intersight stopped minting sessions (`error=tokenlimit_reached`). So login, keepalive and the browser now live in the single account daemon ([VKVM_BROWSER.md](VKVM_BROWSER.md#why-one-daemon-not-one-per-server)); `browser_open`, `browser_login` and `browser_status` in any MCP server are served by it. The login also picks its tab by URL, so it never navigates any console tab away.

If you see the OIDC error again, look for a second process driving the same browser profile: an MCP server still running an old build, a legacy per-server daemon (`recorder.lock` files under `~/.intersight-mcp/recordings/`), or a script of your own.

**Status:** validated live 2026-07-28 — a cold automated login from a fresh browser profile completed the whole Cisco ID chain (including TOTP and the 3-account chooser) and ended authenticated on the regional host. TOTP generation is verified against the RFC 6238 test vectors; credential loading, masking, the no-credentials path, and the login policy ([loginPolicy.test.ts](../test/loginPolicy.test.ts), [loginGate.test.ts](../test/loginGate.test.ts)) are verified too.

## Never click the Cisco ID button before the page is ready

A login died this way on 2026-08-24, and the operator's description was exactly
right: *"the Sign in with Cisco ID button showed a loading icon for about a
minute"*. From the daemon's own log:

```
waiting for locator(':text("Sign In with Cisco ID")').first()
  - locator resolved to <ucs-button disabled ... id="submitButton" ...>
- attempting click action
  57 x waiting for element to be visible, enabled and stable
     - <div class="login-container">...</div> intercepts pointer events
   - retrying click action
locator.click: Timeout 30000ms exceeded.
```

Two faults at once:

1. The button carried a **`disabled` attribute** while the widget booted. It is a
   custom element (`ucs-button`), and Playwright's enabled-check understands
   native form controls and `aria-disabled` — **not** a bare attribute on a custom
   element. So it believed the button was clickable.
2. The page's own loading overlay, **`div.login-container`**, covered it, so every
   hit test failed and the click spent its full 30-second timeout retrying.

The attempt was then spent; the retry 28 seconds later landed on a
half-initialised page where the username field never appeared either, giving the
misleading `Could not find the username field on the Cisco ID login page`. The
daemon went `degraded` and backed off 60s, 120s, 240s.

So the click now waits for readiness first
([loginButtonReady.ts](../src/utils/loginButtonReady.ts)): up to 45 seconds for
the button to lose `disabled`/`aria-disabled` **and** for a hit test at its centre
to reach the button rather than an overlay. Every blocker is named in the login
steps, because "not ready" alone leaves the next reader to reverse-engineer 57
identical Playwright retry lines. The click itself is then bounded at 10 seconds,
and if an overlay outlasts the wait a programmatic in-page click is used — no
overlay can intercept that, and by then the button is enabled so the click means
something. Clicking a still-disabled button is explicitly refused: it would do
nothing while looking like success.

## Failure kinds: credential or mechanical (a label, no longer a budget)

Every failed attempt is still classified by how far it got
([loginFailureClassification.ts](../src/utils/loginFailureClassification.ts)),
and the result is reported as `failureKind` in the login result and in
`loginPolicy.lastAttempt`:

| How far the attempt got | `failureKind` |
|---|---|
| Page never loaded, button not clickable, username field missing | mechanical |
| Username submitted (identifier-first IdP discovery) | mechanical — nothing was verified |
| **Password submitted** | credential |
| **TOTP / MFA submitted** | credential |
| Failure at the account chooser, after Cisco ID accepted us | mechanical — an Intersight problem, not a credential one |

Until 2026-10 this was a budget: only credential failures counted toward a
three-strike guard, and mechanical ones were "retried freely". That was the right
call for the Cisco ID password lockout it was designed around, and the wrong one
for what actually locked the account: Intersight's own limit on logins. On
2026-09-26, ~950 of the ~1,050 attempts were mechanical — none sent a credential,
none counted, all of them counted. So now **any** failure disarms automatic login
(see the policy above), and the classification only tells the reader where the
attempt broke: a mechanical failure points at the page (inspect the screenshot and
`stepsCompleted`), a credential failure points at the credentials.

## The sign-in page asks for the email first (redesign, 2026-08-24)

The page changed shape and the flow was built for the old one. Captured live from
a failure screenshot plus a shadow-DOM dump:

```
ucs-input            > … > input#input[name="Email"][type="text"]   <- fill THIS first
ucs-button#submitButton  "Sign In with Cisco ID"                    <- disabled until it is filled
---- Or ----
ucs-input#ssoEmail   > … > input#input[name="sso-email"]            <- a DIFFERENT flow
ucs-button               "Sign In with SSO"
```

Three faults followed from one change:

1. **The button is disabled until the email is typed.** The flow clicked it first,
   so the click could never land — and the operator saw a spinner on the button
   while Playwright retried for 30 seconds.
2. **The selectors missed the field.** It is `name="Email"` (capital E) with
   `type="text"`; the flow looked for `name="email"` and `type="email"`. CSS
   attribute values are case-sensitive, so neither matched — reported as
   `Could not find the username field on the Cisco ID login page`, which points at
   the wrong thing entirely. Selectors now carry the `i` flag.
3. **There are two email boxes.** Typing a Cisco ID address into the SSO one
   starts a different login, so the choice is deliberate
   ([intersightLoginForm.ts](../src/utils/intersightLoginForm.ts)) and returns
   nothing rather than guessing.

Verified live: a daemon restarted on the fix reached `phase: active` with a live
console in 83 seconds, first attempt, no login failures. The older single-field
layout is still handled — a missing email box is a recorded step, not an error.

