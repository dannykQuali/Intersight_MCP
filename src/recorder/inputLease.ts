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

import crypto from 'crypto';

/**
 * Serialises console input between clients, and blocks it while the daemon is
 * busy with a login, reset or recovery.
 *
 * Deliberately a LEASE with fail-fast refusal rather than a queue. A keystroke
 * buffered through a 90-second Tunneled vKVM reset would arrive on a screen
 * that has changed — that is how a password gets typed into a boot menu. Better
 * to refuse with a reason and let the caller decide.
 *
 * Refusals always carry a reason and a retry hint, because "no reaction" was
 * misread as "input is broken" three times in one week of field use.
 */

/** A lease dies after this long without renewal, so a vanished client cannot hold a console. */
export const LEASE_TTL_MS = 30_000;

export interface AcquireResult {
  granted: boolean;
  leaseId?: string;
  reason?: string;
  retryAfterMs?: number;
}

interface BusyState {
  what: string;
  until: number;
}

export class InputArbiter {
  private leaseId: string | null = null;
  private leaseHolder: string | null = null;
  private leaseExpiresAt = 0;
  private busyState: BusyState | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** What the daemon is busy with, or null. Self-clearing if it overran. */
  busy(): { what: string; retryAfterMs: number } | null {
    if (!this.busyState) {
      return null;
    }
    const remaining = this.busyState.until - this.now();
    if (remaining <= 0) {
      // A crashed reset must not render a console permanently unusable.
      this.busyState = null;
      return null;
    }
    return { what: this.busyState.what, retryAfterMs: remaining };
  }

  /** Mark the daemon busy for an estimated duration (login, reset, recovery). */
  setBusy(what: string, estimatedMs: number): void {
    this.busyState = { what, until: this.now() + Math.max(0, estimatedMs) };
  }

  clearBusy(): void {
    this.busyState = null;
  }

  /** The client currently allowed to send input, or null. */
  holder(): string | null {
    if (this.leaseHolder && this.leaseExpiresAt > this.now()) {
      return this.leaseHolder;
    }
    this.leaseHolder = null;
    this.leaseId = null;
    return null;
  }

  /**
   * Ask to send input. The same client re-acquiring simply renews, so a
   * multi-step interaction (press_until, a typed password) is never blocked by
   * its own lease.
   */
  acquire(clientId: string): AcquireResult {
    const busy = this.busy();
    if (busy) {
      return {
        granted: false,
        reason: `the console is busy: ${busy.what}. Input cannot be delivered until it finishes.`,
        retryAfterMs: busy.retryAfterMs,
      };
    }
    const current = this.holder();
    if (current && current !== clientId) {
      return {
        granted: false,
        reason: `another client (${current}) holds the input lease for this console`,
        retryAfterMs: Math.max(0, this.leaseExpiresAt - this.now()),
      };
    }
    if (!current) {
      this.leaseId = crypto.randomUUID();
      this.leaseHolder = clientId;
    }
    this.leaseExpiresAt = this.now() + LEASE_TTL_MS;
    return { granted: true, leaseId: this.leaseId! };
  }

  /** Release a lease. A stray or wrong id is ignored, never someone else's. */
  release(leaseId: string): void {
    if (this.leaseId && leaseId === this.leaseId) {
      this.leaseId = null;
      this.leaseHolder = null;
      this.leaseExpiresAt = 0;
    }
  }
}
