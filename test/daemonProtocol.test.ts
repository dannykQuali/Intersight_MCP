/**
 * Every MCP server and the daemon must agree on one port, taken from the same
 * place. A typo there must fail loudly: a client quietly falling back to the
 * default would look for the daemon somewhere it is not and start a rival.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_DAEMON_PORT, daemonPort } from '../src/recorder/daemonProtocol.js';

describe('the daemon port setting', () => {
  it('defaults when unset or blank', () => {
    assert.equal(daemonPort({}), DEFAULT_DAEMON_PORT);
    assert.equal(daemonPort({ INTERSIGHT_DAEMON_PORT: '  ' }), DEFAULT_DAEMON_PORT);
  });

  it('uses INTERSIGHT_DAEMON_PORT when it is a port number', () => {
    assert.equal(daemonPort({ INTERSIGHT_DAEMON_PORT: '30111' }), 30111);
  });

  for (const bad of ['abc', '0', '65536', '-5', '12.5', '8080x']) {
    it(`rejects ${JSON.stringify(bad)} instead of silently using the default`, () => {
      assert.throws(() => daemonPort({ INTERSIGHT_DAEMON_PORT: bad }), /INTERSIGHT_DAEMON_PORT/);
    });
  }

  it('keeps the default out of every OS\'s ephemeral range', () => {
    // Linux hands out outgoing local ports from 32768; macOS and Windows from
    // 49152. A default inside those could be squatted by any outgoing connection.
    assert.ok(DEFAULT_DAEMON_PORT < 32768 && DEFAULT_DAEMON_PORT > 1024);
  });
});
