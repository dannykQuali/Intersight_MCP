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
 * Retire the per-server recorder daemons that builds before the account daemon
 * started.
 *
 * Each of those carries its own login and session keepalive, so one left running
 * would keep driving Cisco ID logins in the shared browser against the account
 * daemon's — the very collision ("OIDC state parameter is invalid") that the
 * account daemon exists to end. Dormant ones are no exception: they released
 * their consoles but never stopped logging in.
 *
 * They are found by the `recorder.lock` each left beside its frames, and asked
 * to stop over their own control port with force (the peer-etiquette check would
 * otherwise refuse: the old MCP servers that used them may still be around). A
 * stopped legacy daemon keeps its frames and removes its own lock. A lock whose
 * process is gone is simply tidied away.
 */
const LEGACY_LOCK = 'recorder.lock';

export interface LegacyCleanup {
  asked: Array<{ serverMoid: string; pid: number }>;
  tidied: string[];
  failed: Array<{ serverMoid: string; pid: number; error: string }>;
}

export async function stopLegacyDaemons(
  recordingRoot: string,
  log: (message: string) => void,
  timeoutMs = 5000
): Promise<LegacyCleanup> {
  const out: LegacyCleanup = { asked: [], tidied: [], failed: [] };
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(recordingRoot);
  } catch {
    return out;
  }
  for (const serverMoid of entries) {
    const lockPath = path.join(recordingRoot, serverMoid, LEGACY_LOCK);
    const lock = readLegacyLock(lockPath);
    if (!lock) {
      continue;
    }
    if (!pidAlive(lock.pid)) {
      try {
        fs.unlinkSync(lockPath);
        out.tidied.push(serverMoid);
      } catch {
        /* already gone */
      }
      continue;
    }
    if (!lock.controlPort) {
      out.failed.push({ serverMoid, pid: lock.pid, error: 'its lock names no control port' });
      log(`legacy recorder daemon pid ${lock.pid} for ${serverMoid} cannot be reached (no control port); stop it by pid`);
      continue;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${lock.controlPort}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, clientId: 'account-daemon-migration' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      out.asked.push({ serverMoid, pid: lock.pid });
      log(`asked legacy per-server recorder daemon pid ${lock.pid} (${serverMoid}) to stop; its frames are kept`);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200);
      out.failed.push({ serverMoid, pid: lock.pid, error: message });
      log(`could not stop legacy recorder daemon pid ${lock.pid} (${serverMoid}): ${message}; stop it by pid`);
    }
  }
  return out;
}

function readLegacyLock(file: string): { pid: number; controlPort: number | null } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.pid !== 'number') {
      return null;
    }
    return { pid: parsed.pid, controlPort: typeof parsed.controlPort === 'number' ? parsed.controlPort : null };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
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
