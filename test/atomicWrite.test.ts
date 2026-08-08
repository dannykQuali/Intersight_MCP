/**
 * Temp-then-rename is how every file two processes share gets written here, and
 * on Windows the rename itself is the unreliable step: it fails with EPERM
 * whenever another handle has the target open, even for microseconds.
 *
 * Measured on this machine: ~1 in 100 renames of a freshly written file fails.
 * That is not a cosmetic loss. The two callers are a recorder's `state.json`
 * (frozen state reads exactly like an idle console — what a stall alarm fires
 * on) and a daemon's `recorder.lock` (a failed write means a daemon that cannot
 * start, or one that is alive but has no discoverable control port).
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync } from '../src/utils/atomicWrite.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  dirs.push(dir);
  return dir;
}

describe('atomic file writes', () => {
  it('writes a file that did not exist', () => {
    const target = path.join(tempDir(), 'a.json');
    assert.equal(writeFileAtomicSync(target, '{"a":1}'), true);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
  });

  it('replaces existing content in full, never appending', () => {
    const target = path.join(tempDir(), 'b.json');
    writeFileAtomicSync(target, 'first-and-longer');
    writeFileAtomicSync(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  });

  it('retries a rename that fails transiently, as Windows does under contention', () => {
    const target = path.join(tempDir(), 'c.json');
    let attempts = 0;
    const ok = writeFileAtomicSync(target, 'payload', {
      rename: (from, to) => {
        if (++attempts < 3) {
          const error: NodeJS.ErrnoException = new Error('EPERM: operation not permitted, rename');
          error.code = 'EPERM';
          throw error;
        }
        fs.renameSync(from, to);
      },
    });
    assert.equal(ok, true, 'a transient EPERM must not lose the write');
    assert.equal(attempts, 3);
    assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
  });

  it('gives up after the backoff and reports failure instead of throwing', () => {
    // The callers must keep working when publishing fails: a recorder keeps
    // recording, and a daemon reports why it could not take the lock.
    const target = path.join(tempDir(), 'd.json');
    let attempts = 0;
    const ok = writeFileAtomicSync(target, 'payload', {
      rename: () => {
        attempts++;
        throw new Error('EPERM: operation not permitted, rename');
      },
    });
    assert.equal(ok, false);
    assert.ok(attempts > 1, `must have retried, saw ${attempts} attempt(s)`);
  });

  it('leaves no temp files behind when it gives up', () => {
    // Otherwise a recorder directory accumulates junk beside its frames on every
    // contended write, forever.
    const dir = tempDir();
    writeFileAtomicSync(path.join(dir, 'e.json'), 'payload', {
      rename: () => {
        throw new Error('EPERM');
      },
    });
    assert.deepEqual(fs.readdirSync(dir), [], 'the temp file must be cleaned up');
  });

  it('does not collide when two writers target the same file', () => {
    // Concurrent writers must not share a temp name, or one truncates the
    // other's half-written file and both can end up publishing nothing.
    const dir = tempDir();
    const target = path.join(dir, 'f.json');
    const seen = new Set<string>();
    for (const id of ['writer-1', 'writer-2']) {
      writeFileAtomicSync(target, id, {
        rename: (from, to) => {
          seen.add(path.basename(from));
          fs.renameSync(from, to);
        },
        tempSuffix: id,
      });
    }
    assert.equal(seen.size, 2, `each writer needs its own temp file, saw ${[...seen].join(', ')}`);
  });

  it('survives a directory that does not exist yet', () => {
    const target = path.join(tempDir(), 'nested', 'deeper', 'g.json');
    assert.equal(writeFileAtomicSync(target, 'payload'), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
  });

  it('writes reliably many times over, which the bare rename did not', () => {
    // The regression this exists for: 500 writes of a fresh file produced ~5
    // EPERM failures with a single un-retried rename.
    const dir = tempDir();
    let failures = 0;
    for (let i = 0; i < 300; i++) {
      const target = path.join(dir, `run-${i}.json`);
      fs.writeFileSync(target, 'stale-content');
      if (!writeFileAtomicSync(target, `payload-${i}`)) {
        failures++;
      }
    }
    assert.equal(failures, 0, `${failures} of 300 atomic writes failed`);
  });
});
