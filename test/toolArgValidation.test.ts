/**
 * Unit coverage for validateToolArgs — the required-argument gate that stands
 * between an agent's tool call and URL interpolation (see
 * toolCallValidation.test.ts for the end-to-end story).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateToolArgs, type ToolDefinitionLike } from '../src/utils/toolArgValidation.js';

function tool(overrides: Partial<ToolDefinitionLike> = {}): ToolDefinitionLike {
  return {
    name: 'list_pools',
    inputSchema: {
      properties: {
        poolType: { description: 'Pool type (e.g., "ippool/Pools")' },
      },
      required: ['poolType'],
    },
    ...overrides,
  };
}

describe('validateToolArgs', () => {
  it('accepts a call with all required arguments present', () => {
    assert.equal(validateToolArgs(tool(), { poolType: 'ippool/Pools' }), null);
  });

  it('rejects a missing required argument and names the tool and argument', () => {
    const message = validateToolArgs(tool(), {});
    assert.ok(message);
    assert.match(message, /list_pools/);
    assert.match(message, /'poolType'/);
    assert.match(message, /missing/);
  });

  it('includes the schema description so the caller can self-correct', () => {
    const message = validateToolArgs(tool(), {});
    assert.ok(message);
    assert.match(message, /ippool\/Pools/);
  });

  it('rejects null', () => {
    assert.match(validateToolArgs(tool(), { poolType: null }) ?? '', /'poolType' is null/);
  });

  it('rejects empty and whitespace-only strings', () => {
    assert.match(validateToolArgs(tool(), { poolType: '' }) ?? '', /'poolType' is empty/);
    assert.match(validateToolArgs(tool(), { poolType: '  \t ' }) ?? '', /'poolType' is empty/);
  });

  it('does NOT treat falsy non-strings (0, false) as missing', () => {
    const coords: ToolDefinitionLike = {
      name: 'browser_mouse',
      inputSchema: { properties: {}, required: ['x', 'y'] },
    };
    assert.equal(validateToolArgs(coords, { x: 0, y: 0 }), null);
  });

  it('suggests the intended key for snake_case and PascalCase near-misses', () => {
    assert.match(validateToolArgs(tool(), { pool_type: 'a' }) ?? '', /'pool_type'/);
    assert.match(validateToolArgs(tool(), { PoolType: 'a' }) ?? '', /'PoolType'/);
    assert.match(validateToolArgs(tool(), { 'pool-type': 'a' }) ?? '', /'pool-type'/);
  });

  it('does not suggest unrelated keys', () => {
    const message = validateToolArgs(tool(), { filter: 'x' });
    assert.ok(message);
    assert.doesNotMatch(message, /did you mean/);
  });

  it('reports all problems in one message', () => {
    const two: ToolDefinitionLike = {
      name: 'get_policy',
      inputSchema: { properties: {}, required: ['policyType', 'moid'] },
    };
    const message = validateToolArgs(two, {}) ?? '';
    assert.match(message, /'policyType'/);
    assert.match(message, /'moid'/);
  });

  it('accepts anything when the schema declares no required arguments', () => {
    assert.equal(validateToolArgs({ name: 't', inputSchema: { properties: {} } }, {}), null);
    assert.equal(validateToolArgs({ name: 't' }, {}), null);
  });

  it('ignores extra arguments beyond the schema', () => {
    assert.equal(validateToolArgs(tool(), { poolType: 'a', extra: 1 }), null);
  });

  it('survives a property definition that is not an object', () => {
    const weird: ToolDefinitionLike = {
      name: 't',
      inputSchema: { properties: { key: true as unknown }, required: ['key'] },
    };
    const message = validateToolArgs(weird, {});
    assert.ok(message);
    assert.match(message, /'key' is missing/);
  });
});
