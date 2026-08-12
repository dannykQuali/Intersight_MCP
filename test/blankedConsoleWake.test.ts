/**
 * A blanked console must be woken even when its REASON cannot be read.
 *
 * Field case, C240 running an ESXi install. The operator saw the green
 * "No Signal — Reason: User Inactivity — Press a key to wake up the system"
 * screen repeatedly, and it cleared the instant they moved a real mouse over it.
 * The recorder reported `wakes: 0` across 28 hours.
 *
 * Measured from that recorder's own frames: the green screens were 0.815 green,
 * far above the 0.5 detection threshold, and OCR of the very same file in a fresh
 * process read the reason perfectly. But inside that daemon every OCR call had
 * failed (570 failures, 0 successes), so `classifyNoSignal(null, {blanked:true})`
 * returned `kind: 'unknown'` — and the wake path only ran for `'inactivity'`.
 * A broken OCR engine therefore disabled waking altogether.
 *
 * The remedy is the cheap one: a bare modifier key. It types nothing, submits
 * nothing, and is exactly what the screen asks for. There is no reason to require
 * proof of WHY the screen is blank before trying it — so "blanked, reason unknown"
 * is treated as wake-worthy, and only a screen we positively know to be
 * powered-off or dropped is handled differently.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyNoSignal, shouldWakeBlankedConsole } from '../src/services/consoleSignals.js';

describe('deciding to wake a blanked console', () => {
  it('wakes on a screen it can read as user inactivity', () => {
    const state = classifyNoSignal('No Signal Reason: User Inactivity Press a key to wake up the system.', {
      blanked: true,
    });
    assert.equal(state.kind, 'inactivity');
    assert.equal(shouldWakeBlankedConsole(state), true);
  });

  it('wakes on a blanked screen whose reason could not be read', () => {
    // The actual field failure: OCR dead, so the reason is unknown — and the
    // console sat green for minutes with wakes: 0.
    const state = classifyNoSignal(null, { blanked: true });
    assert.equal(state.kind, 'unknown');
    assert.equal(shouldWakeBlankedConsole(state), true, 'an unreadable reason must not disable waking');
  });

  it('does not waste a keypress on a powered-off server', () => {
    // No key wakes a machine that is off, and pretending otherwise sends the
    // caller round the recovery loop.
    const state = classifyNoSignal('No Signal Reason: Host power is off', { blanked: true });
    assert.equal(state.kind, 'power-off');
    assert.equal(shouldWakeBlankedConsole(state), false);
  });

  it('does not try to wake a dropped connection, which needs a relaunch', () => {
    // The client's actual wording, which is what the detector was built against.
    const state = classifyNoSignal('No Signal Connection to server dropped, attempting to reconnect', {
      blanked: true,
    });
    assert.equal(state.kind, 'dropped');
    assert.equal(shouldWakeBlankedConsole(state), false);
  });

  it('leaves a healthy console alone', () => {
    const state = classifyNoSignal(null, { blanked: false });
    assert.equal(state.blanked, false);
    assert.equal(shouldWakeBlankedConsole(state), false);
  });

  it('never claims a screen that is not blanked is wake-worthy', () => {
    // Whatever text OCR returns, the pixels decide whether the console is blank.
    const state = classifyNoSignal('User Inactivity', { blanked: false });
    assert.equal(shouldWakeBlankedConsole(state), false);
  });
});
