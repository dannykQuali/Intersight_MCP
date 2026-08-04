/**
 * End-to-end anti-blank behaviour through the real capture loop.
 *
 * nudgeDecision.test.ts pins the rule; this pins the wiring - that the recorder
 * actually feeds it a correct "how long has the screen sat still" count. The
 * live failure it guards against: a Windows console whose taskbar clock
 * repainted once a minute received ZERO nudges in 11 minutes, while a static
 * UEFI console on the same browser nudged on schedule.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkvmRecorder } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, movingMarkFrame, solidPng, waitFor } from './helpers/fakeConsolePage.js';

const dirs: string[] = [];
const recorders: VkvmRecorder[] = [];

afterEach(() => {
  for (const recorder of recorders.splice(0)) {
    recorder.stop();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-blank-test-'));
  dirs.push(dir);
  return dir;
}

/**
 * Recorder over a console with controllable "activity", scaled down from
 * reality: a 2s anti-blank window (8 samples) instead of 240s.
 */
function consoleRecorder(nextFrame: (sample: number) => Buffer | null) {
  const page = new FakeConsolePage(solidPng(0, 200, 200));
  let samples = 0;
  const originalScreenshot = page.screenshot.bind(page);
  page.screenshot = async () => {
    const frame = nextFrame(++samples);
    if (frame) {
      page.setFrame(frame);
    }
    return originalScreenshot();
  };

  const nudges: number[] = [];
  const recorder = new VkvmRecorder(
    page.asPage(),
    tempDir(),
    { intervalMs: 250, antiBlankSeconds: 2, heartbeatSeconds: 3600, deadCheckEveryTicks: 1000 },
    {
      nudge: async () => {
        nudges.push(Date.now());
        return true;
      },
    }
  );
  recorders.push(recorder);
  return { recorder, nudges };
}

describe('VkvmRecorder anti-blank', () => {
  it('keeps nudging a console whose only motion is a blink', async () => {
    // Two frames toggling — a cursor. The classifier calls it oscillating, so
    // the console counts as at rest and anti-blank keeps protecting it. (Under
    // the old rule the blink reset the still-run every cycle and this console
    // - an idle login prompt, the one MOST likely to blank - was never nudged.)
    const a = solidPng(0, 200, 200);
    const b = movingMarkFrame(1);
    const { recorder, nudges } = consoleRecorder((n) => (n % 6 === 0 ? (Math.floor(n / 6) % 2 ? b : a) : null));
    recorder.start();

    // The first nudge is the on-attach one; the second proves the idle rule
    // survived a screen that never stops repainting.
    await waitFor(() => nudges.length >= 2, 10000, 'a second nudge on a blinking console');
    assert.equal(recorder.status().antiBlank.nudgesSent, nudges.length);
  });

  it('never nudges a console that is actively working', async () => {
    // Genuinely new content on every sample, landing in fresh places — an
    // installer writing output. Novelty keeps refreshing, so no nudge.
    const { recorder, nudges } = consoleRecorder((n) => movingMarkFrame(n));
    recorder.start();

    await waitFor(() => nudges.length >= 1, 5000, 'the on-attach nudge');
    // Well past the 2s anti-blank window - a busy console must still be left alone.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(nudges.length, 1, 'only the on-attach nudge; the console is busy');
  });
});
