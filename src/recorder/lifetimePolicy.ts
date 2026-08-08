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
 * When a recorder should release the console, and when its frames should go.
 *
 * These are deliberately SEPARATE clocks. Keeping a recorder alive is not a
 * neutral background cost: it holds the server's only vKVM session slot and
 * pokes the console with an anti-blank nudge every few minutes. Measured on a
 * real idle recorder — zero novelty for 6.6 hours, 100MB of frames, 110 nudges
 * — which is ongoing interference with a machine nobody was watching.
 *
 * Frames on disk, by contrast, need no process at all. So dormancy can be
 * aggressive (hours) while data expiry is generous (days): the next agent gets
 * the history it might want without anything holding a console hostage for it.
 */

/** No client contact for this long -> release the console, keep the frames. */
export const DORMANCY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Frames older than this are deleted. Long enough that a campaign finishing
 * overnight is still reviewable the next working day.
 */
export const DATA_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * A powered-off server with nothing happening is released sooner: there is no
 * console to watch, so holding one cannot pay off.
 */
export const POWERED_OFF_DORMANCY_AFTER_MS = 30 * 60 * 1000;

/**
 * How long a daemon may sit unable to open a console before it exits.
 *
 * It is not a passive wait: each retry attempts a Cisco ID login, and that path
 * locks the account after three failures. Exiting is also the better retry
 * strategy -- the next client spawns a fresh daemon on demand, with a fresh
 * browser, instead of an unattended loop nobody reads.
 */
export const DEGRADED_GIVE_UP_MS = 30 * 60 * 1000;

/** Slowest retry while degraded, so a fixed cause is picked up promptly. */
export const MAX_DEGRADED_RETRY_MS = 15 * 60 * 1000;

export interface DegradedInput {
  now: number;
  /** When the console first failed to open. Null = the console is fine. */
  degradedSince: number | null;
  lastClientContactAt: number | null;
  /** Failed attempts so far, used only to space out retries. */
  attempts?: number;
}

export interface DegradedDecision {
  giveUp: boolean;
  /** How long to wait before the next attempt. */
  retryAfterMs: number;
  reason: string;
}

/**
 * Whether to keep trying to open a console, and how soon.
 *
 * A client that is still asking keeps the daemon trying indefinitely: an agent
 * watching status while a human clears an MFA prompt is precisely the case this
 * daemon exists for, and exiting under them would be the wrong answer.
 */
export function shouldGiveUpDegraded(input: DegradedInput): DegradedDecision {
  const { now, degradedSince, lastClientContactAt, attempts = 1 } = input;
  const retryAfterMs = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_DEGRADED_RETRY_MS);

  if (degradedSince === null) {
    return { giveUp: false, retryAfterMs, reason: 'the console is not degraded' };
  }

  const degradedMs = now - degradedSince;
  const clientIdleMs = lastClientContactAt === null ? degradedMs : now - lastClientContactAt;
  if (degradedMs > DEGRADED_GIVE_UP_MS && clientIdleMs > DEGRADED_GIVE_UP_MS) {
    return {
      giveUp: true,
      retryAfterMs,
      reason: `could not open a console for ${Math.round(degradedMs / 60000)}m and no client has asked in ${Math.round(
        clientIdleMs / 60000
      )}m`,
    };
  }
  return {
    giveUp: false,
    retryAfterMs,
    reason:
      clientIdleMs <= DEGRADED_GIVE_UP_MS
        ? 'a client is still waiting for this console'
        : 'the failure is recent enough to keep retrying',
  };
}

export interface LifetimeInput {
  now: number;
  /** When an MCP client last asked this recorder for anything. Null = never. */
  lastClientContactAt: number | null;
  oldestFrameAt: number | null;
  newestFrameAt: number | null;
  /** Last time NEW content appeared, per the tile classifier. */
  lastNoveltyAt: number | null;
  serverPoweredOn: boolean;
  /** A client can pin a recorder awake for a known-long campaign. */
  explicitKeepAliveUntil: number | null;
  diskBytes: number;
  diskBudgetBytes: number;
}

export interface LifetimeDecision {
  phase: 'active' | 'dormant' | 'expired';
  /** End the vKVM session, close the tab, stop capturing and nudging. */
  releaseConsole: boolean;
  /** Delete the frames and transcript. */
  deleteData: boolean;
  reason: string;
}

export function decideLifetime(input: LifetimeInput): LifetimeDecision {
  const {
    now,
    lastClientContactAt,
    newestFrameAt,
    lastNoveltyAt,
    serverPoweredOn,
    explicitKeepAliveUntil,
    diskBytes,
    diskBudgetBytes,
  } = input;

  // Data expiry is judged on the FRAMES, not on client interest: nobody asking
  // for days is normal, and is not a reason to destroy evidence.
  const dataAge = newestFrameAt === null ? 0 : now - newestFrameAt;
  if (dataAge > DATA_EXPIRY_MS) {
    return {
      phase: 'expired',
      releaseConsole: true,
      deleteData: true,
      reason: `no frames captured for ${Math.round(dataAge / 3600000)}h, past the ${Math.round(
        DATA_EXPIRY_MS / 3600000
      )}h data-expiry window`,
    };
  }

  if (explicitKeepAliveUntil !== null && now < explicitKeepAliveUntil) {
    return {
      phase: 'active',
      releaseConsole: false,
      deleteData: false,
      reason: 'an explicit keep-alive is in force for a long-running campaign',
    };
  }

  // A never-contacted recorder has only just been spawned; the client that
  // started it has not had a chance to call yet.
  const idleMs = lastClientContactAt === null ? 0 : now - lastClientContactAt;

  // A powered-off server with no activity is released early. Still-watching
  // clients keep it alive: an agent waiting for a machine to come UP must not
  // lose its eyes at the moment it powers on.
  const quietMs = lastNoveltyAt === null ? idleMs : now - lastNoveltyAt;
  if (
    !serverPoweredOn &&
    idleMs > POWERED_OFF_DORMANCY_AFTER_MS &&
    quietMs > POWERED_OFF_DORMANCY_AFTER_MS
  ) {
    return {
      phase: 'dormant',
      releaseConsole: true,
      deleteData: overBudget(diskBytes, diskBudgetBytes),
      reason: `server is powered off and nothing has changed for ${Math.round(quietMs / 60000)}m`,
    };
  }

  if (idleMs > DORMANCY_AFTER_MS) {
    const over = overBudget(diskBytes, diskBudgetBytes);
    return {
      phase: 'dormant',
      releaseConsole: true,
      deleteData: over,
      reason: over
        ? `no client contact for ${Math.round(idleMs / 3600000)}h and disk budget exceeded`
        : `no client contact for ${Math.round(idleMs / 3600000)}h`,
    };
  }

  return {
    phase: 'active',
    releaseConsole: false,
    // Never evict the frames of a recording someone is watching: the answer
    // there is retention pruning inside the recorder, not dropping the lot.
    deleteData: false,
    reason: 'a client interacted recently',
  };
}

function overBudget(diskBytes: number, diskBudgetBytes: number): boolean {
  return diskBudgetBytes > 0 && diskBytes > diskBudgetBytes;
}
