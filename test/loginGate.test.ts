/**
 * The login policy is only worth anything if every road to a web login runs
 * through it. This drives the REAL BrowserService.ensureLoggedIn — the one
 * choke point — with the two things that touch the outside world stubbed: the
 * session-evidence probe and the Cisco ID flow itself.
 *
 * Before this, three roads bypassed the guard: a failed login was retried once
 * in a fresh TOTP window, the keepalive re-logged-in with `force` (which also
 * reset the failure counters), and mechanical failures never counted. Together
 * they produced ~1,050 logins in one morning and a locked-out account.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BrowserService } from '../src/services/browserService.js';
import type { SessionEvidence } from '../src/services/loginPolicy.js';

interface GateOpts {
  recorders?: number;
  evidence?: SessionEvidence | (() => SessionEvidence);
  /** What the Cisco ID flow reports when it runs. Defaults to a mechanical failure. */
  login?: () => Promise<Record<string, unknown>>;
  browserOpen?: boolean;
}

function gated(opts: GateOpts = {}) {
  const svc = new BrowserService('https://intersight.example/api/v1');
  const calls = { attempts: 0, evidenceProbes: 0 };
  const s = svc as any;
  s.sso = { ...s.sso, autoLogin: true, configured: true, username: 'u@example.com', password: 'p', keepaliveSeconds: 240 };
  svc.setRecorderCensus(() => opts.recorders ?? 1);
  s.sessionEvidence = async (): Promise<SessionEvidence> => {
    calls.evidenceProbes++;
    const e = opts.evidence ?? 'proven-logged-out';
    return typeof e === 'function' ? e() : e;
  };
  s.performCiscoIdLogin = async () => {
    calls.attempts++;
    return opts.login
      ? opts.login()
      : {
          loggedIn: false,
          action: 'login-failed',
          error: 'Could not find the username field on the Cisco ID login page',
          failureKind: 'mechanical',
          stepsCompleted: ['opened intersight.com'],
        };
  };
  if (opts.browserOpen) {
    s.context = {}; // "a browser is open" is all the gate needs to know
  }
  return { svc, calls };
}

describe('one web login per need', () => {
  it('attempts once on a failure and never retries by itself', async () => {
    const { svc, calls } = gated();
    const first = await svc.ensureLoggedIn();
    assert.equal(first.loggedIn, false);
    assert.equal(calls.attempts, 1, 'no second attempt in a fresh TOTP window, nothing');

    const again = await svc.ensureLoggedIn();
    assert.equal(calls.attempts, 1, 'a recorder asking again must not produce another web login');
    assert.equal(again.loggedIn, false);
    assert.match(String(again.reason), /browser_login/);
  });

  it('lets an explicit browser_login try exactly once more', async () => {
    const { svc, calls } = gated();
    await svc.ensureLoggedIn();
    await svc.ensureLoggedIn({ trigger: 'explicit' });
    assert.equal(calls.attempts, 2);
    await svc.ensureLoggedIn();
    assert.equal(calls.attempts, 2, 'the explicit attempt failed, so automatic login stays disarmed');
  });

  it('treats force the way it treats an explicit request: one attempt, re-armed', async () => {
    const { svc, calls } = gated();
    await svc.ensureLoggedIn();
    await svc.ensureLoggedIn({ force: true });
    assert.equal(calls.attempts, 2);
  });

  it('shares one attempt between concurrent callers', async () => {
    // The login only starts once the evidence probe has answered, so the test
    // waits for it to begin before letting it finish.
    let release!: () => void;
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => (loginStarted = resolve));
    const { svc, calls } = gated({
      login: () =>
        new Promise((resolve) => {
          release = () => resolve({ loggedIn: true, action: 'logged-in' });
          loginStarted();
        }),
    });
    const a = svc.ensureLoggedIn();
    const b = svc.ensureLoggedIn();
    await started;
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls.attempts, 1);
    assert.equal(ra.loggedIn, true);
    assert.equal(rb.loggedIn, true);
  });
});

describe('no login unless the session is proven gone', () => {
  it('does nothing while the session is valid', async () => {
    const { svc, calls } = gated({ evidence: 'valid' });
    const r = await svc.ensureLoggedIn({ trigger: 'explicit' });
    assert.equal(r.loggedIn, true);
    assert.equal(calls.attempts, 0);
  });

  it('refuses when the session state is inconclusive, even when asked explicitly', async () => {
    const { svc, calls } = gated({ evidence: 'unknown' });
    const r = await svc.ensureLoggedIn({ trigger: 'explicit', force: true });
    assert.equal(r.loggedIn, false);
    assert.equal(calls.attempts, 0);
    assert.match(String(r.reason), /inconclusive|not proven|unknown/i);
  });

  it('after a success, logs in again only once the session is proven gone', async () => {
    let evidence: SessionEvidence = 'proven-logged-out';
    const { svc, calls } = gated({
      evidence: () => evidence,
      login: async () => ({ loggedIn: true, action: 'logged-in', stepsCompleted: [] }),
    });
    assert.equal((await svc.ensureLoggedIn()).loggedIn, true);
    assert.equal(calls.attempts, 1);

    evidence = 'valid';
    await svc.ensureLoggedIn();
    evidence = 'unknown';
    await svc.ensureLoggedIn();
    assert.equal(calls.attempts, 1, 'neither a valid nor an unknown session is a reason to log in');

    evidence = 'proven-logged-out';
    await svc.ensureLoggedIn();
    assert.equal(calls.attempts, 2);
  });
});

describe('no recorder, no login', () => {
  it('refuses every trigger when no recorder needs a console', async () => {
    const { svc, calls } = gated({ recorders: 0, browserOpen: true });
    for (const opts of [{}, { trigger: 'explicit' as const }, { force: true }]) {
      const r = await svc.ensureLoggedIn(opts);
      assert.equal(r.loggedIn, false);
      assert.match(String(r.reason), /recorder/i);
    }
    assert.equal(calls.attempts, 0);
  });

  it('does not even open a browser to find out, when none is open', async () => {
    const { svc, calls } = gated({ recorders: 0 });
    await svc.ensureLoggedIn({ trigger: 'explicit' });
    assert.equal(calls.evidenceProbes, 0, 'probing the session would launch a browser for a login that cannot happen');
    assert.equal(calls.attempts, 0);
  });
});

describe('the keepalive', () => {
  it('only pings; a dead session is reported, never re-logged-in', async () => {
    const { svc, calls } = gated();
    (svc as any).isLoggedIn = async () => false;
    for (let i = 0; i < 3; i++) {
      await svc.keepaliveTick();
    }
    assert.equal(calls.attempts, 0, 'the keepalive re-login was the loop that ran all night');
    assert.equal((svc as any).lastKeepalive?.ok, false);
  });

  it('records a healthy ping', async () => {
    const { svc } = gated();
    (svc as any).isLoggedIn = async () => true;
    await svc.keepaliveTick();
    assert.equal((svc as any).lastKeepalive?.ok, true);
  });
});

describe('what a caller is told', () => {
  it('carries the policy state in every answer, so an agent sees why nothing happened', async () => {
    const { svc } = gated();
    const refusedAfterFailure = await svc.ensureLoggedIn().then(() => svc.ensureLoggedIn());
    assert.equal(refusedAfterFailure.loginPolicy?.armed, false);
    assert.equal(refusedAfterFailure.loginPolicy?.lastAttempt?.outcome, 'failed');
    assert.equal(refusedAfterFailure.evidence, 'proven-logged-out');
  });
});
