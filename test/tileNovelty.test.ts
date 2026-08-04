/**
 * Change classification by WHERE and WHAT, replacing the magnitude threshold.
 *
 * The magnitude threshold could not work, empirically: a password dot and a
 * cursor blink both move ~0.0003 of the frame — legitimate content and pure
 * noise with IDENTICAL magnitude. Every calibration traded one failure for
 * another (0.0005 lost password dots; 0.0001 would store a blinking cursor
 * once a second, collapsing the 4h ring buffer to ~50 minutes and saturating
 * the OCR queue).
 *
 * The tracker divides the frame into tiles and remembers each tile's recent
 * states, so a change can be classified instead of measured:
 *   - returns to a state the tile just showed  -> oscillating (cursor blink)
 *   - new content on a regular rhythm          -> rhythmic (clock, spinner)
 *   - new content in a quiet tile              -> NOVEL - the signal
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { TileTracker } from '../src/services/tileNovelty.js';

const W = 400;
const H = 300;

/** A solid frame with optional per-pixel overrides. */
function frame(base: number, paint: Array<{ x: number; y: number; w?: number; h?: number; v: number }> = []): PNG {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = png.data[i + 1] = png.data[i + 2] = base;
    png.data[i + 3] = 255;
  }
  for (const p of paint) {
    for (let dy = 0; dy < (p.h ?? 8); dy++) {
      for (let dx = 0; dx < (p.w ?? 8); dx++) {
        const i = (W * (p.y + dy) + (p.x + dx)) << 2;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = p.v;
      }
    }
  }
  return png;
}

/** Feed a sequence of frames at a fixed cadence; returns the per-frame results. */
function run(tracker: TileTracker, frames: PNG[], stepMs = 1000, startAt = 1_000_000) {
  return frames.map((f, i) => tracker.update(f, startAt + i * stepMs));
}

describe('TileTracker', () => {
  it('treats the first frame as baseline, not as change', () => {
    const t = new TileTracker();
    const [r] = run(t, [frame(0)]);
    assert.equal(r.novelTiles, 0);
    assert.equal(r.changedTiles, 0);
  });

  it('reports nothing for identical frames', () => {
    const t = new TileTracker();
    const results = run(t, [frame(0), frame(0), frame(0)]);
    assert.equal(results[1].changedTiles + results[2].changedTiles, 0);
  });

  it('flags a small new mark in a quiet region as novel — the password dot', () => {
    // ~0.0003 of the frame: the exact magnitude the old threshold threw away.
    const t = new TileTracker();
    const results = run(t, [frame(0), frame(0, [{ x: 200, y: 150, v: 255 }])]);
    assert.equal(results[1].novelTiles, 1);
  });

  it('classifies a cursor blink as oscillating after one round trip', () => {
    const t = new TileTracker();
    const blank = () => frame(0);
    const cursor = () => frame(0, [{ x: 40, y: 40, v: 255 }]);
    const results = run(t, [blank(), cursor(), blank(), cursor(), blank(), cursor()]);
    assert.equal(results[1].novelTiles, 1, 'the FIRST appearance is novel — nothing is known yet');
    for (let i = 2; i < results.length; i++) {
      assert.equal(results[i].novelTiles, 0, `blink #${i} must not be novel`);
      assert.equal(results[i].oscillatingTiles, 1, `blink #${i} is a return to a known state`);
    }
  });

  it('classifies a clock as rhythmic once its cadence is established', () => {
    // New content in the same tile at a perfectly regular interval. Unlike a
    // blink it never returns to an old state, so only rhythm can catch it.
    const t = new TileTracker();
    const tick = (n: number) => frame(0, [{ x: 320, y: 280, v: 50 + n * 20 }]);
    const frames = [frame(0)];
    for (let n = 1; n <= 6; n++) {
      frames.push(tick(n));
    }
    const results = run(t, frames, 60_000); // once a minute
    assert.equal(results[1].novelTiles, 1, 'first tick: unknown, novel');
    const later = results.slice(4);
    for (const r of later) {
      assert.equal(r.novelTiles, 0, 'an established clock must stop counting as novel');
      assert.equal(r.rhythmicTiles, 1);
    }
  });

  it('keeps IRREGULAR updates novel — steady log output is progress, not a clock', () => {
    // Same tile, new content each time, but at varying intervals. This is a
    // terminal's last line during an install; suppressing it would recreate
    // the false-wedge problem the tracker exists to fix.
    const t = new TileTracker();
    const line = (n: number) => frame(0, [{ x: 40, y: 280, w: 200, v: 40 + n * 15 }]);
    const frames = [frame(0), line(1), line(2), line(3), line(4), line(5), line(6)];
    const gaps = [0, 1000, 4200, 1500, 9000, 2100, 6400];
    let at = 1_000_000;
    const results = frames.map((f, i) => {
      at += gaps[i];
      return t.update(f, at);
    });
    const novel = results.slice(1).filter((r) => r.novelTiles > 0).length;
    assert.ok(novel >= 5, `irregular same-tile updates must stay novel, got ${novel}/6`);
  });

  it('treats a full repaint with new content as broadly novel', () => {
    const t = new TileTracker();
    const results = run(t, [frame(0), frame(0), frame(200)]);
    assert.ok(results[2].novelTiles > 20, 'a mode switch touches many quiet tiles');
  });

  it('resets cleanly for a new console', () => {
    const t = new TileTracker();
    run(t, [frame(0), frame(0, [{ x: 40, y: 40, v: 255 }])]);
    t.reset();
    const [r] = run(t, [frame(0)]);
    assert.equal(r.changedTiles, 0, 'after reset the first frame is baseline again');
  });

  it('handles a resolution change without mixing up tiles', () => {
    const t = new TileTracker();
    t.update(frame(0), 1_000_000);
    const small = new PNG({ width: 100, height: 80 });
    small.data.fill(255);
    const r = t.update(small, 1_001_000);
    assert.equal(r.novelTiles, 0, 'a resize is a new baseline, not a burst of novelty');
  });
});
