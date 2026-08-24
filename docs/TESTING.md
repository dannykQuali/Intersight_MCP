# Testing

```bash
npm test              # run the suite
npm run typecheck:tests   # type-check src + test together (npm run build only covers src)
```

The runner is Node's built-in `node --test` driven through `tsx`, so there is **no test framework dependency** — nothing was added to `package.json` beyond two scripts. Tests live in [`test/`](../test), outside `rootDir`, so they never end up in `build/`.

## What is worth testing here

Most of this server is a thin mapping from MCP tool calls onto Intersight REST, which the API itself validates far better than a mock would. The parts that carry real logic — and where the bugs have actually been — are the **vKVM console recorder's self-healing and anti-blank rules** and the **recorder daemon's lifetime and session-ownership decisions**. They are timer-driven, run unattended for hours, span processes, and fail *silently*: a broken recorder does not throw, it just quietly records nothing useful until morning. That is what the current tests cover.

## Approach

**Seams instead of mocks.** Two decisions were pulled out of the timer loop so they can be tested as pure functions against the real production code path:

- `shouldNudge()` in [vkvmRecorder.ts](../src/services/vkvmRecorder.ts) — is this console due for an anti-blank nudge?
- [`AgentInputTracker`](../src/services/agentInputTracker.ts) — is the agent using this console right now? It takes a clock function, so quiet-window tests advance time instead of sleeping.

Everything else runs the real `VkvmRecorder` against a [`FakeConsolePage`](../test/helpers/fakeConsolePage.ts) that implements only the two members the recorder touches (`isClosed`, `screenshot`). Real capture, real hashing, real pixel diffing, real recovery state machine — only the browser is fake.

**Timings scaled, ratios preserved.** Timer-driven behaviour needs real time to pass, so the tests shrink the intervals while keeping the *shape* of the real situation: a 2s anti-blank window against a console repainting every 6 samples has the same character as 240s against a 60s clock, and it plays out in three seconds. Waiting is always `waitFor(predicate, timeout)` — never a bare sleep for a fixed duration — so a fast machine finishes early and a slow one still passes.

**Pure decisions, extracted.** The daemon's judgement calls are pure functions taking facts and returning a verdict with a reason, so they can be tested exhaustively without a browser, a server, or a clock: `decideLifetime` / `shouldGiveUpDegraded` ([lifetimePolicy.ts](../src/recorder/lifetimePolicy.ts)), `classifySession` ([sessionOwnership.ts](../src/recorder/sessionOwnership.ts)), and `waitUntilNotStarting` ([recorderClient.ts](../src/services/recorderClient.ts)). The reason strings are part of the contract — they are what an operator reads when a recorder ends someone's session or gives up on a console.

**The daemon is driven the way an MCP server drives it.** [recorderDaemonConsole.test.ts](../test/recorderDaemonConsole.test.ts) starts a real `RecorderDaemon`, with its real lock file, real control server and real input arbiter, and talks to it over HTTP on `127.0.0.1`. Only `BrowserService` is faked, and only because Intersight is on the other side of it. Two seams exist purely so this is possible: the daemon takes an optional browser, and it calls an `onStopped` callback instead of `process.exit` (a shutdown that exited would take the test runner with it).

**Sub-threshold means sub-threshold.** The "ticking clock" fixture changes exactly one pixel of a 200×200 frame, which lands at 0.0004 against the 0.0005 storage threshold. Getting that wrong would make the fixture a *storable change* and quietly test something else entirely.

## Regressions these lock down

Each test file opens with the live failure it exists to prevent:

| File | Guards against |
|---|---|
| [recorderRecovery.test.ts](../test/recorderRecovery.test.ts) | A born-dead console relaunching every ~9 seconds forever, never escalating to the Tunneled vKVM reset that fixes it |
| [nudgeDecision.test.ts](../test/nudgeDecision.test.ts) / [recorderAntiBlank.test.ts](../test/recorderAntiBlank.test.ts) | Anti-blank silently never running on any console with a clock on it |
| [agentInputTracker.test.ts](../test/agentInputTracker.test.ts) | Input on one console suppressing anti-blank on all the others |
| [recorderHooks.test.ts](../test/recorderHooks.test.ts) | A self-healing hook silently going unwired — `wakeConsole` was implemented and called but never passed in, so sleeping consoles were never woken |
| [blankedConsoleWake.test.ts](../test/blankedConsoleWake.test.ts) | A broken OCR engine disabling console waking, because an unreadable REASON classified a blank screen as `unknown` — `wakes: 0` across 28 hours |
| [antiBlankInputIdle.test.ts](../test/antiBlankInputIdle.test.ts) | A busy screen postponing the anti-blank nudge forever, so a console mid-install blanked on the CIMC's own schedule |
| [frameOcrRecovery.test.ts](../test/frameOcrRecovery.test.ts) | An OCR engine that broke mid-life being reused forever — 570 failures, 0 successes, and the error swallowed so nobody could see why |
| [consoleSignals.test.ts](../test/consoleSignals.test.ts) | An unrecognised green "No Signal" reason being reported as a healthy console — "Host power is off" matched neither known pattern |
| [frameCoords.test.ts](../test/frameCoords.test.ts) | Coordinates read off a downscaled recorded frame being passed as page pixels, landing the click 30–50% off |
| [recorderRetention.test.ts](../test/recorderRetention.test.ts) | The ring buffer deleting console evidence without ever saying so |
| [recorderState.test.ts](../test/recorderState.test.ts) | Recorder status being unreadable from other processes, and the published file silently freezing while a reader polls it |
| [recorderOcrText.test.ts](../test/recorderOcrText.test.ts) | A parked installer reading as a calm machine because only its words changed, not its pixels |
| [frameOcrLifetime.test.ts](../test/frameOcrLifetime.test.ts) | A process that used OCR never exiting — which would break any background waiter, since its notification fires on exit |
| [frameOcrAccuracy.test.ts](../test/frameOcrAccuracy.test.ts) | The real OCR engine regressing on dense console text, inventing text on a blank frame, or leaking browser chrome into the transcript |
| [loginFailureClassification.test.ts](../test/loginFailureClassification.test.ts) | A lockout guard meant to protect an account disarming automatic login over failures that never sent a credential |
| [loginButtonReady.test.ts](../test/loginButtonReady.test.ts) | Clicking "Sign In with Cisco ID" while it is still `disabled` under the page's loading overlay — Playwright cannot see a custom element's disabled attribute, so it burned a 30s click timeout and killed the login |
| [consoleFocus.test.ts](../test/consoleFocus.test.ts) | Keyboard input being dispatched into page chrome because the shadow-DOM traversal never reached the console canvas |
| [keyboardText.test.ts](../test/keyboardText.test.ts) | Shifted characters arriving unshifted at the BMC (`Cisco123!` → `cisco1231`) because no real Shift keydown was ever sent |
| [tileNovelty.test.ts](../test/tileNovelty.test.ts) | The change-magnitude threshold judging a password dot and a cursor blink identically (~0.0003 each) — changes are now classified by region history instead of measured |
| [recorderLock.test.ts](../test/recorderLock.test.ts) | Two daemons recording one server and wiping each other's frames; a dead holder's lock blocking that server forever |
| [sessionOwnership.test.ts](../test/sessionOwnership.test.ts) | Ending a vKVM session that belongs to another user or to a live recorder — and the opposite failure, never daring to end anything, so orphans hold session slots forever |
| [lifetimePolicy.test.ts](../test/lifetimePolicy.test.ts) | An idle recorder holding a console for 6.6 hours and nudging it 110 times; and the inverse — deleting the frames of a run someone is still watching |
| [inputLease.test.ts](../test/inputLease.test.ts) | Two agents typing into one console at once, and input silently swallowed during a 90-second Tunneled vKVM reset |
| [controlServer.test.ts](../test/controlServer.test.ts) | Reads being blocked by another client's input lease — recorded history must stay readable no matter who holds the console |
| [recorderClientDiscovery.test.ts](../test/recorderClientDiscovery.test.ts) | A recorder dying with the MCP server that started it, or being unfindable by the next one; and `vkvm_record_start` reporting "recording" for a console that is still logging in |
| [recorderDaemonConsole.test.ts](../test/recorderDaemonConsole.test.ts) | A daemon reporting phase `active` while sitting on a Forbidden page, an already-ended session, or a reused tab that nothing is recording |
| [recorderSharing.test.ts](../test/recorderSharing.test.ts) | One agent stopping a recorder another agent is watching; a recorder that cannot be stopped at all because a peer holds the input lease; and a live recorder advertised as dormant by a marker left behind by an earlier run |
| [recorderDaemonExit.test.ts](../test/recorderDaemonExit.test.ts) | A daemon that releases its console, logs its shutdown, and then never exits — a recorder killable only by pid |
| [recorderFrameAdoption.test.ts](../test/recorderFrameAdoption.test.ts) | A starting recorder deleting the frames a caller had just asked to search — reachable from a READ once recorders became daemons; and the sequel, adopting 56 frames of history and evicting them at once against the new session's retention window |
| [recorderIdenticalHeartbeat.test.ts](../test/recorderIdenticalHeartbeat.test.ts) | Storing a full copy of the same powered-off green screen every 60 seconds — 1193 frames and 57 MB of nothing on one server |
| [toolDispatch.test.ts](../test/toolDispatch.test.ts) | A tool advertised in the tool list with no dispatch case, so calling it returns `Unknown tool` — three of them shipped that way |
| [pacedTyping.test.ts](../test/pacedTyping.test.ts) / [pasteAttempts.test.ts](../test/pasteAttempts.test.ts) | Typing faster than the BMC can accept, so a held key auto-repeats — `autoinstall` arriving as `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll` — and a retry that appends to the damage instead of clearing it |
| [typedTextVerdict.test.ts](../test/typedTextVerdict.test.ts) | Reporting "did not match" for repeat damage, which sends the caller after focus problems that do not exist |
| [consolePaste.test.ts](../test/consolePaste.test.ts) | Driving the client's own paste dialog: a plain `{type:'input'}` the browser rejects, and a half-driven dialog left open so the fallback types into ITS textarea |
| [pasteTextFlow.test.ts](../test/pasteTextFlow.test.ts) | Pressing Enter on a line that could not be verified — harmless for `grep`, not for `dd` |
| [browserAcquisition.test.ts](../test/browserAcquisition.test.ts) | Spawning a second browser onto a live profile, deleting a running browser's port file, and navigating a live console tab — one incident produced all three |
| [atomicWrite.test.ts](../test/atomicWrite.test.ts) | Windows `EPERM` on rename (~1 in 100) silently losing a state publish or a lock write — the latter showing up as a daemon that randomly refuses to start |
| [toolArgValidation.test.ts](../test/toolArgValidation.test.ts) / [toolCallValidation.test.ts](../test/toolCallValidation.test.ts) | A tool call missing a required argument reaching Intersight as `GET /v1/undefined` — answered by an opaque 403 `InvalidUrl` instead of a message naming the argument. The MCP SDK does not enforce `inputSchema.required`, so [toolArgValidation.ts](../src/utils/toolArgValidation.ts) does, for both the stdio and HTTP transports |

All of them were confirmed to **fail against the pre-fix code** before the fixes landed — a test that has never been red is not yet known to test anything.

## Notes for adding tests

- Prefer driving the real recorder over asserting on internals; `status()` is the intended observation surface and is what the MCP tools return anyway.
- Anything that writes frames must use a temp dir and clean it up in `afterEach` — the recorder deletes stale PNGs from its directory on `start()`.
- Recorders hold an interval timer: always `stop()` them, or the runner hangs.
- **Browser-side logic still belongs in a tested function.** The shadow-DOM focus traversal was an inline `page.evaluate` string, so nothing exercised it and a version that never found the console canvas shipped. It is now a real function tested against a hand-built fake DOM mirroring the live structure, and composed into the page script with `toString()` — one implementation, two runners.
- **Some properties can only be seen from outside the process.** "Does this terminate" is one: the OCR lifetime test spawns a child that deliberately falls off the end without `process.exit()`, because no in-process assertion can catch a process that refuses to die.
- **When a rule is wrong twice in the same direction, the rule is wrong.** The anti-blank nudge keyed off stored changes, then off screen novelty; both times a repainting screen was read as activity and the console blanked anyway. The third version measures the only thing the CIMC actually watches — input. The two superseded tests were REVERSED rather than deleted, each keeping the evidence for why the old expectation was wrong, because the old reasoning was plausible and will be proposed again.
- **Make the fake refuse what the real thing refuses.** The paste dialog was driven with `dispatchEvent({type:'input'})`, which the hand-built fake DOM accepted and the browser rejected outright ("parameter 1 is not of type 'Event'"). A fake that is more permissive than production turns a test suite into a rubber stamp, so the fake now throws on a non-Event and the event factory is part of the function's signature.
- **A timeout is not an absence.** The acquisition bug reduced to one bad inference: attach timed out, so the code concluded there was no browser and started destroying evidence of one. When a probe fails, ask what else would explain it before acting irreversibly — and prefer a cheap, unambiguous check (an HTTP `/json/version`) over an expensive one whose failure is ambiguous (a full page-by-page attach).
- **Measure before you fix.** The obvious explanation for keys sticking was that the recorder's screenshots were delaying the keyup. A throwaway browser timestamping every down/up showed p90 of 16 ms with a capture loop running — the browser was never the bottleneck, and a day could have gone into optimising the wrong layer. The measurement lives in the test header, so nobody re-derives it.
- **Test the surface you advertise, not just the code behind it.** Every test here called production code directly, so none of them noticed that three tools had lost their dispatch cases while staying in the tool list — an MCP client got `Unknown tool` for something the server was still offering. Two hand-maintained lists of 220 names need a test that compares them, in both directions.
- **Follow the new call graph, not the old one.** Two of the worst bugs in the daemon work were not in the daemon: they were old behaviours that only became wrong once the caller changed. `start()` deleting stale PNGs was reasonable while the MCP server owned the recorder; it became data loss the moment a read could spawn one. Whenever ownership of a component moves, re-read what its callers now imply.
- **A hang is a result.** `recorderSharing.test.ts` passed every assertion and then sat there for 88 seconds. That was not a runner quirk: the daemon had refused its own shutdown (`stop` needed the input lease, which a peer held), so its control socket kept the process alive. Chasing it with `process.getActiveResourcesInfo()` found the lingering handle in seconds. If a test file passes but the run does not end, something in production is failing to release a resource.
- **Assert the property, not a proxy for it.** The first attempt at the above counted `TCPServerWrap` handles in-process, which entangled the assertion with every other listener the runner had open and gave a confusing `expected 2, actual 1`. The property that actually matters is "the process exits", so the test spawns a child that stops a daemon and falls off the end without `process.exit()` — the same shape as the OCR lifetime test, and immune to in-process noise.
- **Run the batch, and believe it when it fails.** The 100× flakiness batch earned its keep here: `recorderLock` passed every single run until iteration 11, where a lock write failed with `EPERM` on rename. That was not test flakiness — it was a real Windows contention bug that would have made daemons refuse to start at random. Reproducing it took a 500-iteration loop outside the runner (5 failures), and the fix was to share the retrying [`writeFileAtomicSync`](../src/utils/atomicWrite.ts) that `state.json` already needed.
- **Interleave the concurrent access you actually expect.** The state-sidecar bug — a silently frozen file — only appeared because the test read the file between writes, which is what a real watcher does. It then took ~1 write in 300 to show up, so a single green run would have shipped it. If a design has two parties touching one resource, make the test be both of them, and run it 40×.
