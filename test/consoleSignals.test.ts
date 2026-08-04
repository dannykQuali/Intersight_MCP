/**
 * Classifying the green "No Signal" screens.
 *
 * Two reasons were known and handled with OPPOSITE remedies (send a key vs
 * relaunch). A third turned up in a real recording - "Reason: Host power is
 * off" - which matched neither pattern, so the console was reported as
 * perfectly healthy while showing a full-screen green placeholder. Nothing to
 * *recover* there, but the caller must be able to tell "powered off" from
 * "working fine".
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import {
  classifyNoSignal,
  noSignalGreenFraction,
  NO_SIGNAL_GREEN_THRESHOLD,
  NO_SIGNAL_RGB,
} from '../src/services/consoleSignals.js';

/** A frame whose console region is filled with the given colour. */
function frame(r: number, g: number, b: number, width = 400, height = 300): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return png;
}

describe('classifyNoSignal', () => {
  it('recognises a sleeping host display, which needs a keypress', () => {
    const c = classifyNoSignal('No Signal Reason: User Inactivity. Press a key to wake up the system.');
    assert.equal(c.kind, 'inactivity');
    assert.equal(c.blanked, true);
    assert.match(c.remedy!, /key/i);
  });

  it('recognises a dropped tunnel, which needs a relaunch', () => {
    const c = classifyNoSignal('No Signal Reason: Connection to server dropped. Client is attempting to reconnect.');
    assert.equal(c.kind, 'dropped');
    assert.equal(c.blanked, true);
    assert.match(c.remedy!, /relaunch/i);
  });

  it('recognises a powered-off host and does NOT ask for a remedy', () => {
    // Observed live on C240-WZP26220B5F. There is no console to recover.
    const c = classifyNoSignal('No Signal Reason: Host power is off');
    assert.equal(c.kind, 'power-off');
    assert.equal(c.blanked, true);
    assert.equal(c.remedy, null, 'nothing the console tools can do about a powered-off server');
  });

  it('reports an unrecognised reason rather than silently calling it healthy', () => {
    const c = classifyNoSignal('No Signal Reason: Something we have never seen');
    assert.equal(c.kind, 'unknown');
    assert.equal(c.blanked, true);
    assert.match(c.reason!, /Something we have never seen/);
  });

  it('treats a bare No Signal screen as blanked', () => {
    const c = classifyNoSignal('No Signal');
    assert.equal(c.blanked, true);
    assert.equal(c.kind, 'unknown');
  });

  it('does not fire on a healthy console', () => {
    for (const text of ['', 'Shell> fs0:', 'Booting `Install Rocky Linux 9.5\'', 'Server Manager Dashboard']) {
      const c = classifyNoSignal(text);
      assert.equal(c.blanked, false, `false positive on: ${text}`);
      assert.equal(c.kind, null);
    }
  });

  it('trusts a pixel-proven blank screen even when no text could be read', () => {
    // OCR unavailable or unreadable, but the pixels say placeholder. Reporting
    // "healthy" here is the failure mode this whole path exists to avoid.
    const c = classifyNoSignal(null, { blanked: true });
    assert.equal(c.blanked, true);
    assert.equal(c.kind, 'unknown');
  });

  it('is not fooled by the lingering virtual-media toast', () => {
    // This toast sits on a LIVE console and describes a past event. Treating it
    // as a console failure previously caused a relaunch loop.
    const c = classifyNoSignal(
      'Virtual Media session has been disconnected due to: Network connection has been dropped. Close'
    );
    assert.equal(c.blanked, false);
    assert.equal(c.kind, null);
  });
});

/**
 * The placeholder is painted into the VIDEO SURFACE, not the DOM. Verified live:
 * on a console plainly showing "No Signal / Reason: Host power is off",
 * document.body.textContent does not contain the phrase, there is no canvas in
 * the light DOM, and no shadow root holds it either. Detection therefore has to
 * come from pixels - a DOM text search cannot ever see this screen.
 */
describe('noSignalGreenFraction', () => {
  it('detects the flat CSS-green placeholder fill', () => {
    const f = noSignalGreenFraction(frame(NO_SIGNAL_RGB.r, NO_SIGNAL_RGB.g, NO_SIGNAL_RGB.b));
    assert.ok(f > 0.99, `expected a near-solid green fill, got ${f}`);
    assert.ok(f > NO_SIGNAL_GREEN_THRESHOLD);
  });

  it('tolerates slight colour drift from the video path', () => {
    const f = noSignalGreenFraction(frame(4, 132, 5));
    assert.ok(f > 0.99, `expected drift to still count as green, got ${f}`);
  });

  it('does not fire on ordinary console screens', () => {
    for (const [name, png] of [
      ['black text console', frame(0, 0, 0)],
      ['white installer', frame(255, 255, 255)],
      ['Intersight chrome grey', frame(66, 72, 94)],
      ['bright non-CIMC green', frame(0, 255, 0)],
    ] as Array<[string, PNG]>) {
      const f = noSignalGreenFraction(png);
      assert.ok(f < NO_SIGNAL_GREEN_THRESHOLD, `false positive on ${name}: ${f}`);
    }
  });

  it('ignores the Intersight chrome, which is never part of the console', () => {
    // Left nav + top bar in chrome grey, console region green: still detected.
    const png = frame(66, 72, 94, 1600, 900);
    for (let y = 90; y < 900; y++) {
      for (let x = 400; x < 1600; x++) {
        const i = (1600 * y + x) << 2;
        png.data[i] = NO_SIGNAL_RGB.r;
        png.data[i + 1] = NO_SIGNAL_RGB.g;
        png.data[i + 2] = NO_SIGNAL_RGB.b;
      }
    }
    assert.ok(noSignalGreenFraction(png) > NO_SIGNAL_GREEN_THRESHOLD);
  });

  it('survives a zero-sized frame', () => {
    assert.equal(noSignalGreenFraction({ width: 0, height: 0, data: Buffer.alloc(0) }), 0);
  });
});
