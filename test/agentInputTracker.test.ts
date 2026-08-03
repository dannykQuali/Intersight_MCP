/**
 * Agent-input bookkeeping must be PER CONSOLE.
 *
 * Regression: these were two scalars on BrowserService, so a mouse move on
 * server A suppressed the anti-blank nudge on server B (observed live:
 * interacting with C240 at 21:31:58 caused 2-2-5's 21:32:22 nudge to be
 * declined and its idle clock pushed out another 4 minutes).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentInputTracker } from '../src/services/agentInputTracker.js';

/** Controllable clock so the quiet-window tests never sleep. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('AgentInputTracker', () => {
  it('reports the console the agent is using as busy', async () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);
    let observedDuringInput: boolean | null = null;

    await tracker.run('serverA', async () => {
      observedDuringInput = tracker.isBusy('serverA');
    });

    assert.equal(observedDuringInput, true, 'the console being typed into is busy');
    assert.equal(tracker.isBusy('serverA'), true, 'still busy inside the quiet window');
  });

  it('does NOT mark other consoles busy while one is being used', async () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);
    let otherDuringInput: boolean | null = null;

    await tracker.run('serverA', async () => {
      otherDuringInput = tracker.isBusy('serverB');
    });

    assert.equal(otherDuringInput, false, 'input on A must not block a nudge on B');
    assert.equal(tracker.isBusy('serverB'), false, 'B stays nudgeable after A is done');
  });

  it('keeps the used console busy for the quiet window, then releases it', () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);

    tracker.markInput('serverA');
    clock.advance(59_999);
    assert.equal(tracker.isBusy('serverA'), true, 'still inside the quiet window');

    clock.advance(2);
    assert.equal(tracker.isBusy('serverA'), false, 'quiet window elapsed');
  });

  it('stays busy until the LAST concurrent interaction finishes', async () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = tracker.run('serverA', async () => gate);
    const quick = tracker.run('serverA', async () => undefined);
    await quick;

    assert.equal(tracker.isBusy('serverA'), true, 'the slow interaction is still in flight');
    release();
    await slow;
    assert.equal(tracker.isBusy('serverA'), true, 'quiet window now applies');
  });

  it('records input even when the interaction throws', async () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);

    await assert.rejects(
      tracker.run('serverA', async () => {
        throw new Error('key press failed');
      }),
      /key press failed/
    );

    assert.equal(tracker.isBusy('serverA'), true, 'a failed keystroke may still have reached the console');
  });

  it('ignores input aimed at a non-console page', async () => {
    const clock = fakeClock();
    const tracker = new AgentInputTracker(60_000, clock.now);

    await tracker.run(null, async () => undefined);

    assert.equal(tracker.isBusy('serverA'), false, 'typing in an unrelated tab must not block any console');
  });
});
