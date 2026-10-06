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

/**
 * Entry point for the account daemon: one process for the browser, the login
 * and every console recorder.
 *
 * Spawned detached by an MCP server (or by hand for debugging). It outlives
 * every MCP server, which is the point — MCP servers come and go with each chat
 * and fork, and console recordings must not.
 *
 *   node build/recorder/daemonMain.js [--port N] [--base-url URL]
 *
 * The port defaults to INTERSIGHT_DAEMON_PORT, else the built-in default. A
 * daemon that finds the port taken exits with status 3: if the holder is our
 * daemon, it is already doing the job.
 */
import os from 'os';
import path from 'path';
import { AccountDaemon } from './accountDaemon.js';
import { daemonPort } from './daemonProtocol.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const stamp = () => new Date().toISOString();

// Builds before the account daemon spawned one daemon PER SERVER with
// `--server <moid>`. An MCP server still running that code in memory can spawn
// this file; it would then wait for a per-server lock file that never appears.
// Saying why here puts the answer in the log that MCP server shows its caller.
if (process.argv.includes('--server')) {
  console.error(
    `${stamp()} This MCP server is running an outdated build that starts one recorder daemon per server. ` +
      'Recorders now live in a single account daemon. Restart this MCP server (reload its window or reconnect it) to pick up the new code.'
  );
  process.exit(3);
}

const port = Number(arg('port') ?? daemonPort());
/**
 * The daemon authenticates with the BROWSER's cookies, never an API key, so it
 * must not depend on API-key configuration. Requiring the full MCP config made
 * a detached daemon die on startup with "INTERSIGHT_API_KEY_ID is required"
 * whenever it was spawned without those variables in its environment.
 */
const baseUrl = arg('base-url') ?? process.env.INTERSIGHT_BASE_URL ?? 'https://intersight.com/api/v1';
const recordingRoot = path.join(os.homedir(), '.intersight-mcp', 'recordings');

// One process now holds every console, so one server's bug must not end them
// all. A stray rejection is logged, not fatal.
process.on('unhandledRejection', (reason) => {
  console.error(`${stamp()} [daemon pid ${process.pid}] unhandled rejection (kept running): ${String((reason as Error)?.stack ?? reason).slice(0, 1000)}`);
});

// The log file is appended to across runs, so mark where each one begins.
console.error(`${stamp()} === account daemon starting (pid ${process.pid}, node ${process.version}, port ${port}) ===`);

const daemon = new AccountDaemon({ port, baseUrl, recordingRoot, onExit: () => process.exit(0) });
const started = await daemon.start();
console.error(`${stamp()} [daemon pid ${process.pid}] ${JSON.stringify(started)}`);
if (!started.started) {
  process.exit(3);
}
process.on('SIGTERM', () => void daemon.shutdown('SIGTERM'));
process.on('SIGINT', () => void daemon.shutdown('SIGINT'));
