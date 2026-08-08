/**
 * A recorder's PROCESS lifetime and its DATA lifetime are separate questions.
 *
 * Keeping a recorder "alive just in case" is not free: it holds the server's
 * only vKVM session slot and pokes the console with an anti-blank nudge every
 * few minutes. Measured on a real idle recorder: zero novelty for 6.6 hours,
 * 100MB of frames, 110 nudges sent — ongoing interference with a machine nobody
 * was watching.
 *
 * So a recorder goes DORMANT quickly (releasing the console but keeping every
 * frame) and its DATA expires slowly. Frames on disk need no process to
 * survive, which is what makes aggressive dormancy safe.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  decideLifetime,
  shouldGiveUpDegraded,
  DORMANCY_AFTER_MS,
  DATA_EXPIRY_MS,
  DEGRADED_GIVE_UP_MS,
  type LifetimeInput,
} from '../src/recorder/lifetimePolicy.js';

const NOW = 2_000_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An actively-used recorder: an agent asked for something a minute ago. */
function active(overrides: Partial<LifetimeInput> = {}): LifetimeInput {
  return {
    now: NOW,
    lastClientContactAt: NOW - MIN,
    oldestFrameAt: NOW - HOUR,
    newestFrameAt: NOW - 1000,
    lastNoveltyAt: NOW - 5 * MIN,
    serverPoweredOn: true,
    explicitKeepAliveUntil: null,
    diskBytes: 10_000_000,
    diskBudgetBytes: 2_000_000_000,
    ...overrides,
  };
}

describe('decideLifetime', () => {
  it('keeps capturing while a client is interacting', () => {
    const d = decideLifetime(active());
    assert.equal(d.phase, 'active');
    assert.equal(d.releaseConsole, false);
    assert.equal(d.deleteData, false);
  });

  it('goes dormant after the idle window and RELEASES the console', () => {
    const d = decideLifetime(active({ lastClientContactAt: NOW - DORMANCY_AFTER_MS - MIN }));
    assert.equal(d.phase, 'dormant');
    assert.equal(d.releaseConsole, true, 'a dormant recorder must stop holding the session slot');
    assert.equal(d.deleteData, false, 'frames survive dormancy — that is the whole point');
    assert.match(d.reason, /no client/i);
  });

  it('does not go dormant one minute early', () => {
    const d = decideLifetime(active({ lastClientContactAt: NOW - DORMANCY_AFTER_MS + MIN }));
    assert.equal(d.phase, 'active');
  });

  it('goes dormant early when the server is powered off and nothing is happening', () => {
    // Nothing to watch, so there is no case for holding the console.
    const d = decideLifetime(
      active({ serverPoweredOn: false, lastNoveltyAt: NOW - 2 * HOUR, lastClientContactAt: NOW - 2 * HOUR })
    );
    assert.equal(d.phase, 'dormant');
    assert.match(d.reason, /powered off/i);
  });

  it('stays active on a powered-off server while a client is still watching', () => {
    // An agent waiting for a machine to be powered ON must not lose its eyes.
    const d = decideLifetime(active({ serverPoweredOn: false, lastClientContactAt: NOW - MIN }));
    assert.equal(d.phase, 'active');
  });

  it('honours an explicit keep-alive for a known long campaign', () => {
    const d = decideLifetime(
      active({
        lastClientContactAt: NOW - 3 * DORMANCY_AFTER_MS,
        explicitKeepAliveUntil: NOW + 10 * HOUR,
      })
    );
    assert.equal(d.phase, 'active');
    assert.match(d.reason, /keep-alive/i);
  });

  it('expires DATA on a much longer clock than the process', () => {
    const d = decideLifetime(
      active({
        lastClientContactAt: NOW - DATA_EXPIRY_MS - HOUR,
        newestFrameAt: NOW - DATA_EXPIRY_MS - HOUR,
        oldestFrameAt: NOW - DATA_EXPIRY_MS - 2 * HOUR,
      })
    );
    assert.equal(d.phase, 'expired');
    assert.equal(d.deleteData, true);
    assert.ok(DATA_EXPIRY_MS > DORMANCY_AFTER_MS * 10, 'data must outlive the process by a wide margin');
  });

  it('keeps data that is still fresh even when long dormant', () => {
    // Dormant for days is fine; the frames are what the next agent may want.
    const d = decideLifetime(
      active({ lastClientContactAt: NOW - 2 * DATA_EXPIRY_MS, newestFrameAt: NOW - 2 * HOUR })
    );
    assert.equal(d.deleteData, false, 'recent frames survive however long nobody asked');
    assert.equal(d.phase, 'dormant');
  });

  it('evicts dormant data when the disk budget is exceeded', () => {
    const d = decideLifetime(
      active({
        lastClientContactAt: NOW - DORMANCY_AFTER_MS - MIN,
        diskBytes: 3_000_000_000,
        diskBudgetBytes: 2_000_000_000,
      })
    );
    assert.equal(d.deleteData, true);
    assert.match(d.reason, /disk/i);
  });

  it('never evicts an ACTIVE recorder for disk, only dormant data', () => {
    // Deleting the frames of a recording someone is watching is never right;
    // the answer there is to prune within retention, not to drop the recorder.
    const d = decideLifetime(active({ diskBytes: 3_000_000_000, diskBudgetBytes: 2_000_000_000 }));
    assert.equal(d.phase, 'active');
    assert.equal(d.deleteData, false);
  });

  it('treats a never-contacted recorder as contacted at start', () => {
    // A freshly spawned daemon has had no client call yet; it must not be
    // dormant on its first tick.
    const d = decideLifetime(active({ lastClientContactAt: null }));
    assert.equal(d.phase, 'active');
  });
});

/**
 * A daemon that can never open a console is not harmless: it retries a Cisco ID
 * login on a schedule, and the SSO path locks the account out after three
 * failures. So "keep retrying forever" is the wrong default -- it must give up
 * and let the next client spawn a fresh attempt, which is a better retry
 * mechanism than an unattended loop nobody is reading.
 */
describe('giving up on a console that will not open', () => {
  const base = { now: NOW, degradedSince: NOW - MIN, lastClientContactAt: NOW - MIN };

  it('keeps retrying while the failure is recent', () => {
    const d = shouldGiveUpDegraded(base);
    assert.equal(d.giveUp, false);
  });

  it('gives up after the degraded window with nobody asking', () => {
    const d = shouldGiveUpDegraded({
      now: NOW,
      degradedSince: NOW - DEGRADED_GIVE_UP_MS - MIN,
      lastClientContactAt: NOW - DEGRADED_GIVE_UP_MS - MIN,
    });
    assert.equal(d.giveUp, true);
    assert.match(d.reason, /console/i);
  });

  it('keeps retrying past the window while a client is still asking', () => {
    // An agent watching status and waiting for a human to finish an MFA prompt
    // is exactly who this daemon is for; do not exit under them.
    const d = shouldGiveUpDegraded({
      now: NOW,
      degradedSince: NOW - 10 * DEGRADED_GIVE_UP_MS,
      lastClientContactAt: NOW - MIN,
    });
    assert.equal(d.giveUp, false);
  });

  it('never gives up when it was never degraded', () => {
    const d = shouldGiveUpDegraded({ now: NOW, degradedSince: null, lastClientContactAt: null });
    assert.equal(d.giveUp, false);
  });

  it('backs off retries instead of hammering the login every tick', () => {
    const first = shouldGiveUpDegraded({ ...base, attempts: 1 }).retryAfterMs;
    const later = shouldGiveUpDegraded({ ...base, attempts: 5 }).retryAfterMs;
    assert.ok(later > first, `expected backoff to grow, got ${first} then ${later}`);
    // Bounded, so a daemon left degraded overnight still recovers promptly once
    // the cause is fixed.
    const forever = shouldGiveUpDegraded({ ...base, attempts: 50 }).retryAfterMs;
    assert.ok(forever <= 15 * MIN, `expected the backoff to be capped, got ${forever}`);
  });
});
