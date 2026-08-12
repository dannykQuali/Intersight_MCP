/**
 * When is a console due for an anti-blank nudge?
 *
 * This rule has been wrong twice, in the same direction, and the fix each time
 * was to stop treating the SCREEN as evidence of activity.
 *
 * First: the idle test folded in `lastPixelChangeAt`, refreshed by any
 * sub-threshold repaint. A Windows taskbar clock repaints once a minute forever,
 * so a booted desktop never reached the 240s mark — 0 nudges in 11 minutes on
 * C240, while a static UEFI console nudged on schedule.
 *
 * Then: it keyed off screen NOVELTY and required the screen to be at rest. A
 * scrolling ESXi installer produces novelty every second and is never at rest, so
 * the nudge fired 32 times in 28 hours and the CIMC blanked the console anyway —
 * three green "User Inactivity" screens in 40 minutes, 127 to 241 seconds each,
 * while the install carried on throughout.
 *
 * A console blanks on INPUT idle. It does not care that its own clock is ticking,
 * and it does not care that an installer is scrolling. So the rule measures only
 * input: our nudges, and the agent's own keystrokes.
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
    lastNoveltyAt: NOW - 600_000,
    lastNudgeAt: NOW - 600_000,
    lastAgentInputAt: 0,
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

  it('DOES nudge a console that is actively working', () => {
    // Reversed deliberately. This once asserted the opposite, on the reasoning
    // that a busy console should not be disturbed — but the CIMC blanks on input
    // idleness regardless of how busy the guest is, so "busy" was exactly the
    // case where the nudge was needed and never came. What protects a working
    // console is WHAT is sent (a bare modifier, a 3px drift), not withholding it.
    assert.equal(shouldNudge(idleConsole({ stillSamples: 0 })), true);
    assert.equal(shouldNudge(idleConsole({ stillSamples: STILL_SAMPLES_BEFORE_NUDGE - 1 })), true);
  });

  it('DOES nudge while real console output is flowing', () => {
    // Boot messages or an installer step a second ago say nothing about whether
    // the CIMC has seen input. Under the old rule this postponed the nudge every
    // second, forever, and the console blanked mid-install.
    assert.equal(shouldNudge(idleConsole({ lastNoveltyAt: NOW - 1000 })), true);
  });

  it('treats the agent’s own input as activity', () => {
    // An agent typing has already reset the CIMC's timer; nudging on top of that
    // is pointless traffic.
    assert.equal(shouldNudge(idleConsole({ lastAgentInputAt: NOW - 1000 })), false);
    assert.equal(shouldNudge(idleConsole({ lastAgentInputAt: NOW - 600_000 })), true);
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
      lastNoveltyAt: NOW,
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
