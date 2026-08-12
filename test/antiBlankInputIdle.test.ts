/**
 * The console blanks on INPUT idleness, so anti-blank must be driven by input —
 * not by whether the screen looks busy.
 *
 * Field case, C240 mid-ESXi-install. The CIMC blanked the video three times in
 * 40 minutes (green "User Inactivity" screens, 15.7 and 21.1 minutes apart), each
 * lasting 127 to 241 seconds, while the guest carried on installing the whole
 * time — the frames either side show the installer had advanced. Nothing was
 * wrong with the machine: the CIMC stops streaming when it receives no HID input,
 * whatever the guest is drawing.
 *
 * The anti-blank nudge is supposed to prevent exactly that, and it fired 32 times
 * in 28 hours — because `shouldNudge` counted screen NOVELTY as activity. A
 * scrolling installer produces novelty every second, so the nudge was almost
 * never due, and the console blanked on the CIMC's own schedule.
 *
 * Video activity is not input activity. The rule now measures the only clock that
 * matters: time since input was last DELIVERED (our nudge, or the agent's own
 * keystrokes). The nudge is a bare modifier plus a three-pixel mouse drift — it
 * types nothing and submits nothing, so there is no console it can disturb.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { shouldNudge, type NudgeDecision } from '../src/services/vkvmRecorder.js';

const NOW = 1_800_000_000_000;
const SEC = 1000;

/** A console whose screen is busy but which has received no input for a while. */
function busyConsole(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
  return {
    now: NOW,
    antiBlankSeconds: 240,
    mode: 'key',
    state: 'recording',
    needsInitialNudge: false,
    // Novelty a second ago: an installer scrolling, exactly the C240 case.
    lastNoveltyAt: NOW - 1 * SEC,
    lastNudgeAt: NOW - 300 * SEC,
    lastAgentInputAt: 0,
    startedAt: NOW - 3600 * SEC,
    stillSamples: 0,
    ...overrides,
  };
}

describe('anti-blank on a console that is busy but not receiving input', () => {
  it('nudges a scrolling installer, which the old novelty rule never did', () => {
    // The whole bug in one assertion: the screen is changing every second, and
    // the CIMC blanks anyway because no input has arrived for five minutes.
    assert.equal(shouldNudge(busyConsole()), true);
  });

  it('does not nudge before the window has elapsed', () => {
    assert.equal(shouldNudge(busyConsole({ lastNudgeAt: NOW - 100 * SEC })), false);
  });

  it('counts the agent’s own input as input', () => {
    // An agent typing keeps the console awake by itself; nudging on top of that
    // is pointless traffic.
    assert.equal(shouldNudge(busyConsole({ lastAgentInputAt: NOW - 10 * SEC })), false);
  });

  it('nudges once the agent has been idle for the window, however busy the screen', () => {
    assert.equal(shouldNudge(busyConsole({ lastAgentInputAt: NOW - 300 * SEC })), true);
  });

  it('still nudges a completely idle console', () => {
    // The case that always worked must keep working.
    assert.equal(
      shouldNudge(busyConsole({ lastNoveltyAt: NOW - 3000 * SEC, stillSamples: 50 })),
      true
    );
  });

  it('does not nudge when anti-blank is switched off', () => {
    assert.equal(shouldNudge(busyConsole({ mode: 'none' })), false);
    assert.equal(shouldNudge(busyConsole({ antiBlankSeconds: 0 })), false);
  });

  it('does not nudge a recorder that is not recording', () => {
    assert.equal(shouldNudge(busyConsole({ state: 'recovering' })), false);
  });

  it('nudges immediately on attach, before anything is known about the console', () => {
    // It may already be blanked when we attach, and an agent should not wait out
    // a whole window to find out what is on screen.
    assert.equal(shouldNudge(busyConsole({ needsInitialNudge: true, lastNudgeAt: NOW })), true);
  });

  it('does not let a novel screen DELAY a nudge any more', () => {
    // The regression this test exists for. Under the old rule, novelty one second
    // ago pushed the next nudge 240s into the future, every second, forever.
    const constantlyChanging = busyConsole({ lastNoveltyAt: NOW, lastNudgeAt: NOW - 241 * SEC });
    assert.equal(shouldNudge(constantlyChanging), true);
  });
});
