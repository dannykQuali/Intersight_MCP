/**
 * A recorder daemon must never claim a live console it does not have.
 *
 * launchVkvm reports its failures in the RESULT, not by throwing: a Forbidden
 * page, a session that ends the instant it opens, and a reused tab all come back
 * "successfully". A daemon that only caught exceptions therefore reported phase
 * 'active' with nothing being captured, and an agent would watch for frames that
 * were never coming — the exact blindness this architecture exists to remove.
 *
 * Two of those cases leave no recorder behind at all: autorecord is skipped for
 * a dead console, and a REUSED tab keeps only the recorder it already had (so a
 * daemon adopting a tab left by a hard-killed predecessor recorded nothing). So
 * capture is asserted here, not assumed.
 *
 * The daemon is driven the way an MCP server drives it — over its real control
 * port — and only BrowserService is faked, because what is under test is the
 * daemon's verdict on a launch, not Intersight.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { callDaemon as call, cleanUpDaemons, fakeBrowser, startDaemon } from './helpers/daemonHarness.js';

afterEach(cleanUpDaemons);

describe('a daemon deciding whether it really has a console', () => {
  it('reports degraded, not recording, when the vKVM page is Forbidden', async () => {
    const fake = fakeBrowser({
      launch: { accessDenied: true, hint: 'TunneledKvmState can read Ready and still be inaccessible.' },
    });
    const status = await call((await startDaemon(fake)).port, 'status');

    assert.equal(status.phase, 'degraded', 'a Forbidden page is not a console');
    assert.match(String(status.lastError), /authorization/i);
    assert.equal(fake.calls.startRecording, 0, 'nothing should be recorded off an error page');
  });

  it('reports degraded when the session ends the moment it opens', async () => {
    const fake = fakeBrowser({ launch: { sessionEnded: true, hint: 'known Intersight bug' } });
    const status = await call((await startDaemon(fake)).port, 'status');

    assert.equal(status.phase, 'degraded');
    assert.match(String(status.lastError), /ended immediately/i);
  });

  it('escalates to a Tunneled vKVM reset once launches keep coming back dead', async () => {
    const fake = fakeBrowser({ launch: { sessionEnded: true } });
    const { port } = await startDaemon(fake);
    assert.equal(fake.calls.resets, 0, 'one dead launch is not evidence of a wedged tunnel');

    // A client asking again retries immediately, whatever the backoff said.
    await call(port, 'resume').catch(() => undefined);
    assert.equal(fake.calls.resets, 1, 'a second dead launch is what the reset exists for');

    // Capped: if two resets did not help, the tunnel is not the problem.
    await call(port, 'resume').catch(() => undefined);
    await call(port, 'resume').catch(() => undefined);
    assert.equal(fake.calls.resets, 2, `resets must be capped, saw ${fake.calls.resets}`);
  });

  it('starts capture on a REUSED tab that had no recorder', async () => {
    // The hard-kill case: a predecessor died leaving its tab open, so the launch
    // reuses it and reports success — with nothing recording it.
    const fake = fakeBrowser({ launch: { reused: true, clientUrl: 'https://intersight.example/vkvm' } });
    const status = await call((await startDaemon(fake)).port, 'status');

    assert.equal(status.phase, 'active');
    assert.equal(fake.calls.startRecording, 1, 'a reused tab must still be recorded');
  });

  it('does not restart a recorder that is already running', async () => {
    // Restarting would clear the frames captured so far, which is the one thing
    // a recovering daemon must not do to a console it just adopted.
    const fake = fakeBrowser({ launch: { reused: true }, recorderRunning: true });
    const status = await call((await startDaemon(fake)).port, 'status');

    assert.equal(status.phase, 'active');
    assert.equal(fake.calls.startRecording, 1);
    assert.equal(status.lastError, undefined);
  });

  it('refuses console INPUT while degraded, with the reason', async () => {
    const fake = fakeBrowser({ launch: { accessDenied: true } });
    const { port } = await startDaemon(fake);
    // A keystroke into a console that does not exist must fail loudly here
    // rather than as an opaque "no page" from the browser layer.
    await assert.rejects(() => call(port, 'sendKeys', { text: 'hello' }), /no live console/i);
    assert.equal(fake.calls.keys, 0);
  });

  it('reports degraded when the console opens but nothing records it', async () => {
    const fake = fakeBrowser({ launch: { videoSurface: 'kvm-ui console mounted' }, recorderRefuses: true });
    const status = await call((await startDaemon(fake)).port, 'status');

    assert.equal(status.phase, 'degraded', 'a console nobody is capturing is not a working recorder');
    assert.match(String(status.lastError), /nothing is recording/i);
  });

  it('does not claim to be active after a failed relaunch', async () => {
    // relaunch tears the console down first, so a failure leaves nothing
    // running at all — the one moment where a stale 'active' is most harmful.
    const fake = fakeBrowser({ launch: { reused: true } });
    const { port } = await startDaemon(fake);
    assert.equal((await call(port, 'status')).phase, 'active');

    fake.calls.launches = 0;
    (fake.browser as any).launchVkvm = async () => {
      fake.calls.launches++;
      return { accessDenied: true };
    };
    await assert.rejects(() => call(port, 'relaunch'), /authorization/i);
    const status = await call(port, 'status');
    assert.equal(status.phase, 'degraded');
    assert.equal(fake.calls.launches, 1);
  });

  it('still serves recorded history while degraded', async () => {
    // Frames already on disk are the most useful thing a broken recorder has;
    // reads must not be gated on a console that is missing.
    const fake = fakeBrowser({ launch: { accessDenied: true } });
    const status = await call((await startDaemon(fake)).port, 'status');
    assert.equal(status.phase, 'degraded');
    assert.ok(status.recording, 'status must still report the recorder view');
  });
});
