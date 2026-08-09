/**
 * A console that is showing nothing must not be recorded as if it were.
 *
 * Six of nine recorded servers were found powered OFF, their consoles a static
 * green "No Signal — Reason: Host power is off". The screen was byte-identical
 * every tick, so the heartbeat dutifully stored a full copy of that same image
 * every 60 seconds: 1193 frames and 57 MB on one server, and an OCR pass on each
 * one. As the operator put it, "if they even record anything it's mainly
 * nothing".
 *
 * The heartbeat still earns its place — it proves capture is alive and anchors
 * the freshness clocks that dormancy and data-expiry read. So the cadence backs
 * OFF while a frame would be byte-identical to the one already stored, instead of
 * being switched off: the record keeps a periodic anchor, at a thirtieth of the
 * volume. Anything that actually changes is stored immediately, as before.
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
  for (const r of recorders.splice(0)) {
    r.stop();
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identical-heartbeat-'));
  dirs.push(dir);
  return dir;
}

/**
 * Timings are scaled, ratios preserved: a 0.2s heartbeat against a 2s identical
 * anchor has the same shape as the real 60s against 30 minutes.
 */
function startRecorder(page: FakeConsolePage, overrides: Record<string, unknown> = {}): VkvmRecorder {
  const recorder = new VkvmRecorder(page as never, tempDir(), {
    intervalMs: 50,
    retentionMinutes: 240,
    heartbeatSeconds: 0.2,
    identicalHeartbeatSeconds: 2,
    antiBlankSeconds: 0,
    antiBlankMode: 'none',
    ocrText: false,
    ...overrides,
  } as never);
  recorders.push(recorder);
  recorder.start();
  return recorder;
}

describe('a console showing the same thing forever', () => {
  it('stores one frame, not one per heartbeat', async () => {
    // The powered-off case: the screen never changes at all.
    const recorder = startRecorder(new FakeConsolePage(solidPng(40)));
    await waitFor(() => recorder.status().framesStored >= 1, 2000, 'the first frame');

    // Long enough for ~7 ordinary heartbeats to have fired.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = recorder.status();
    assert.equal(status.framesStored, 1, `expected the identical screen to be stored once, got ${status.framesStored}`);
    assert.ok(
      status.heartbeatsSuppressed >= 3,
      `the suppressed heartbeats must be counted, saw ${status.heartbeatsSuppressed}`
    );
  });

  it('still anchors the record periodically, so freshness clocks keep working', async () => {
    // Dormancy and data-expiry are judged on newestFrameAt. Suppressing every
    // heartbeat forever would freeze that and eventually expire the data of a
    // console someone is still watching.
    const recorder = startRecorder(new FakeConsolePage(solidPng(40)));
    await waitFor(() => recorder.status().framesStored >= 2, 6000, 'the periodic anchor frame');

    const status = recorder.status();
    assert.equal(status.framesStored, 2, 'exactly one anchor, not a burst');
    assert.ok(status.heartbeatsSuppressed > 5, 'and the ordinary heartbeats in between were skipped');
  });

  it('stores immediately when the screen finally changes', async () => {
    // The moment that matters: the server powers on and video returns. Backing
    // off must not delay that by a single tick.
    const page = new FakeConsolePage(solidPng(40, 200, 200));
    const recorder = startRecorder(page);
    await waitFor(() => recorder.status().framesStored >= 1, 2000, 'the first frame');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(recorder.status().framesStored, 1, 'still quiet while nothing happens');

    page.setFrame(movingMarkFrame(7));
    await waitFor(() => recorder.status().framesStored >= 2, 2000, 'the change to be captured');
    const events = recorder.timeline().filter((e: any) => e.reason === 'change');
    assert.ok(events.length >= 1, 'the change must be recorded as a change, not as an anchor');
  });

  it('keeps the normal cadence for a screen that keeps repainting', async () => {
    // A ticking clock is NOT byte-identical: each heartbeat frame carries a new
    // time, so those heartbeats still say something and are kept.
    const page = new FakeConsolePage(movingMarkFrame(1));
    const recorder = startRecorder(page);
    let seed = 1;
    const ticking = setInterval(() => page.setFrame(movingMarkFrame(++seed)), 60);

    try {
      await waitFor(() => recorder.status().framesStored >= 3, 4000, 'several frames from a live screen');
      assert.equal(recorder.status().heartbeatsSuppressed, 0, 'nothing may be suppressed on a changing console');
    } finally {
      clearInterval(ticking);
    }
  });
});
