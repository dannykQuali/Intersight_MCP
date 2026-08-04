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
 * Minimal shape of the DOM nodes this traversal touches, so the selection logic
 * can be exercised in Node against a hand-built tree.
 */
export interface FocusableLike {
  tagName?: string;
  id?: string;
  shadowRoot?: RootLike | null;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
  focus?: () => void;
  getRootNode?: () => { activeElement?: FocusableLike | null };
}

export interface RootLike {
  activeElement?: FocusableLike | null;
  querySelector?: (sel: string) => FocusableLike | null;
  querySelectorAll?: (sel: string) => Iterable<FocusableLike>;
}

/**
 * Where the console's key events must land, most specific first.
 *
 * The Intersight client renders the server's video into `canvas#kvmCanvas` and
 * listens for keyboard events THERE, not on the document.
 */
export const CONSOLE_TARGET_SELECTORS = ['canvas#kvmCanvas', 'canvas', 'video'];

/**
 * Find the console's key target, piercing NESTED shadow roots.
 *
 * This is the bug that made keyboard input silently do nothing. The canvas lives
 * two shadow roots deep:
 *
 *   body > div#kvmApplicationDiv > kvm-ui (shadow) > div#contents
 *        > kvm-video (shadow) > canvas#kvmCanvas
 *
 * and `querySelector` does not cross a shadow boundary. The previous code looked
 * only inside `kvm-ui`'s own root, found no canvas there, and fell back to "the
 * first element with a tabindex" - a div in the page header. Real key events
 * therefore went to chrome and were never seen by the client, while the focus
 * check compared against that same wrong element and reported success.
 */
export function findConsoleTarget(root: RootLike | null | undefined): FocusableLike | null {
  for (const sel of CONSOLE_TARGET_SELECTORS) {
    const hit = deepQuery(root, sel, new Set());
    if (hit) {
      return hit;
    }
  }
  return null;
}

function deepQuery(root: RootLike | null | undefined, sel: string, seen: Set<unknown>): FocusableLike | null {
  if (!root || seen.has(root)) {
    return null;
  }
  seen.add(root);
  const direct = root.querySelector ? root.querySelector(sel) : null;
  if (direct) {
    return direct;
  }
  const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (const el of all) {
    if (el.shadowRoot) {
      const inner = deepQuery(el.shadowRoot, sel, seen);
      if (inner) {
        return inner;
      }
    }
  }
  return null;
}

/**
 * The same logic, packaged for `page.evaluate`.
 *
 * Playwright serialises a function's source, so anything it closes over is
 * unavailable in the page. Composing the script from these functions' own
 * `toString()` keeps ONE implementation that both the tests and the browser run
 * — the previous inline string could not be tested at all, which is how a
 * traversal that never reached the canvas survived.
 */
export function consoleFocusPageScript(): string {
  return `(() => {
  const CONSOLE_TARGET_SELECTORS = ${JSON.stringify(CONSOLE_TARGET_SELECTORS)};
  ${deepQuery.toString()}
  ${findConsoleTarget.toString()}
  ${describeNode.toString()}
  ${focusConsoleTarget.toString()}
  return focusConsoleTarget(document);
})()`;
}

/** A readable identity for a node, for reporting what was actually focused. */
export function describeNode(el: FocusableLike | null | undefined): string | null {
  if (!el) {
    return null;
  }
  const tag = (el.tagName ?? '').toLowerCase();
  return el.id ? `${tag}#${el.id}` : tag;
}

/**
 * Focus the console's key target and report what happened.
 *
 * Runs inside the page (Playwright serialises it), and is deliberately
 * self-contained so it can also be called in tests against a fake tree. The
 * return value names the element focused: reporting merely "focused: true" is
 * what let the original bug hide, since it was true of the wrong element.
 */
export function focusConsoleTarget(root?: RootLike): {
  focused: boolean;
  target: string | null;
  isConsoleCanvas: boolean;
} {
  const doc: RootLike | undefined = root ?? (typeof document !== 'undefined' ? (document as unknown as RootLike) : undefined);
  const target = findConsoleTarget(doc);
  if (!target) {
    return { focused: false, target: null, isConsoleCanvas: false };
  }
  // A canvas is not focusable without a tabindex.
  if (target.getAttribute && target.getAttribute('tabindex') === null && target.setAttribute) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus?.();
  // Verify against the element's OWN root: document.activeElement only ever
  // reports the outermost host, so it cannot confirm focus inside a shadow root.
  const owner = target.getRootNode?.();
  const focused = !!owner && owner.activeElement === target;
  const name = describeNode(target);
  return { focused, target: name, isConsoleCanvas: name === 'canvas#kvmCanvas' };
}
