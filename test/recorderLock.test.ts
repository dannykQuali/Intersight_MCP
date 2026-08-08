/**
 * Exactly one recorder daemon per server, with takeover when the holder dies.
 *
 * Without this, two daemons on one server destroy each other: `start()` deletes
 * the existing PNGs, so the second writer wipes the first's evidence. And the
 * lock must survive the holder dying — which happens routinely, since MCP
 * servers come and go with every chat and fork. Observed in the wild: five
 * recorder directories whose state still claimed `running: true` while their
 * processes had been gone for days.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireServerLock, readLock, releaseLock } from '../src/recorder/recorderLock.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-lock-test-'));
  dirs.push(d);
  return d;
}

/** A pid that is certainly not running. */
const DEAD_PID = 999_999_997;

describe('recorder lock', () => {
  it('is acquired when nobody holds it', () => {
    const dir = tempDir();
    const r = acquireServerLock(dir);
    assert.equal(r.acquired, true);
    assert.equal(readLock(dir)?.pid, process.pid);
  });

  it('is refused while a LIVE holder has it', () => {
    const dir = tempDir();
    assert.equal(acquireServerLock(dir).acquired, true);
    // Same process asking again as if it were another daemon: still held.
    const second = acquireServerLock(dir, { pid: DEAD_PID });
    assert.equal(second.acquired, false);
    assert.equal(second.heldByPid, process.pid);
    assert.match(second.reason, /held/i);
  });

  it('is taken over when the holder process is gone', () => {
    const dir = tempDir();
    // Plant a lock from a process that cannot exist.
    fs.writeFileSync(
      path.join(dir, 'recorder.lock'),
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString(), controlPort: 1234 })
    );
    const r = acquireServerLock(dir);
    assert.equal(r.acquired, true, 'a dead holder must not block forever');
    assert.match(r.reason, /dead|stale/i);
    assert.equal(readLock(dir)?.pid, process.pid);
  });

  it('survives a corrupt lock file', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'recorder.lock'), '{ this is not json');
    assert.equal(acquireServerLock(dir).acquired, true);
  });

  it('releases so the next daemon can take it', () => {
    const dir = tempDir();
    acquireServerLock(dir);
    releaseLock(dir);
    assert.equal(readLock(dir), null);
    assert.equal(acquireServerLock(dir).acquired, true);
  });

  it('records the control port so clients can find the holder', () => {
    const dir = tempDir();
    acquireServerLock(dir, { controlPort: 45678 });
    assert.equal(readLock(dir)?.controlPort, 45678);
  });

  it('lets the holder update its own port without losing the lock', () => {
    // The port is only known after the control server binds, which happens
    // after the lock is taken.
    const dir = tempDir();
    acquireServerLock(dir);
    const r = acquireServerLock(dir, { pid: process.pid, controlPort: 5555 });
    assert.equal(r.acquired, true, 'the holder may re-acquire to publish its port');
    assert.equal(readLock(dir)?.controlPort, 5555);
  });
});
