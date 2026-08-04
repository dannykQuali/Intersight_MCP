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
 * OCR of recorded console frames, via PaddleOCR (ONNX).
 *
 * Engine choice is the whole story here. The previous engine (tesseract.js) is
 * a document-scan engine: it binarises GLOBALLY, so a frame whose console area
 * is mostly black swamped the threshold and text a human could plainly read
 * came back as literally nothing (confidence 0, zero characters, measured on a
 * real frame). Compensating required a stack of workarounds - page-segmentation
 * tuning, a confidence gate, a hand-tuned crop rectangle with hardcoded pixel
 * offsets - and the crop then mutilated consoles whose layout differed ("Cisco
 * Systems" read as "ystems" on a narrower viewport).
 *
 * PaddleOCR detects text regions with a learned model first and recognises each
 * line separately, so a dark background is just background. Benchmarked on the
 * same frames (dense synthetic kernel log, lock screen over a photo, login
 * screen, green "No Signal", textless spinner): 9/10 expected strings against
 * tesseract's 6/10, with the two wins exactly where they matter - dense
 * terminal text (4/4 vs 2/4) and text over photo backgrounds (2/2 vs 0/2) -
 * and zero hallucination on the textless frame.
 *
 * The runtime is also better behaved: no worker process, so nothing holds the
 * event loop open (a short-lived process that OCRs still exits by itself -
 * regression-tested), and nothing to idle-terminate.
 *
 * Everything fails soft: if the engine cannot load, an unavailable flag is set
 * rather than an error thrown, and recording continues without a transcript.
 */
import fs from 'fs';

/**
 * Detected lines entirely inside the Intersight chrome, dropped by position.
 *
 * The left nav is a fixed ~210px column and the top bar ~50px tall. Filtering
 * DETECTED LINES by their box keeps the transcript to what the server said
 * (hostname, menu labels and the operator's name never belong in it) - and
 * unlike the old pixel-space crop, it cannot mutilate console text: a line
 * either sits wholly inside the chrome strips or it is kept whole.
 */
const NAV_EDGE_X = 220;
const TOP_BAR_Y = 55;

/**
 * Per-line confidence below which a detection is discarded. Real console lines
 * benchmark well above this; the rare speck the detector imagines on a blank
 * screen does not.
 */
const MIN_LINE_CONFIDENCE = 0.3;

/** One detected line: text, mean confidence, and a 4-point box. */
interface DetectedLine {
  text: string;
  mean: number;
  box: Array<[number, number]>;
}

export class FrameOcr {
  /** path -> recognised text. Frames are immutable, so this never goes stale. */
  private cache = new Map<string, string>();
  private engine: { detect(image: string | Buffer): Promise<unknown> } | null = null;
  private initPromise: Promise<typeof this.engine> | null = null;
  private unavailableReason: string | null = null;

  private async getEngine(): Promise<typeof this.engine> {
    if (this.engine) {
      return this.engine;
    }
    if (this.unavailableReason) {
      return null;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { default: Ocr } = await import('@gutenye/ocr-node');
          this.engine = await Ocr.create();
          return this.engine;
        } catch (error) {
          this.unavailableReason = (error as Error).message?.slice(0, 200) ?? String(error);
          return null;
        }
      })();
    }
    return this.initPromise;
  }

  isUnavailable(): string | null {
    return this.unavailableReason;
  }

  /**
   * Order and filter detected lines into a transcript-ready string.
   *
   * Detection returns lines in no useful order; a console transcript needs
   * top-to-bottom, left-to-right. Lines are banded into rows (a console line is
   * ~16-22px tall) and sorted within each band.
   */
  private linesToText(result: unknown): string {
    const items = (Array.isArray(result) ? result : []) as DetectedLine[];
    const kept = items.filter((l) => {
      if (!l || typeof l.text !== 'string' || !Array.isArray(l.box)) {
        return false;
      }
      if (typeof l.mean === 'number' && l.mean < MIN_LINE_CONFIDENCE) {
        return false;
      }
      const xs = l.box.map((p) => p[0]);
      const ys = l.box.map((p) => p[1]);
      // Entirely within the nav column or the top bar: chrome, not console.
      if (Math.max(...xs) < NAV_EDGE_X || Math.max(...ys) < TOP_BAR_Y) {
        return false;
      }
      return true;
    });
    const keyed = kept.map((l) => {
      const xs = l.box.map((p) => p[0]);
      const ys = l.box.map((p) => p[1]);
      return { text: l.text, top: Math.min(...ys), left: Math.min(...xs) };
    });
    keyed.sort((a, b) => {
      const rowA = Math.round(a.top / 16);
      const rowB = Math.round(b.top / 16);
      return rowA === rowB ? a.left - b.left : rowA - rowB;
    });
    return keyed
      .map((l) => l.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Recognised text for a frame, or null if OCR is unavailable/failed. */
  async textOf(framePath: string): Promise<string | null> {
    const cached = this.cache.get(framePath);
    if (cached !== undefined) {
      return cached;
    }
    const engine = await this.getEngine();
    if (!engine) {
      return null;
    }
    try {
      // Read the file ourselves: the engine's own file loader mishandles some
      // path styles (observed with POSIX-style paths on Windows), and the
      // recorder already knows the file exists.
      const buf = await fs.promises.readFile(framePath);
      const text = this.linesToText(await engine.detect(buf));
      // Bound the cache; frames age out of the ring buffer anyway.
      if (this.cache.size > 500) {
        this.cache.clear();
      }
      this.cache.set(framePath, text);
      return text;
    } catch {
      return null;
    }
  }

  /** Recognise straight from an in-memory PNG (no cache — buffers are one-off). */
  async textOfBuffer(buf: Buffer): Promise<string | null> {
    const engine = await this.getEngine();
    if (!engine) {
      return null;
    }
    try {
      return this.linesToText(await engine.detect(buf));
    } catch {
      return null;
    }
  }

  cachedCount(): number {
    return this.cache.size;
  }

  /**
   * Drop the engine so its models can be reclaimed. Purely advisory now: this
   * engine holds no worker and keeps nothing alive - a process that used it
   * exits by itself (regression-tested) - so unlike its predecessor, forgetting
   * to call this cannot strand a process.
   */
  async terminate(): Promise<void> {
    this.engine = null;
    this.initPromise = null;
  }
}
