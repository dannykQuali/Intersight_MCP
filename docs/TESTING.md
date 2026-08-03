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

All of them were confirmed to **fail against the pre-fix code** before the fixes landed — a test that has never been red is not yet known to test anything.

## Notes for adding tests

- Prefer driving the real recorder over asserting on internals; `status()` is the intended observation surface and is what the MCP tools return anyway.
- Anything that writes frames must use a temp dir and clean it up in `afterEach` — the recorder deletes stale PNGs from its directory on `start()`.
- Recorders hold an interval timer: always `stop()` them, or the runner hangs.
