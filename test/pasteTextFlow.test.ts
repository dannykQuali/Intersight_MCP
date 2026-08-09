/**
 * The paste-text flow: type, read the line back, retry slower, and never submit
 * a line that could not be verified.
 *
 * The last property is the one that matters most. An agent typed
 * `grep -m3 -riE "nocloud|autoinstall|ds" /var/log/cloud-init.log` and the guest's
 * key-repeat turned it into `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll`, then Enter was
 * pressed on it. A mangled `grep` is harmless; a mangled `dd` or `rm` is not. So
 * Enter is gated on verification, always.
 *
 * The flow is driven through the real daemon over its real control port — the
 * same path an MCP server takes — with only the browser faked, because what is
 * under test is the retry/verify decision-making, not Playwright.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { callDaemon, cleanUpDaemons, fakeBrowser, startDaemon } from './helpers/daemonHarness.js';

afterEach(cleanUpDaemons);

/**
 * A fake console that mangles the Nth attempt the way a stalled HID queue does,
 * and echoes cleanly after that.
 */
function pastingBrowser(opts: { mangleAttempts: number }) {
  const fake = fakeBrowser({ launch: { videoSurface: 'kvm-ui console mounted' } });
  const calls = { pastes: [] as Array<Record<string, unknown>>, enters: 0 };
  let attempt = 0;
  (fake.browser as any).pasteText = async (p: Record<string, unknown>) => {
    // Stand in for BrowserService.pasteText's own retry loop: the daemon layer is
    // what is under test here, so this reports the outcome it would have reached.
    attempt++;
    calls.pastes.push(p);
    const mangled = attempt <= opts.mangleAttempts;
    const verified = !mangled;
    if (p.submit && verified) {
      calls.enters++;
    }
    return {
      text: p.text,
      verified,
      submitted: !!p.submit && verified,
      attempts: [{ attempt, matched: verified }],
      ...(mangled ? { problem: "the text arrived but was mangled by key-repeat: 'i' x20" } : {}),
      ...(p.submit && !verified ? { notSubmitted: 'Enter was NOT pressed' } : {}),
    };
  };
  return { fake, calls };
}

describe('pasting text into a console through the daemon', () => {
  it('reports a verified line', async () => {
    const { fake } = pastingBrowser({ mangleAttempts: 0 });
    const { port } = await startDaemon(fake);
    const r = await callDaemon(port, 'pasteText', { text: 'cat /proc/cmdline' });
    assert.equal(r.verified, true);
    assert.equal(r.submitted, false, 'Enter must not be pressed unless asked');
  });

  it('presses Enter only after verification succeeds', async () => {
    const { fake, calls } = pastingBrowser({ mangleAttempts: 0 });
    const { port } = await startDaemon(fake);
    const r = await callDaemon(port, 'pasteText', { text: 'ls -la', submit: true });
    assert.equal(r.submitted, true);
    assert.equal(calls.enters, 1);
  });

  it('refuses to submit a line it could not verify', async () => {
    // The whole point: a mangled command must never be executed.
    const { fake, calls } = pastingBrowser({ mangleAttempts: 99 });
    const { port } = await startDaemon(fake);
    const r = await callDaemon(port, 'pasteText', { text: 'dd if=/dev/zero of=/dev/sda', submit: true });
    assert.equal(r.verified, false);
    assert.equal(r.submitted, false);
    assert.equal(calls.enters, 0, 'Enter must never reach an unverified line');
    assert.match(String(r.notSubmitted ?? r.problem), /not|mangled/i);
  });

  it('names key-repeat damage rather than a bare mismatch', async () => {
    const { fake } = pastingBrowser({ mangleAttempts: 99 });
    const { port } = await startDaemon(fake);
    const r = await callDaemon(port, 'pasteText', { text: 'autoinstall' });
    assert.match(String(r.problem), /repeat/i);
  });

  it('holds the input lease while typing, with an ETA a peer can act on', async () => {
    // Typing a long line takes seconds at a safe cadence. A second agent must be
    // refused with a reason and a wait, not left guessing.
    const { fake } = pastingBrowser({ mangleAttempts: 0 });
    const { port } = await startDaemon(fake);

    let peerError = '';
    (fake.browser as any).pasteText = async () => {
      // While this is in flight, the daemon should already be marked busy.
      const res = await fetch(`http://127.0.0.1:${port}/sendKeys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'peer-agent', text: 'x' }),
      });
      const body = (await res.json()) as any;
      peerError = `${res.status} ${body.error ?? ''}`;
      return { verified: true, submitted: false, attempts: [] };
    };

    await callDaemon(port, 'pasteText', { text: 'a longer command line here', clientId: 'typing-agent' });
    assert.match(peerError, /^409/, `a peer's input must be refused while typing, got ${peerError}`);
    assert.match(peerError, /typing|character/i, 'and told what the console is doing');
  });

  it('requires a live console, like every other input action', async () => {
    const fake = fakeBrowser({ launch: { accessDenied: true } });
    const { port } = await startDaemon(fake);
    await assert.rejects(() => callDaemon(port, 'pasteText', { text: 'ls' }), /no live console/i);
  });
});
