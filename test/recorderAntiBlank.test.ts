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
import { PNG } from 'pngjs';
import { VkvmRecorder } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, solidPng, waitFor } from './helpers/fakeConsolePage.js';

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
 * A frame differing from `solidPng(0)` by a single pixel.
 *
 * Sized so the difference is BELOW the change threshold, like a real clock
 * digit: the recorder samples every 4th pixel, so 200x200 gives 2500 sampled
 * pixels and one of them is 0.0004 - under the 0.0005 default.
 */
function oneDifferentPixel(): Buffer {
  const png = PNG.sync.read(solidPng(0, 200, 200));
  png.data[0] = 255;
  png.data[1] = 255;
  png.data[2] = 255;
  return PNG.sync.write(png);
}

/**
 * Recorder over a console that repaints on a fixed period, scaled down from
 * reality: a 2s anti-blank window (8 samples) against a "clock" that ticks
 * every 6 samples - the same shape as 240s against a 60s clock.
 */
function tickingConsoleRecorder(samplesPerRepaint: number) {
  const frames = [solidPng(0, 200, 200), oneDifferentPixel()];
  const page = new FakeConsolePage(frames[0]);
  let samples = 0;
  let which = 0;
  const originalScreenshot = page.screenshot.bind(page);
  page.screenshot = async () => {
    if (samplesPerRepaint > 0 && ++samples % samplesPerRepaint === 0) {
      which ^= 1;
      page.setFrame(frames[which]);
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
  it('keeps nudging a console whose only activity is a periodic repaint', async () => {
    const { recorder, nudges } = tickingConsoleRecorder(6);
    recorder.start();

    // The first nudge is the on-attach one; the second proves the idle rule
    // survived a screen that never stops repainting.
    await waitFor(() => nudges.length >= 2, 10000, 'a second nudge on a ticking console');
    assert.equal(recorder.status().antiBlank.nudgesSent, nudges.length);
  });

  it('never nudges a console that is actively working', async () => {
    // Repaints on every single sample: an installer progress bar or a spinner.
    const { recorder, nudges } = tickingConsoleRecorder(1);
    recorder.start();

    await waitFor(() => nudges.length >= 1, 5000, 'the on-attach nudge');
    // Well past the 2s anti-blank window - a busy console must still be left alone.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(nudges.length, 1, 'only the on-attach nudge; the console is busy');
  });
});
