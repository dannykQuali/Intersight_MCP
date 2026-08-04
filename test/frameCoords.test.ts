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
import { fromScaledFrame } from '../src/utils/frameCoords.js';

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
