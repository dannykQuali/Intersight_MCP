/**
 * A process that used OCR must be able to exit.
 *
 * The original engine (tesseract.js) spawned a worker that held the event loop
 * open and nothing ever released it, so any short-lived process touching OCR
 * ran forever after finishing its work. It cost real time twice over: a
 * diagnostic script that had already produced its answer looked like it had
 * hung mid-OCR (its stdout never closed, so a `| tail` showed nothing at all),
 * and the same bug would have silently broken the background-waiter design —
 * the waiter would complete, never exit, and the harness notification that
 * fires on exit would never arrive.
 *
 * The current engine holds no worker, but this stays as the guard that keeps
 * any FUTURE engine change honest about process lifetime. Asserted from
 * outside, because "does this process terminate" cannot be observed from
 * within it.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'ocrThenExit.ts');

/** Run the fixture and report how it ended. */
function runFixture(idleMs: number, killAfterMs: number) {
  return new Promise<{ exited: boolean; code: number | null; stdout: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, String(idleMs)], {
      cwd: path.join(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', () => {});

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exited: false, code: null, stdout, ms: Date.now() - started });
    }, killAfterMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, stdout, ms: Date.now() - started });
    });
  });
}

describe('FrameOcr process lifetime', () => {
  it('lets a short-lived process exit on its own after OCR', async () => {
    const r = await runFixture(0, 45000);

    assert.match(r.stdout, /OCR_DONE/, 'the fixture must actually reach the OCR call');
    assert.equal(r.exited, true, `process did not exit within 45s (it used to run forever)`);
    assert.equal(r.code, 0, 'and it should exit cleanly');
  });
});
