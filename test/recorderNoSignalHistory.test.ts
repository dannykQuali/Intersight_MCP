/**
 * A blanked console must leave a trace in the METADATA, not only in the pixels.
 *
 * Recorded frames are now the console canvas rather than the whole tab. The green
 * "No Signal / Reason: User Inactivity" screen survives that — it is sent by the
 * BMC as video, not drawn by the client (searched: those words appear in none of
 * the 39 scripts the client loads, and nowhere in the DOM) — so it is painted into
 * the canvas and still captured.
 *
 * But relying on that alone leaves the operator's real complaint unanswered: the
 * only record of a console having been blank was the picture itself. Nothing in
 * `vkvm_timeline` said "the console went green at 02:00 and came back at 02:04",
 * so reviewing a night's run meant looking at frames to find out. And when OCR
 * fails — which it did for 570 consecutive frames on a live recorder — the reason
 * text was gone entirely.
 *
 * So the state and its reason are recorded as timeline events and reported in
 * status, independently of the frames and of OCR.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkvmRecorder } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, movingMarkFrame, waitFor } from './helpers/fakeConsolePage.js';

const dirs: string[] = [];
const recorders: VkvmRecorder[] = [];

afterEach(() => {
  for (const r of recorders.splice(0)) {
    r.stop();
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A recorder whose console blankness is under the test's control. */
function recorderWithSignal(
  signal: () => { kind: 'inactivity' | 'dropped' | 'power-off' | 'unknown'; reason: string } | null
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosignal-history-'));
  dirs.push(dir);
  const page = new FakeConsolePage(movingMarkFrame(1));
  const recorder = new VkvmRecorder(
    page as never,
    dir,
    {
      intervalMs: 50,
      // Check on every tick so the test does not have to wait out a cadence.
      deadCheckEveryTicks: 1,
      retentionMinutes: 240,
      heartbeatSeconds: 3600,
      antiBlankSeconds: 0,
      antiBlankMode: 'none',
      ocrText: false,
    },
    {
      // Both are needed: the recorder only consults isConsoleDisconnected inside
      // the periodic liveness check, which is gated on isConsoleDead existing.
      isConsoleDead: async () => false,
      isConsoleDisconnected: async () => signal(),
      // Waking is not what is under test; report success so the recorder moves on.
      wakeConsole: async () => true,
    }
  );
  recorders.push(recorder);
  recorder.start();
  return recorder;
}

// timeline() exposes an event's kind in its `reason` field (frames put their
// capture reason there), and that is exactly how an agent reads it back.
const events = (r: VkvmRecorder) => r.timeline().filter((e: any) => e.seq === undefined);

describe('recording that the console was blank', () => {
  it('records an event when the console goes blank, naming the reason', async () => {
    const recorder = recorderWithSignal(() => ({
      kind: 'inactivity',
      reason: 'User Inactivity Press a key to wake up the system',
    }));

    await waitFor(() => events(recorder).some((e: any) => e.reason === 'no-signal'), 3000, 'a no-signal event');
    const event = events(recorder).find((e: any) => e.reason === 'no-signal') as any;
    assert.match(event.detail, /inactivity/i, event.detail);
    assert.match(event.detail, /wake up the system/i, 'the REASON must be in the metadata, not just the pixels');
  });

  it('records it once, not on every check', async () => {
    // A console can sit blank for minutes; one event per transition is the point.
    const recorder = recorderWithSignal(() => ({ kind: 'inactivity', reason: 'User Inactivity' }));
    await waitFor(() => events(recorder).some((e: any) => e.reason === 'no-signal'), 3000, 'the first event');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const blanks = events(recorder).filter((e: any) => e.reason === 'no-signal');
    assert.equal(blanks.length, 1, `expected exactly one, got ${blanks.length}`);
  });

  it('records the recovery too, so a window can be read off the timeline', async () => {
    let blank = true;
    const recorder = recorderWithSignal(() =>
      blank ? { kind: 'inactivity', reason: 'User Inactivity' } : null
    );
    await waitFor(() => events(recorder).some((e: any) => e.reason === 'no-signal'), 3000, 'the blank');
    blank = false;
    await waitFor(
      () => events(recorder).some((e: any) => e.reason === 'signal-restored'),
      3000,
      'the restoration'
    );
  });

  it('reports the current state in status, with how long it has been blank', async () => {
    const recorder = recorderWithSignal(() => ({ kind: 'power-off', reason: 'Host power is off' }));
    await waitFor(() => !!recorder.status().noSignal, 3000, 'status to report the blank');
    const noSignal = recorder.status().noSignal;
    assert.equal(noSignal.kind, 'power-off');
    assert.match(noSignal.reason, /power is off/i);
    assert.ok(typeof noSignal.since === 'string' && noSignal.since.length > 10, 'when it started');
    assert.ok(noSignal.seconds >= 0);
  });

  it('says nothing at all while the console is healthy', async () => {
    const recorder = recorderWithSignal(() => null);
    await waitFor(() => recorder.status().framesStored >= 1, 3000, 'a frame');
    assert.equal(recorder.status().noSignal, undefined);
    assert.equal(events(recorder).filter((e: any) => e.reason === 'no-signal').length, 0);
  });

  it('records a change of reason as a new event', async () => {
    // Inactivity that becomes a dropped tunnel is a different problem with a
    // different remedy; collapsing them would hide the transition.
    let kind: 'inactivity' | 'dropped' = 'inactivity';
    const recorder = recorderWithSignal(() => ({ kind, reason: kind }));
    await waitFor(() => events(recorder).some((e: any) => e.reason === 'no-signal'), 3000, 'the first');
    kind = 'dropped';
    await waitFor(
      () => events(recorder).filter((e: any) => e.reason === 'no-signal').length >= 2,
      4000,
      'a second event for the new reason'
    );
  });
});
