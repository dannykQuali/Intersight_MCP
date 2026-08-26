/**
 * Coordinates read off a SCALED recorded frame are not page coordinates.
 *
 * Field report: an operator picked (900, 450) off a 0.6-scaled vkvm_recent
 * frame and passed it straight to browser_mouse, which takes unscaled page
 * pixels. The click landed ~40% off - possibly outside the console area
 * entirely - and the resulting "input does nothing" was misdiagnosed for hours.
 * Nothing in either tool's description warned that the two spaces differ.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fromScaledFrame, canvasPointToViewport } from '../src/utils/frameCoords.js';

describe('fromScaledFrame', () => {
  it('converts coordinates read off a scaled frame back to page pixels', () => {
    assert.deepEqual(fromScaledFrame(900, 450, 0.6), { x: 1500, y: 750 });
    assert.deepEqual(fromScaledFrame(400, 250, 0.5), { x: 800, y: 500 });
  });

  it('rounds to whole pixels', () => {
    assert.deepEqual(fromScaledFrame(100, 100, 0.7), { x: 143, y: 143 });
  });

  it('is a no-op at full scale', () => {
    assert.deepEqual(fromScaledFrame(820, 500, 1), { x: 820, y: 500 });
  });

  it('ignores a missing or nonsensical scale rather than mangling the click', () => {
    // Better to click where the caller said than to divide by zero.
    for (const scale of [undefined, 0, -1, NaN]) {
      assert.deepEqual(fromScaledFrame(820, 500, scale as number), { x: 820, y: 500 }, `scale=${scale}`);
    }
  });

  it('rejects a scale above 1, which would move the click the wrong way', () => {
    assert.throws(() => fromScaledFrame(820, 500, 1.5), /between/i);
  });
});

/**
 * A canvas frame's coordinates are in the canvas's BACKING STORE, which is not
 * where the pointer lives.
 *
 * Recorded frames are now the console canvas itself, so a coordinate read off one
 * is in the server's own resolution — measured live: backing store 1024x768,
 * displayed 1011x758 at (388,50), a ratio of 0.987. Adding only the offset (which
 * is all `relativeTo:'canvas'` ever did) is therefore wrong by a factor, not by a
 * shift: about 13px at the right edge here, but the ratio is set by the window
 * size against the server's video mode. Let the server switch to 1920x1080 in the
 * same 1011px-wide box and the factor becomes 0.53 — a click meant for x=1900
 * lands ~900px away.
 *
 * This was always latent in `relativeTo:'canvas'`; making it the default for
 * canvas-capturing recorders is what turned it into everybody's problem.
 */
describe('mapping a canvas-frame point into the viewport', () => {
  /** The live geometry, measured on CHG-UCSX-2-1-1. */
  const live = { box: { x: 388, y: 50, width: 1011, height: 758 }, backing: { width: 1024, height: 768 } };

  it('scales by the backing-store ratio and then offsets', () => {
    const p = canvasPointToViewport(1020, 760, live);
    // 388 + 1020*(1011/1024) = 1395.  NOT 388 + 1020 = 1408.
    assert.equal(p.x, 1395);
    assert.equal(p.y, 800);
    assert.ok(Math.abs(p.scaleX - 0.987) < 0.001);
  });

  it('puts the canvas origin at the canvas origin', () => {
    const p = canvasPointToViewport(0, 0, live);
    assert.deepEqual({ x: p.x, y: p.y }, { x: 388, y: 50 });
  });

  it('puts the canvas centre at the box centre', () => {
    const p = canvasPointToViewport(512, 384, live);
    assert.equal(p.x, Math.round(388 + 1011 / 2));
    assert.equal(p.y, Math.round(50 + 758 / 2));
  });

  it('handles a server video mode much larger than the displayed canvas', () => {
    // The case that turns a 13px error into a 900px one.
    const big = { box: { x: 388, y: 50, width: 1011, height: 569 }, backing: { width: 1920, height: 1080 } };
    const p = canvasPointToViewport(1900, 1000, big);
    assert.equal(p.x, Math.round(388 + 1900 * (1011 / 1920)));
    assert.ok(p.x < 1400, `must stay inside the canvas box, got ${p.x}`);
  });

  it('offsets without scaling when the backing size is unknown', () => {
    // Better to be off by a ratio than to divide by zero and click nowhere.
    const p = canvasPointToViewport(100, 100, { box: live.box, backing: { width: 0, height: 0 } });
    assert.deepEqual({ x: p.x, y: p.y }, { x: 488, y: 150 });
    assert.equal(p.scaleX, 1);
  });

  it('returns the point untouched when there is no canvas box at all', () => {
    const p = canvasPointToViewport(100, 100, { box: null, backing: live.backing });
    assert.deepEqual({ x: p.x, y: p.y }, { x: 100, y: 100 });
    assert.equal(p.applied, false);
  });
});
