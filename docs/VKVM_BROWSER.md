# vKVM Browser Tools — seeing and controlling servers through Intersight

These tools give an AI agent eyes and hands on a physical UCS server's console: launch a tunneled vKVM session through Intersight, take screenshots of the console, and send keyboard/mouse input.

## Why a browser is involved at all

Intersight's REST API documents `kvm.Session` / `kvm.Tunnel` resources with create operations, and they appear in the SDKs and Terraform provider — but the SaaS backend **rejects creates authenticated with API keys**:

```
400 — "Create operation is not allowed using an API key. Use a valid user session."
(magnum_create_not_allowed_using_api_key, verified live 2026-07-09)
```

vKVM launch is deliberately tied to interactive user sessions (a human accountable for console access — session records carry `UserIdOrEmail`, `ClientIpAddress`, `Role`). Additionally, there is **no server-side screenshot API** anywhere in Intersight or CIMC: the console pixels only exist inside the HTML5 KVM client page (a `<canvas>` fed by a WebSocket).

Both constraints point at the same solution: a real browser.

## Architecture

- `BrowserService` ([src/services/browserService.ts](../src/services/browserService.ts)) drives a **visible (non-headless)** Chromium-family browser via `playwright-core`, preferring the system-installed **Edge**, then Chrome (no browser download needed).
- The browser uses a **persistent profile** at `~/.intersight-mcp/browser-profile`, so the Intersight login (Cisco SSO + MFA) is done by a human **once**; cookies survive browser and MCP-server restarts until Intersight expires the session.
- Session-authenticated API calls are made through the browser context's cookie jar (`context.request`). Intersight's CSRF protection requires the `X-Requested-With: XMLHttpRequest` header on API calls (a header cross-site requests can't set without a CORS preflight); its absence returns `401 iam_csrf_header_is_missing`, so the service always sends it.
- After login Intersight redirects to a **regional** host (e.g. `us-east-1.intersight.com`) where the session cookies live; the service targets that active regional origin rather than the bare `intersight.com`.
- Screenshots are saved to `~/.intersight-mcp/screenshots/` and also returned inline as MCP image content, so the model literally sees the console.

## Tool flow

```
browser_open                    → visible window at intersight.com; user logs in (once)
browser_status                  → poll until loggedIn: true
launch_vkvm_session {serverMoid}→ open the Intersight vKVM app route in a new tab
                                  (/cisco-vkvm/tunneled?selectedServerMoid=…)
browser_screenshot {serverMoid} → PNG of the console (returned as an image)
browser_send_keys   {text|keys} → keyboard into the console ("Control+Alt+Delete", "F6", …)
browser_mouse       {x, y, …}   → mouse; coordinates match the screenshot's pixels
vkvm_wait           {mode}      → block until the screen changes / stabilizes, return that frame
vkvm_press_until    {keys}      → hammer key(s) until the screen changes/stabilizes (enter BIOS)
vkvm_watch          {durationMs}→ record a window; report every change with timestamps
reset_tunneled_vkvm {serverMoid}→ fix for the "KVM session has ended" Intersight bug
close_vkvm_session / browser_close
```

Support/diagnostic tools: `browser_goto` (navigate a tab), `browser_evaluate` (run JS in the page, e.g. inspect the KVM client DOM), `browser_intersight_api` (any session-authenticated Intersight REST call).

### How the launch actually works (learned by observing the UI)

The "Launch Tunneled vKVM" action in the Intersight UI does **not** open the `kvm.Tunnel.ClientUrl` (`intersight.com/kvm/mux-…`, which is single-use and returns "Bad Request" if opened directly). Instead it opens a first-party web-app route:

```
https://<region>.intersight.com/cisco-vkvm/tunneled?selectedServerMoid=<moid>&selectedServerName=<name>&serverProfileName=<profile>
```

That app creates and manages the `kvm.Tunnel` / `kvm.Session` internally using the logged-in session. So `launch_vkvm_session` resolves the server MOID to `compute.RackUnit`/`compute.Blade` and its assigned server-profile name (best-effort), then opens this route on the active regional origin.

**"Ready" does not mean reachable.** A server can report `compute.ServerSetting.TunneledKvmState: Ready` and still serve an Intersight **"Forbidden — You are not authorized to access this resource"** page (observed on `C845-WZP29429JQ2`). Because that is not a *death* wording, a recorder will happily capture the error page and report a healthy console — an unattended agent would then watch "Forbidden" all night believing it had eyes on the server. `launch_vkvm_session` therefore checks for it explicitly, returns `accessDenied: true` with a hint, and **skips auto-recording** so nothing records an error page. Before claiming a server, it is also worth checking `GET /api/v1/kvm/Sessions?$filter=Status eq 'Active'` — a console held by *another user* will be fought over.

**One live session per server (idempotent launch).** A server allows only one live tunneled vKVM session. Launching a second while the first tab is still connected produces a **born-dead** "KVM session has ended" page — which is easy to misdiagnose as the reset-needing bug below and waste a ~90s reset cycle. `launch_vkvm_session` is therefore idempotent:
- If a **live** vKVM tab for the server is already open, it is **reused** (returned with `reused: true`) rather than relaunched.
- If the existing tab is **dead** (or `forceNew: true` is passed), it is closed first and the server is given a few seconds to free the session slot before a fresh tab opens.
- When a launch still comes up born-dead **and other vKVM tabs are open**, the returned `hint` tells the agent to close the other session(s) first (cheap) before reaching for `reset_tunneled_vkvm`.

The console renders inside a `<kvm-ui>` **custom element / shadow DOM** (siblings: `<ucs-session-mgr>`, `<ucs-router>`) — there is no top-level `<canvas>`. Screenshots capture it fine (they read rendered pixels), and mouse/keyboard events dispatched by page coordinate reach it, so **`browser_mouse` coordinates line up 1:1 with what `browser_screenshot` shows**.

Verified live 2026-07-09 against `C240-WZP26220B5F`: the console showed the server's Maglev (Catalyst Center) configuration wizard, with the full vKVM toolbar (Power, Boot Device, Virtual Media, Macros).

### Time-sensitive control (the perceive→think→act latency problem)

vKVM is far more time-sensitive than the REST tools. An agent's loop is slow: screenshot → (seconds of thinking) → act. For console work this breaks two ways:

- **Temporal blindness** — two screenshots that both show "Memory testing" don't tell the agent whether the machine rebooted in between.
- **Reactive timing** — pressing F2 to enter setup has to happen *while the POST prompt is on screen*, not seconds later after the agent has finished reasoning about an old frame.

The fix is architectural: **push the tight sample→compare→act loop out of the agent and into the browser service**, where it runs at machine speed. The agent supplies intent; the service runs the fast loop and returns the decisive frame. All three tools are built on full-frame pixel diffing (`pixelmatch` + `pngjs`): a screenshot is compared to a baseline/previous frame and the fraction of differing pixels is thresholded (default ~1%, which ignores a blinking cursor or ticking clock).

- **`vkvm_press_until {keys}`** — presses the key(s) every `intervalMs` (default 300ms) until the screen changes (default) or stabilizes, or `timeoutMs`. This is how to enter BIOS/boot setup: `keys:["F2"]` (or `["Delete"]`, `["Escape"]`) spams the prompt with no agent latency between presses, and stops the instant the menu appears. Returns the final frame as an image.
- **`vkvm_wait {mode}`** — blocks until the frame **changes** (`mode:"change"` — a reboot, a progress step, a new menu) or goes **stable** (`mode:"stable"` — quiet for `stablePeriodMs`), then returns that frame. In stable mode the outcome distinguishes `stable` (it moved, then settled — e.g. a boot finished) from `quiet` (it never moved during the wait), so a screen that was static the whole time is not mistaken for "settled after an action". Lets the agent act at the right instant: "wait stable, then screenshot / send keys."
- **`vkvm_watch {durationMs}`** — samples for a fixed window and reports every change with timestamps, plus the first and last frames. One call answers "did it reboot / did anything move while I was thinking?" instead of two manually-spaced screenshots.
- **`browser_screenshot`** now also returns `changeSinceLastShot` (pixel-diff ratio + seconds since your previous screenshot of that page), so even plain screenshots carry a hint of net activity.

Caveat: these loops call `bringToFront()` so the KVM tab paints fresh frames (background tabs throttle rendering), which means they momentarily take focus in the operator's browser window — and because a single shared browser is used, running two long operations against different servers concurrently can interfere. Diffing is full-frame at a few FPS; that's plenty for boot/POST work but is not a substitute for real key-timing on sub-second animations.

**Threshold limitation (important):** change/stable detection is a single *global* full-frame pixel ratio. A physically small but semantically critical change — a `Press F2 to enter setup` prompt, one new log/error line — can be under the default ~1% threshold and therefore missed, while a ticking clock or spinner can exceed it and register as spurious activity. For small-target prompts, lower `threshold`, or prefer `vkvm_press_until` (which hammers the key regardless and stops when *anything* changes) over waiting for the prompt to be detected. A region-aware diff would be the more robust long-term mechanism.

Note there are **two independent thresholds** and they are tuned differently: the *wait/press* tools above default to `0.01`–`0.02` (they are looking for a decisive screen transition), while the **recorder** uses a far more sensitive `0.0005` calibrated to catch a single new line of text (see *Change-threshold calibration* below). Don't copy one value onto the other.

**Availability:** all browser/vKVM tools are enabled only in **All Tools Mode** (`INTERSIGHT_TOOL_MODE=all`); Core Mode stays read-only and does not expose them.

### Continuous recording — never miss what happened between looks

Even with the tools above, a screenshot is a *point sample* of a continuous process. An agent that looks every few minutes cannot tell a frozen screen from one that rebooted in between, and short-lived prompts and errors are simply never seen. Timing the call better does not fix this: some operations genuinely take a long time, and the console is often the only signal that anything is happening at all.

The fix is to decouple **observation** from **inspection**. A background recorder samples the console every second and keeps every frame in which the screen changed; the agent then retrieves batches of frames whenever it gets around to looking. MCP cannot push data to a model, but a tool *result* can carry a whole filmstrip — so what the agent sees is a sequence, not a single instant.

Recording starts **automatically** with `launch_vkvm_session` (disable with `INTERSIGHT_VKVM_AUTORECORD=false`).

| Tool | Use |
|---|---|
| `vkvm_recent {serverMoid, count, scale}` | The last N frames as a filmstrip (default 8). The default way to check on a machine. |
| `vkvm_frames_at {serverMoid, at\|secondsAgo, before, after}` | A specific moment **plus neighbours on both sides**, so you see how it got there and what followed. |
| `vkvm_timeline {serverMoid, minutesAgo}` | Text-only change history — **no image tokens**. Find *when* something happened, then look at it. |
| `vkvm_record_start` / `_stop` / `_status` | Manual control, tuning, disk/error stats. |

**Observed capacity (measured over a multi-hour run).** With the defaults (1s sampling, 60s heartbeat, 120-minute retention) a mostly-idle 1600×900 console settles at roughly **20MB and ~170 frames per server**, reached after about two hours and flat thereafter — pruning holds it there. A second recorder on a static console plateaued near 6MB. Budget per *recorded server*, not per session.

**Storage is change-triggered, not time-triggered.** Frames are stored only when the screen actually changes, plus a heartbeat every 60s as proof-of-life. An idle console costs almost nothing; a boot sequence keeps every distinct state. Pixel-identical frames are detected by hashing the PNG bytes, which skips image decoding entirely in the common idle case. Defaults: 1s sampling, 120 minutes retention, 3000 frames max, pruned oldest-first.

**Change-threshold calibration (measured, don't guess).** On a 1600×900 console a single character — a blinking cursor — moves ~0.0003 of the frame, while a whole new line of text moves 0.001–0.0026. The default threshold is therefore **0.0005**, which sits between the two: cursor blink is ignored, every new line of output is captured. Verified: 4/4 distinct screens recorded, 0 frames from 6 cursor toggles. An earlier 0.002 threshold looked conservative and silently discarded three quarters of real console activity — if you tune this, measure rather than assume, and bias low.

**Token cost.** A full-resolution frame is ~1920 vision tokens, so batches are downscaled by default (`scale: 0.7`; `0.5` → ~480 tokens). Box-averaging is used rather than nearest-neighbour so thin console text stays legible. For reading fine detail, request `scale: 1.0` with a small `count`. Use `vkvm_timeline` to navigate before spending image tokens.

**Missed-change signalling.** When a console is being recorded, `browser_screenshot` reports `missedChanges` — how many recorded changes are *not* visible in that single frame — so a point sample can't be mistaken for the whole story.

**Two independent liveness signals.** The client announces death with several different wordings — `KVM session has ended` (born dead) and `Session Terminated / terminated by an Administrator` (admin kill) are terminal, blocking dialogs and are matched. Transient **toasts** like `KVM session has been disconnected due to: Network connection has been dropped` are deliberately *not* matched: they describe a past event and linger on a freshly relaunched console, so treating them as death made every recovery look like a new death and produced a relaunch loop (observed live: 4 recoveries from one termination). The component also ships an unseen session-**expired** dialog (its `ucsSessionMgr.expired.*` i18n keys sit in the DOM even on a healthy console, so patterns must require spaced human-readable phrasing or they false-positive). Because enumerating wordings is guesswork, a second, authoritative signal asks Intersight directly whether an `Active` kvm.Session still exists for the server (`isSessionDeadViaApi`, every ~60s). The text probe is fast (~10s); the API check is wording-independent and catches death modes we have never seen.

The API backstop **debounces**: a freshly relaunched console takes a few seconds to register as Active, so one negative reading is a race, not a death. Requiring two consecutive readings — and resetting the counters on `attachPage()` — prevents the backstop from recovering its own recovery. This was observed live: it fired 1s after a successful recovery and forced a needless second relaunch.

**Detecting a dead console (shadow DOM gotcha).** The console renders entirely inside **open** shadow roots (`<ucs-session-mgr>`, `<ucs-router>`, `<kvm-ui>`): `document.body.innerText` is literally *empty*, and `outerHTML` does not serialize shadow content either. Liveness detection must walk the shadow roots and read **`textContent`** (which works on a `ShadowRoot`; `innerText` does not). A subtle earlier version walked the roots correctly but only collected text when the node was an `Element` — a `ShadowRoot` never is — so it always saw nothing and the check silently never fired, which is why born-dead sessions had to be spotted by eye. The probe tests each root with early exit rather than concatenating: the full text is ~477KB, almost all inlined CSS.

**Surviving a session timeout (the overnight case).** An unattended run *will* hit the Intersight session timeout, and when it does the console dies. This is the dangerous case: a dead console shows a perfectly static "KVM session has ended" screen, so pure change detection would report a calm, idle machine forever — exactly the blindness recording is meant to prevent. So the recorder actively verifies liveness (every ~10 ticks) and, on detecting a closed tab or a dead console, heals itself:

1. re-establish the Intersight session (automatic Cisco ID login if configured — see [UNATTENDED_LOGIN.md](UNATTENDED_LOGIN.md)),
2. relaunch the tunneled vKVM session (`forceNew`, since the old one is dead),
3. re-attach to the new page and carry on — **keeping all prior frames**, so the timeline spans the outage instead of restarting.

**The two green "No Signal" screens — same colour, opposite remedies.** Both were observed live, and confusing them means applying the wrong fix:

| Screen | Meaning | Correct action |
|---|---|---|
| *"Reason: **User Inactivity**. Press a key to wake up the system."* | The **host video** is asleep. The session and tunnel are fine. | **Send a key.** Relaunching achieves nothing. A mouse move is *not* enough — verified: moving the mouse left the message on screen. |
| *"Reason: **Connection to server dropped**. Client is attempting to reconnect."* | The **tunnel** died. | **Relaunch**, but only after ~40s (4 checks) — the client often reconnects itself. |

The recorder classifies the two and responds accordingly: a sleeping console gets a bare `Shift` (types nothing, activates nothing) and is logged as a wake; a dropped tunnel goes down the recovery path. `vkvm_record_status` reports `wakes` separately from `recoveries`.

Prevention still matters more than cure: the console that reached "User Inactivity" was the one with `antiBlankMode: 'none'`, while a console running with the default mouse nudge went ~7 hours without ever sleeping.

Four conditions trigger recovery: the tab closing, a death dialog / API-confirmed dead session, a **persistent "No Signal" state**, and **10 consecutive capture failures** — a page can break without closing and without showing any dialog (renderer crash, hung tab), and without that third trigger recording would stall silently for the rest of the night.

Retries use escalating backoff (30s → 5 min cap) and continue indefinitely, so a long outage recovers on its own; the login circuit breaker separately protects the Cisco account. Recovery deliberately skips the launcher's auto-record so it cannot clobber the recorder driving it.

Everything is visible rather than silent: `vkvm_record_status` reports `state` (`recording` / `recovering` / `failed`), `consoleLive`, `recoveries`, `recoveryFailures`, `nextRecoveryAttemptAt` and `secondsSinceLastFrame`; `vkvm_timeline` interleaves `console-dead` / `recovering` / `recovered` events with the frames so a gap is explicit; and `vkvm_recent` prefixes its filmstrip with a loud **CONSOLE NOT LIVE** warning when the console isn't healthy, so stale frames can't be mistaken for the present. If a relaunch comes back born-dead, the failure detail names `reset_tunneled_vkvm` as the fix — that stays an agent decision, since it PATCHes server settings.

**Keeping an idle console awake (anti-blank).** An idle console blanks into a screensaver, hiding the machine's state exactly when you are relying on the recording. Do not confuse this with the green *"No Signal"* screen above: a **blank/black** console means the *server's display* has gone to sleep and a nudge wakes it (verified — a black console turned out to be a sleeping Windows desktop); a **green "No Signal"** means the *tunnel* dropped, which no amount of input will fix and which triggers recovery instead. The recorder therefore nudges the console after `antiBlankSeconds` of idleness (default 240, under the usual 10-minute blank timeout; `0` disables).

- **The first nudge is immediate**, not gated on the idle timer. A console is very often *already* blanked when you attach to it (verified live: a blanked Windows Server desktop presented as a plain black screen), so waiting out `antiBlankSeconds` would leave the agent staring at black for minutes before discovering there was a desktop there all along. The same applies right after a recovery, since the relaunched console may also be asleep.
- **Then only when genuinely idle.** Idleness is measured by *any* pixel change — including sub-threshold ones like a ticking counter or spinner that aren't worth storing — so a console that is quietly doing something is never disturbed. (Using the storage threshold here was a bug: a log line advancing by one character looked idle.)
- **`antiBlankMode: 'mouse'` (default)** sends a 1px pointer move: it cannot type, cannot click, and bootloaders ignore pointer motion. **`'key'`** additionally taps Shift, which wakes a blanked Linux *text* console more reliably (tty blanking resets on keyboard input) — but pressing Shift during early boot drops some distros into the GRUB menu and can stall an unattended install, so it is opt-in. **`'none'`** disables input entirely.
- **It never collides with the agent.** Deliberate input (`browser_send_keys`, `browser_mouse`, `vkvm_press_until`) runs under a marker; the nudge stands down while any interaction is in flight — including for the whole duration of a `press_until` loop — and for 60s afterwards, since real input has already reset the blank timer. `vkvm_record_status` reports `antiBlank.nudgesSent` and `lastNudgeAt`.

Note: the capture loop deliberately does **not** call `bringToFront()`. Stealing focus every second would make the operator's desktop unusable; Chromium is launched with background throttling disabled so background tabs keep painting.

### The "KVM session has ended" bug and `reset_tunneled_vkvm`

Intersight has a known bug where launching a tunneled vKVM session immediately shows **"KVM session has ended. Please close the window."** The fix is to disable Tunneled vKVM on the server and re-enable it. `reset_tunneled_vkvm` automates this (verified live 2026-07-09 on `CHG-UCSX-2-2-5`):

1. `PATCH /api/v1/compute/ServerSettings/{moid}` with `{"TunneledKvmState": "Disable"}` — note the enum values are the *action verbs* `Disable`/`Enable` (`Disabled` is rejected). Works with plain API-key auth (unlike `kvm.Session` creation).
2. Poll the spawned "Update Tunneled vKVM" workflow (`RunningWorkflow` in the PATCH response) until `COMPLETED` (~15s).
3. `PATCH` with `{"TunneledKvmState": "Enable"}`, poll again.
4. **Wait ~30s** — relaunching immediately after the Enable workflow completes still yields a dead session; the KVM service needs settle time (the tool includes this delay).

`launch_vkvm_session` detects the dead-session text on the client page and returns `sessionEnded: true` with a hint to run `reset_tunneled_vkvm`, so an agent can recover autonomously: launch → sees `sessionEnded` → reset → launch again.

## Requirements & limitations

- **Login**: by default a human completes the Intersight SSO login once in the opened window (the session then persists in the browser profile). For **unattended/overnight runs**, configure Cisco ID credentials + TOTP so the server logs itself in and re-logins on expiry — see [UNATTENDED_LOGIN.md](UNATTENDED_LOGIN.md).
- **Session expiry**: Intersight web sessions have an idle timeout (account-configurable). Without auto-login configured, vKVM launches start failing with 401 and a human must log in again; with it configured, the keepalive + re-login self-heals and `launch_vkvm_session` recovers automatically.
- **Desktop session**: the headed browser needs a desktop (this is a Windows workstation setup; on a headless host you would need a virtual display).
- **License/privilege**: tunneled vKVM requires the Intersight Advantage tier and a role with the *Launch vKVM* privilege.
- **Tab lifetime**: KVM pages live inside the managed browser. Closing the window (or the MCP server exiting) ends the console sessions; the login cookies persist.
- The exact DOM of Cisco's HTML5 KVM client wasn't fully mapped yet (needs a live logged-in run). `launch_vkvm_session` reports what video surface it found (`canvas`/`video` counts); use `browser_screenshot` and `browser_evaluate` to adapt if the client structure differs.

## Security notes

- No credentials are stored by these tools; authentication lives in the browser profile as ordinary session cookies, exactly as in a manual login.
- The `browser_evaluate` and `browser_intersight_api` tools execute with the logged-in user's full privileges — they are enabled in core mode because vKVM itself is interactive-session-gated, but remove them from `enabledTools` in [intersight-mcp-server-config.json](../intersight-mcp-server-config.json) if you want a tighter surface.
- Every vKVM launch is audited by Intersight (`kvm/Sessions` records the user, client IP, and role).
