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
 * The exact fill the CIMC paints behind "No Signal" — CSS `green`, measured off
 * a live console at 88.6% of the video region.
 *
 * The placeholder is drawn into the VIDEO SURFACE, not the DOM: a live console
 * showing it has no "No Signal" text anywhere in the document or in any shadow
 * root (verified — `document.body.textContent` does not contain the phrase and
 * there is no canvas in the light DOM). So it can only be detected from pixels,
 * which is why this constant exists rather than a selector.
 */
export const NO_SIGNAL_RGB = { r: 0, g: 128, b: 0 };

/** Small tolerance for the video path's colour handling. */
const RGB_TOLERANCE = 12;

/**
 * Fraction of the CONSOLE REGION that is the flat "No Signal" green.
 *
 * The Intersight chrome (left nav, top bar) is excluded by sampling only the
 * right/lower part of the frame, and every 4th pixel is sampled - enough for a
 * fill that covers most of the screen, and cheap enough to run on every
 * screenshot.
 */
export function noSignalGreenFraction(png: {
  width: number;
  height: number;
  data: Buffer | Uint8Array;
}): number {
  const x0 = Math.round(png.width * 0.25);
  const y0 = Math.round(png.height * 0.1);
  let green = 0;
  let total = 0;
  for (let y = y0; y < png.height; y += 4) {
    for (let x = x0; x < png.width; x += 4) {
      const i = (png.width * y + x) << 2;
      total++;
      if (
        Math.abs(png.data[i] - NO_SIGNAL_RGB.r) <= RGB_TOLERANCE &&
        Math.abs(png.data[i + 1] - NO_SIGNAL_RGB.g) <= RGB_TOLERANCE &&
        Math.abs(png.data[i + 2] - NO_SIGNAL_RGB.b) <= RGB_TOLERANCE
      ) {
        green++;
      }
    }
  }
  return total === 0 ? 0 : green / total;
}

/**
 * How much flat green means the console is showing a placeholder.
 *
 * Measured 88.6% on a real "No Signal" screen; 0.5 leaves a wide margin both
 * ways, since no real console screen is half flat CSS-green.
 */
export const NO_SIGNAL_GREEN_THRESHOLD = 0.5;

/** What a green "No Signal" console screen means, and what (if anything) fixes it. */
export interface NoSignalState {
  /** The console is showing a placeholder rather than the server's video. */
  blanked: boolean;
  /**
   * null when the console is fine. 'unknown' when it IS blanked but the reason
   * is one we have not seen - deliberately not silently treated as healthy.
   */
  kind: 'inactivity' | 'dropped' | 'power-off' | 'unknown' | null;
  /** The reason text as the console phrased it, for the caller to read. */
  reason: string | null;
  /** What the caller should do, or null when nothing console-side can help. */
  remedy: string | null;
}

const HEALTHY: NoSignalState = { blanked: false, kind: null, reason: null, remedy: null };

/**
 * Classify the green "No Signal" screen from the console's own text.
 *
 * Kept as a pure function over the extracted text (rather than regexes inside
 * page.evaluate) so every reason we have met in the field is pinned by a test.
 * Three exist so far, and they need three different responses:
 *
 *   User Inactivity          the host VIDEO is asleep -> send a key. Relaunching
 *                            does nothing; the screen states the fix itself.
 *   Connection ... dropped   the TUNNEL died -> relaunch, but only after it
 *                            persists; the client often reconnects by itself.
 *   Host power is off        the SERVER is off -> nothing console-side applies.
 *                            Reported so a caller cannot mistake a powered-down
 *                            machine for a healthy idle one (observed live: a
 *                            recorder sat happily on this screen for hours).
 *
 * Matching requires the human-readable phrasing: the client ships i18n keys
 * like `ucsSessionMgr.expired.*` in the DOM of perfectly healthy consoles, so
 * loose patterns false-positive. For the same reason the lingering "Virtual
 * Media session has been disconnected ... Network connection has been dropped"
 * toast must NOT match - it describes a past event on a live console, and
 * treating it as a failure previously caused a relaunch loop.
 */
export function classifyNoSignal(
  text: string | null | undefined,
  opts: { blanked?: boolean } = {}
): NoSignalState {
  if (!text) {
    // Pixels can prove the screen is a placeholder even when no text is
    // readable (OCR unavailable, or a reason we could not resolve).
    return opts.blanked ? { blanked: true, kind: 'unknown', reason: null, remedy: null } : HEALTHY;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  const isNoSignal = /\bNo Signal\b/i.test(flat);
  if (!isNoSignal && !opts.blanked) {
    return HEALTHY;
  }
  const reason = flat.match(/Reason:\s*([^.\n]{1,120})/i)?.[1]?.trim() ?? null;
  const subject = reason ?? flat;

  if (/User Inactivity|Press a key to wake/i.test(subject)) {
    return {
      blanked: true,
      kind: 'inactivity',
      reason,
      remedy: 'Send a key (browser_send_keys keys:["Shift"]). The host video is asleep; relaunching does nothing.',
    };
  }
  if (/Connection to server dropped|attempting to reconnect/i.test(subject)) {
    return {
      blanked: true,
      kind: 'dropped',
      reason,
      remedy:
        'Wait ~40s for the client to reconnect itself; if it persists, relaunch with launch_vkvm_session forceNew:true.',
    };
  }
  if (/power is off|powered off|power off/i.test(subject)) {
    return {
      blanked: true,
      kind: 'power-off',
      reason,
      // Deliberately null: no console action helps, and suggesting one would
      // send a caller round the recovery loop for a machine that is simply off.
      remedy: null,
    };
  }
  return { blanked: true, kind: 'unknown', reason, remedy: null };
}
