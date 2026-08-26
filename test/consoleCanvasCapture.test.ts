/**
 * Capture the console from the CANVAS, not through the compositor.
 *
 * An elevated investigation (docs/RECORDER_DISPLAY_POWER_REQUEST.md) traced a
 * security defect to this project: each active recorder screenshots its console
 * tab once per second, and in headful Chromium that capture makes the browser
 * hold a Windows DisplayRequired power request (`powercfg /requests` reports
 * holder `msedge.exe`, reason `Capturing`, one entry per capturing renderer).
 * With one recorder the request flickers; with two or three the gaps vanish and
 * it is held permanently. Windows implements the machine-inactivity lock by
 * running the screen saver, and a held display request suppresses it — so the
 * laptop could not auto-lock. Measured: 0 policy-timer locks while a request was
 * held, 44 without; and an overnight run left an authenticated session unlocked
 * for 14.5 hours.
 *
 * The console's pixels do not need the compositor. The client paints the server's
 * screen into `canvas#kvmCanvas`, so the frame can be read from the canvas's own
 * backing store inside the renderer — no capture path, no power request. Verified
 * live: 1024x768, faithful to the viewport screenshot taken at the same instant
 * (both showed the same blanked console).
 *
 * Two consequences the caller must handle, and which these tests pin down:
 *
 *  - The frame is the CANVAS, so it has no client chrome. OCR must not apply its
 *    chrome-position filter to such a frame, or a shell prompt at the left edge
 *    would be discarded as navigation furniture.
 *  - Frame coordinates become canvas-space, not viewport-space, so mouse input
 *    derived from a frame must be sent relative to the canvas.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { movingMarkFrame } from './helpers/fakeConsolePage.js';
import {
  consoleCanvasGeometryPageScript,
  consoleCanvasCapturePageScript,
  decodeCanvasCapture,
  MIN_CAPTURE_BYTES,
} from '../src/utils/consoleCanvasCapture.js';

/** A minimal but real 1x1 PNG, base64-encoded. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function dataUrl(b64: string): string {
  return `data:image/png;base64,${b64}`;
}

/** A REAL png, big enough to pass the size floor — the same generator the
 *  recorder tests use, so the fixture cannot drift from a genuine image. */
const BIG_PNG = movingMarkFrame(1, 640, 480);
const BIG_B64 = BIG_PNG.toString('base64');

describe('decoding a canvas capture', () => {
  it('has a fixture that is genuinely a PNG above the floor', () => {
    // Guards the fixture itself: a fabricated base64 blob would make the size and
    // signature checks below vacuous.
    assert.ok(BIG_PNG.length > MIN_CAPTURE_BYTES, `fixture is only ${BIG_PNG.length} bytes`);
    assert.equal(BIG_PNG.subarray(1, 4).toString(), 'PNG');
  });

  it('decodes a PNG data URL into bytes', () => {
    const out = decodeCanvasCapture({ ok: true, dataUrl: dataUrl(BIG_B64), w: 1024, h: 768 });
    assert.ok('png' in out, JSON.stringify(out));
    assert.ok(out.png.length > MIN_CAPTURE_BYTES);
    assert.equal(out.width, 1024);
    assert.equal(out.height, 768);
  });

  it('rejects a capture the page could not take', () => {
    const out = decodeCanvasCapture({ ok: false, reason: 'no canvas in this page' });
    assert.ok('error' in out);
    assert.match(out.error, /no canvas/);
  });

  it('rejects anything that is not a PNG data URL', () => {
    // A tainted or WebGL canvas can throw, or hand back "data:," — neither must
    // be stored as if it were a frame.
    const notAPng = dataUrl(Buffer.from('x'.repeat(MIN_CAPTURE_BYTES * 2)).toString('base64'));
    for (const bad of ['data:,', 'data:image/png;base64,', 'not-a-url', '', null, undefined, 42, notAPng]) {
      // A plausible size, so this exercises the URL checks rather than the
      // readiness floor.
      const out = decodeCanvasCapture({ ok: true, dataUrl: bad as never, w: 1024, h: 768 });
      assert.ok('error' in out, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('treats a blank read as NOT READY, not as broken', () => {
    // A WebGL canvas without preserveDrawingBuffer reads back empty, and so does
    // a console canvas in the moment before the stream arrives. Retrying is right;
    // recording thousands of blank frames is not.
    const out = decodeCanvasCapture({ ok: true, dataUrl: dataUrl(TINY_PNG), w: 1024, h: 768 });
    assert.ok('notReady' in out, JSON.stringify(out));
    assert.match(out.notReady, /blank|buffer/i);
  });

  it('treats an unsized canvas as NOT READY — the live first-tick case', () => {
    // Seen live: canvas#kvmCanvas exists at the HTML default 300x150 one second
    // after launch, before the client sizes it. Locking into screenshot mode over
    // that would give up on the fix permanently.
    const out = decodeCanvasCapture({ ok: true, dataUrl: dataUrl(BIG_B64), w: 300, h: 150 });
    assert.ok('notReady' in out, JSON.stringify(out));
    assert.match(out.notReady, /300x150|sized|floor/i);
  });

  it('rejects a zero-sized canvas', () => {
    const out = decodeCanvasCapture({ ok: true, dataUrl: dataUrl(BIG_B64), w: 0, h: 0 });
    assert.ok('error' in out);
    assert.match(out.error, /size|zero/i);
  });

  it('rejects a null result, which is what a page throw looks like', () => {
    assert.ok('error' in decodeCanvasCapture(null));
    assert.ok('error' in decodeCanvasCapture(undefined));
  });
});

describe('the in-page capture script', () => {
  it('parses, and reads the canvas backing store rather than the screen', () => {
    const script = consoleCanvasCapturePageScript();
    assert.doesNotThrow(() => new Function(`return ${script}`), 'the page script must parse');
    assert.match(script, /toDataURL/, 'the whole point is to read the canvas itself');
    assert.doesNotMatch(script, /captureScreenshot|getDisplayMedia/, 'no compositor capture');
  });

  it('finds the console canvas through nested shadow roots', () => {
    // canvas#kvmCanvas lives two shadow roots down: kvm-ui > kvm-video > canvas.
    const script = consoleCanvasCapturePageScript();
    assert.match(script, /shadowRoot/);
    assert.match(script, /kvmCanvas/);
  });

  it('reports a reason when there is no canvas, instead of returning nothing', () => {
    assert.match(consoleCanvasCapturePageScript(), /reason/);
  });

  it('never throws out of the page, because a throw would look like a dead console', () => {
    const script = consoleCanvasCapturePageScript();
    assert.match(script, /try|catch/);
  });
});

describe('the canvas geometry probe', () => {
  it('parses and reports both the box and the backing store', () => {
    // Both are required: a canvas frame is in the backing store, the pointer is in
    // CSS pixels, and they differ by a ratio as well as an offset.
    const script = consoleCanvasGeometryPageScript();
    assert.doesNotThrow(() => new Function(`return ${script}`));
    assert.match(script, /getBoundingClientRect/);
    assert.match(script, /backing/);
  });

  it('finds the canvas by the same rule as the capture', () => {
    // If the click and the capture ever picked different canvases, every
    // coordinate would be silently wrong.
    const capture = consoleCanvasCapturePageScript();
    const geometry = consoleCanvasGeometryPageScript();
    for (const rule of ['kvmCanvas', 'shadowRoot', '320', '240']) {
      assert.ok(capture.includes(rule) && geometry.includes(rule), `both must share the rule: ${rule}`);
    }
  });

  it('reports an unknown geometry rather than throwing', () => {
    assert.match(consoleCanvasGeometryPageScript(), /box: null/);
  });
});
