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
 * Entry point for a recorder daemon: one process, one server's console.
 *
 * Spawned detached by an MCP server (or by hand for debugging). It outlives
 * every MCP server, which is the point — MCP servers come and go with each chat
 * and fork, and console recordings must not.
 *
 *   node build/recorder/daemonMain.js --server <moid> [--name <n>] [--type <t>]
 *                                     [--retention-minutes N] [--interval-ms N]
 *                                     [--no-ocr] [--disk-budget-mb N]
 */
import os from 'os';
import path from 'path';
import { RecorderDaemon } from './recorderDaemon.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function num(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const serverMoid = arg('server');
if (!serverMoid) {
  console.error('usage: daemonMain --server <serverMoid> [--name <serverName>] [--type <objectType>]');
  process.exit(2);
}

const recordingRoot = path.join(os.homedir(), '.intersight-mcp', 'recordings');

/**
 * The daemon authenticates with the BROWSER's cookies, never an API key, so it
 * must not depend on API-key configuration. Requiring the full MCP config made
 * a detached daemon die on startup with "INTERSIGHT_API_KEY_ID is required"
 * whenever it was spawned without those variables in its environment.
 */
const baseUrl = arg('base-url') ?? process.env.INTERSIGHT_BASE_URL ?? 'https://intersight.com/api/v1';
const daemon = new RecorderDaemon(
  {
    serverMoid,
    serverName: arg('name'),
    objectType: arg('type'),
    recording: {
      retentionMinutes: num('retention-minutes'),
      intervalMs: num('interval-ms'),
      heartbeatSeconds: num('heartbeat-seconds'),
      maxFrames: num('max-frames'),
      antiBlankSeconds: num('anti-blank-seconds'),
      antiBlankMode: arg('anti-blank-mode') as 'mouse' | 'key' | 'none' | undefined,
      ocrText: flag('no-ocr') ? false : undefined,
    },
    diskBudgetBytes: num('disk-budget-mb') ? num('disk-budget-mb')! * 1024 * 1024 : undefined,
    onStopped: () => process.exit(0),
  },
  baseUrl,
  recordingRoot
);

// The log file is appended to across runs, so mark where each one begins.
console.error(
  `${new Date().toISOString()} === recorder daemon starting for ${serverMoid} (pid ${process.pid}, node ${
    process.version
  }) ===`
);

const started = await daemon.start();
// The spawner reads this line to learn the control port, then stops caring.
console.log(JSON.stringify(started));
if (!started.started) {
  process.exit(3);
}
