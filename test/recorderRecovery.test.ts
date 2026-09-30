/**
 * A console that is reborn dead must not relaunch forever.
 *
 * Regression (observed live on CHG-UCSX-2-2-5): Intersight's tunneled-vKVM bug
 * makes a freshly launched console mount healthy and then die ~10s later. The
 * recorder's backoff only armed when recovery THREW, and this recovery
 * succeeds - so it looped "console-dead -> recovered" every ~9 seconds
 * indefinitely with recoveryFailures stuck at 0, never escalating to the
 * disable/re-enable of Tunneled vKVM that actually fixes it.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkvmRecorder } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, waitFor } from './helpers/fakeConsolePage.js';

const dirs: string[] = [];
const recorders: VkvmRecorder[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-rec-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const recorder of recorders.splice(0)) {
    recorder.stop();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A recorder whose console is ALWAYS dead, so every dead-check triggers
 * recovery. Timings are scaled down (250ms sampling, checked every tick) so the
 * loop the test is about plays out in a couple of seconds.
 */
function alwaysDeadRecorder(opts: { shortLivedRecoveryMs?: number } = {}) {
  const counts = { relaunches: 0, resets: 0 };
  const recorder = new VkvmRecorder(
    new FakeConsolePage().asPage(),
    tempDir(),
    {
      intervalMs: 250,
      deadCheckEveryTicks: 1,
      antiBlankSeconds: 0,
      heartbeatSeconds: 3600,
      ...opts,
    },
    {
      isConsoleDead: async () => true,
      recover: async () => {
        counts.relaunches++;
        return new FakeConsolePage().asPage();
      },
      resetTunneledVkvm: async () => {
        counts.resets++;
      },
    }
  );
  recorders.push(recorder);
  return { recorder, counts };
}

describe('VkvmRecorder recovery escalation', () => {
  it('resets Tunneled vKVM when relaunched consoles keep dying immediately', async () => {
    const { recorder, counts } = alwaysDeadRecorder();
    recorder.start();

    await waitFor(() => counts.resets >= 1, 15000, 'a Tunneled vKVM reset to be attempted');

    const status = recorder.status();
    assert.ok(
      status.recentEvents.some((e: any) => e.kind === 'vkvm-reset'),
      'the reset should be visible on the timeline'
    );
    assert.ok(counts.relaunches >= 2, 'escalation happens only after repeated quick deaths');
  });

  it('gives up into backoff instead of relaunching forever', async () => {
    const { recorder, counts } = alwaysDeadRecorder();
    recorder.start();

    await waitFor(() => recorder.status().state === 'failed', 20000, 'the recorder to stop retrying');
    const status = recorder.status();
    const relaunchesAtGiveUp = counts.relaunches;

    assert.ok(status.recoveryFailures >= 1, 'a give-up must arm the backoff ladder');
    assert.ok(
      status.nextRecoveryAttemptAt && Date.parse(status.nextRecoveryAttemptAt) > Date.now(),
      'the next attempt must be scheduled in the future'
    );
    assert.ok(counts.resets >= 1, 'the reset must be tried before giving up');
    assert.ok(
      relaunchesAtGiveUp <= 10,
      `bounded relaunches before giving up, got ${relaunchesAtGiveUp}`
    );

    // And it stays backed off rather than resuming the ~9s loop.
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(counts.relaunches, relaunchesAtGiveUp, 'no further relaunches while backing off');
  });

  it('does not spend the reset budget on resets that never ran', async () => {
    // Regression (CHGLAB-UCSX-1-5-1, 2026-09-30): the browser session had
    // expired, so both escalations failed at the ServerSettings lookup before
    // any PATCH was sent - yet each was counted as a reset. With the budget
    // "spent", every later attempt ended in "the server needs attention"
    // without the reset ever having been applied once.
    const counts = { relaunches: 0, resetCalls: 0, resetsApplied: 0 };
    const recorder = new VkvmRecorder(
      new FakeConsolePage().asPage(),
      tempDir(),
      {
        intervalMs: 250,
        deadCheckEveryTicks: 1,
        antiBlankSeconds: 0,
        heartbeatSeconds: 3600,
        recoveryBackoffMs: 50,
      },
      {
        isConsoleDead: async () => true,
        recover: async () => {
          counts.relaunches++;
          return new FakeConsolePage().asPage();
        },
        resetTunneledVkvm: async () => {
          counts.resetCalls++;
          if (counts.resetCalls <= 2) {
            throw new Error('ServerSettings lookup failed: HTTP 401 (the browser session is not logged in)');
          }
          counts.resetsApplied++;
        },
      }
    );
    recorders.push(recorder);
    recorder.start();

    await waitFor(() => counts.resetsApplied >= 1, 20000, 'a reset to be applied once the session is back');

    const status = recorder.status();
    assert.ok(status.tunneledVkvmResets >= 1, 'an applied reset is counted');
    assert.ok(
      status.tunneledVkvmResets <= counts.resetsApplied,
      `only applied resets may be counted (counted ${status.tunneledVkvmResets}, applied ${counts.resetsApplied})`
    );
    const failures = status.recentEvents.filter((e: any) => e.kind === 'recovery-failed');
    assert.ok(
      failures.some((e: any) => /401/.test(e.detail ?? '')),
      'the real cause of a failed reset must reach the timeline'
    );
  });

  it('does not escalate when each recovered console survives', async () => {
    // shortLivedRecoveryMs=1 means every console counts as long-lived, i.e. a
    // console dying hours apart all night - normal, not the Intersight bug.
    const { recorder, counts } = alwaysDeadRecorder({ shortLivedRecoveryMs: 1 });
    recorder.start();

    await waitFor(() => counts.relaunches >= 4, 15000, 'several ordinary recoveries');

    assert.equal(counts.resets, 0, 'a healthy relaunch cycle must never reset Tunneled vKVM');
    assert.equal(recorder.status().state, 'recording');
  });
});
