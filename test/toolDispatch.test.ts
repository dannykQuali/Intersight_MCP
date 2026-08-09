/**
 * Every tool this server ADVERTISES must actually be callable.
 *
 * The tool list and the dispatch switch are two hand-maintained lists of the same
 * 220+ names, and nothing tied them together. Rewiring the console tools onto the
 * recorder daemons dropped three dispatch cases while leaving their declarations
 * in place: `browser_intersight_api`, `browser_evaluate` and `browser_goto`
 * kept appearing in the tool list, and calling any of them returned
 * `Unknown tool` — found only when a live diagnostic session reached for one.
 *
 * That failure mode is invisible to every other test here, because each of those
 * tests calls the code directly rather than through the advertised surface. So
 * this asserts the surface itself: the two lists must agree, in both directions.
 * An undeclared case is the mirror bug — a tool nobody can discover.
 *
 * Parsing the source is deliberate. Constructing the server needs API-key
 * configuration and a network, and neither has anything to do with whether the
 * two lists match.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'server.ts'), 'utf8');

/** Names in the advertised tool list: entries of the ListTools response. */
function declaredTools(): Set<string> {
  return new Set([...source.matchAll(/^\s{8}name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]));
}

/** Names the dispatch switch handles. A case may open a block, so no line anchor. */
function dispatchedTools(): Set<string> {
  return new Set([...source.matchAll(/^\s+case '([a-z0-9_]+)':/gm)].map((m) => m[1]));
}

describe('the advertised tool surface', () => {
  it('parses both lists at a plausible size', () => {
    // Guards the regexes themselves: if a refactor changes the shape of either
    // list, this test must fail loudly rather than silently compare two empty
    // sets and pass forever.
    const declared = declaredTools();
    const dispatched = dispatchedTools();
    assert.ok(declared.size > 100, `expected to find the tool list, parsed ${declared.size} names`);
    assert.ok(dispatched.size > 100, `expected to find the dispatch switch, parsed ${dispatched.size} cases`);
    assert.ok(declared.has('vkvm_record_status'), 'a known tool must be among the declarations');
    assert.ok(dispatched.has('vkvm_record_status'), 'a known tool must be among the dispatch cases');
  });

  it('dispatches every tool it declares', () => {
    const missing = [...declaredTools()].filter((name) => !dispatchedTools().has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      `these tools are advertised but return "Unknown tool" when called: ${missing.join(', ')}`
    );
  });

  it('declares every tool it dispatches', () => {
    const undeclared = [...dispatchedTools()].filter((name) => !declaredTools().has(name)).sort();
    assert.deepEqual(
      undeclared,
      [],
      `these tools are implemented but invisible to any client: ${undeclared.join(', ')}`
    );
  });
});
