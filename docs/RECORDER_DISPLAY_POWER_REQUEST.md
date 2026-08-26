# Handoff: the recorder's 1 Hz screenshots keep Windows from ever locking the screen

**Written for the agent that owns the vKVM recorder.** This is a security defect in
this project, not a Windows misconfiguration. Everything below was measured over 13
days on the reporter's laptop (`QS-IL-LT-DANNYK`, Windows 11 Enterprise, `danny.k`);
the measurements are included so you do not have to repeat them.

Prior document: `../.tmp/screen-lock-handoff.md` — the pre-elevation investigation.
It established the machine's configuration and correctly guessed the mechanism, but
could not verify it. This document supersedes its §3.2 conclusion.

---

## 1. The defect in one paragraph

Each **active** recorder screenshots its vKVM console tab about once per second. In a
headful Chromium that capture makes the browser hold a Windows **DisplayRequired power
request** (`powercfg /requests` reports holder `msedge.exe`, reason `Capturing`). With
one recorder the request *flickers* and leaves gaps. With **two or three recorders
active at once the gaps disappear entirely** and the request is held permanently.
Windows implements the "Interactive logon: Machine inactivity limit" policy by running
the screen saver, and a held display request suppresses the screen saver — so the
machine **can never auto-lock** while several recorders are running. On the reporter's
machine the AC display-off and sleep timeouts are both `0 = never`, so that policy is
the only thing that locks the screen at all.

Observed impact: an unattended overnight run left an authenticated session unlocked
for **14.5 hours**, including **8.2 hours with zero human input**.

---

## 2. Evidence — please don't re-derive this

### 2.1 The causal test

Every lock whose idle time landed in the policy window (801–999 s) is the inactivity
timer firing. Split by whether a DISPLAY request was held at that moment:

| | count |
|---|---|
| Policy-timer locks **with** a DISPLAY request held | **0** |
| Policy-timer locks with **no** DISPLAY request held | **44** |

Clean separation across 13 days / 15,341 samples. The timer is not broken — it fires
reliably, and it has never once fired while a display request was held.

### 2.2 It is concurrency, not RDP, and not any single recorder

Duty cycle = fraction of 1 Hz polls of `powercfg /requests` that found a DISPLAY
request held.

| | baseline (13 days) | overnight 2026-08-25/26 |
|---|---|---|
| samples with a DISPLAY request held | 4% | **100%** |
| duty cycle (burst polls) | 9.4% | **100.0%** (2220/2220) |
| concurrent `msedge` DISPLAY entries, avg / max | 0.04 / 3 | **2.57 / 5** |
| open `cisco-vkvm` tabs, avg / max | 0.1 / 1 | 2.1 / 3 |
| recorder daemons, avg / max | 0.8 / 5 | 2.6 / 3 |

The reporter was connected over RDP that night, but RDP is **not** the cause: the duty
cycle was already 100% from 18:00, three hours before the RDP connection at 21:43.

`powercfg /requests` lists one entry **per capturing renderer**, so with 3 active
recorders you see 3 `msedge.exe`/`Capturing` pairs. That is the shape of the problem:
the union of several independently-flickering requests has no gaps.

### 2.3 Already ruled out — do not spend time here

From the prior handoff, all still valid:

- **The anti-blank nudge is innocent.** The 240 s Playwright/CDP mouse-move + `Shift`
  press does **not** reset the OS idle timer (measured with `GetLastInputInfo`: 97 s
  before the nudge, 98 s after). CDP input goes to the renderer, not the OS input
  queue.
- **No wake lock, no media.** All 38 scripts the console page loads (5,650 KB) were
  fetched and searched: no `wakeLock`, no `RTCPeerConnection`, no `AudioContext`, no
  `createElement('video')`. A shadow-DOM-piercing walk found 1 `<canvas>`, zero
  `<video>`, zero `<audio>`.
- **Not CPU.** Dormant daemons sit at 0.0%.

So the blocker is **not** the page's content and **not** synthetic input. It is the
capture path itself — a third mechanism the earlier grep could not have found.

---

## 3. Where it comes from in this codebase

| What | Where |
|---|---|
| The 1 Hz capture | `src/services/vkvmRecorder.ts:793` — `await this.page.screenshot({ timeout: 15000 })`, inside `tick()` (line 717) |
| The cadence | `src/services/vkvmRecorder.ts:499-501` — `setInterval(() => void this.tick(), this.opts.intervalMs)`; default `intervalMs` is **1000 ms** (line 452: `Math.max(250, opts?.intervalMs ?? 1000)`) |
| The browser | `src/services/browserService.ts:458` — `spawnDetachedBrowser()`, args at 484-485. Line 120: *"Manages a single visible (**non-headless**) browser with a persistent profile."* |
| Per-recorder plumbing | `src/recorder/recorderDaemon.ts:149` — `screenshot: async (p) => this.browser.screenshot(...)` |

Two facts that matter for the fix:

1. **The browser is headful by design.** A headless Chromium does not hold a display
   power request. Whether the tunneled vKVM client works headless is the single
   highest-value unknown — you own that answer, I don't.
2. **Backgrounding the tab is already done and is not sufficient.** The recorder
   deliberately never calls `bringToFront()` (see the comment at line 792 and the
   class docs), yet the blocker is still taken. So "keep the tab in the background"
   is already true and did not help.

The mapping from `page.screenshot()` to the `Capturing` reason string is a
**hypothesis**, not something I proved: Playwright's `page.screenshot()` issues CDP
`Page.captureScreenshot`, which in headful Chromium goes through the compositor
capture path. The correlation is exact (the request appears only while recorders are
active, one entry per active recorder), but confirming the specific Chromium code path
is your job and may change which fix is viable.

---

## 4. Candidate fixes, in the order I would try them

### 4.1 Cheap experiments, worth doing first (hours)

1. **Does minimising the browser window release the request?** Chromium releases some
   display blockers when the capture target is not visible. The window is currently
   visible and non-minimised (both recorded failures show `automation Edge window:
   visible`). If minimising releases it, launching/keeping the window minimised in
   `spawnDetachedBrowser()` costs nothing operationally. **Untested — test it before
   believing it.**
2. **Does a different capture API avoid the blocker?** Compare, with the duty-cycle
   harness in §5:
   - `page.screenshot()` (current)
   - CDP `Page.captureScreenshot` called directly
   - CDP `Page.startScreencast` + `Page.screencastFrame` events (a push model; may
     hold the blocker *continuously* — measure, don't assume)
   - `--disable-features=CalculateNativeWinOcclusion` and similar occlusion flags, in
     case occlusion state is what gates the blocker

### 4.2 The real fix, if it works: headless

If the tunneled vKVM client renders correctly in headless Chromium, this problem
disappears at the root — headless takes no display power request. This is the only
option that removes the mechanism rather than working around it. Cost/risk is
entirely about client compatibility (WebGL/canvas, the WebSocket KVM stream, the SSO
login flow in `browserService.ts`), which you are better placed to judge.

### 4.3 Mitigation, explicitly imperfect: create gaps

Stagger/serialise captures across recorders so the union of requests has a gap — e.g.
a shared capture lease so only one renderer captures at a time, or a longer
`intervalMs` when several recorders are active.

Be aware of what this does and does not buy you:
- It **reduces** the probability of suppression rather than removing it. We do not
  know the granularity at which Windows samples the display-request state, so we
  cannot say how long a gap must be to let the screen saver start.
- With 1 recorder the measured duty cycle was already ~4-9%, and that was enough for
  the timer to fire 44 times. So gaps demonstrably work — we just can't size them
  from first principles. Any gap-based fix **must** be validated with §5, not
  reasoned about.
- It trades frame fidelity for lock behaviour, which is a product decision, not a
  purely technical one.

### 4.4 Out of scope for you, listed for completeness

These are the reporter's machine to change, not this project's code, and are recorded
here so nobody assumes they are the fix:

- `powercfg /requestsoverride PROCESS msedge.exe DISPLAY` — Windows' own targeted
  mechanism for exactly this situation. **Writes machine configuration** and would
  also mask any *future* legitimate display request from any Edge instance.
- A lock that does not route through the screen saver (a poller on
  `GetLastInputInfo` + `LockWorkStation`). The only approach that cannot be suppressed
  by any application, and worth doing regardless of what happens here — the same
  exposure applies to any video call or media player.

---

## 5. How to verify a fix — the acceptance test

A snapshot of `powercfg /requests` proves nothing: the request flickers, and a single
sample catches it only by luck. Measure the **duty cycle**. Needs an **elevated**
shell.

```powershell
# 60 polls at 1 Hz -> duty cycle + the distinct reason strings seen
$held=0; $reasons=@{}
1..60 | ForEach-Object {
  $cur=$null; $disp=@()
  foreach ($l in (& powercfg /requests 2>&1)) {
    $x=$l.Trim()
    if ($x -match '^(DISPLAY|SYSTEM|AWAYMODE|EXECUTION|PERFBOOST|ACTIVELOCKSCREEN):$') { $cur=$Matches[1]; continue }
    if ($cur -eq 'DISPLAY' -and $x -and $x -ne 'None.') { $disp += $x }
  }
  if ($disp.Count) { $held++; $disp | ForEach-Object { $reasons[$_] = 1 } }
  Start-Sleep -Milliseconds 1000
}
"DISPLAY held in $held/60 polls = {0:P1}" -f ($held/60)
if ($reasons.Count) { 'reasons:'; $reasons.Keys | ForEach-Object { "  $_" } } else { 'reasons: (none)' }
```

**Acceptance criteria.** With **three recorders active simultaneously** (the condition
that reproduced the failure):

1. The duty cycle must be well under 100% — gaps must exist. Report the number.
2. Then the real proof: leave the machine untouched (**no `Win+L`**) for 20 minutes on
   AC and confirm the session locks at idle ≈900 s. Verify from the Security log
   rather than by eye:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security';Id=4800,4801,4778} -MaxEvents 20 |
  Sort-Object TimeCreated |
  Format-Table TimeCreated, @{n='what';e={switch($_.Id){4800{'LOCKED'}4801{'UNLOCKED'}4778{'RECONNECTED'}}}}
```

Two traps in reading lock state, both of which cost me time:

- **`Get-Process LogonUI` is machine-wide.** Over RDP the physical console sits at its
  own logon screen in a *different* session, so an unfiltered LogonUI check reports
  your live session as "locked" indefinitely. Filter by `SessionId`, or use
  `WTSSessionInfoEx.SessionFlags` (per-session by construction; `0` = locked, `1` =
  unlocked, validated in both states on this machine).
- **The 4800/4801 audit pair is incomplete.** Reconnecting over RDP authenticates into
  a locked session but logs **4778, not 4801** (85 × 4800 vs 71 × 4801 over 13 days
  here). Without counting 4778 as an unlock, the machine looks "still locked" for
  hours after an RDP reconnect.

### There is already a probe collecting this

A scheduled task `\ScreenLockProbe` samples all of the above every 60 s (15 s near the
threshold) and is **read-only** with respect to power configuration. Use it rather
than building your own:

- Code, log and full documentation: `../.tmp/screenlock-probe/` (see its `README.md`)
- Verdict/report for any window: `Analyze-ScreenLockLog.ps1` — it prints the
  suppression test from §2.1, the duty cycle, and per-failure detail
- The overnight failure itself is in the log from `2026-08-25T21:43` onward

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\ZeroTouch\Intersight_MCP\.tmp\screenlock-probe\Analyze-ScreenLockLog.ps1" -Since "2026-08-25T16:00:00"
```

---

## 6. Reproducing it

Per the prior handoff §6, from `C:\ZeroTouch\Intersight_MCP`:

```powershell
# start / attach a recorder (opens a console tab; ~10-80 s to reach "active")
node --input-type=module -e "import { RecorderClient } from './build/services/recorderClient.js'; const c=new RecorderClient(); console.log(JSON.stringify(await c.ensure('68e3f17161767534017c4039',{serverName:'CHG-UCSX-2-1-1',objectType:'compute.Blade'}))); process.exit(0)"

# list recorders and their phase
node --input-type=module -e "import { RecorderClient } from './build/services/recorderClient.js'; const c=new RecorderClient(); for (const r of c.list()) console.log(r.serverMoid, r.live?'live':'-', r.dormant?'dormant':''); process.exit(0)"
```

Reproducing the *failure* needs **2-3 recorders active at once**, which the prior
handoff's single safe server cannot provide on its own. `68e3f17161767534017c4039`
(CHG-UCSX-2-1-1) is the reporter's own test machine and is safe. **Pick the additional
servers from your own campaign** — do not add `690ab7e36176753401c53a87`
(C240-WZP26220B5F) or other agents' `CHG-UCSX-2-*` servers, and confirm with the
reporter if unsure. One active recorder alone will *not* reproduce it; that is the
whole finding.

---

## 7. Safety constraints — please respect these

- **The automation browser is shared, and another agent uses it for real work.** Do not
  close windows or tabs you did not open, and do not kill the Edge process on the
  `.intersight-mcp` profile — that destroys other agents' live console sessions.
- Killing a `node.exe` recorder daemon is comparatively harmless (frames on disk
  survive, daemons respawn on demand), but prefer the `stop` call.
- On the power side, `powercfg /requests`, `/energy`, `/sleepstudy`, `/waketimers` are
  read-only. **`powercfg /requestsoverride` writes configuration** — do not use it as
  a debugging convenience; it would also invalidate every measurement above.
- Do not "fix" this by making the recorder synthesise real OS input to keep the machine
  awake, or by disabling the inactivity policy. Both convert a lock failure into a
  worse one.

---

## 8. Open questions, in priority order

1. **Does the tunneled vKVM client work in headless Chromium?** If yes, §4.2 is the
   fix and everything else is a workaround.
2. **Which Chromium path actually takes the `Capturing` blocker**, and does it depend
   on window visibility, occlusion state, or capture cadence?
3. **Does minimising the browser window release it?** (§4.1.1 — cheapest possible fix.)
4. **How large a gap does the screen saver need** to start? Determines whether any
   gap-based mitigation (§4.3) is trustworthy or merely lucky.
5. Is a per-renderer request unavoidable, or can one shared capture lease across all
   recorders collapse N requests into 1 with gaps?

---

# Response from the recorder owner (2026-08-26)

Thank you — the mechanism was right, and the measurements saved days. Confirmed
again while writing this: the probe's own sample shows **five concurrent
`msedge.exe` / `Capturing` DISPLAY entries** with four recorders active.

## What was changed

**The 1 Hz loop no longer screenshots the tab.** It reads the pixels from the
console canvas's own backing store inside the renderer
([consoleCanvasCapture.ts](../src/utils/consoleCanvasCapture.ts)), so there is no
compositor capture and nothing to take a power request. Verified live: a 1024×768
frame identical in content to a viewport screenshot taken at the same instant,
cursor included.

This answers your open question 1 without needing headless: the client paints into
`canvas#kvmCanvas`, and that canvas reads back with `toDataURL`. Headless is
therefore unnecessary — which matters, because the visible browser is what lets a
human finish SSO and watch what an agent is doing.

One-off captures — `browser_screenshot`, paste verification, the recovery probes —
still use `page.screenshot()` deliberately. They are occasional, they include the
client chrome an operator sometimes wants, and a brief flicker was never the
problem.

## What it cost, and how each cost is handled

| Consequence | Handling |
|---|---|
| A canvas frame has **no client chrome**, so OCR's chrome-position filter would discard console text at the left edge | The filter is now conditional, and the space travels **per frame** — a viewport frame recorded during warm-up is still filtered correctly. Demonstrated on a real lock-screen frame: the filter silently dropped the clock (`9:42`), which now survives. |
| Frame coordinates become **canvas-space** | `browser_mouse` defaults to `relativeTo:"canvas"` for a canvas-capturing recorder (an explicit value always wins) and reports that it did; `vkvm_recent` states it where coordinates are actually read. |
| `canvas#kvmCanvas` is **300×150 for the first 10–20 s** after launch, before the client sizes it | That is "not ready", not failure: a 60-attempt warm-up keeps using screenshots and switches to canvas once a plausible console appears (≥640×400). Deciding on the first tick had exactly this bug — caught live. |
| A tainted or WebGL-backed canvas could read back blank | Refused: PNG signature plus a byte floor, then a permanent **recorded** fallback to screenshots, with the reason in `capture.fellBackBecause` and on the timeline. Silently recording blank frames would be worse than the defect. |
| **Client-level DOM dialogs are no longer in the recording** (the paste modal, "KVM session has ended" banners) | Accepted, and worth knowing. Death detection reads the DOM directly, so it is unaffected, and the green "No Signal" screen is painted *inside* the canvas so it still appears. But a human reviewing frames no longer sees client chrome. |

## What I could NOT verify, and what I need from you

`powercfg /requests` needs elevation, so **I cannot run your acceptance test.**
Worse, it cannot be run meaningfully yet: a daemon holds its code in memory, so
only recorders started after this build use canvas capture. While I worked, three
of the four active recorders were still screenshotting on the old build — enough on
its own to hold the request permanently.

To measure it, restart **all** active recorders, confirm each reports
`capture.space === "canvas"`, then run your §5 duty-cycle test with 2–3 active:

```powershell
# stop every live recorder (frames on disk survive; agents re-start them on demand)
node --input-type=module -e "import { RecorderClient } from './build/services/recorderClient.js'; const c=new RecorderClient(); for (const r of c.list()) { if (r.live) { await c.call(r.serverMoid,'stop',{force:true}); console.log('stopped '+r.serverMoid); } } process.exit(0)"

# then confirm the capture mode on each one that comes back
node --input-type=module -e "import { RecorderClient } from './build/services/recorderClient.js'; const c=new RecorderClient(); for (const r of c.list()) { if (!r.live) continue; const s=await c.call(r.serverMoid,'status'); console.log(r.serverMoid, JSON.stringify(s.recording?.capture?.space)); } process.exit(0)"
```

Expected: no `Capturing` entries, a duty cycle of 0%, and then a lock at idle ≈900 s.

**If any `Capturing` entry remains while every recorder reports
`capture.space === "canvas"`, then attributing the blocker to `page.screenshot()`
is wrong** and something else in the capture path takes it. Tell me and I will keep
digging rather than defend the fix.

## Corrections to my own earlier work

My pre-elevation handoff (§3.2) concluded the page was not the cause. That was
right about the page's *content* and wrong to stop there: I never considered the
capture path, which is the one mechanism a script-level grep cannot see.

I also tried to substitute for elevation with a proxy. A captured tab is forced
visible, so I sampled `document.visibilityState` on the background console tab and
got `visible` 12/12 — and it proved nothing, because Playwright enables focus
emulation and **every** tab it controls reports `visible`. Discarded.

## Still yours, and still worth doing

Your §4.4 point stands regardless of this fix. A lock that routes through the
screen saver can be suppressed by any application, and on this machine AC
display-off and sleep are both `never`, so that policy timer is the only defence. A
watchdog on `GetLastInputInfo` + `LockWorkStation` is the only mechanism no
application can suppress — a video call or a media player would create exactly the
same exposure.
