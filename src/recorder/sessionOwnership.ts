/*
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Decide what may be done with an existing vKVM session on our server.
 *
 * Established live against Intersight, and each fact shaped this logic:
 *
 *  - A kvm.Session references the iam.Session that created it — but two agents
 *    sharing one browser produce the SAME iam.Session (verified: two different
 *    agents' sessions both carried iam.Session 6a761611...). So "is it mine?"
 *    is not an answerable question, and not the useful one.
 *  - The useful question is "is a live client attached?" A session with no tab
 *    and no live recorder is holding the server's only slot for nobody.
 *  - Ending a session that a LIVE recorder watches makes it relaunch and then
 *    escalate to a ~90s Tunneled vKVM reset (observed). Recorder liveness is
 *    therefore a hard veto, not a hint.
 *  - Ending is `PATCH {"Status":"Ended"}`; DELETE returns 403 "Operation not
 *    supported".
 *
 * Only the daemon holding this server's lock is the authority, which is what
 * makes ending safe at all: with a single authority per server there is no
 * second party to fight.
 */

/** A session created this recently may belong to a client still mounting it. */
const TOO_NEW_TO_END_MS = 15_000;

export interface SessionFacts {
  sessionMoid: string;
  /** iam.Session that created it, per the kvm.Session's Session ref. */
  iamSessionMoid: string | null;
  userIdOrEmail: string | null;
  /** Our browser's current iam.Session. */
  ourIamSessionMoid: string | null;
  ourUserIdOrEmail: string | null;
  /** A console tab for this server exists in the shared browser. */
  hasAdoptableTab: boolean;
  /** A recorder in another process is publishing fresh state for this server. */
  liveRecorderElsewhere: boolean;
  /** We hold this server's recorder lock. */
  weAreTheAuthority: boolean;
  createdAt: number;
  now: number;
}

export interface SessionVerdict {
  verdict: 'reuse' | 'share' | 'orphan' | 'foreign';
  /** True only when ending it is both safe and useful. */
  mayEnd: boolean;
  reason: string;
}

export function classifySession(f: SessionFacts): SessionVerdict {
  const sameUser =
    !!f.userIdOrEmail && !!f.ourUserIdOrEmail && f.userIdOrEmail.toLowerCase() === f.ourUserIdOrEmail.toLowerCase();

  // Another user's console is never ours to touch, whatever else is true.
  if (!sameUser) {
    return {
      verdict: 'foreign',
      mayEnd: false,
      reason: `held by ${f.userIdOrEmail ?? 'another user'}; never end another user's console session`,
    };
  }

  // A live recorder elsewhere means an agent is actively using this console.
  // Ending it would both steal their eyes and trigger their relaunch loop.
  if (f.liveRecorderElsewhere) {
    return {
      verdict: 'share',
      mayEnd: false,
      reason: 'another live recorder is already recording this server — share it rather than relaunching',
    };
  }

  if (f.hasAdoptableTab) {
    return {
      verdict: 'reuse',
      mayEnd: false,
      reason: 'a live console tab for this server is already open — adopt it',
    };
  }

  if (!f.weAreTheAuthority) {
    return {
      verdict: 'orphan',
      mayEnd: false,
      reason: 'looks orphaned, but this process does not hold the server authority, so it must not end it',
    };
  }

  if (f.now - f.createdAt < TOO_NEW_TO_END_MS) {
    return {
      verdict: 'orphan',
      mayEnd: false,
      reason: `created ${Math.round((f.now - f.createdAt) / 1000)}s ago — too new to end; a client may still be mounting it`,
    };
  }

  const provenance =
    f.iamSessionMoid && f.ourIamSessionMoid && f.iamSessionMoid === f.ourIamSessionMoid
      ? 'created by our current browser login'
      : 'created by an earlier login of ours (a browser restart mints a new iam.Session)';
  return {
    verdict: 'orphan',
    mayEnd: true,
    reason: `${provenance}, no client tab and no live recorder — it is holding the server's only session slot for nobody`,
  };
}
