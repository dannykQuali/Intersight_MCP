/**
 * A recorder daemon that is told to stop must actually exit.
 *
 * It did not. `stop` was registered as an INPUT action, so it needed the input
 * lease — and a single failed keystroke from another client held that lease for
 * 30 seconds, during which every stop was refused with 409, including a forced
 * one. The daemon kept its console, kept its port, and could only be ended by
 * pid: the unkillable recorder this architecture exists to prevent, arrived at
 * from the opposite direction. It surfaced as a test file that passed every
 * assertion and then hung for 88 seconds.
 *
 * Asserted from OUTSIDE, because whether a process terminates cannot be observed
 * from within it. This also guards the shutdown path's other exit hazards: a
 * lingering listening socket, an un-unref'd timer, or a teardown step that
 * blocks forever.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'daemonThenExit.ts');

function runFixture(killAfterMs: number) {
  return new Promise<{ exited: boolean; code: number | null; stdout: string; stderr: string; ms: number }>(
    (resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
        cwd: path.join(here, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stderr += String(d)));

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ exited: false, code: null, stdout, stderr, ms: Date.now() - started });
      }, killAfterMs);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ exited: true, code, stdout, stderr, ms: Date.now() - started });
      });
    }
  );
}

describe('recorder daemon process lifetime', () => {
  it('exits on its own after a client stops it', async () => {
    const r = await runFixture(30000);

    assert.match(r.stdout, /DAEMON_STOPPED=true/, 'the fixture must actually reach the shutdown');
    assert.equal(
      r.exited,
      true,
      `the daemon process did not exit within 30s — a stopped recorder must not outlive its shutdown.\nstderr: ${r.stderr.slice(
        -600
      )}`
    );
    assert.equal(r.code, 0, 'and it should exit cleanly');
  });
});
