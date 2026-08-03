/**
 * BrowserService must supply every hook the recorder can use.
 *
 * Regression: the hook object was assembled inline at the call site and
 * `wakeConsole` was omitted. Nothing failed - the recorder simply never took
 * the "User Inactivity / press a key to wake up the system" branch, so a
 * sleeping console stayed green all night with `wakes` stuck at 0, while the
 * docs said it was handled. A missing OPTIONAL hook cannot be caught by the
 * compiler, so it is asserted here instead.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BrowserService } from '../src/services/browserService.js';

/** Hooks whose absence degrades self-healing silently. */
const REQUIRED_HOOKS = [
  'isConsoleDead',
  'isConsoleDisconnected',
  'isSessionDeadViaApi',
  'wakeConsole',
  'recover',
  'nudge',
] as const;

function hooksFor(service: BrowserService): Record<string, unknown> {
  // Private by design - this asserts on wiring, which has no public surface.
  return (service as any).recorderHooks('test-moid');
}

describe('BrowserService recorder wiring', () => {
  it('supplies every self-healing hook', () => {
    const service = new BrowserService('https://intersight.com/api/v1');
    const hooks = hooksFor(service);

    for (const name of REQUIRED_HOOKS) {
      assert.equal(typeof hooks[name], 'function', `recorder hook "${name}" is not wired up`);
    }
  });

  it('supplies the Tunneled vKVM reset once a resetter is injected', () => {
    const service = new BrowserService('https://intersight.com/api/v1');
    assert.equal(hooksFor(service).resetTunneledVkvm, undefined, 'nothing to escalate to yet');

    let resetFor: string | null = null;
    service.setTunneledVkvmResetter(async (moid) => {
      resetFor = moid;
    });

    const reset = hooksFor(service).resetTunneledVkvm;
    assert.equal(typeof reset, 'function', 'escalation hook must appear once wired');
    return (reset as () => Promise<void>)().then(() => {
      assert.equal(resetFor, 'test-moid', 'the reset must target the recorded server');
    });
  });
});
