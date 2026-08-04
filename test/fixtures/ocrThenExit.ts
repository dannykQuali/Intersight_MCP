/**
 * Fixture: OCR one frame, then fall off the end of the script.
 *
 * Deliberately does NOT call process.exit() or terminate() — the point is that a
 * process which merely USED OCR must still be able to exit by itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PNG } from 'pngjs';
import { FrameOcr } from '../../src/services/frameOcr.js';

// A tiny blank frame: this test is about process lifetime, not recognition, and
// a small image keeps it fast.
const png = new PNG({ width: 64, height: 32 });
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = 255;
  png.data[i + 1] = 255;
  png.data[i + 2] = 255;
  png.data[i + 3] = 255;
}
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-exit-')), 'frame.png');
fs.writeFileSync(file, PNG.sync.write(png));

const ocr = new FrameOcr();
await ocr.textOf(file);
console.log('OCR_DONE');
