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
