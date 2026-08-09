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
 * How to get hold of the shared browser, and what must never be done to it.
 *
 * These rules exist because their absence cost an agent its console. Two vKVM
 * renderers were wedged by a `beforeunload` dialog, so Playwright's attach —
 * which attaches to EVERY page — hung and timed out. The failed attach fell
 * through to "spawn a browser", whose first act was to delete the profile's
 * DevToolsActivePort: the live browser's own port file, and the only way anyone
 * discovers it. Edge then launched onto an in-use profile, handed its about:blank
 * to the running browser and exited without writing a new port file, so the spawn
 * threw and every retry repeated the cycle — discovery permanently broken, one
 * stray blank tab per attempt.
 *
 * The missing rule, in one line: a browser that ANSWERS is present, however badly
 * it is behaving, and a port file must never be deleted while something is
 * listening on it.
 */

export interface AcquisitionFacts {
  /** Endpoint read from the profile's port file, or null when there is none. */
  endpointFromFile: string | null;
  /** Does something answer on that endpoint right now? */
  endpointAnswers: boolean;
  /** Did an attach to it already fail this round? */
  attachFailed?: boolean;
  /** Is a browser process already holding this profile? */
  profileInUse?: boolean;
}

export interface AcquisitionDecision {
  action: 'attach' | 'retry-attach' | 'spawn';
  /** Only ever true for a port file nobody is listening on. */
  removeStalePortFile: boolean;
  reason: string;
}

export function decideBrowserAcquisition(facts: AcquisitionFacts): AcquisitionDecision {
  const { endpointFromFile, endpointAnswers, attachFailed, profileInUse } = facts;

  if (endpointFromFile && endpointAnswers) {
    // A hung or failed attach is evidence of a browser, not of its absence — a
    // single wedged page is enough to stall Playwright's attach to all of them.
    return attachFailed
      ? {
          action: 'retry-attach',
          removeStalePortFile: false,
          reason:
            'a browser is listening on the published port, so it exists even though attaching just failed — ' +
            'retrying beats spawning a competitor and orphaning it',
        }
      : { action: 'attach', removeStalePortFile: false, reason: 'the published endpoint answers' };
  }

  if (profileInUse) {
    // Launching onto a locked profile does not start a browser: the new process
    // hands its URL to the running one and exits, leaving a stray tab and no port
    // file. Waiting for the existing browser to become attachable is the only
    // thing that can work.
    return {
      action: 'retry-attach',
      removeStalePortFile: false,
      reason:
        'the profile is already in use by a running browser, which would swallow a launch and leave a stray tab — ' +
        'wait for it to become attachable instead',
    };
  }

  return {
    action: 'spawn',
    removeStalePortFile: !!endpointFromFile,
    reason: endpointFromFile
      ? 'the published port answers nothing, so that file is stale and safe to clear before launching'
      : 'no browser is published for this profile and none is running',
  };
}

/** Is this the URL of a vKVM console page? */
export function isConsoleUrl(url: string): boolean {
  return /\/cisco-vkvm\//i.test(url ?? '');
}

/**
 * Which existing tab may be navigated, if any.
 *
 * Never a console: navigating one away raises `beforeunload` ("Leave site?"),
 * which wedges that renderer until a human clicks — and if the click is "Leave",
 * it destroys a console another agent may be mid-installation on. A blank tab is
 * preferred as the cheapest thing to reuse. null means "open a new tab".
 */
export function pickNavigablePage(urls: string[]): number | null {
  const blank = urls.findIndex((u) => u === 'about:blank' || u === '');
  if (blank >= 0) {
    return blank;
  }
  const other = urls.findIndex((u) => !isConsoleUrl(u));
  return other >= 0 ? other : null;
}
