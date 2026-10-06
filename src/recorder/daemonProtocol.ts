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
 * How an MCP server and the account daemon find and recognise each other.
 *
 * The daemon's listening port IS the lock. Only one process can listen on a
 * given loopback address and port, on every OS, and the OS takes the port back
 * the moment that process dies — even on a crash. So there is no lock file to go
 * stale, no pid to be reused, and nothing a client could delete: the per-server
 * lock files this replaced failed on all three counts, and a client deleting a
 * live daemon's lock is how one server ended up with three daemons logging in
 * against each other.
 *
 * A fixed number can collide with an unrelated program, so every client says
 * hello first and only trusts an answer that names this service.
 */

/** What the daemon calls itself in its hello, so a stranger on the port is recognisable. */
export const DAEMON_SERVICE = 'intersight-mcp-daemon';

/** Bumped when a client and daemon can no longer understand each other. */
export const DAEMON_PROTOCOL = 1;

/**
 * Below 32768 on purpose: that is where Linux's ephemeral range starts (macOS and
 * Windows start at 49152), so an outgoing connection's OS-picked local port can
 * never be squatting on it.
 */
export const DEFAULT_DAEMON_PORT = 29417;

/** The port for this user's daemon: INTERSIGHT_DAEMON_PORT, or the default. */
export function daemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INTERSIGHT_DAEMON_PORT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DAEMON_PORT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`INTERSIGHT_DAEMON_PORT must be a TCP port number (1-65535), got "${raw}"`);
  }
  return n;
}

export interface DaemonHello {
  service: string;
  protocol: number;
  pid: number;
  port: number;
  startedAt: string;
}

export type ProbeResult =
  | { state: 'ours'; hello: DaemonHello }
  | { state: 'absent' }
  | { state: 'foreign'; detail: string }
  | { state: 'unresponsive'; detail: string };

/**
 * Ask whatever is on the port who it is.
 *
 * 'absent' is only ever a REFUSED connection — nothing is listening, so a daemon
 * may be started. Anything else that fails means something holds the port, and
 * starting a daemon could not bind it anyway; the caller reports it instead.
 */
export async function probeDaemon(port: number, timeoutMs = 5000): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { state: 'absent' };
    }
    return {
      state: 'unresponsive',
      detail: (error as Error)?.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : describe(error),
    };
  }
  const body = (await res.json().catch(() => null)) as any;
  const hello = body?.result;
  if (body?.ok === true && hello?.service === DAEMON_SERVICE) {
    return { state: 'ours', hello };
  }
  return { state: 'foreign', detail: `HTTP ${res.status}, not a ${DAEMON_SERVICE} hello` };
}

/** Plain-language explanation of a port held by something that is not our daemon. */
export function foreignPortMessage(port: number, detail: string): string {
  return (
    `Port ${port} on 127.0.0.1 is in use by another program (${detail}), so the Intersight MCP daemon cannot use it. ` +
    `Set INTERSIGHT_DAEMON_PORT to a free port in the environment of every MCP server (they must all agree), or stop that program.`
  );
}

function isConnectionRefused(error: unknown): boolean {
  const codes = [(error as any)?.code, (error as any)?.cause?.code];
  // An AggregateError carries one error per address family tried.
  for (const inner of (error as any)?.cause?.errors ?? []) {
    codes.push(inner?.code);
  }
  return codes.includes('ECONNREFUSED');
}

function describe(error: unknown): string {
  const cause = (error as any)?.cause;
  return String(cause?.code ?? cause?.message ?? (error as Error)?.message ?? error).slice(0, 200);
}
