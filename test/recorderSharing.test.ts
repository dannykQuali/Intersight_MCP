/**
 * Two agents may share one console, so no MCP server owns a recorder — and that
 * cuts both ways: nobody owns it, so nobody gets to unilaterally destroy it.
 *
 * Stopping a recorder kills the daemon, ends the vKVM session and closes the
 * tab. Done under another agent that is mid-installation, that is the same
 * outage this architecture was built to end — except caused by a peer instead of
 * a restart. A recorder nobody is using needs no stopping anyway: it goes dormant
 * on its own and releases the console.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { callDaemon, cleanUpDaemons, fakeBrowser, freshRoot, startDaemon } from './helpers/daemonHarness.js';

afterEach(cleanUpDaemons);

const liveConsole = () => fakeBrowser({ launch: { videoSurface: 'kvm-ui console mounted' } });

describe('stopping a recorder other agents may be using', () => {
  it('stops when only the asking client has been using it', async () => {
    const { port } = await startDaemon(liveConsole());
    await callDaemon(port, 'status', { clientId: 'mcp-A' });
    const res = await callDaemon(port, 'stop', { clientId: 'mcp-A' });
    assert.equal(res.stopping, true);
  });

  it('refuses while another client is actively using the console', async () => {
    const { port } = await startDaemon(liveConsole());
    await callDaemon(port, 'status', { clientId: 'mcp-B' });

    await assert.rejects(
      () => callDaemon(port, 'stop', { clientId: 'mcp-A' }),
      /another client/i,
      'stopping under a working agent must be refused, not merely logged'
    );
    // Still alive and answering, which is the point.
    assert.ok(await callDaemon(port, 'status', { clientId: 'mcp-A' }));
  });

  it('names who is using it and how recently, so the refusal is actionable', async () => {
    const { port } = await startDaemon(liveConsole());
    await callDaemon(port, 'status', { clientId: 'mcp-B' });
    await assert.rejects(() => callDaemon(port, 'stop', { clientId: 'mcp-A' }), /mcp-B/);
  });

  it('stops anyway when the caller insists with force', async () => {
    // The escape hatch matters: a wedged recorder must be killable by whoever
    // notices, without hunting down which agent touched it last.
    const { port } = await startDaemon(liveConsole());
    await callDaemon(port, 'status', { clientId: 'mcp-B' });
    const res = await callDaemon(port, 'stop', { clientId: 'mcp-A', force: true });
    assert.equal(res.stopping, true);
  });

  it('can be stopped while another client holds the input lease', async () => {
    // Stopping is not console input, so it must not queue behind the input
    // lease. It did: one failed keystroke left the lease held for 30 seconds, and
    // every stop in that window was refused with 409 — including a forced one.
    // The daemon then never exited, which is the unkillable recorder this whole
    // design exists to prevent.
    const { port } = await startDaemon(liveConsole());
    await callDaemon(port, 'sendKeys', { clientId: 'mcp-B', text: 'x' });

    const res = await callDaemon(port, 'stop', { clientId: 'mcp-A', force: true });
    assert.equal(res.stopping, true);
  });

  it('does not count the asking client as somebody else', async () => {
    // The control server records contact before running the action, so the
    // asker's own timestamp is always fresh; treating it as "in use" would make
    // stop impossible for everyone.
    const { port } = await startDaemon(liveConsole());
    for (let i = 0; i < 3; i++) {
      await callDaemon(port, 'status', { clientId: 'mcp-A' });
    }
    assert.equal((await callDaemon(port, 'stop', { clientId: 'mcp-A' })).stopping, true);
  });
});

/**
 * `dormant.json` is how a client in another process learns that a live daemon has
 * released its console but kept its frames. It is therefore a claim about RIGHT
 * NOW, and a stale one misleads: a working recorder was reported as dormant
 * because a marker from a previous run was still sitting in its directory —
 * written by every clean shutdown, since teardown reuses the same release path.
 */
describe('the dormancy marker', () => {
  it('is cleared when a daemon has a live console', async () => {
    const { root, dir } = freshRoot();
    fs.writeFileSync(path.join(dir, 'dormant.json'), JSON.stringify({ dormantSince: 'yesterday' }));

    await startDaemon(liveConsole(), { root });
    assert.equal(
      fs.existsSync(path.join(dir, 'dormant.json')),
      false,
      'an active recorder must not be advertised as dormant'
    );
  });

  it('is not left behind by a stop', async () => {
    // A stopped daemon is gone, not resting: the marker would make the next
    // client think there is something to resume.
    const { port, dir } = await startDaemon(liveConsole());
    await callDaemon(port, 'stop', { clientId: 'mcp-A', force: true });
    await waitFor(() => !fs.existsSync(path.join(dir, 'dormant.json')), 3000);
    assert.equal(fs.existsSync(path.join(dir, 'dormant.json')), false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
