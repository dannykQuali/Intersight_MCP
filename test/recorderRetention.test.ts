/**
 * The ring buffer must say when it starts destroying evidence.
 *
 * Field report: a 10.5-hour campaign ran against the 240-minute default and
 * lost roughly 60% of its console frames. Nothing reported that — the frames
 * were simply absent when someone went looking, hours after the window had
 * begun rolling and long after anything could be done about it.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkvmRecorder } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, movingMarkFrame, waitFor } from './helpers/fakeConsolePage.js';

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

describe('VkvmRecorder retention', () => {
  it('counts evicted frames and reports when the buffer started rolling', async () => {
    // Genuinely new content each sample (a two-frame flip would be classified
    // as an oscillating blink and correctly never stored).
    const page = new FakeConsolePage(movingMarkFrame(0));
    let n = 0;
    const shoot = page.screenshot.bind(page);
    page.screenshot = async () => {
      page.setFrame(movingMarkFrame(++n));
      return shoot();
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-ret-test-'));
    dirs.push(dir);
    const recorder = new VkvmRecorder(page.asPage(), dir, {
      intervalMs: 250,
      maxFrames: 3,
      antiBlankSeconds: 0,
      heartbeatSeconds: 3600,
    });
    recorders.push(recorder);
    recorder.start();

    await waitFor(() => recorder.status().framesEvicted > 0, 10000, 'the ring buffer to start evicting');

    const status = recorder.status();
    assert.ok(status.framesStored <= 3, `buffer must stay capped, got ${status.framesStored}`);
    assert.ok(status.evictionStartedAt, 'the moment eviction began must be reported');
    assert.match(status.evictionNote, /cannot be recovered/i);

    // Evicted frames must be gone from disk too, not just from the index.
    const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    assert.equal(onDisk, status.framesStored, 'index and disk must agree');
  });

  it('reports a clean buffer as not yet rolling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-ret-test-'));
    dirs.push(dir);
    const recorder = new VkvmRecorder(new FakeConsolePage().asPage(), dir, { antiBlankSeconds: 0 });
    recorders.push(recorder);

    const status = recorder.status();
    assert.equal(status.framesEvicted, 0);
    assert.equal(status.evictionStartedAt, null);
    assert.equal(status.evictionNote, undefined, 'no scary note when nothing has been lost');
  });
});
