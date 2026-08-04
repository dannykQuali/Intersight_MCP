/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Classifies console changes by WHERE they happen and WHAT they are, replacing
 * the global change-magnitude threshold.
 *
 * The threshold could not be fixed by tuning, because magnitude does not carry
 * meaning: a password dot and a cursor blink both move ~0.0003 of the frame —
 * real content and pure noise at IDENTICAL magnitude. Any value lost one or
 * flooded on the other (a blinking cursor stored once a second collapses the
 * 4-hour ring buffer to ~50 minutes and saturates the OCR queue).
 *
 * So the frame is divided into tiles and each tile remembers its own recent
 * past. A change is then classified, not measured:
 *
 *   oscillating  the tile RETURNED to a state it just showed (cursor blink,
 *                caret, a two-phase animation) — noise, however large.
 *   rhythmic     new content in the same tile on a REGULAR cadence (taskbar
 *                clock, spinner, a ticking counter) — self-driven repainting,
 *                not the machine doing something new.
 *   novel        new content in a tile with no such pattern — the signal.
 *
 * Irregularity is what protects real activity from the rhythmic class: steady
 * log output lands as new content at varying intervals (and scrolls across
 * tiles), so it stays novel, while a clock's metronome cadence does not.
 *
 * This runs on every decoded sample, so it is deliberately cheap: the same
 * stride-4 pixel walk the differ uses, bucketed per tile into an FNV-1a hash.
 * ~1000 tiles of a few numbers each — the whole state is ~50KB per console.
 */
import type { PNG } from 'pngjs';

/** Pixels per tile edge. 40px x stride 4 = 100 sampled pixels per tile. */
const TILE_SIZE = 40;
/** Sample every Nth pixel in each axis, matching the differ's stride. */
const STRIDE = 4;
/** Changes needed in one tile before a cadence can be called established. */
const RHYTHM_MIN_CHANGES = 3;
/** A cadence counts as regular when intervals deviate less than this fraction. */
const RHYTHM_MAX_DEVIATION = 0.25;
/**
 * Cadences slower than this are never "rhythmic": a once-per-few-minutes
 * repaint is worth seeing even if it is regular.
 */
const RHYTHM_MAX_INTERVAL_MS = 75_000;

/** One frame's classification, aggregated over tiles. */
export interface NoveltyResult {
  changedTiles: number;
  novelTiles: number;
  oscillatingTiles: number;
  rhythmicTiles: number;
}

interface TileState {
  current: number;
  previous: number;
  changes: number;
  lastChangeAt: number;
  /** Exponential means of the change interval and its absolute deviation. */
  emaIntervalMs: number;
  emaDeviationMs: number;
}

export class TileTracker {
  private tiles: TileState[] = [];
  private cols = 0;
  private rows = 0;
  private width = 0;
  private height = 0;

  /** Forget everything — a new console, or a deliberate restart. */
  reset(): void {
    this.tiles = [];
    this.width = 0;
    this.height = 0;
  }

  /**
   * Classify one decoded frame against the tracked history.
   *
   * The first frame after construction/reset/resize is the baseline and
   * reports no change — there is nothing to compare against yet.
   */
  update(png: PNG, at: number): NoveltyResult {
    const result: NoveltyResult = { changedTiles: 0, novelTiles: 0, oscillatingTiles: 0, rhythmicTiles: 0 };
    if (png.width !== this.width || png.height !== this.height) {
      this.rebaseline(png);
      return result;
    }
    const hashes = this.hashTiles(png);
    for (let i = 0; i < hashes.length; i++) {
      const tile = this.tiles[i];
      const hash = hashes[i];
      if (hash === tile.current) {
        continue;
      }
      result.changedTiles++;

      // A return to the immediately-previous state is a blink, not news.
      const oscillating = hash === tile.previous;

      // Track cadence on every change, so a rhythm can be recognised.
      const interval = tile.lastChangeAt > 0 ? at - tile.lastChangeAt : 0;
      if (interval > 0) {
        if (tile.emaIntervalMs === 0) {
          tile.emaIntervalMs = interval;
          tile.emaDeviationMs = 0;
        } else {
          const deviation = Math.abs(interval - tile.emaIntervalMs);
          tile.emaIntervalMs = tile.emaIntervalMs * 0.7 + interval * 0.3;
          tile.emaDeviationMs = tile.emaDeviationMs * 0.7 + deviation * 0.3;
        }
      }
      tile.changes++;
      tile.lastChangeAt = at;
      tile.previous = tile.current;
      tile.current = hash;

      if (oscillating) {
        result.oscillatingTiles++;
        continue;
      }
      const rhythmic =
        tile.changes >= RHYTHM_MIN_CHANGES &&
        tile.emaIntervalMs > 0 &&
        tile.emaIntervalMs <= RHYTHM_MAX_INTERVAL_MS &&
        tile.emaDeviationMs <= tile.emaIntervalMs * RHYTHM_MAX_DEVIATION;
      if (rhythmic) {
        result.rhythmicTiles++;
      } else {
        result.novelTiles++;
      }
    }
    return result;
  }

  private rebaseline(png: PNG): void {
    this.width = png.width;
    this.height = png.height;
    this.cols = Math.max(1, Math.ceil(png.width / TILE_SIZE));
    this.rows = Math.max(1, Math.ceil(png.height / TILE_SIZE));
    const hashes = this.hashTiles(png);
    this.tiles = Array.from(hashes, (h) => ({
      current: h,
      previous: 0,
      changes: 0,
      lastChangeAt: 0,
      emaIntervalMs: 0,
      emaDeviationMs: 0,
    }));
  }

  /** FNV-1a per tile over the stride-sampled pixels. */
  private hashTiles(png: PNG): Uint32Array {
    const hashes = new Uint32Array(this.cols * this.rows).fill(0x811c9dc5);
    const { width, height, data } = png;
    for (let y = 0; y < height; y += STRIDE) {
      const rowTile = Math.floor(y / TILE_SIZE) * this.cols;
      for (let x = 0; x < width; x += STRIDE) {
        const i = (width * y + x) << 2;
        const t = rowTile + Math.floor(x / TILE_SIZE);
        let h = hashes[t];
        h = Math.imul(h ^ data[i], 0x01000193);
        h = Math.imul(h ^ data[i + 1], 0x01000193);
        h = Math.imul(h ^ data[i + 2], 0x01000193);
        hashes[t] = h >>> 0;
      }
    }
    return hashes;
  }
}
