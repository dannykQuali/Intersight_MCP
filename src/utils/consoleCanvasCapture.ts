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
 * Read a console frame from the CANVAS instead of screenshotting the tab.
 *
 * Screenshotting is what made this a security defect. Each active recorder
 * captured its tab once a second, and in headful Chromium that capture makes the
 * browser hold a Windows DisplayRequired power request (`powercfg /requests`:
 * holder `msedge.exe`, reason `Capturing`, one entry per capturing renderer).
 * One recorder made it flicker; two or three held it permanently. Windows runs
 * the machine-inactivity lock through the screen saver, and a held display
 * request suppresses the screen saver — so the laptop could not auto-lock.
 * Measured over 13 days: 0 policy-timer locks while a request was held, 44
 * without, and one overnight run left an authenticated session unlocked for 14.5
 * hours. Full investigation: docs/RECORDER_DISPLAY_POWER_REQUEST.md.
 *
 * None of that is needed to get the server's screen. The client paints it into
 * `canvas#kvmCanvas`, so the pixels can be read from the canvas's own backing
 * store inside the renderer — no compositor, no capture path, no power request.
 * Verified live: 1024x768 and faithful to a viewport screenshot taken at the same
 * instant.
 *
 * The trade is that a frame is now the canvas alone: no client chrome (so OCR
 * must not apply its chrome-position filter) and coordinates are canvas-space (so
 * mouse input from a frame goes relative to the canvas). Both are handled by the
 * caller, and both are why this returns the dimensions it read.
 */

/**
 * Smallest believable console frame.
 *
 * A WebGL canvas read without `preserveDrawingBuffer` comes back empty, and an
 * empty 1024x768 PNG is on the order of a kilobyte. Recording thousands of blank
 * frames would be a worse failure than the one being fixed, so anything this
 * small is refused and the caller falls back to a real screenshot.
 */
export const MIN_CAPTURE_BYTES = 2048;

/**
 * Smallest canvas that could plausibly be a server's screen.
 *
 * `canvas#kvmCanvas` exists before the video stream arrives, at the HTML default
 * of 300x150 — seen live on the first tick after launch. Accepting that would
 * have recorded a blank thumbnail as the console, so a canvas below this is
 * treated as NOT READY YET rather than as a failure.
 */
export const MIN_CONSOLE_CANVAS = { width: 640, height: 400 };

/** The 8 bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the page script reports back. */
export interface CanvasCaptureResult {
  ok: boolean;
  dataUrl?: string;
  w?: number;
  h?: number;
  reason?: string;
}

export type DecodedCapture =
  | { png: Buffer; width: number; height: number }
  /** Retryable: the canvas is there but not yet a console. */
  | { notReady: string }
  | { error: string };

/** Validate and decode what the page handed back. Never throws. */
export function decodeCanvasCapture(raw: unknown): DecodedCapture {
  if (!raw || typeof raw !== 'object') {
    return { error: 'the page returned nothing (the capture script threw)' };
  }
  const result = raw as CanvasCaptureResult;
  if (!result.ok) {
    return { error: result.reason ?? 'the page could not capture the canvas' };
  }
  const width = Number(result.w ?? 0);
  const height = Number(result.h ?? 0);
  if (!width || !height) {
    return { error: `the canvas reported a zero size (${width}x${height})` };
  }
  const url = typeof result.dataUrl === 'string' ? result.dataUrl : '';
  const marker = 'data:image/png;base64,';
  if (!url.startsWith(marker) || url.length <= marker.length) {
    return { error: 'the canvas did not yield a PNG data URL (it may be tainted or WebGL-backed)' };
  }
  let png: Buffer;
  try {
    png = Buffer.from(url.slice(marker.length), 'base64');
  } catch {
    return { error: 'the canvas data URL was not valid base64' };
  }
  // The 8-byte PNG signature: cheap, and it catches a data URL that claims to be
  // a PNG while carrying something else.
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { error: 'the canvas data URL did not contain a PNG' };
  }
  if (width < MIN_CONSOLE_CANVAS.width || height < MIN_CONSOLE_CANVAS.height) {
    return {
      notReady:
        `the console canvas is still ${width}x${height}, below the ${MIN_CONSOLE_CANVAS.width}x` +
        `${MIN_CONSOLE_CANVAS.height} floor - the client has not sized it for the video stream yet`,
    };
  }
  if (png.length < MIN_CAPTURE_BYTES) {
    return {
      notReady:
        `the canvas read back only ${png.length} bytes for ${width}x${height}, which is a blank buffer ` +
        'rather than a picture of the console',
    };
  }
  return { png, width, height };
}

/**
 * The in-page capture, as a script for page.evaluate.
 *
 * Finds the console canvas through nested shadow roots — it lives two deep
 * (`kvm-ui` > `kvm-video` > `canvas#kvmCanvas`) and `querySelector` does not
 * cross a shadow boundary. Never throws out of the page: a throw is
 * indistinguishable from a dead console to the caller, so failures come back as
 * a reason instead.
 */
export function consoleCanvasCapturePageScript(): string {
  return `(() => {
  try {
    const seen = new Set();
    let found = null;
    const walk = (root, depth) => {
      if (!root || depth > 12 || seen.has(root) || found) return;
      seen.add(root);
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.tagName === 'CANVAS') {
          // The console canvas by id, else the biggest plausible canvas: the
          // client has decorative ones far smaller than a server's screen.
          if (el.id === 'kvmCanvas') { found = el; return; }
          if (el.width >= 320 && el.height >= 240 && (!found || el.width * el.height > found.width * found.height)) {
            found = el;
          }
        }
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    };
    walk(document.body, 0);
    if (!found) return { ok: false, reason: 'no console canvas in this page' };
    return { ok: true, dataUrl: found.toDataURL('image/png'), w: found.width, h: found.height };
  } catch (e) {
    return { ok: false, reason: 'canvas read failed: ' + String((e && e.message) || e).slice(0, 120) };
  }
})()`;
}

/**
 * Read the console canvas's geometry: where it sits, and its backing-store size.
 *
 * Finds the canvas by exactly the same rule the capture uses, so a click and the
 * frame it was read from can never disagree about which canvas is meant. Both
 * numbers are needed because a canvas frame is in the backing store while the
 * pointer is in CSS pixels, and the two differ by a ratio as well as an offset.
 */
export function consoleCanvasGeometryPageScript(): string {
  return `(() => {
  try {
    const seen = new Set();
    let found = null;
    const walk = (root, depth) => {
      if (!root || depth > 12 || seen.has(root) || found) return;
      seen.add(root);
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.tagName === 'CANVAS') {
          if (el.id === 'kvmCanvas') { found = el; return; }
          if (el.width >= 320 && el.height >= 240 && (!found || el.width * el.height > found.width * found.height)) {
            found = el;
          }
        }
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    };
    walk(document.body, 0);
    if (!found) return { box: null, backing: { width: 0, height: 0 } };
    const r = found.getBoundingClientRect();
    return {
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      backing: { width: found.width, height: found.height },
    };
  } catch (e) {
    return { box: null, backing: { width: 0, height: 0 } };
  }
})()`;
}
