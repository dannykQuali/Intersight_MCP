/**
 * A broken OCR engine must be rebuilt, not used forever.
 *
 * Found on a live recorder: 570 consecutive OCR failures and zero successes. The
 * engine had initialised fine (`ocrUnavailable` was null) and then broken
 * mid-life, and because the error was swallowed and the object kept, every frame
 * for the rest of that process failed the same way.
 *
 * It cost more than the transcript. The green "No Signal" screen's REASON is read
 * by OCR, so with OCR dead `classifyNoSignal` returned `unknown` and the recorder
 * never woke the console — `wakes: 0` across 28 hours, while the operator watched
 * it sit blank for two to four minutes at a time and cleared it by hand.
 *
 * So: count failures, keep the reason, and after a few in a row throw the engine
 * away so the next call builds a fresh one.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { FrameOcr } from '../src/services/frameOcr.js';

/** An engine that fails a given number of detect() calls, then works. */
function flakyEngine(failuresBeforeWorking: number) {
  const stats = { built: 0, detects: 0 };
  let remaining = failuresBeforeWorking;
  const create = async () => {
    stats.built++;
    return {
      async detect() {
        stats.detects++;
        if (remaining > 0) {
          remaining--;
          throw new Error('onnxruntime session is closed');
        }
        // The shape linesToText expects: detected lines with text and a box.
        return [{ text: 'hello console', mean: 0.99, box: [{ x: 300, y: 300 }] }];
      },
    };
  };
  return { create, stats, brokenForever: () => (remaining = Number.MAX_SAFE_INTEGER) };
}

const FRAME = Buffer.from('not a real png, the fake engine never looks at it');

describe('recovering from a broken OCR engine', () => {
  it('reports the failure reason instead of swallowing it', async () => {
    const e = flakyEngine(1);
    const ocr = new FrameOcr(e.create);

    assert.equal(await ocr.textOfBuffer(FRAME), null);
    const health = ocr.health();
    assert.equal(health.failures, 1);
    assert.match(String(health.lastError), /onnxruntime/);
    assert.equal(health.unavailable, null, 'the engine initialised, so it is not "unavailable"');
  });

  it('rebuilds the engine after repeated failures, and then works again', async () => {
    // Three failures is enough evidence that the engine, not the frame, is broken.
    const e = flakyEngine(3);
    const ocr = new FrameOcr(e.create);

    for (let i = 0; i < 3; i++) {
      assert.equal(await ocr.textOfBuffer(FRAME), null, `call ${i + 1} should fail`);
    }
    assert.equal(ocr.health().rebuilds, 1, 'the engine must have been discarded');

    const text = await ocr.textOfBuffer(FRAME);
    assert.match(String(text), /hello console/, 'the rebuilt engine must be used');
    assert.equal(e.stats.built, 2, 'built once, then rebuilt once');
  });

  it('does not churn the engine over a single bad frame', async () => {
    // One unreadable frame is not evidence of a broken engine.
    const e = flakyEngine(1);
    const ocr = new FrameOcr(e.create);
    await ocr.textOfBuffer(FRAME);
    assert.equal(ocr.health().rebuilds, 0);
    assert.equal(e.stats.built, 1);
  });

  it('resets the failure streak once a frame reads successfully', async () => {
    const e = flakyEngine(2);
    const ocr = new FrameOcr(e.create);
    await ocr.textOfBuffer(FRAME);
    await ocr.textOfBuffer(FRAME);
    assert.equal(ocr.health().consecutive, 2);

    await ocr.textOfBuffer(FRAME); // succeeds
    assert.equal(ocr.health().consecutive, 0, 'a success means the engine is alive again');
    assert.equal(ocr.health().failures, 2, 'but the total is still reported');
  });

  it('keeps rebuilding rather than giving up on a permanently broken engine', async () => {
    // The alternative — latching "unavailable" — is what would turn a transient
    // fault into a dead recorder for the rest of the process's life.
    const e = flakyEngine(0);
    e.brokenForever();
    const ocr = new FrameOcr(e.create);
    for (let i = 0; i < 7; i++) {
      await ocr.textOfBuffer(FRAME);
    }
    assert.ok(ocr.health().rebuilds >= 2, `expected repeated rebuilds, saw ${ocr.health().rebuilds}`);
    assert.equal(ocr.health().unavailable, null);
  });

  it('reports an engine that cannot be built at all as unavailable', async () => {
    // A different fault with a different remedy: the model is missing or the
    // native module will not load, and no amount of rebuilding helps.
    const ocr = new FrameOcr(async () => {
      throw new Error('Cannot find module onnxruntime-node');
    });
    assert.equal(await ocr.textOfBuffer(FRAME), null);
    assert.match(String(ocr.health().unavailable), /onnxruntime-node/);
  });
});
