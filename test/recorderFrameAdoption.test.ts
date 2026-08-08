/**
 * A starting recorder must ADOPT the frames already in its directory, not delete
 * them.
 *
 * It used to delete them, which was defensible when the MCP server owned the
 * recorder and a restart meant a fresh unrelated run. Under per-server recorder
 * daemons it became a data-loss path reachable by a READ: with no daemon live,
 * `vkvm_find_text` on last night's campaign spawned one, whose recorder started
 * by deleting exactly the frames the caller had asked to search. The lock file
 * already guarantees one recorder per server, so continuing the existing series
 * is safe — and retention still bounds disk by age, which is what "keep disk use
 * bounded" actually needed.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-adoption-'));
  dirs.push(dir);
  return dir;
}

/** Frames left behind by a previous run, as they exist on disk. */
function plantFrames(dir: string, count: number, ageMinutes = 30): string[] {
  const written: string[] = [];
  for (let i = 1; i <= count; i++) {
    const file = path.join(dir, `f-${String(i).padStart(6, '0')}.png`);
    fs.writeFileSync(file, solidPng(10 + i * 5));
    const at = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(file, at, at);
    written.push(file);
  }
  return written;
}

function startRecorder(dir: string, page = new FakeConsolePage(movingMarkFrame(1))): VkvmRecorder {
  const recorder = new VkvmRecorder(page as never, dir, {
    intervalMs: 50,
    retentionMinutes: 240,
    heartbeatSeconds: 3600,
    antiBlankSeconds: 0,
    antiBlankMode: 'none',
    ocrText: false,
  });
  recorders.push(recorder);
  recorder.start();
  return recorder;
}

describe('a recorder starting in a directory that already has frames', () => {
  it('keeps the existing frames instead of deleting them', async () => {
    const dir = tempDir();
    const planted = plantFrames(dir, 4);
    startRecorder(dir);

    for (const file of planted) {
      assert.equal(fs.existsSync(file), true, `${path.basename(file)} was deleted by a starting recorder`);
    }
  });

  it('counts them, so they are visible to a caller asking what it has', async () => {
    const dir = tempDir();
    plantFrames(dir, 4);
    const recorder = startRecorder(dir);

    const status = recorder.status();
    assert.ok(status.framesStored >= 4, `expected the adopted frames to be counted, got ${status.framesStored}`);
    assert.ok(status.diskBytes > 0, 'adopted frames must count toward disk use, or the budget is a lie');
  });

  it('reports them on the timeline, so history is searchable', async () => {
    const dir = tempDir();
    plantFrames(dir, 3);
    const recorder = startRecorder(dir);

    const events = recorder.timeline();
    const adopted = events.filter((e: any) => e.reason === 'adopted');
    assert.equal(adopted.length, 3, 'adopted frames must appear in the history a caller reads');
    assert.ok(adopted.every((e: any) => typeof e.path === 'string'));
  });

  it('continues the sequence rather than overwriting frame 1', async () => {
    const dir = tempDir();
    plantFrames(dir, 3);
    const before = fs.readFileSync(path.join(dir, 'f-000001.png'));
    const recorder = startRecorder(dir);

    await waitFor(() => recorder.status().framesStored > 3, 3000, 'a new frame to be captured');
    assert.deepEqual(
      fs.readFileSync(path.join(dir, 'f-000001.png')),
      before,
      'a new capture must not land on an existing frame file'
    );
    const newest = recorder.timeline().at(-1) as any;
    assert.ok(newest.seq > 3, `the new frame must take a fresh sequence number, got ${newest.seq}`);
  });

  it('still prunes adopted frames that are older than retention', async () => {
    // Adoption must not become a leak: the reason frames were deleted on start
    // was to bound disk, and retention is what actually does that.
    const dir = tempDir();
    plantFrames(dir, 3, 600); // 10 hours old
    const recorder = new VkvmRecorder(new FakeConsolePage(movingMarkFrame(1)) as never, dir, {
      intervalMs: 50,
      retentionMinutes: 60,
      heartbeatSeconds: 3600,
      antiBlankSeconds: 0,
      antiBlankMode: 'none',
      ocrText: false,
    });
    recorders.push(recorder);
    recorder.start();

    await waitFor(() => recorder.status().framesStored >= 1, 3000, 'the first live frame');
    assert.equal(
      fs.existsSync(path.join(dir, 'f-000001.png')),
      false,
      'a frame past the retention window must still be evicted'
    );
    assert.ok(recorder.status().framesEvicted >= 1, 'and the eviction must be reported, not silent');
  });

  it('ignores files that are not frames', async () => {
    const dir = tempDir();
    plantFrames(dir, 2);
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    fs.writeFileSync(path.join(dir, 'text.jsonl'), '{"seq":1,"text":"hello"}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a frame');
    const recorder = startRecorder(dir);

    const paths = recorder
      .timeline()
      .map((e: any) => e.path)
      .filter((p: string | undefined): p is string => p !== undefined);
    assert.ok(
      paths.every((p) => p.endsWith('.png')),
      `only PNG frames may be adopted, got ${paths.join(', ')}`
    );
    assert.equal(paths.length, 2, 'state.json, text.jsonl and stray files are not frames');
  });
});
