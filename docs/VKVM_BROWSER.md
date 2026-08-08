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

## Recorders are their own processes

An MCP server is a short-lived thing. It restarts on every code reload, and every chat or fork gets its own. A console session is the opposite: a provisioning run watched overnight must survive all of that. While the MCP server *owned* the recorders, those two lifetimes were fused, and the consequences were observed live:

- An agent in another window **lost its live console twice** because this MCP server restarted and took the browser with it.
- After an MCP restart the next launch failed with the session slot still occupied by the previous run's session, and nothing could free it — the recorder that owned it was gone.
- Nobody could tell *whose* session an existing one was, so the safe action was always "leave it", and orphans accumulated (four dead vKVM tabs piled up on one server).

So the recorder became the durable thing and the MCP server became a thin client:

```
┌─ MCP server (transient) ─┐        ┌─ MCP server (another window) ─┐
│      RecorderClient      │        │        RecorderClient         │
└────────────┬─────────────┘        └───────────────┬───────────────┘
             │  discover by lock file, act over HTTP/127.0.0.1
             └──────────────┬───────────────────────┘
                            ▼
        ┌─ recorder daemon (one per server, detached) ─┐
        │  RecorderDaemon: login · session repair ·    │
        │  capture · OCR · dormancy · input arbitration│
        └───────────────────┬─────────────────────────┘
                            ▼
        detached Chromium (shared, owned by nobody)
```

- **One daemon per server**, enforced by `recorder.lock` beside that server's frames ([src/recorder/recorderLock.ts](../src/recorder/recorderLock.ts)). It holds the pid and the control port. A lock whose pid is dead is taken over; a lock whose pid is alive turns a second daemon away. A lock is also self-correcting: if nothing answers on its port, the client clears it, because the OS reuses pids and an eternally "live" lock pointing at a dead port would make that server unrecordable forever.
- **Discovery is by filesystem, not memory** — the same trick Chromium uses with `DevToolsActivePort`. A brand-new MCP process that shares nothing with the old one still finds the running recorder ([src/services/recorderClient.ts](../src/services/recorderClient.ts)).
- **Nobody owns a recorder.** Any MCP server may attach, so two agents can watch and drive the same console.
- **Spawning is detached** (`detached: true`, stdio to `daemon.log`), so the daemon outlives the process that started it. Verified live: the spawner exits, the daemon keeps recording.
- **The evidence is on disk, not in a process.** Frames, `state.json` and `text.jsonl` live beside each other, so a background watcher can poll a recorder's state with no protocol and no dependency on this server. The `vkvm_*` read tools go through the daemon (it holds the frame index and the OCR transcript) and never spawn one — see below.

### Each daemon is the single authority for its server

This is what finally made session repair safe. When two parties could act on one server, ending a "stale" session made someone else's recorder relaunch and escalate to a ~90-second Tunneled vKVM reset. With one authority per server there is nobody left to fight, so the daemon can clean up on startup ([src/recorder/sessionOwnership.ts](../src/recorder/sessionOwnership.ts)):

| What it sees | Verdict |
|---|---|
| Session belongs to a different Intersight user | **never touch it** |
| A live recorder holds it | **share** — attach rather than launch a duplicate |
| Our login, and a console tab is still open | **reuse** the tab |
| Our login, no tab, no recorder, older than 15s | **orphan** → end it (`PATCH {"Status":"Ended"}`) |
| We are not the authority for this server | leave it alone |

`DELETE` on a `kvm.Session` returns `403 Operation not supported`; `PATCH {"Status":"Ended"}` is the working remedy (both verified live). That is why this was so hard to find — and why `reset_tunneled_vkvm` looked like the only option while never being able to help.

Verified live end-to-end: with an `Active` session deliberately left holding a server's only slot and no tab anywhere, a freshly spawned daemon logged

```
ended orphaned session 6a770f2d…: created by our current browser login, no client tab
and no live recorder — it is holding the server's only session slot for nobody
```

and then opened its own console.

### A daemon never claims a console it does not have

`launchVkvm` reports its failures in the **result**, not by throwing: a `Forbidden` page, a session that ends the instant it opens, and a reused tab all come back "successfully". Two of those leave no recorder behind at all (autorecord is skipped for a dead console, and a reused tab keeps only the recorder it already had). So the daemon asserts the outcome instead of assuming it, and reports phase `degraded` with the reason when it has no eyes:

- Forbidden → `degraded`; retrying cannot help, so it eventually gives up.
- Born-dead session → `degraded`, and after the second consecutive one it resets Tunneled vKVM itself (capped at two — if two did not help, the tunnel is not the problem).
- Console opened but nothing is recording it → `degraded`; a console nobody captures is not a working recorder.
- A failed `relaunch` → `degraded`, never a stale `active`: relaunch tears the console down first, so that is the moment a lie is most costly.

While degraded, console **input** is refused with the real reason rather than an opaque "no page", and recorded history still reads normally. `vkvm_record_start` says `recording: false` plus a `consoleProblem` explaining what to fix, instead of promising frames that are not coming.

### A read never starts anything, and a start never deletes anything

Two rules that together closed a data-loss path created by the daemon split. Before them, `vkvm_find_text` on last night's campaign — a question purely about the past — spawned a daemon, which logged in, opened a vKVM session, took the server's only session slot, and started a recorder whose **first act was to delete the frames being searched**.

- **Reads never spawn.** `vkvm_recent`, `vkvm_timeline`, `vkvm_find_text`, `vkvm_frames_at` and `vkvm_export` go to a live daemon or refuse, saying how many frames are on disk and where. Starting a console on a physical server is not something a read gets to decide.
- **A starting recorder ADOPTS the frames it finds.** Their capture times come from file mtimes and they are labelled `reason: 'adopted'` — change ratios are never invented, because a fabricated `0` would be indistinguishable from a measured one. The sequence continues past the highest existing frame, so nothing is overwritten, and retention prunes them by age exactly as it does live ones (which is what "keep disk use bounded" actually needed — deleting on start was a blunt substitute).

Verified live: a daemon stopped with 12 frames on disk, restarted, reported `framesStored: 12` with all 12 files intact and 12 `adopted` rows on its timeline.

### Lifetimes: the process and the data are separate clocks

Keeping a recorder alive is not free — it holds the server's only session slot and pokes the console with an anti-blank nudge every few minutes. Measured on one idle recorder: **zero novelty for 6.6 hours, 100 MB of frames, 110 nudges** sent to a machine nobody was watching. Frames on disk, by contrast, cost nothing but disk ([src/recorder/lifetimePolicy.ts](../src/recorder/lifetimePolicy.ts)):

| Clock | Default | What happens |
|---|---|---|
| No client contact | 6 h | **dormant**: release the console and session, keep every frame; resumes on demand |
| Powered-off server, quiet | 30 min | dormant early — there is no console to watch |
| Newest frame older than | 3 days | data expires and the daemon exits (long enough that an overnight run is reviewable next working day) |
| Cannot open a console | 30 min | give up and exit, unless a client is still asking |
| Disk over budget | 2 GB | dormant data is dropped; an **active** recorder's frames never are |

Giving up on a console matters more than it sounds: every retry attempts a Cisco ID login, and that path locks the account after three failures. Retries back off (1 min doubling to 15 min), and a client asking for the console retries immediately — an agent watching `vkvm_record_status` while a human clears an MFA prompt is exactly who the daemon is for. `vkvm_keep_alive` pins a recorder awake for a known-long campaign.

### Two agents, one console: input is leased, not queued

Reads are always allowed. Console **input** requires a 30-second lease, and a second client is refused with `409` naming the holder and a retry ETA ([src/recorder/inputLease.ts](../src/recorder/inputLease.ts)):

```
another client (mcp-31984-a1c) holds the input lease for this console — retry in about 17s
```

Refusal is deliberate, not queueing: a keystroke delivered 90 seconds late lands on a screen that has changed. The daemon also marks itself **busy** during login, session repair and Tunneled vKVM resets, so input during those windows is refused with what it is doing and how long it should take.

**Stopping is not input, and must never be gated by the lease.** It was, briefly, and the result was the failure this architecture exists to prevent, reached from the other direction: one failed keystroke from another client held the lease for 30 seconds, every `stop` in that window came back `409` — *including a forced one* — and the daemon kept its console and its port, killable only by pid.

What *does* guard stopping is peer etiquette, because nobody owning a recorder cuts both ways — nobody gets to destroy one either. `vkvm_record_stop` / `close_vkvm_session` are refused when a **different** client used the recorder in the last 5 minutes:

```
another client (mcp-31984-a1c) used this console 12s ago; stopping it would take their
console away mid-run. Pass force:true to stop it anyway, or just leave it — an unused
recorder releases the console on its own after 6h.
```

`force: true` is always available, so a wedged recorder is never un-killable by whoever notices it.

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

Note the *wait/press* tools' `threshold` (default `0.01`–`0.02`, looking for a decisive screen transition) is their own per-call sensitivity knob. The **recorder** has no threshold at all — its storage decision is content-classification, not magnitude (see *What gets stored* below).

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

**Observed capacity (measured).** Budget per *recorded server*, not per session — and expect an order of magnitude of spread, because cost tracks how much of the screen moves, not time:

| Console | Measured |
|---|---|
| Idle / static text console | ~6 MB total; ~3 MB per hour |
| Mostly-idle 1600×900 desktop | ~20 MB, ~170 frames, flat after ~2h |
| Windows GUI + running installers | **91 MB / 553 frames over a 4h window — ~23 MB per hour** |
| Four concurrent recorders, 10.5h | 101 MB (GUI) vs 9–11 MB each (text blades) |

An earlier "~10 MB per hour per console" rule of thumb was measured on idle text consoles and understates a GUI install by roughly 2.5×. Size retention against the busiest console you are recording, not the quietest.

**Storage is change-triggered, not time-triggered.** Frames are stored only when the screen actually changes, plus a heartbeat every 60s as proof-of-life. An idle console costs almost nothing; a boot sequence keeps every distinct state. Pixel-identical frames are detected by hashing the PNG bytes, which skips image decoding entirely in the common idle case. Defaults: 1s sampling, 240 minutes retention (sized so a long OS install fits — a 3-hour Windows install overflowed the earlier 120-minute default and lost its early history), 3000 frames max, pruned oldest-first.

**What gets stored: novelty, not magnitude — there is no threshold to tune.** There used to be one (0.0005, carefully calibrated), and it was unfixable by calibration: a password dot and a cursor blink both move **~0.0003** of the frame — real content and pure noise at *identical magnitude*. Any value lost one or flooded on the other (storing a blinking cursor once a second collapses the 4-hour ring buffer to ~50 minutes via `maxFrames` and saturates the OCR queue).

Instead the frame is divided into tiles ([`tileNovelty.ts`](../src/services/tileNovelty.ts)) and each tile remembers its own recent states, so a change is *classified*:

| Tile behaviour | Class | Example | Stored? |
|---|---|---|---|
| Returns to a state it just showed | oscillating | cursor blink | no (heartbeat covers it) |
| New content on a regular cadence | rhythmic | taskbar clock, spinner, ticking counter | no (heartbeat covers it) |
| New content, no such pattern | **novel** | password dot, log line, error dialog, scroll | **yes** |

Irregularity protects real activity: steady log output lands as new content at varying intervals and across different tiles, so it stays novel, while a clock's metronome cadence does not. The same classification feeds `novelty.lastNoveltyAt` in status/state.json — "when did the machine last do something" with blinks and clocks already excluded — and the change magnitude is still recorded per frame as metadata (`changeRatio`, used by `vkvm_timeline`'s `minChangeRatio` filter).

**Token cost.** A full-resolution frame is ~1920 vision tokens, so batches are downscaled by default (`scale: 0.7`; `0.5` → ~480 tokens). Box-averaging is used rather than nearest-neighbour so thin console text stays legible. For reading fine detail, request `scale: 1.0` with a small `count`. Use `vkvm_timeline` to navigate before spending image tokens.

**Finding text without spending image tokens (`vkvm_find_text`).** The failure that costs hours is a *parked* one — an installer stopped on an error or a "press any key" prompt, after which nothing changes, so change-detection reports a calm machine. Searching the recorded frames by OCR answers it in text alone: `pattern: "ERROR|FAILED|panic|press any key"` returns the matching frames with timestamps and paths, and you only spend image tokens on the moment that matters (via `vkvm_frames_at`).

Practicalities: recognition costs ~0.7-1.5s per frame, so the scan is bounded (`maxFrames`, default 25) and runs newest-first, stopping at `maxMatches`. Results are cached per frame, so repeat polling only OCRs genuinely new frames (measured: a repeat search went 2.1s to 0ms). Console text reads reliably down to dense 14px terminal output (see the engine section below), but exact identifiers can still wobble by a character (`FCH23027GA0` vs `FCH23027GAO`), and spacing inside compound tokens is not guaranteed (`Ctrl+Alt+ Delete`) — so match on conspicuous words, not exact serials, and prefer patterns tolerant of internal whitespace. Intersight chrome (hostname, nav labels) is filtered out by position, so patterns match what the server displayed, not the browser page. If the engine cannot load, the tool reports `ocrUnavailable` rather than failing.

**Sleeping through healthy phases (`vkvm_wait` predicates).** Plain `mode: "stable"` wakes on every pause, including the harmless ones. Add `untilText` to keep waiting until the settled screen actually matches what you are waiting for (`"login:|installation complete"`), or `differentFromPath` to wait until it settles on something genuinely *different* from a reference frame you already looked at.

**Missed-change signalling.** When a console is being recorded, `browser_screenshot` reports `missedChanges` — how many recorded changes are *not* visible in that single frame — so a point sample can't be mistaken for the whole story.

**Two independent liveness signals.** The client announces death with several different wordings — `KVM session has ended` (born dead) and `Session Terminated / terminated by an Administrator` (admin kill) are terminal, blocking dialogs and are matched. Transient **toasts** like `KVM session has been disconnected due to: Network connection has been dropped` are deliberately *not* matched: they describe a past event and linger on a freshly relaunched console, so treating them as death made every recovery look like a new death and produced a relaunch loop (observed live: 4 recoveries from one termination). The component also ships an unseen session-**expired** dialog (its `ucsSessionMgr.expired.*` i18n keys sit in the DOM even on a healthy console, so patterns must require spaced human-readable phrasing or they false-positive). Because enumerating wordings is guesswork, a second, authoritative signal asks Intersight directly whether an `Active` kvm.Session still exists for the server (`isSessionDeadViaApi`, every ~60s). The text probe is fast (~10s); the API check is wording-independent and catches death modes we have never seen.

The API backstop **debounces**: a freshly relaunched console takes a few seconds to register as Active, so one negative reading is a race, not a death. Requiring two consecutive readings — and resetting the counters on `attachPage()` — prevents the backstop from recovering its own recovery. This was observed live: it fired 1s after a successful recovery and forced a needless second relaunch.

**Detecting a dead console (shadow DOM gotcha).** The console renders entirely inside **open** shadow roots (`<ucs-session-mgr>`, `<ucs-router>`, `<kvm-ui>`): `document.body.innerText` is literally *empty*, and `outerHTML` does not serialize shadow content either. Liveness detection must walk the shadow roots and read **`textContent`** (which works on a `ShadowRoot`; `innerText` does not). A subtle earlier version walked the roots correctly but only collected text when the node was an `Element` — a `ShadowRoot` never is — so it always saw nothing and the check silently never fired, which is why born-dead sessions had to be spotted by eye. The probe tests each root with early exit rather than concatenating: the full text is ~477KB, almost all inlined CSS.

**Surviving a session timeout (the overnight case).** An unattended run *will* hit the Intersight session timeout, and when it does the console dies. This is the dangerous case: a dead console shows a perfectly static "KVM session has ended" screen, so pure change detection would report a calm, idle machine forever — exactly the blindness recording is meant to prevent. So the recorder actively verifies liveness (every ~10 ticks) and, on detecting a closed tab or a dead console, heals itself:

1. re-establish the Intersight session (automatic Cisco ID login if configured — see [UNATTENDED_LOGIN.md](UNATTENDED_LOGIN.md)),
2. relaunch the tunneled vKVM session (`forceNew`, since the old one is dead),
3. re-attach to the new page and carry on — **keeping all prior frames**, so the timeline spans the outage instead of restarting.

**The green "No Signal" screens — same colour, different remedies.** All three were observed live, and confusing them means applying the wrong fix:

| Screen | Meaning | Correct action |
|---|---|---|
| *"Reason: **User Inactivity**. Press a key to wake up the system."* | The **host video** is asleep. The session and tunnel are fine. | **Send a key.** Relaunching achieves nothing. A mouse move is *not* enough — verified: moving the mouse left the message on screen. |
| *"Reason: **Connection to server dropped**. Client is attempting to reconnect."* | The **tunnel** died. | **Relaunch**, but only after ~40s (4 checks) — the client often reconnects itself. |
| *"Reason: **Host power is off**"* | The **server** is off. Console, tunnel and session are all fine. | **Nothing console-side.** Power the server on. |

The third one is why classification lives in [`consoleSignals.ts`](../src/services/consoleSignals.ts) as a pure, tested function rather than as regexes buried in `page.evaluate`. It matched neither known pattern, so a recorder sat on a full-screen green placeholder for hours reporting a perfectly healthy console — the caller had no way to distinguish "powered off" from "idle and fine". `browser_screenshot` and `browser_send_keys` now return a `noSignal: {kind, reason, remedy}` block whenever the console is showing a placeholder, and an unrecognised reason reports `kind: "unknown"` rather than being silently treated as healthy. Matching deliberately requires the human-readable phrasing, because the client ships i18n keys in the DOM of healthy consoles and the lingering *"Virtual Media session has been disconnected … Network connection has been dropped"* toast must not count — it describes a past event on a live console.

The recorder classifies the two and responds accordingly: a sleeping console gets a bare `Shift` (types nothing, activates nothing) and is logged as a wake; a dropped tunnel goes down the recovery path. `vkvm_record_status` reports `wakes` separately from `recoveries`.

> The wake path was dormant for a while: the `wakeConsole` hook was implemented and called, but never actually passed to the recorder, so a console asleep from user inactivity was simply left green with `wakes` stuck at 0. A missing *optional* hook cannot fail to compile and does not throw, so the hook set is now built in one place and asserted by a test.

Prevention still matters more than cure: the console that reached "User Inactivity" was the one with `antiBlankMode: 'none'`, while a console running with the default mouse nudge went ~7 hours without ever sleeping.

Four conditions trigger recovery: the tab closing, a death dialog / API-confirmed dead session, a **persistent "No Signal" state**, and **10 consecutive capture failures** — a page can break without closing and without showing any dialog (renderer crash, hung tab), and without that third trigger recording would stall silently for the rest of the night.

Retries use escalating backoff (30s → 5 min cap) and continue indefinitely, so a long outage recovers on its own; the login circuit breaker separately protects the Cisco account. Recovery deliberately skips the launcher's auto-record so it cannot clobber the recorder driving it.

**When relaunching cannot help: the born-dead console.** A relaunch that *succeeds* and then dies seconds later is a different failure from a relaunch that fails, and it needs a different remedy. Intersight's tunneled-vKVM bug makes every fresh session born dead, and the console **mounts looking healthy** before the death dialog appears — so the launcher's own born-dead check passes and the backoff ladder, which only arms when recovery throws, never engages. Observed live on `CHG-UCSX-2-2-5`: `console-dead → recovering → recovered` every ~9 seconds indefinitely, with `recoveryFailures` stuck at 0. Overnight that spins all night and records nothing, at the cost of a real API call and page load per cycle.

The recorder now counts recoveries whose console died within 60s as **short-lived** and escalates instead of retrying blindly: after two in a row it runs the Tunneled vKVM disable/re-enable itself (the only thing that fixes this), logging a `vkvm-reset` event on the timeline. If the console *still* comes back dead after two such resets, recovery throws — which hands control to the normal backoff ladder rather than looping. A console that survives longer than the window clears both counters, so an ordinary nightly session timeout never triggers an escalation. `vkvm_record_status` exposes `shortLivedRecoveries` and `tunneledVkvmResets`.

Everything is visible rather than silent: `vkvm_record_status` reports `state` (`recording` / `recovering` / `failed`), `consoleLive`, `recoveries`, `recoveryFailures`, `nextRecoveryAttemptAt` and `secondsSinceLastFrame`; `vkvm_timeline` interleaves `console-dead` / `recovering` / `recovered` events with the frames so a gap is explicit; and `vkvm_recent` prefixes its filmstrip with a loud **CONSOLE NOT LIVE** warning when the console isn't healthy, so stale frames can't be mistaken for the present. If a relaunch comes back born-dead, the failure detail names `reset_tunneled_vkvm` as the fix — that stays an agent decision, since it PATCHes server settings.

**Keeping an idle console awake (anti-blank).** An idle console blanks into a screensaver, hiding the machine's state exactly when you are relying on the recording. Do not confuse this with the green *"No Signal"* screen above: a **blank/black** console means the *server's display* has gone to sleep and a nudge wakes it (verified — a black console turned out to be a sleeping Windows desktop); a **green "No Signal"** means the *tunnel* dropped, which no amount of input will fix and which triggers recovery instead. The recorder therefore nudges the console after `antiBlankSeconds` of idleness (default 240, under the usual 10-minute blank timeout; `0` disables).

- **The first nudge is immediate**, not gated on the idle timer. A console is very often *already* blanked when you attach to it (verified live: a blanked Windows Server desktop presented as a plain black screen), so waiting out `antiBlankSeconds` would leave the agent staring at black for minutes before discovering there was a desktop there all along. The same applies right after a recovery, since the relaunched console may also be asleep.
- **Then only when genuinely idle.** Idleness is measured from *novelty* — new content appearing, as classified by the tile tracker — and the nudge additionally requires the screen to be **at rest right now** (three consecutive at-rest samples, where blink-only churn counts as rest).

  This rule has been wrong twice, so it is worth stating why it is what it is. Measuring idleness by the storage threshold was the first bug: a log line advancing by one character looked idle. Measuring it by *any* pixel change — the obvious fix — was the second, and worse: a Windows taskbar clock repaints once a minute forever, so a booted desktop never accrued 240s of stillness and **anti-blank silently never ran on it** (measured: 0 nudges in 11 minutes on a Windows console, while a static UEFI console on the same browser nudged on schedule). A console blanks on *input* idle; it does not care what repaints itself. The tracker settles both directions at once: clocks and spinners are classified out of idleness, and treating a blinking cursor as rest closes a further long-standing hole — an idle login prompt (the console *most* likely to blank) used to reset the still-run with every blink and was never nudged at all.
- **`antiBlankMode: 'mouse'` (default)** sends a 1px pointer move: it cannot type, cannot click, and bootloaders ignore pointer motion. **`'key'`** additionally taps Shift, which wakes a blanked Linux *text* console more reliably (tty blanking resets on keyboard input) — but pressing Shift during early boot drops some distros into the GRUB menu and can stall an unattended install, so it is opt-in. **`'none'`** disables input entirely.
- **It never collides with the agent — per console.** Deliberate input (`browser_send_keys`, `browser_mouse`, `vkvm_press_until`) runs under a marker; the nudge stands down while an interaction is in flight against *that* console — including for the whole duration of a `press_until` loop — and for 60s afterwards, since real input has already reset that console's blank timer. `vkvm_record_status` reports `antiBlank.nudgesSent` and `lastNudgeAt`.

  The scoping is load-bearing. This bookkeeping was originally two scalars on the service, which is correct with one console and wrong with several: input on server A declined the due nudge on server B, and because a declined attempt still resets the idle clock, B's next nudge was pushed out another full window. Demonstrated live — a mouse move on C240 at 21:31:58 caused 2-2-5's 21:32:22 nudge to be declined (`nudgesSent` unchanged, `lastNudgeAt` advanced) — an agent touching one console every few minutes could keep every *other* console's anti-blank permanently deferred. It is now tracked per server (`AgentInputTracker`).

Note: the capture loop deliberately does **not** call `bringToFront()`. Stealing focus every second would make the operator's desktop unusable; Chromium is launched with background throttling disabled so background tabs keep painting.

### Recording several consoles at once

Recorders are independent and run concurrently in one browser. Measured over a two-console run (a Windows desktop and a UEFI shell, 1s sampling each):

| | C240 (Windows) | 2-2-5 (UEFI shell) |
|---|---|---|
| Frames / disk over ~11 min | 14 / 2.5 MB | 21 / 1.5 MB |
| Capture errors | 0 | 0 |
| Heartbeat intervals | 60.4–60.5s | 60.4–60.5s |

Interference is negligible — about 0.45s of drift per minute, i.e. ~7ms of added capture cost per 1s tick — and frames never cross over between recorders. That works *because* of the no-`bringToFront()` rule above: two 1 Hz samplers that each activated their tab would fight over focus every second.

Two things are worth knowing when running more than one:

- **Anti-blank is per console** (see above). Getting this wrong is the main way parallel recording degrades quietly.
- **One live tunneled session per server.** `launch_vkvm_session` reuses an existing live session rather than launching a duplicate, because a second session for the same server is born dead — that is a *per-server* limit, not a global one, so recording many servers at once is fine.

### Keyboard input goes to the canvas, two shadow roots down

Keyboard input did not work at all, silently. The client renders the server's video into `canvas#kvmCanvas` and only forwards keys that arrive **on that canvas**:

```
body > div#kvmApplicationDiv > kvm-ui (shadow) > div#contents
     > kvm-video (shadow) > canvas#kvmCanvas
```

`querySelector` does not cross a shadow boundary. The focus helper searched only `kvm-ui`'s own root, found no canvas there, and fell back to "the first element with a tabindex" — a div in the page header. Every keystroke was dispatched into chrome. Worse, the focus check compared against that same wrong element, so `browser_send_keys` reported `consoleFocused: true` while delivering nothing.

Proven with an A/B on a Windows lock screen, which advances on any keypress:

| Key dispatched on | Reached the server? |
|---|---|
| `canvas#kvmCanvas` | **Yes** — a bare Shift woke the display from blank |
| `div#contents` (what the old code focused) | **No** — lock screen unchanged |

An ancestor handler calls `preventDefault()` on *both* paths, so "something consumed the event" proves nothing; only the canvas path is forwarded over the WebSocket.

Three things this explains:

- **Neither a mouse move nor a real click focuses the canvas** (it has no `tabindex`), so there was no accidental workaround — the fix must set `tabindex` and call `focus()` explicitly.
- **The "User Inactivity" wake never worked**, even after its hook was wired up: it sends a key, and the key went to chrome.
- A field report describing input that "silently stopped being delivered" on a long-lived session was almost certainly this, not session degradation. Its own second hypothesis — *canvas focus never acquired* — was right.

The traversal now lives in [`consoleFocus.ts`](../src/utils/consoleFocus.ts) as a tested function, composed into a page script via `toString()` so the browser and the tests run **one** implementation. The previous version was an inline string that nothing could exercise, which is how a traversal that never reached the canvas survived. `browser_send_keys` now reports `focusedElement` by name and warns when it is not the console canvas, because "focused: true" about the wrong element is precisely what hid this.

**Shift must be a real keypress, not a flag.** Once focus was fixed, a second input bug surfaced (field repro): typing `aA!@#1-_=+` delivered `aa1231--==` — every shifted character arrived as its unshifted base key, so `Cisco123!` reached a login prompt as `cisco1231`. The client forwards input to the BMC as USB-HID scancode + modifier byte, and it derives that byte by **tracking physical Shift keydown/keyup events**; Playwright's `keyboard.type()` dispatches characters with a modifier *flag* on the event and never emits a Shift keydown, so the modifier byte stayed 0. Text is therefore typed as explicit `Shift+<base>` presses ([`keyboardText.ts`](../src/utils/keyboardText.ts), pinned by tests on the exact repro strings), replaying what a human keyboard sends. Combos are normalised the same way — `"Shift+C"` (reported to deliver *nothing*) becomes `Shift+c`. Characters no US keystroke can produce are rejected loudly: a BMC receives scancodes, and silently mangling a password is the worst failure available. A small inter-key gap (25ms) is kept because BMCs drop back-to-back keystrokes.

### Input is verified, not assumed

`browser_send_keys` returning `{"sent": …}` only ever meant *Playwright dispatched the event locally*. On a 7-hour-old session whose input channel had quietly degraded, every keystroke reported success while the screen never moved, and the failure took hours to even localise — video was perfect throughout, so no liveness signal fired.

So the tool now reports what it can actually observe:

- **`consoleFocused`** — whether a focusable element inside the `<kvm-ui>` shadow root was genuinely focused, confirmed by reading `activeElement` back rather than assumed. A console we never managed to focus swallows every keystroke.
- **`echo: {changed, changeRatio, afterMs}`** — the console is watched for up to `verifyMs` (default 1500) after the input; any pixel movement is proof the far end reacted, and the check stops early on the first sign of life.
- **A `warning` when nothing changed**, naming the escalation path cheapest-first: check `consoleFocused` and `noSignal`, retry with `vkvm_press_until`, then relaunch with `forceNew: true` to rebuild the input channel. It also says plainly that some input legitimately draws nothing (a modifier, a key an idle prompt ignores), because a false alarm here is worse than none.

Pass `verifyMs: 0` for deliberately blind input. Note this is a *best-effort* signal: a pixel change proves delivery, but no change is evidence rather than proof. There is still no direct read of the WebSocket input channel's health — see the open questions at the end.

**Coordinates: recorded frames are not page pixels.** `vkvm_recent` and `vkvm_frames_at` downscale by default (`scale: 0.7`) to save image tokens, while `browser_mouse` takes unscaled viewport pixels. Passing the former straight to the latter lands the click 30–50% off, which looks exactly like "input is not being delivered" — a real field misdiagnosis that sent an operator down the wrong path for hours. Either read coordinates off a full-size `browser_screenshot`, or pass `fromScale` with the scale the frame was rendered at and let the tool do the arithmetic.

**Which server did that call hit?** Tools that accept an optional `serverMoid` fall back to the most recently opened tab, which with four sessions open is the wrong server surprisingly often. `browser_screenshot`, `browser_send_keys` and `browser_mouse` now echo a `targeted: {serverMoid, serverName}` block, plus a `targetWarning` when no moid was given and more than one session is open.

### Keeping console evidence longer than the ring buffer

The recording is a rolling window: frames older than `retentionMinutes` (default 240) are **deleted permanently**. A 10.5-hour campaign on the default lost roughly 60% of its console history, and the first sign was frames simply not being there when someone went looking — hours after anything could be done.

Three changes, in order of how much they help:

- **`launch_vkvm_session` takes a `recording` block** (`retentionMinutes`, `antiBlankMode`, …) and passes it to the auto-started recorder. Previously the only way to get a longer window was to know to stop and restart the recorder by hand, which is exactly how the default got adopted by accident. On a *reused* session the options cannot be applied — the recorder belongs to the session being reused — and the response says so explicitly rather than no-opping.
- **`vkvm_record_status` reports `framesEvicted` and `evictionStartedAt`**, with a note once the buffer starts rolling. Silence used to be indistinguishable from "nothing lost yet".
- **`vkvm_export {serverMoid, destDir, from, to, minChangeRatio}`** copies frames out of the buffer into a directory of your choice, named by timestamp so they sort chronologically beside other test evidence. `minChangeRatio: 0.05` archives just the structural moments. Frames evicted mid-export are counted rather than silently missing.

Listing all recorders (`vkvm_record_status` with no `serverMoid`) reports every server that has frames on disk, each labelled **live**, **dormant** (console released, frames kept, resumes on demand) or **historical** (no daemon running). Nothing is ever deleted automatically outside a daemon's own retention and expiry clocks: frames are the evidence, and a directory whose daemon is gone still answers questions.

### The console text transcript — telling wedged apart from slow

Pixel change answers *"did the screen move"*. It cannot answer *"did anything happen"*, and that gap caused failures in both directions on a real campaign:

- A parked Rocky installer showing `Error setting up software source` produced **no further pixel change**, so change-detection reported a calm machine and the wedge was spotted ~18 minutes later, by eye.
- Twice a perfectly healthy install was nearly declared wedged, because a `wget` progress line and an ESXi module loader move too few pixels to register.

So each recorder now reads the text of every stored frame and appends to `text.jsonl` beside the frames, **only when the text actually changed**:

```json
{"seq":412,"at":"2026-08-03T09:12:44.108Z","frame":"f-000412.png",
 "changeRatio":0.0018,
 "text":"3) [!] Installation source (Error setting up software source)"}
```

A change-log rather than one line per frame, so it *is* the transcript of what the machine said.

**Every stored frame, including heartbeats — deliberately not gated on change magnitude.** That gate was the obvious optimisation and it is exactly backwards: a one-line error moves 0.001–0.0026 of the screen and may only ever land on a *heartbeat* frame, while the frames with huge ratios are full-screen repaints carrying the least readable text. Gating on magnitude reads the wrong frames.

What it buys:

- **`timeline` entries carry `textChanged`.** A tiny `changeRatio` *with* `textChanged` is a new line of output; a large one *without* it is a repaint.
- **`status().ocr.secondsSinceTextChange`** — the wedge predicate worth alerting on, far better than pixel idleness.
- **`pending` / `skipped` / `failures`** so "the transcript shows no error" can never be confused with "not every frame was read".

**The engine is PaddleOCR (via `@gutenye/ocr-node`, ONNX), and the choice is the whole story.** The first engine, tesseract.js, is a *document-scan* engine: it binarises the image globally, so a frame whose console area is mostly black swamped the threshold and text a human could plainly read came back as **confidence 0 and not one character** (measured on a real frame). It hallucinated on textless frames (a loading spinner produced a *different* single character per frame — `<`, `a`, `A)` — off antialiased vector edges, making a frozen blank screen look like ever-changing text). Making it usable took a stack of compensations — page-segmentation tuning, a confidence gate, a hand-tuned pixel crop — and the crop then mutilated consoles whose layout differed (`Cisco Systems` read as `ystems` on a narrower viewport). The stack of workarounds was the symptom; the engine was the cause.

PaddleOCR detects text regions with a learned model first, then recognises each line separately — a dark background is just background. Benchmarked on identical frames (dense synthetic kernel log, lock screen and login over photo backgrounds, the green "No Signal", a textless spinner):

| Corpus (10 expected strings) | PaddleOCR | tesseract.js (fully tuned) |
|---|---|---|
| Total hits | **9 (10 with a spacing wobble)** | 6 |
| Dense 14px kernel-log text | **4/4** | 2/4 |
| Text over photo (login screen) | **2/2** | 0/2 — read 14 chars |
| Hallucination on textless frame | none | none (only after gating) |

The two wins are exactly the classes that matter: dense terminal output is what the transcript exists for, and login screens are where unattended runs get stuck.

What replaced the workarounds:

- **Chrome is filtered by detected line position, not by cropping pixels.** Detected lines wholly inside the nav column (~210px) or top bar (~50px) are dropped whole, so the transcript is what the *machine* said — and unlike a pixel crop, a filter cannot cut a console line in half. A green "No Signal" frame reads as exactly `No Signal Reason: Host power is off`.
- **Reading order is reconstructed from line boxes** (banded top-to-bottom, then left-to-right), so kernel logs come back in console order.
- **Per-line confidence** gates out the rare imagined speck; the meaningful-character floor in the recorder stays as engine-independent insurance.
- **No worker process.** The tesseract worker held the event loop open, which cost a misdiagnosis (a finished script looked hung because its stdout never closed) and would have silently broken the background-waiter pattern below, whose notification fires *on process exit*. The current engine keeps nothing alive — a regression test spawns a child that OCRs and asserts it exits by itself — and an accuracy test runs the real engine against a generated console frame, so an engine or model change that regresses console reading fails in the suite rather than overnight.

Cost: ~1.4s per frame with text, ~0.7s without, ~600ms one-time model load, and ~310MB of `node_modules` (onnxruntime + bundled models — runs on Windows, macOS and Linux, container included). **Every recognition is still bounded** (`ocrTimeoutMs`, default 30s): a previous engine was observed to fail to settle, and an unbounded await would park the queue permanently with no error while the recorder looked healthy. `ocrText: false` records pixels only. Bounded like everything else that grows on a timer: the queue caps at 300 frames (trimming the oldest, counted), the transcript compacts to its newest half at 5000 lines, and all recorders share one engine instance. OCR failures are counted and never propagate — it enriches the recording and must not be able to stop it.

### Turning pull into push: the state sidecar

Every tool here is **pull** — you learn what happened when you next ask. On a long unattended run that means checking on your own timer and discovering a parked installer at the next tick rather than when it parked.

MCP cannot push: it is request/response, and the server has no way to wake an agent. But most agent harnesses *can* run a command in the background and notify when it exits, which is enough:

```
agent → background command that polls and EXITS when a condition is met
        …agent does other work, or the turn ends…
        condition met → process exits → harness notifies → agent wakes
```

The missing piece was that the waiter could not see the recorder. Recorder state lived only in the MCP server's memory, so another process could read the frames on disk but not what the recorder made of them. That bit for real: asked for a live campaign's `wakes` counter, the only honest answer was *"another process has it and I cannot reach it"*, and the highest-severity question in a field report went unanswered.

So each recorder now **publishes its status beside its frames**, at `<recordingDir>/<serverMoid>/state.json`, rewritten on every stored frame and every event (`state`, `consoleLive`, `novelty.lastNoveltyAt`, `ocr.lastTextChangeAt`, `newestFrameAt`, `noSignal`, `wakes`, `recoveries`, `framesEvicted`, …). The frames directory was already the shared medium between processes; the status goes there too. Two things fall out:

- **`vkvm_record_status` reports every recorder**, read from those files plus each daemon's lock — so any MCP server sees what all the others are recording, complete with counters, instead of guessing from file mtimes. (Recorders now *always* live in another process, which is what made this indispensable rather than merely useful.)
- **A background waiter is a trivial poller** with no dependency on this server, no second browser, and no duplicated capture.

Three properties that matter if you build on it:

**Never fire a trigger on stale state.** A reader flags `stale` past 180s and forces `consoleLive: false`, because a process that stopped updating cannot vouch for the console. This is the safety net for the failure below — a frozen file must never be read as a quiet console.

**Writes are temp-then-rename, with retries.** Windows refuses to replace a file another handle has open, and `readFileSync` holds exactly such a handle — so a watcher polling at the same cadence the recorder writes collides regularly (measured: ~1 write in 300). The failure was originally swallowed, which **froze the file at an old value**, and a frozen `lastNoveltyAt` is indistinguishable from an idle console — it would have manufactured false stall alerts on healthy installs. Rename now retries with a short backoff, `writeRecorderState` returns success, and the recorder counts `statePublishFailures`.

**Pixel stillness alone is a noisy wedge signal.** A healthy installer writing one line every few seconds looks static too (an ESXi module loader and a `wget` progress display both nearly caused false wedge calls). The better predicate is *idle **and** the text has not changed* — so a waiter woken by stillness should confirm with `vkvm_find_text` before concluding anything.

### The "KVM session has ended" bug and `reset_tunneled_vkvm`

Intersight has a known bug where launching a tunneled vKVM session immediately shows **"KVM session has ended. Please close the window."** The fix is to disable Tunneled vKVM on the server and re-enable it. `reset_tunneled_vkvm` automates this (verified live 2026-07-09 on `CHG-UCSX-2-2-5`):

1. `PATCH /api/v1/compute/ServerSettings/{moid}` with `{"TunneledKvmState": "Disable"}` — note the enum values are the *action verbs* `Disable`/`Enable` (`Disabled` is rejected). Works with plain API-key auth (unlike `kvm.Session` creation).
2. Poll the spawned "Update Tunneled vKVM" workflow (`RunningWorkflow` in the PATCH response) until `COMPLETED` (~15s).
3. `PATCH` with `{"TunneledKvmState": "Enable"}`, poll again.
4. **Wait ~30s** — relaunching immediately after the Enable workflow completes still yields a dead session; the KVM service needs settle time (the tool includes this delay).

`launch_vkvm_session` detects the dead-session text on the client page and returns `sessionEnded: true` with a hint to run `reset_tunneled_vkvm`, so an agent can recover autonomously: launch → sees `sessionEnded` → reset → launch again. A recorder escalates to it by itself after two consecutive born-dead relaunches (see above).

**It fixes only this.** The tool's description says so emphatically, because it is an attractive-looking hammer: it costs 60–90s of server-settings churn and two workflows, and it is the right answer to exactly one symptom — *a session that can be created but is born dead*. It does nothing for a live console whose input has stopped being delivered (relaunch with `forceNew: true`, which rebuilds the input channel), for any of the green "No Signal" screens, for a login or session-expiry failure (`browser_login`), for a wedged guest OS, or for a case where a tunneled session cannot be opened at all — that last one is usually the Advantage licence or the *Launch vKVM* privilege, and no amount of resetting will help.

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
