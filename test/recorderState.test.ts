/**
 * Recorder state must be readable from OTHER processes.
 *
 * Recorder state lived only in the MCP server's memory, so a second server
 * process — or any background watcher — could see the frames on disk but not
 * what the recorder thought about them. This bit for real: asked for a
 * campaign's `wakes` counter, the only honest answer was "another process has
 * it and I cannot reach it", and the highest-severity question in a field
 * report went unanswered because of it.
 *
 * The frames directory is already the shared medium between processes, so the
 * state goes next to them.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRecorderState,
  writeRecorderState,
  STATE_FILENAME,
  STALE_AFTER_MS,
} from '../src/services/recorderState.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-state-test-'));
  dirs.push(d);
  return d;
}

const SAMPLE = {
  serverMoid: 'abc123',
  state: 'recording',
  running: true,
  consoleLive: true,
  framesStored: 42,
  wakes: 3,
};

describe('recorder state sidecar', () => {
  it('round-trips through the filesystem', () => {
    const dir = tempDir();
    writeRecorderState(dir, SAMPLE);

    const read = readRecorderState(dir);
    assert.equal(read?.serverMoid, 'abc123');
    assert.equal(read?.wakes, 3, 'the counter another process could not see');
    assert.equal(read?.pid, process.pid, 'the writer identifies itself');
    assert.ok(read?.updatedAt, 'and stamps when it last spoke');
  });

  it('reports nothing rather than throwing when there is no state', () => {
    assert.equal(readRecorderState(tempDir()), null);
  });

  it('survives a corrupt or half-written state file', () => {
    // A reader must never crash on a file another process is mid-write on.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, STATE_FILENAME), '{"state":"recor');
    assert.equal(readRecorderState(dir), null);
  });

  it('keeps updating while a reader is polling the same file', () => {
    // Regression: on Windows a replace fails while another handle has the file
    // open (readFileSync holds one without FILE_SHARE_DELETE), and the failure
    // was swallowed - so the file silently froze at an old value. Reproduced at
    // roughly 1 write in 300, i.e. every few minutes for a watcher polling at
    // 1Hz. A frozen `lastChangeAt` reads as an idle console, which is exactly
    // what a stall trigger fires on, so this must not fail quietly.
    const dir = tempDir();
    for (let i = 0; i < 200; i++) {
      const ok = writeRecorderState(dir, { ...SAMPLE, framesStored: i });
      assert.equal(ok, true, `write ${i} reported success`);
      // Interleaved read: this is what opens the competing handle.
      const read = readRecorderState(dir);
      assert.equal(read?.framesStored, i, `read ${i} back intact`);
    }
    const strays = fs.readdirSync(dir).filter((f) => f !== STATE_FILENAME);
    assert.deepEqual(strays, [], 'no temp files left lying around');
  });

  it('reports failure rather than silently freezing the file', () => {
    // A directory that cannot be written to: the caller must be told, because a
    // stale-but-plausible state file is worse than a missing one.
    const dir = path.join(tempDir(), 'nested');
    fs.mkdirSync(dir);
    fs.rmSync(dir, { recursive: true });
    // Point at a path whose parent is a FILE, so mkdir/write cannot succeed.
    const blocked = path.join(dir, 'x');
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory');
    assert.equal(writeRecorderState(path.join(blocked, 'sub'), SAMPLE), false);
  });

  it('flags state whose writer has gone quiet', () => {
    const dir = tempDir();
    writeRecorderState(dir, SAMPLE);
    const fresh = readRecorderState(dir)!;
    assert.equal(fresh.stale, false);
    assert.ok(fresh.ageMs < STALE_AFTER_MS);

    // Backdate it: a crashed or exited process leaves its last state behind,
    // and a reader must not report a dead recorder as live.
    const file = path.join(dir, STATE_FILENAME);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.updatedAt = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(parsed));

    const old = readRecorderState(dir)!;
    assert.equal(old.stale, true, 'stale state must be labelled, not trusted');
    assert.equal(old.consoleLive, false, 'and must not claim the console is live');
  });

  it('says whether the state belongs to this process or another one', () => {
    const dir = tempDir();
    writeRecorderState(dir, SAMPLE);
    assert.equal(readRecorderState(dir)?.ownedByThisProcess, true);

    const file = path.join(dir, STATE_FILENAME);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.pid = process.pid + 1;
    fs.writeFileSync(file, JSON.stringify(parsed));
    assert.equal(readRecorderState(dir)?.ownedByThisProcess, false);
  });
});
