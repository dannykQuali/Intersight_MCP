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
 * On-demand OCR of recorded console frames.
 *
 * Why on demand and not at capture time: recognising a 1600x900 frame costs
 * ~0.6-1.4s, so OCR-ing every frame at 1 fps is not viable. Searching a bounded
 * set of recent frames when the agent actually asks is, and that is the case
 * that matters — "did ERROR / FAILED / press any key appear while I wasn't
 * looking" answered WITHOUT spending image tokens.
 *
 * Accuracy note (measured on real console frames): prominent text — dialogs,
 * headings, full-screen messages — reads reliably; small sidebar chrome is
 * hit-and-miss. That suits failure detection, which is about conspicuous text.
 *
 * Everything here fails soft: tesseract.js fetches its language data on first
 * use, so an offline host simply gets an unavailable flag rather than an error.
 */
export class FrameOcr {
  /** path -> recognised text. Frames are immutable, so this never goes stale. */
  private cache = new Map<string, string>();
  private worker: any | null = null;
  private initPromise: Promise<any | null> | null = null;
  private unavailableReason: string | null = null;

  private async getWorker(): Promise<any | null> {
    if (this.worker) {
      return this.worker;
    }
    if (this.unavailableReason) {
      return null;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { createWorker } = await import('tesseract.js');
          this.worker = await createWorker('eng');
          return this.worker;
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

  /** Recognised text for a frame, or null if OCR is unavailable/failed. */
  async textOf(framePath: string): Promise<string | null> {
    const cached = this.cache.get(framePath);
    if (cached !== undefined) {
      return cached;
    }
    const worker = await this.getWorker();
    if (!worker) {
      return null;
    }
    try {
      const { data } = await worker.recognize(framePath);
      const text = (data?.text ?? '').replace(/\s+/g, ' ').trim();
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
    const worker = await this.getWorker();
    if (!worker) {
      return null;
    }
    try {
      const { data } = await worker.recognize(buf);
      return (data?.text ?? '').replace(/\s+/g, ' ').trim();
    } catch {
      return null;
    }
  }

  cachedCount(): number {
    return this.cache.size;
  }

  async terminate(): Promise<void> {
    try {
      await this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
    this.initPromise = null;
  }
}
