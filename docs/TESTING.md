# Testing

```bash
npm test              # run the suite
npm run typecheck:tests   # type-check src + test together (npm run build only covers src)
```

The runner is Node's built-in `node --test` driven through `tsx`, so there is **no test framework dependency** — nothing was added to `package.json` beyond two scripts. Tests live in [`test/`](../test), outside `rootDir`, so they never end up in `build/`.

## What is worth testing here

Most of this server is a thin mapping from MCP tool calls onto Intersight REST, which the API itself validates far better than a mock would. The parts that carry real logic — and where the bugs have actually been — are the **vKVM console recorder's self-healing and anti-blank rules**. They are timer-driven, run unattended for hours, and fail *silently*: a broken recorder does not throw, it just quietly records nothing useful until morning. That is what the current tests cover.

## Approach

**Seams instead of mocks.** Two decisions were pulled out of the timer loop so they can be tested as pure functions against the real production code path:

- `shouldNudge()` in [vkvmRecorder.ts](../src/services/vkvmRecorder.ts) — is this console due for an anti-blank nudge?
- [`AgentInputTracker`](../src/services/agentInputTracker.ts) — is the agent using this console right now? It takes a clock function, so quiet-window tests advance time instead of sleeping.

Everything else runs the real `VkvmRecorder` against a [`FakeConsolePage`](../test/helpers/fakeConsolePage.ts) that implements only the two members the recorder touches (`isClosed`, `screenshot`). Real capture, real hashing, real pixel diffing, real recovery state machine — only the browser is fake.

**Timings scaled, ratios preserved.** Timer-driven behaviour needs real time to pass, so the tests shrink the intervals while keeping the *shape* of the real situation: a 2s anti-blank window against a console repainting every 6 samples has the same character as 240s against a 60s clock, and it plays out in three seconds. Waiting is always `waitFor(predicate, timeout)` — never a bare sleep for a fixed duration — so a fast machine finishes early and a slow one still passes.

**Sub-threshold means sub-threshold.** The "ticking clock" fixture changes exactly one pixel of a 200×200 frame, which lands at 0.0004 against the 0.0005 storage threshold. Getting that wrong would make the fixture a *storable change* and quietly test something else entirely.

## Regressions these lock down

Each test file opens with the live failure it exists to prevent:

| File | Guards against |
|---|---|
| [recorderRecovery.test.ts](../test/recorderRecovery.test.ts) | A born-dead console relaunching every ~9 seconds forever, never escalating to the Tunneled vKVM reset that fixes it |
| [nudgeDecision.test.ts](../test/nudgeDecision.test.ts) / [recorderAntiBlank.test.ts](../test/recorderAntiBlank.test.ts) | Anti-blank silently never running on any console with a clock on it |
| [agentInputTracker.test.ts](../test/agentInputTracker.test.ts) | Input on one console suppressing anti-blank on all the others |
| [recorderHooks.test.ts](../test/recorderHooks.test.ts) | A self-healing hook silently going unwired — `wakeConsole` was implemented and called but never passed in, so sleeping consoles were never woken |
| [consoleSignals.test.ts](../test/consoleSignals.test.ts) | An unrecognised green "No Signal" reason being reported as a healthy console — "Host power is off" matched neither known pattern |
| [frameCoords.test.ts](../test/frameCoords.test.ts) | Coordinates read off a downscaled recorded frame being passed as page pixels, landing the click 30–50% off |
| [recorderRetention.test.ts](../test/recorderRetention.test.ts) | The ring buffer deleting console evidence without ever saying so |
| [recorderState.test.ts](../test/recorderState.test.ts) | Recorder status being unreadable from other processes, and the published file silently freezing while a reader polls it |
| [recorderOcrText.test.ts](../test/recorderOcrText.test.ts) | A parked installer reading as a calm machine because only its words changed, not its pixels |
| [frameOcrLifetime.test.ts](../test/frameOcrLifetime.test.ts) | A process that used OCR never exiting — which would break any background waiter, since its notification fires on exit |
| [frameOcrAccuracy.test.ts](../test/frameOcrAccuracy.test.ts) | The real OCR engine regressing on dense console text, inventing text on a blank frame, or leaking browser chrome into the transcript |
| [consoleFocus.test.ts](../test/consoleFocus.test.ts) | Keyboard input being dispatched into page chrome because the shadow-DOM traversal never reached the console canvas |
| [keyboardText.test.ts](../test/keyboardText.test.ts) | Shifted characters arriving unshifted at the BMC (`Cisco123!` → `cisco1231`) because no real Shift keydown was ever sent |
| [tileNovelty.test.ts](../test/tileNovelty.test.ts) | The change-magnitude threshold judging a password dot and a cursor blink identically (~0.0003 each) — changes are now classified by region history instead of measured |

All of them were confirmed to **fail against the pre-fix code** before the fixes landed — a test that has never been red is not yet known to test anything.

## Notes for adding tests

- Prefer driving the real recorder over asserting on internals; `status()` is the intended observation surface and is what the MCP tools return anyway.
- Anything that writes frames must use a temp dir and clean it up in `afterEach` — the recorder deletes stale PNGs from its directory on `start()`.
- Recorders hold an interval timer: always `stop()` them, or the runner hangs.
- **Browser-side logic still belongs in a tested function.** The shadow-DOM focus traversal was an inline `page.evaluate` string, so nothing exercised it and a version that never found the console canvas shipped. It is now a real function tested against a hand-built fake DOM mirroring the live structure, and composed into the page script with `toString()` — one implementation, two runners.
- **Some properties can only be seen from outside the process.** "Does this terminate" is one: the OCR lifetime test spawns a child that deliberately falls off the end without `process.exit()`, because no in-process assertion can catch a process that refuses to die.
- **Interleave the concurrent access you actually expect.** The state-sidecar bug — a silently frozen file — only appeared because the test read the file between writes, which is what a real watcher does. It then took ~1 write in 300 to show up, so a single green run would have shipped it. If a design has two parties touching one resource, make the test be both of them, and run it 40×.
