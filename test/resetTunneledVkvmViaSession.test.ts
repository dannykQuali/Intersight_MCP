/**
 * The recorder's Tunneled vKVM reset must report WHY its lookup failed.
 *
 * Regression (CHGLAB-UCSX-1-5-1, 2026-09-30): the browser session had expired,
 * the ServerSettings GET came back non-OK, and the reset reported "no
 * compute.ServerSetting found for server ..." - which reads like a wrong filter
 * for blades and sent the investigation the wrong way. The setting existed all
 * along (Server.Moid matches compute.Blade and compute.RackUnit alike).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BrowserService, type SessionApiResult } from '../src/services/browserService.js';

function serviceAnswering(answer: (method: string, apiPath: string) => SessionApiResult) {
  const service = new BrowserService('https://intersight.com/api/v1');
  const calls: string[] = [];
  service.sessionApi = async (method: string, apiPath: string) => {
    calls.push(`${method} ${apiPath}`);
    return answer(method, apiPath);
  };
  return { service, calls };
}

describe('resetTunneledVkvmViaSession', () => {
  it('reports a failed lookup as a failed request, not as a missing setting', async () => {
    const { service, calls } = serviceAnswering(() => ({ status: 401, ok: false, body: { code: 'Unauthorized' } }));

    await assert.rejects(service.resetTunneledVkvmViaSession('6a4f04026176753401bd5dcb'), (error: Error) => {
      assert.match(error.message, /401/, 'the HTTP status must be in the message');
      assert.doesNotMatch(error.message, /no compute\.ServerSetting found/i);
      return true;
    });
    assert.ok(
      calls.every((c) => c.startsWith('GET ')),
      'nothing may be PATCHed when the setting could not even be read'
    );
  });

  it('still says so when the server genuinely has no ServerSetting', async () => {
    const { service, calls } = serviceAnswering(() => ({ status: 200, ok: true, body: { Results: [] } }));

    await assert.rejects(
      service.resetTunneledVkvmViaSession('6a4f04026176753401bd5dcb'),
      /no compute\.ServerSetting found for server 6a4f04026176753401bd5dcb/
    );
    assert.equal(calls.length, 1);
  });

  it('reports a failed PATCH with its status', async () => {
    const { service } = serviceAnswering((method) =>
      method === 'GET'
        ? { status: 200, ok: true, body: { Results: [{ Moid: 'setting-1' }] } }
        : { status: 403, ok: false, body: null }
    );

    await assert.rejects(service.resetTunneledVkvmViaSession('srv'), /Tunneled vKVM Disable failed: 403/);
  });
});
