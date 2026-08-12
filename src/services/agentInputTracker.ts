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
 * Tracks, PER CONSOLE, when the agent is interacting with it.
 *
 * The background anti-blank nudge must stay out of the way of deliberate agent
 * input: injecting a stray pointer event mid-interaction risks disturbing
 * whatever the agent is doing, and the agent's own input already reset the
 * console's blank timer, so no nudge is needed anyway.
 *
 * The scoping is the whole point. This used to be two scalars on
 * BrowserService, which was correct with a single console and wrong with
 * several: a mouse move on server A declined the due nudge on server B, and
 * because a declined attempt still resets the idle clock, B's next nudge was
 * pushed out another full anti-blank window. An agent that touches one console
 * every few minutes could keep every OTHER console's anti-blank permanently
 * deferred - the exact blanking the feature exists to prevent.
 */
export class AgentInputTracker {
  /** serverMoid -> interactions currently running against that console. */
  private readonly inFlight = new Map<string, number>();
  /** serverMoid -> when the agent last finished sending it input. */
  private readonly lastInputAt = new Map<string, number>();

  /**
   * @param quietMs How long after an interaction the console still counts as
   *   agent-driven (its blank timer was reset by that input).
   * @param now Clock seam, so tests do not have to sleep.
   */
  constructor(
    private readonly quietMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Run a deliberate agent interaction against one console.
   *
   * `scope` is the serverMoid, or null for a page that is not a console (typing
   * into an unrelated tab must not hold off any console's nudge).
   */
  async run<T>(scope: string | null, fn: () => Promise<T>): Promise<T> {
    if (!scope) {
      return fn();
    }
    this.inFlight.set(scope, (this.inFlight.get(scope) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const remaining = (this.inFlight.get(scope) ?? 1) - 1;
      if (remaining > 0) {
        this.inFlight.set(scope, remaining);
      } else {
        this.inFlight.delete(scope);
      }
      // Recorded even when the interaction threw: a failed keystroke may still
      // have reached the console.
      this.markInput(scope);
    }
  }

  /** Note that input reached a console outside of run() (e.g. a wake keypress). */
  markInput(scope: string): void {
    this.lastInputAt.set(scope, this.now());
  }

  /**
   * True only while an interaction is actually running against this console.
   * Narrower than isBusy(): use it where the concern is racing with input in
   * progress rather than "input already counted as activity".
   */
  isInputInFlight(scope: string): boolean {
    return (this.inFlight.get(scope) ?? 0) > 0;
  }

  /** True while the agent is using this console, or has just used it. */
  /**
   * When input was last delivered to this console, or 0 if never.
   *
   * The anti-blank rule needs it: the CIMC blanks on INPUT idleness, so an agent
   * that has been typing has already kept the console awake and a nudge on top is
   * pointless traffic.
   */
  lastInputAtFor(scope: string): number {
    return this.lastInputAt.get(scope) ?? 0;
  }

  isBusy(scope: string): boolean {
    if (this.isInputInFlight(scope)) {
      return true;
    }
    const last = this.lastInputAt.get(scope);
    return last !== undefined && this.now() - last < this.quietMs;
  }
}
