/**
 * A text transcript of the console, built as it records.
 *
 * Two field failures motivate this. A parked installer showing "Error setting up
 * software source" produced NO further pixel change, so change-detection
 * reported a calm machine and the wedge was found ~18 minutes later by eye. And
 * twice a perfectly healthy install was nearly declared wedged because a `wget`
 * progress line and an ESXi module loader move too few pixels to register.
 *
 * Pixel-stillness and content-stillness are different questions, and the second
 * one is the one that matters. Note the gate is EVERY STORED FRAME, not frames
 * above some change magnitude: a one-line error is 0.001-0.0026 of the screen
 * while a useless full-screen repaint is 0.5-0.9, so gating on magnitude would
 * skip exactly the frames worth reading.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkvmRecorder, OCR_TEXT_FILENAME } from '../src/services/vkvmRecorder.js';
import { FakeConsolePage, movingMarkFrame, waitFor } from './helpers/fakeConsolePage.js';

const dirs: string[] = [];
const recorders: VkvmRecorder[] = [];

afterEach(() => {
  for (const r of recorders.splice(0)) {
    r.stop();
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vkvm-ocr-test-'));
  dirs.push(d);
  return d;
}

/**
 * A frame with genuinely NEW content — a mark in a fresh place each time, like
 * real console output. (A whole-frame colour cycle at the sampling cadence is
 * correctly classified as rhythmic noise and would not be stored at all.)
 */
function variantFrame(seed: number): Buffer {
  return movingMarkFrame(seed);
}

/**
 * Recorder whose "OCR" is a script of texts, so the transcript logic is tested
 * without the cost or nondeterminism of real recognition. Everything else —
 * storage, change detection, queueing — is the real thing.
 */
function recorderWithScriptedOcr(texts: string[], opts: Record<string, unknown> = {}) {
  const dir = tempDir();
  const page = new FakeConsolePage(variantFrame(0));
  let n = 0;
  const shoot = page.screenshot.bind(page);
  page.screenshot = async () => {
    page.setFrame(variantFrame(++n));
    return shoot();
  };

  const ocrCalls: string[] = [];
  const recorder = new VkvmRecorder(
    page.asPage(),
    dir,
    { intervalMs: 250, antiBlankSeconds: 0, heartbeatSeconds: 3600, ...opts },
    {
      ocrFrame: async (framePath: string) => {
        ocrCalls.push(framePath);
        // Walk the script, then hold the last value.
        return texts[Math.min(ocrCalls.length - 1, texts.length - 1)];
      },
    }
  );
  recorders.push(recorder);
  return { recorder, dir, ocrCalls };
}

function readTranscript(dir: string): Array<Record<string, any>> {
  const file = path.join(dir, OCR_TEXT_FILENAME);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('recorder OCR transcript', () => {
  it('records the text of stored frames beside them', async () => {
    const { recorder, dir } = recorderWithScriptedOcr(['login:', 'login: root', 'Permission denied']);
    recorder.start();

    await waitFor(() => readTranscript(dir).length >= 3, 10000, 'three transcript entries');
    const lines = readTranscript(dir);

    assert.deepEqual(
      lines.slice(0, 3).map((l) => l.text),
      ['login:', 'login: root', 'Permission denied']
    );
    for (const line of lines) {
      assert.ok(line.at, 'each entry is timestamped');
      assert.ok(typeof line.seq === 'number', 'and points back at its frame');
    }
  });

  it('appends only when the TEXT changed, not on every frame', async () => {
    // A screen whose pixels churn but whose words do not: a cursor blinking, a
    // spinner, a clock. The transcript must not fill up with duplicates.
    const { recorder, dir } = recorderWithScriptedOcr(['Installing packages...']);
    recorder.start();

    await waitFor(() => recorder.status().ocr.framesRead >= 5, 10000, 'several frames read');
    const lines = readTranscript(dir);
    assert.equal(lines.length, 1, `identical text must appear once, got ${lines.length}`);
    assert.ok(recorder.status().ocr.framesRead >= 5, 'but every frame was still read');
  });

  it('marks which timeline entries changed the TEXT', async () => {
    // The signal that separates "quietly working" from "wedged": pixels moving
    // is not news, words changing is.
    const { recorder } = recorderWithScriptedOcr(['step 1', 'step 1', 'step 2']);
    recorder.start();

    await waitFor(() => recorder.status().ocr.textChanges >= 2, 10000, 'two text changes');
    const rows = recorder.timeline().filter((r: any) => r.textChanged);
    assert.ok(rows.length >= 2, `timeline should flag text changes, got ${rows.length}`);
  });

  it('reports coverage so "no error found" cannot be confused with "not looked at"', async () => {
    const { recorder } = recorderWithScriptedOcr(['booting']);
    recorder.start();

    await waitFor(() => recorder.status().ocr.framesRead >= 2, 10000, 'frames read');
    const ocr = recorder.status().ocr;

    assert.equal(ocr.enabled, true);
    assert.ok(ocr.framesRead >= 2);
    assert.equal(typeof ocr.pending, 'number', 'backlog must be visible');
    assert.equal(typeof ocr.skipped, 'number', 'and so must anything dropped');
  });

  it('ignores OCR noise on a screen with no real text', async () => {
    // Observed live on a blanked (all-black) console of a powered-ON server:
    // OCR hallucinated a different single character from compression noise on
    // every frame — "<", "a", "A)", "(", "~" — so every frame counted as a text
    // change. That inverts the signal precisely where it matters most: on a
    // frozen black screen, which is a classic wedge, secondsSinceTextChange
    // would never grow and the transcript would fill with junk.
    const { recorder, dir } = recorderWithScriptedOcr(['<', 'a', 'A)', '(', '~', 'C', '‘I', '']);
    recorder.start();

    await waitFor(() => recorder.status().ocr.framesRead >= 6, 10000, 'frames read');
    assert.equal(recorder.status().ocr.textChanges, 0, 'noise is not a text change');
    assert.deepEqual(readTranscript(dir), [], 'and does not pollute the transcript');
  });

  it('still sees real text arriving on a previously blank screen', async () => {
    // The other half of the rule: noise must be ignored WITHOUT swallowing the
    // moment real output appears.
    const { recorder, dir } = recorderWithScriptedOcr([
      '<',
      'a',
      'Booting `Install Rocky Linux 9.5\'',
      'Booting `Install Rocky Linux 9.5\'',
    ]);
    recorder.start();

    await waitFor(() => recorder.status().ocr.textChanges >= 1, 10000, 'the real line to register');
    const lines = readTranscript(dir);
    assert.equal(lines.length, 1, 'exactly one change: the real text');
    assert.match(lines[0].text, /Rocky Linux/);
  });

  it('does not let a wedged OCR call stall the queue forever', async () => {
    // OCR is a third-party worker that has been seen fail to settle. Awaiting it
    // unbounded would park the queue permanently: no transcript, no text signal,
    // and no error either - the recorder would look healthy while the one signal
    // that distinguishes wedged from slow quietly stopped updating.
    const dir = tempDir();
    const page = new FakeConsolePage(variantFrame(0));
    let n = 0;
    const shoot = page.screenshot.bind(page);
    page.screenshot = async () => {
      page.setFrame(variantFrame(++n));
      return shoot();
    };
    const recorder = new VkvmRecorder(
      page.asPage(),
      dir,
      { intervalMs: 250, antiBlankSeconds: 0, heartbeatSeconds: 3600, ocrTimeoutMs: 300 },
      { ocrFrame: () => new Promise<string>(() => {}) } // never settles
    );
    recorders.push(recorder);
    recorder.start();

    await waitFor(() => recorder.status().ocr.failures >= 2, 10000, 'the stuck calls to time out');
    const status = recorder.status();
    assert.equal(status.state, 'recording', 'recording continues regardless');
    assert.ok(status.framesStored >= 2, 'and frames keep being captured');
  });

  it('is off, and says so, when no OCR is available', async () => {
    const dir = tempDir();
    const recorder = new VkvmRecorder(new FakeConsolePage().asPage(), dir, {
      intervalMs: 250,
      antiBlankSeconds: 0,
    });
    recorders.push(recorder);
    recorder.start();

    await waitFor(() => recorder.status().framesStored >= 1, 10000, 'a frame');
    assert.equal(recorder.status().ocr.enabled, false);
    assert.equal(readTranscript(dir).length, 0, 'no transcript without an OCR hook');
  });

  it('survives an OCR that fails or returns nothing', async () => {
    const dir = tempDir();
    const page = new FakeConsolePage(variantFrame(0));
    let n = 0;
    const shoot = page.screenshot.bind(page);
    page.screenshot = async () => {
      page.setFrame(variantFrame(++n));
      return shoot();
    };
    let calls = 0;
    const recorder = new VkvmRecorder(
      page.asPage(),
      dir,
      { intervalMs: 250, antiBlankSeconds: 0, heartbeatSeconds: 3600 },
      {
        ocrFrame: async () => {
          calls++;
          if (calls % 2 === 0) {
            throw new Error('worker died');
          }
          return null; // unavailable / unreadable
        },
      }
    );
    recorders.push(recorder);
    recorder.start();

    // Recording must continue regardless: OCR is an enrichment, not a dependency.
    await waitFor(() => recorder.status().framesStored >= 3, 10000, 'recording to continue');
    assert.equal(recorder.status().state, 'recording');
    assert.ok(recorder.status().ocr.failures >= 1, 'failures are counted, not hidden');
  });
});
