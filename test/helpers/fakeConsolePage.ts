/**
 * Minimal stand-in for a Playwright Page showing a vKVM console.
 *
 * Only the two members VkvmRecorder actually touches are implemented
 * (`isClosed` and `screenshot`), so the recorder under test runs its real
 * capture/diff/recovery logic against controllable frames instead of a browser.
 */
import { PNG } from 'pngjs';
import type { Page } from 'playwright-core';

/** A solid WxH PNG of the given grey level. */
export function solidPng(level: number, width = 16, height = 16): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = level;
    png.data[i + 1] = level;
    png.data[i + 2] = level;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A frame with a bright mark whose POSITION depends on the seed — like real
 * console output, each update lands somewhere new.
 *
 * Fixtures that "changed" by cycling whole-frame colours or toggling two frames
 * stopped working the moment change classification got smarter: a regular
 * whole-frame cycle is RHYTHMIC and a two-frame toggle is OSCILLATING, both
 * correctly ignored. New content in fresh locations is what genuine activity
 * looks like, so it is what activity fixtures must produce.
 */
export function movingMarkFrame(seed: number, width = 200, height = 200): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 3] = 255;
  }
  const x = (seed * 53) % (width - 10);
  const y = (seed * 37) % (height - 10);
  for (let dy = 0; dy < 10; dy++) {
    for (let dx = 0; dx < 10; dx++) {
      const i = (width * (y + dy) + (x + dx)) << 2;
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
    }
  }
  return PNG.sync.write(png);
}

export class FakeConsolePage {
  private closed = false;
  /** Number of screenshots taken - lets a test see the capture loop running. */
  public shots = 0;

  constructor(private frame: Buffer = solidPng(0)) {}

  setFrame(buf: Buffer): void {
    this.frame = buf;
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async screenshot(): Promise<Buffer> {
    this.shots++;
    if (this.closed) {
      throw new Error('page is closed');
    }
    return this.frame;
  }

  /** The recorder's parameter type is Page; only the above members are used. */
  asPage(): Page {
    return this as unknown as Page;
  }
}

/** Poll until `predicate` holds, or throw after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  pollMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}
