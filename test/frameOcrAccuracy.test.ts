/**
 * The OCR engine must read a console, in order, without inventing text.
 *
 * This runs the REAL engine against a generated console frame, so an engine or
 * model change that regresses console reading fails here rather than in an
 * overnight run. The fixture mirrors the real failure case that forced the
 * engine change: dense 14px monospace kernel-log text on black — which the
 * previous engine (tesseract.js, a global-binarising document engine) could
 * return NOTHING for when the dark console dominated the frame, and which it
 * needed a stack of workarounds (PSM tuning, confidence gate, hand-tuned pixel
 * crop) to read at all.
 *
 * Also pinned: the textless case. OCR engines do not return "nothing" for an
 * image without text — the previous one hallucinated a different character per
 * frame from antialiased edges, making a frozen blank screen look like a
 * console with ever-changing text.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { FrameOcr } from '../src/services/frameOcr.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-acc-'));
const ocr = new FrameOcr();

after(async () => {
  await ocr.terminate();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A synthetic console frame: chrome strips + dense terminal text on black. */
async function consoleFrame(lines: string[]): Promise<string> {
  const textEls = lines
    .map(
      (l, i) =>
        `<text x="240" y="${80 + i * 22}" font-family="Consolas,monospace" font-size="14" fill="#e8e8e8">${l
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</text>`
    )
    .join('\n');
  const svg = `<svg width="1600" height="900" xmlns="http://www.w3.org/2000/svg">
    <rect width="1600" height="900" fill="#0b0d16"/>
    <rect x="0" y="0" width="210" height="900" fill="#2b3245"/>
    <rect x="0" y="0" width="1600" height="50" fill="#2b3245"/>
    <text x="60" y="30" font-family="Arial" font-size="14" fill="#dfe3ee">Intersight</text>
    <text x="240" y="30" font-family="Arial" font-size="13" fill="#dfe3ee">C240-TEST | Tunneled KVM Console</text>
    <rect x="210" y="50" width="1390" height="850" fill="#000000"/>
    ${textEls}
  </svg>`;
  const file = path.join(dir, `frame-${lines.length}-${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

describe('FrameOcr accuracy (real engine)', () => {
  it('reads dense terminal text on a dark console, top to bottom', async () => {
    const lines = [
      '[ 1183.921768] fnic_fcoe_send_vlan_req: 5 callbacks suppressed',
      '[ 1190.337768] fnic: fnic_fcoe_send_vlan_req: all vlan_req retries failed, unable to send',
      '[ 1360.100200] EXT4-fs (sda2): mounted filesystem with ordered data mode. Opts: (null)',
      'localhost login:',
    ];
    const text = (await ocr.textOf(await consoleFrame(lines))) ?? '';

    for (const needle of ['fnic_fcoe_send_vlan_req', 'callbacks suppressed', 'EXT4-fs', 'localhost login']) {
      assert.ok(text.includes(needle), `must read ${JSON.stringify(needle)}, got: ${text.slice(0, 200)}`);
    }
    assert.ok(
      text.indexOf('callbacks suppressed') < text.indexOf('localhost login'),
      'lines must come back in console order'
    );
    assert.ok(!text.includes('Intersight'), 'chrome text must be filtered from the transcript');
  });

  it('returns nothing for a console with no text, rather than inventing some', async () => {
    const text = await ocr.textOf(await consoleFrame([]));
    assert.equal(text, '', `a textless console must read as empty, got: ${JSON.stringify(text)}`);
  });

  it('caches by path, so repeat reads are free', async () => {
    const file = await consoleFrame(['localhost login:']);
    await ocr.textOf(file);
    const before = Date.now();
    await ocr.textOf(file);
    assert.ok(Date.now() - before < 50, 'second read must come from cache');
  });
});
