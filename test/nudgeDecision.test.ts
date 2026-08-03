/**
 * When is an idle console due for an anti-blank nudge?
 *
 * Regression: the idle test folded in `lastPixelChangeAt`, which is refreshed
 * by ANY sub-threshold repaint. A Windows taskbar clock repaints once a minute
 * forever, so a booted desktop never reached the 240s idle mark and was never
 * nudged - observed live: 0 nudges in 11 minutes on C240, while a static UEFI
 * console nudged on schedule. A console blanks on INPUT idle; it does not care
 * that its own clock is ticking.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { shouldNudge, STILL_SAMPLES_BEFORE_NUDGE, type NudgeDecision } from '../src/services/vkvmRecorder.js';

const NOW = 10_000_000;
const ANTI_BLANK_SECONDS = 240;

/** A console idle well past the anti-blank deadline and currently at rest. */
function idleConsole(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
  return {
    now: NOW,
    antiBlankSeconds: ANTI_BLANK_SECONDS,
    mode: 'mouse',
    state: 'recording',
    needsInitialNudge: false,
    lastChangeAt: NOW - 600_000,
    lastNudgeAt: NOW - 600_000,
    startedAt: NOW - 600_000,
    stillSamples: 30,
    ...overrides,
  };
}

describe('shouldNudge', () => {
  it('nudges a console whose only activity is a ticking clock', () => {
    // A clock repaints once a minute: 59 of every 60 samples are identical, so
    // the screen is at rest right now even though it changed 10s ago.
    const decision = idleConsole({ stillSamples: 10 });
    assert.equal(shouldNudge(decision), true);
  });

  it('does not nudge a console that is actively working', () => {
    // A spinner/progress bar changes on essentially every sample.
    assert.equal(shouldNudge(idleConsole({ stillSamples: 0 })), false);
    assert.equal(shouldNudge(idleConsole({ stillSamples: STILL_SAMPLES_BEFORE_NUDGE - 1 })), false);
  });

  it('does not nudge while real console output is flowing', () => {
    // An above-threshold change moments ago: boot messages, an installer step.
    assert.equal(shouldNudge(idleConsole({ lastChangeAt: NOW - 1000 })), false);
  });

  it('waits the full anti-blank window after the previous nudge', () => {
    assert.equal(shouldNudge(idleConsole({ lastNudgeAt: NOW - 1000 })), false);
    assert.equal(
      shouldNudge(idleConsole({ lastNudgeAt: NOW - ANTI_BLANK_SECONDS * 1000 - 1 })),
      true
    );
  });

  it('nudges immediately on attach, before any idle time has accrued', () => {
    // A console is very often already blanked when we attach to it.
    const fresh = idleConsole({
      needsInitialNudge: true,
      lastChangeAt: NOW,
      startedAt: NOW,
      stillSamples: 0,
    });
    assert.equal(shouldNudge(fresh), true);
  });

  it('never nudges when disabled or not recording', () => {
    assert.equal(shouldNudge(idleConsole({ mode: 'none' })), false);
    assert.equal(shouldNudge(idleConsole({ antiBlankSeconds: 0 })), false);
    assert.equal(shouldNudge(idleConsole({ state: 'recovering' })), false);
    assert.equal(shouldNudge(idleConsole({ state: 'stopped' })), false);
    // ...not even the initial nudge.
    assert.equal(shouldNudge(idleConsole({ mode: 'none', needsInitialNudge: true })), false);
    assert.equal(shouldNudge(idleConsole({ state: 'failed', needsInitialNudge: true })), false);
  });
});
