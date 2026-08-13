/**
 * Missing tool arguments must be rejected BEFORE any request is built.
 *
 * Field report: an agent called list_pools without poolType and the server
 * happily sent GET /v1/undefined to Intersight, which answered
 * 403 InvalidUrl "The URL '/v1/undefined' is invalid" — a message that tells
 * the agent nothing about what it did wrong. The MCP SDK does not enforce
 * inputSchema.required, so the server has to.
 *
 * These tests drive the REAL server over a real MCP client/transport pair
 * (the same path a production stdio client takes). The Intersight credentials
 * are deliberately bogus and the base URL points at an unroutable local port:
 * if a malformed call ever slips past validation again, it fails on signing /
 * connection instead of reaching Intersight, and the assertions on the error
 * text catch the regression.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.INTERSIGHT_API_KEY_ID = 'test-key-id';
process.env.INTERSIGHT_API_SECRET_KEY = 'not-a-real-key';
// Unroutable: guarantees no traffic leaves the machine even if validation regresses.
process.env.INTERSIGHT_BASE_URL = 'http://127.0.0.1:1/api/v1';
// Force the built-in default tool configuration, independent of the repo's config file.
process.env.INTERSIGHT_CONFIG_FILE = './.does-not-exist-intersight-test-config.json';

const { IntersightMCPServer } = await import('../src/server.js');

let client: Client;

before(async () => {
  const server = new IntersightMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'validation-test', version: '1.0.0' });
  await client.connect(clientTransport);
});

after(async () => {
  await client.close();
});

async function callTool(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.map((c) => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

describe('tool argument validation (through a real MCP client)', () => {
  it('rejects list_pools without poolType instead of requesting /v1/undefined', async () => {
    const { isError, text } = await callTool('list_pools', {});
    assert.equal(isError, true);
    assert.match(text, /list_pools/);
    assert.match(text, /'poolType'/);
    // The schema description must ride along so the caller can self-correct.
    assert.match(text, /ippool\/Pools/);
    // Nothing may have been sent: no Intersight/API/signing error text.
    assert.doesNotMatch(text, /Intersight API error|undefined/i);
  });

  it('points a caller who wrote pool_type at the correct camelCase name', async () => {
    const { isError, text } = await callTool('list_pools', { pool_type: 'ippool/Pools' });
    assert.equal(isError, true);
    assert.match(text, /'poolType'/);
    assert.match(text, /'pool_type'/);
  });

  it('rejects null for a required argument', async () => {
    const { isError, text } = await callTool('list_pools', { poolType: null });
    assert.equal(isError, true);
    assert.match(text, /'poolType'/);
  });

  it('rejects an empty string for a required argument', async () => {
    const { isError, text } = await callTool('list_pools', { poolType: '   ' });
    assert.equal(isError, true);
    assert.match(text, /'poolType'/);
  });

  it('reports every missing required argument at once', async () => {
    const { isError, text } = await callTool('get_policy', {});
    assert.equal(isError, true);
    assert.match(text, /'policyType'/);
    assert.match(text, /'moid'/);
  });

  it('lets a well-formed call through to the API layer', async () => {
    const { isError, text } = await callTool('list_pools', { poolType: 'ippool/Pools' });
    // With bogus credentials the call fails later (signing/connection),
    // which proves validation did NOT reject it.
    assert.equal(isError, true);
    assert.doesNotMatch(text, /Invalid arguments/);
  });

  it('does not reject tools whose schema has no required arguments', async () => {
    const { text } = await callTool('list_alarms', {});
    assert.doesNotMatch(text, /Invalid arguments/);
  });

  it('still reports unknown tools as unknown', async () => {
    const { isError, text } = await callTool('list_pools_typo_not_enabled', {});
    assert.equal(isError, true);
    // Unknown names are caught by the enablement check or dispatch, not validation.
    assert.doesNotMatch(text, /Invalid arguments/);
  });

  it('tolerates entirely absent arguments, as the HTTP transport can send', async () => {
    // http-server.ts /api/execute forwards req.body.parameters verbatim and
    // calls handleToolCall directly — replicate that path with undefined args.
    const server = new IntersightMCPServer();
    await assert.rejects(
      () => (server as any).handleToolCall('list_pools', undefined),
      (error: Error) => /Invalid arguments/.test(error.message) && /'poolType'/.test(error.message)
    );
  });

  it('handles a burst of concurrent invalid calls consistently', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => callTool('list_pools', {}))
    );
    for (const r of results) {
      assert.equal(r.isError, true);
      assert.match(r.text, /'poolType'/);
    }
  });
});
