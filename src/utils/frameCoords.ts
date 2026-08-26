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
 * Convert coordinates read off a DOWNSCALED frame into page pixels.
 *
 * Recorded frames (vkvm_recent, vkvm_frames_at) default to scale 0.7 to save
 * image tokens, while mouse input takes unscaled page pixels. Passing the
 * former straight to the latter silently lands the click ~30-50% off, which
 * looks exactly like "input is not being delivered" - a real field
 * misdiagnosis. Callers reading coordinates off a scaled filmstrip pass that
 * scale here (browser_mouse `fromScale`) instead of doing the arithmetic.
 */
export function fromScaledFrame(x: number, y: number, scale?: number): { x: number; y: number } {
  // No scale, or a nonsense one: click where the caller asked rather than
  // dividing by zero and sending the pointer to infinity.
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (scale > 1) {
    throw new Error(`fromScale must be between 0 and 1 (the scale the frame was rendered at), got ${scale}`);
  }
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

/** Where a canvas sits on the page, and how big its backing store is. */
export interface CanvasGeometry {
  /** The canvas's position and displayed size in CSS pixels; null if unknown. */
  box: { x: number; y: number; width: number; height: number } | null;
  /** The canvas's own pixel dimensions — the space a canvas frame is in. */
  backing: { width: number; height: number };
}

export interface MappedPoint {
  x: number;
  y: number;
  /** The ratio applied on each axis, for reporting. 1 = none. */
  scaleX: number;
  scaleY: number;
  /** False when there was no canvas box, so the point was left alone. */
  applied: boolean;
}

/**
 * Turn a point read off a CANVAS frame into a viewport point.
 *
 * A canvas frame is in the canvas's backing store — the server's own resolution —
 * while the pointer lives in CSS pixels on the page. The two differ by both an
 * offset AND a ratio, and only the offset used to be applied. Measured live:
 * backing 1024x768 displayed at 1011x758 (ratio 0.987), which is 13px of error at
 * the right edge. The ratio is set by the window size against the server's video
 * mode, so it is not always near 1: a 1920x1080 console in the same 1011px-wide
 * box gives 0.53, and a click meant for x=1900 would land ~900px away.
 *
 * Degrades rather than throwing: an unknown backing size skips the ratio (an
 * offset is still better than nothing), and a missing box leaves the point alone.
 */
export function canvasPointToViewport(x: number, y: number, geometry: CanvasGeometry): MappedPoint {
  const { box, backing } = geometry;
  if (!box) {
    return { x: Math.round(x), y: Math.round(y), scaleX: 1, scaleY: 1, applied: false };
  }
  const scaleX = backing.width > 0 ? box.width / backing.width : 1;
  const scaleY = backing.height > 0 ? box.height / backing.height : 1;
  return {
    x: Math.round(box.x + x * scaleX),
    y: Math.round(box.y + y * scaleY),
    scaleX,
    scaleY,
    applied: true,
  };
}
