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

/** Written into each recorder's frame directory. */
export const STATE_FILENAME = 'state.json';

/**
 * How long without an update before a state file is assumed abandoned.
 *
 * Generous against the recorder's write cadence (every stored frame, and at
 * least every heartbeat — 60s by default) so a busy-but-healthy recorder is
 * never mistaken for a dead one.
 */
export const STALE_AFTER_MS = 180000;

/** State as read back, with the freshness/ownership facts a reader needs. */
export interface RecorderStateRead extends Record<string, unknown> {
  pid: number;
  updatedAt: string;
  ageMs: number;
  stale: boolean;
  ownedByThisProcess: boolean;
  consoleLive: boolean;
}

/**
 * Publish a recorder's state next to its frames, so any other process can read
 * it.
 *
 * Recorder state used to live only in the MCP server's memory. A second server
 * process could see the frames on disk but had no way to ask what the recorder
 * made of them — which meant a live campaign's `wakes` / `recoveries` counters
 * were unreachable from anywhere else, and a background watcher could not exist
 * at all. The frames directory is already shared between processes, so the
 * status goes there too.
 *
 * Written temp-then-rename: a reader must see either the previous state or the
 * new one, never a half-written file.
 */
export function writeRecorderState(dir: string, state: Record<string, unknown>): boolean {
  const payload = JSON.stringify({ ...state, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2);
  // Retried temp+rename: a watcher polling this file at the cadence the recorder
  // writes it collides regularly (measured: ~1 write in 300 failed). Publishing
  // must never break recording, so the caller only learns that it failed - and a
  // state file frozen at an old `lastNoveltyAt` looks exactly like an idle
  // console, which is precisely what a stall trigger fires on.
  return writeFileAtomicSync(path.join(dir, STATE_FILENAME), payload);
}

/**
 * Read a recorder's published state, or null if there is none / it is unusable.
 *
 * Never throws: the file may be missing, truncated, or being rewritten by
 * another process at this instant.
 */
export function readRecorderState(dir: string, now = Date.now()): RecorderStateRead | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, STATE_FILENAME), 'utf8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // half-written or corrupt: treat as absent
  }
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
  const at = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(at)) {
    return null;
  }
  const ageMs = Math.max(0, now - at);
  const stale = ageMs > STALE_AFTER_MS;
  return {
    ...parsed,
    pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
    updatedAt: updatedAt!,
    ageMs,
    stale,
    ownedByThisProcess: parsed.pid === process.pid,
    // A process that stopped updating cannot vouch for the console any more,
    // whatever its last write claimed.
    consoleLive: stale ? false : parsed.consoleLive === true,
  };
}
