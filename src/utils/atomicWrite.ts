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

/**
 * Write a file that other processes read concurrently: temp file, then rename.
 *
 * A reader must see either the old contents or the new ones, never half a file.
 * The subtlety is the rename: Windows refuses to replace a file that any other
 * handle has open, and `readFileSync` holds one without FILE_SHARE_DELETE. The
 * handle lives for microseconds, but that is enough — measured here, roughly 1
 * rename in 100 fails with EPERM, and it failed on both files this project
 * shares between processes:
 *
 * - `state.json`, where a frozen file reads exactly like an idle console, which
 *   is the thing a stall alarm fires on.
 * - `recorder.lock`, where a lost write means a daemon that cannot start — or,
 *   worse, one that is alive but never published its control port, so no client
 *   can find it.
 *
 * A short backoff clears the contention. Failure is REPORTED, never thrown: the
 * callers have real work to keep doing.
 */
export function writeFileAtomicSync(
  target: string,
  contents: string,
  opts: {
    /** Injectable so the retry path can be tested without provoking the OS. */
    rename?: (from: string, to: string) => void;
    /** Distinguishes concurrent writers' temp files. Defaults to the pid. */
    tempSuffix?: string;
  } = {}
): boolean {
  const rename = opts.rename ?? fs.renameSync;
  const dir = path.dirname(target);
  // Per-writer temp name: two writers sharing one would truncate each other's
  // half-written file and both could end up publishing nothing.
  const tmp = path.join(dir, `.${path.basename(target)}.${opts.tempSuffix ?? process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, contents);
  } catch {
    return false;
  }
  for (const waitMs of RENAME_BACKOFF_MS) {
    try {
      rename(tmp, target);
      return true;
    } catch {
      if (waitMs > 0) {
        sleepSync(waitMs);
      }
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* nothing to clean up */
  }
  return false;
}

/** Immediate retry, then ~31ms of backoff in total. Only paid under contention. */
const RENAME_BACKOFF_MS = [0, 1, 2, 4, 8, 16];

/**
 * Block this thread briefly. Used only on the contended rename path, where the
 * alternative is silently losing the write.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: fall through and just retry immediately */
  }
}
