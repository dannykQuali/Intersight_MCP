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

import http from 'http';
import { AddressInfo } from 'net';
import { InputArbiter } from './inputLease.js';

/**
 * The daemon's control endpoint: how MCP servers ask it to do things.
 *
 * Frames and status stay on the filesystem, where readers need no protocol at
 * all. Only ACTIONS come through here, because they need request/response
 * semantics that files do badly (write a command file, then poll for a result?).
 *
 * Bound to 127.0.0.1 on port 0 — the OS picks a free port, which is then
 * published in the lock file for clients to discover, the same pattern
 * Chromium's DevToolsActivePort uses.
 */

/**
 * Grace given to in-flight requests when closing, before their sockets are cut.
 * Short: a control action is milliseconds of work, and never exiting is worse.
 */
const CLOSE_GRACE_MS = 250;

/** Absolute cap on waiting for the socket layer during teardown. */
const CLOSE_HARD_MS = 2000;

/** One action the daemon knows how to perform. */
export type ControlHandler = (payload: any) => Promise<unknown>;

export interface ControlServerOptions {
  /** Actions that MUTATE the console and therefore need the input lease. */
  inputActions: Record<string, ControlHandler>;
  /** Actions that only read, and are always allowed. */
  readActions: Record<string, ControlHandler>;
  arbiter: InputArbiter;
  /** Called on every request so the daemon can track client interest. */
  onClientContact?: (clientId: string) => void;
}

export class ControlServer {
  private server: http.Server | null = null;
  private boundPort: number | null = null;

  constructor(private readonly opts: ControlServerOptions) {}

  port(): number | null {
    return this.boundPort;
  }

  async listen(): Promise<number> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only: this is an IPC channel, not a network service.
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        timers.forEach((t) => clearTimeout(t));
        resolve();
      };
      // Resolve on the REAL close, so the caller knows the listening handle is
      // gone rather than merely requested to go.
      server.close(finish);
      // `close()` stops accepting but WAITS for open connections, and an MCP
      // client's fetch keeps its socket pooled after the response — so the
      // listening handle outlives the shutdown until a keep-alive timeout
      // expires on one side or the other (~5s). A daemon that has already
      // released its console should not spend that time still running, and its
      // exit code should not depend on a peer's socket pool.
      server.closeIdleConnections?.();
      // Anything still connected gets a moment to finish, then goes: failing to
      // exit is worse than cutting one read short.
      timers.push(setTimeout(() => server.closeAllConnections?.(), CLOSE_GRACE_MS));
      // Last resort, so teardown can never block on the socket layer at all.
      timers.push(setTimeout(finish, CLOSE_HARD_MS));
      timers.forEach((t) => t.unref?.());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      const action = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
      const payload = await readJsonBody(req);
      const clientId = String(payload?.clientId ?? 'unknown-client');
      this.opts.onClientContact?.(clientId);

      const readHandler = this.opts.readActions[action];
      if (readHandler) {
        return send(200, { ok: true, result: await readHandler(payload) });
      }

      const inputHandler = this.opts.inputActions[action];
      if (!inputHandler) {
        return send(404, { ok: false, error: `unknown action "${action}"` });
      }

      // Every console-mutating action must hold the lease. Refusals carry a
      // reason and a retry hint rather than looking like silence.
      const lease = this.opts.arbiter.acquire(clientId);
      if (!lease.granted) {
        return send(409, {
          ok: false,
          error: lease.reason,
          retryAfterMs: lease.retryAfterMs,
          busy: this.opts.arbiter.busy(),
        });
      }
      return send(200, { ok: true, result: await inputHandler(payload) });
    } catch (error) {
      send(500, { ok: false, error: (error as Error).message?.slice(0, 400) ?? String(error) });
    }
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // A control message is tiny; refuse anything that looks like an upload.
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error('control payload too large');
    }
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
