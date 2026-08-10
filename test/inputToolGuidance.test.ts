/**
 * A tool description is the only instruction an agent ever reads.
 *
 * Typing text as keystrokes is unreliable at ANY cadence — the field saw
 * `autoinstall` arrive as `autoiiiiiiiiiiiiiiiiiiiiinstaaaa…ll` at 25ms per key,
 * and `cat /etc/network/interfaces` arrive as `/ettttttt…ccccccc/nnnnnnn…` at
 * 100ms. `vkvm_paste_text` avoids the whole problem by using the paste dialog of
 * the client itself, and it verifies the line. But an agent only reaches for it if
 * the descriptions SAY SO, prominently, in every place that advises on input.
 *
 * So the steering is asserted here. It is prose, and prose gets rewritten — this
 * is what makes sure a rewrite keeps the one instruction that matters.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(here, '..', 'src', 'server.ts'), 'utf8');
const browserSrc = fs.readFileSync(path.join(here, '..', 'src', 'services', 'browserService.ts'), 'utf8');

/** The declaration block of one tool, from its name to its inputSchema. */
function toolBlock(name: string): string {
  const at = serverSrc.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `tool ${name} not found`);
  const end = serverSrc.indexOf('inputSchema', at);
  return serverSrc.slice(at, end > at ? end : at + 4000);
}

describe('steering agents from keystrokes to paste', () => {
  it('sends browser_send_keys callers to vkvm_paste_text for text', () => {
    assert.match(toolBlock('browser_send_keys'), /vkvm_paste_text/);
  });

  it('puts that steering near the START of the description, not buried at the end', () => {
    // An agent skims. Guidance in the last sentence of a 200-word description is
    // guidance nobody follows.
    const block = toolBlock('browser_send_keys');
    const at = block.indexOf('vkvm_paste_text');
    assert.ok(at > 0 && at < 300, `expected the pointer within the first 300 chars, found it at ${at}`);
  });

  it('repeats it on the text parameter itself', () => {
    // The parameter is what an agent looks at when it has already decided to
    // call this tool.
    const at = serverSrc.indexOf("name: 'browser_send_keys'");
    const schema = serverSrc.slice(at, at + 4000);
    const textParam = schema.slice(schema.indexOf('text: {'), schema.indexOf('keys: {'));
    assert.match(textParam, /vkvm_paste_text/, 'the text param must name the better tool');
  });

  it('explains WHY, with the evidence, so the advice is not arbitrary', () => {
    const block = toolBlock('browser_send_keys');
    assert.match(block, /repeat|auto-repeat|autoiiii/i);
  });

  it('names paste first in the monitoring hints an operator reads', () => {
    for (const [label, src] of [
      ['server.ts', serverSrc],
      ['browserService.ts', browserSrc],
    ] as const) {
      const at = src.indexOf('vkvm_press_until to repeat a key');
      assert.ok(at > 0, `${label}: input hint not found`);
      const hint = src.slice(Math.max(0, at - 1200), at + 200);
      assert.match(hint, /vkvm_paste_text/, `${label}: the input hint must lead with paste`);
      assert.ok(
        hint.indexOf('vkvm_paste_text') < hint.indexOf('browser_send_keys'),
        `${label}: paste must come before send_keys in the hint`
      );
    }
  });

  it('points launch_vkvm_session at paste for text too', () => {
    // The launch response is the first thing an agent reads about a new console.
    assert.match(toolBlock('launch_vkvm_session'), /vkvm_paste_text/);
  });

  it('still describes vkvm_paste_text as using the client’s own dialog', () => {
    const block = toolBlock('vkvm_paste_text');
    assert.match(block, /paste dialog/i);
    assert.match(block, /verif/i, 'and that it verifies what landed');
  });
});
