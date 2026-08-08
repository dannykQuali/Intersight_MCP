/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';

/**
 * One recorder daemon per server, enforced by a lock file beside its frames.
 *
 * Two daemons on one server destroy each other's evidence: starting a recorder
 * clears the directory's existing PNGs. And the lock must be reclaimable,
 * because holders die routinely — MCP servers come and go with every chat and
 * fork. Observed in the wild: five recorder directories still claiming
 * `running: true` whose processes had been gone for days.
 *
 * Liveness is decided by asking the OS about the pid, not by a timeout, so a
 * busy-but-slow daemon is never robbed of its own lock.
 */
export const LOCK_FILENAME = 'recorder.lock';

export interface RecorderLock {
  pid: number;
  acquiredAt: string;
  /** Localhost port of the holder's control endpoint, once it has bound one. */
  controlPort: number | null;
}

export interface AcquireResult {
  acquired: boolean;
  heldByPid?: number;
  reason: string;
}

/** Read the current lock, or null when absent/unreadable. */
export function readLock(dir: string): RecorderLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILENAME), 'utf8'));
    if (typeof parsed?.pid !== 'number') {
      return null;
    }
    return {
      pid: parsed.pid,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : new Date(0).toISOString(),
      controlPort: typeof parsed.controlPort === 'number' ? parsed.controlPort : null,
    };
  } catch {
    return null; // missing, corrupt, or mid-write: treat as unheld
  }
}

/** Is a process with this pid running? */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take this server's recorder lock, or report who holds it.
 *
 * The holder may re-acquire to publish its control port, which it only learns
 * after binding (which happens after the lock is taken).
 */
export function acquireServerLock(
  dir: string,
  opts: { pid?: number; controlPort?: number } = {}
): AcquireResult {
  const pid = opts.pid ?? process.pid;
  fs.mkdirSync(dir, { recursive: true });
  const existing = readLock(dir);

  if (existing && existing.pid !== pid && pidAlive(existing.pid)) {
    return {
      acquired: false,
      heldByPid: existing.pid,
      reason: `held by a live recorder daemon (pid ${existing.pid})`,
    };
  }

  const takingOver = existing !== null && existing.pid !== pid;
  const lock: RecorderLock = {
    pid,
    acquiredAt: existing && existing.pid === pid ? existing.acquiredAt : new Date().toISOString(),
    controlPort: opts.controlPort ?? (existing && existing.pid === pid ? existing.controlPort : null),
  };
  // Temp + rename so a concurrent reader never sees half a lock, and RETRIED:
  // a bare rename here failed with EPERM about 1 time in 100 on Windows, which
  // showed up as a daemon randomly refusing to start (reproduced: 5 failures in
  // 500 attempts).
  const written = writeFileAtomicSync(path.join(dir, LOCK_FILENAME), JSON.stringify(lock, null, 2), {
    tempSuffix: String(pid),
  });
  if (!written) {
    return {
      acquired: false,
      reason: `could not write the lock file in ${dir} (the directory may be read-only or contended)`,
    };
  }
  return {
    acquired: true,
    reason: takingOver
      ? `previous holder (pid ${existing!.pid}) is dead, so its stale lock was taken over`
      : 'lock was free',
  };
}

/** Give up the lock. Safe to call when not held. */
export function releaseLock(dir: string): void {
  try {
    const existing = readLock(dir);
    if (existing && existing.pid !== process.pid) {
      return; // never release someone else's lock
    }
    fs.unlinkSync(path.join(dir, LOCK_FILENAME));
  } catch {
    /* already gone */
  }
}
