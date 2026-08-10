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
 * Paste text using the console's OWN paste dialog, rather than pretending to be
 * a keyboard.
 *
 * Synthesised keystrokes cannot be made reliable. Each one crosses the KVM
 * client's WebSocket to the BMC as a HID report, and when that pipe stalls with a
 * key DOWN the guest's keyboard auto-repeat fills the gap. Pacing helped and did
 * not fix it: at 100ms per key — human typing speed — `cat /etc/network/interfaces`
 * still reached a Proxmox prompt as `/ettttttt…ccccccc/nnnnnnn…nnnetttttt…`.
 *
 * The client already solves this properly. Its UI ships a paste dialog with a
 * textarea, a keyboard-layout selector and an unsupported-character handler;
 * whatever rate limiting and scancode mapping the vendor does, its Send button
 * does it right. Mapped from the live client over CDP:
 *
 *   kvm-modal-paste[ref=modalPaste]                      (shadow)
 *     kvm-modal-paste-ask-for-action                     <- unsupported chars
 *     kvm-modal-paste-settings
 *     ucs-draggable-modal[header=kvm.menu.pasteFromClipboard]
 *       div[slot=body]   > ucs-textarea[ref=pasteTextarea] (shadow) > textarea
 *       div[slot=footer] > ucs-button "Settings" | "Cancel" | [primary] "Send"
 *
 * The component's own methods are used to open it and, if the button cannot be
 * found, to submit: `updateDisplayModal`, `handlePasteButtonClick`. Those names
 * are the vendor's, so this can break on a client update — hence every failure
 * returns a reason and the caller falls back to typing.
 */

/** Minimal DOM shape, so the logic can be exercised against a hand-built tree. */
export interface NodeLike {
  tagName?: string;
  textContent?: string | null;
  value?: string;
  shadowRoot?: RootLike | null;
  getAttribute?: (name: string) => string | null;
  hasAttribute?: (name: string) => boolean;
  click?: () => void;
  focus?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
  /** Vendor component methods, present on kvm-modal-paste. */
  updateDisplayModal?: (show: boolean) => void;
  handlePasteButtonClick?: () => void;
  handleCloseButtonClick?: () => void;
}

export interface RootLike {
  querySelector?: (sel: string) => NodeLike | null;
  querySelectorAll?: (sel: string) => Iterable<NodeLike>;
}

/**
 * Builds the events dispatched at the textarea.
 *
 * Injected rather than constructed inline because the browser REJECTS a plain
 * object: `dispatchEvent` threw "parameter 1 is not of type 'Event'" against the
 * live client while a hand-built fake DOM accepted it happily. Making the factory
 * part of the contract is what keeps the test honest about that.
 */
export type EventFactory = (type: string) => unknown;

export interface PasteResult {
  ok: boolean;
  reason: string;
  /** How the paste was submitted, for reporting which path ran. */
  via?: 'send-button' | 'component-method';
}

/** The client's paste component, and the textarea it owns. */
export const PASTE_COMPONENT_TAG = 'kvm-modal-paste';
export const PASTE_TEXTAREA_REF = 'pasteTextarea';

/** Every element in the tree, piercing nested shadow roots. */
export function deepFind(
  root: RootLike | null | undefined,
  match: (el: NodeLike) => boolean,
  seen: Set<unknown> = new Set()
): NodeLike | null {
  if (!root || seen.has(root) || !root.querySelectorAll) {
    return null;
  }
  seen.add(root);
  for (const el of root.querySelectorAll('*')) {
    if (match(el)) {
      return el;
    }
    if (el.shadowRoot) {
      const hit = deepFind(el.shadowRoot, match, seen);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

const tag = (el: NodeLike): string => (el.tagName ?? '').toLowerCase();

/**
 * Put `text` into the client's paste dialog and submit it.
 *
 * Runs entirely inside the page: no clicks by coordinate, no dependency on the
 * dialog being visible, and no keystrokes at all.
 */
export function pasteIntoConsole(
  doc: { body?: RootLike | null },
  text: string,
  makeEvent: EventFactory
): PasteResult {
  if (!text) {
    return { ok: false, reason: 'no text to paste' };
  }
  const modal = deepFind(doc.body, (el) => tag(el) === PASTE_COMPONENT_TAG);
  if (!modal) {
    return {
      ok: false,
      reason: `this console has no ${PASTE_COMPONENT_TAG} component, so the client offers no paste dialog`,
    };
  }

  // Open it first: the component builds/enables its controls when displayed.
  if (typeof modal.updateDisplayModal === 'function') {
    try {
      modal.updateDisplayModal(true);
    } catch {
      /* opening is best-effort; the controls may already exist */
    }
  }

  // Anchor on the ref the vendor gives the paste box, so the Settings sub-modal's
  // own inputs can never be filled by mistake. Any textarea is the fallback.
  const holder = deepFind(
    modal.shadowRoot,
    (el) => tag(el) === 'ucs-textarea' && el.getAttribute?.('ref') === PASTE_TEXTAREA_REF
  );
  const textarea =
    deepFind(holder?.shadowRoot, (el) => tag(el) === 'textarea') ??
    deepFind(modal.shadowRoot, (el) => tag(el) === 'textarea');
  if (!textarea) {
    return { ok: false, reason: 'the paste dialog has no textarea to fill' };
  }

  textarea.focus?.();
  textarea.value = text;
  // The component keeps its own state and starts with Send disabled, so an
  // assignment alone leaves it believing the box is empty.
  // REAL Event objects: the live client threw "parameter 1 is not of type
  // 'Event'" on plain ones, and the fake DOM had accepted them.
  textarea.dispatchEvent?.(makeEvent('input'));
  textarea.dispatchEvent?.(makeEvent('change'));

  const send = deepFind(
    modal.shadowRoot,
    (el) => tag(el) === 'ucs-button' && /^send$/i.test((el.textContent ?? '').trim())
  );
  if (send?.click) {
    send.click();
    return { ok: true, reason: 'pasted through the client’s paste dialog', via: 'send-button' };
  }
  if (typeof modal.handlePasteButtonClick === 'function') {
    modal.handlePasteButtonClick();
    return { ok: true, reason: 'pasted through the client’s paste component', via: 'component-method' };
  }
  return { ok: false, reason: 'found the paste dialog but no way to submit it' };
}

/**
 * Close the paste dialog without sending anything.
 *
 * Needed on every failure path. A half-driven dialog stays OPEN and focused, so a
 * fallback that types keystrokes types them into the dialog's own textarea
 * instead of into the console — observed live, with the command half-landed in
 * the box and nothing reaching the server.
 */
export function closeConsolePaste(doc: { body?: RootLike | null }): { closed: boolean; reason: string } {
  const modal = deepFind(doc.body, (el) => tag(el) === PASTE_COMPONENT_TAG);
  if (!modal) {
    return { closed: false, reason: 'no paste component to close' };
  }
  const cancel = deepFind(
    modal.shadowRoot,
    (el) => tag(el) === 'ucs-button' && /^cancel$/i.test((el.textContent ?? '').trim())
  );
  if (cancel?.click) {
    cancel.click();
    return { closed: true, reason: 'pressed Cancel in the paste dialog' };
  }
  if (typeof modal.handleCloseButtonClick === 'function') {
    modal.handleCloseButtonClick();
    return { closed: true, reason: 'closed the paste dialog through the component' };
  }
  if (typeof modal.updateDisplayModal === 'function') {
    modal.updateDisplayModal(false);
    return { closed: true, reason: 'hid the paste dialog' };
  }
  return { closed: false, reason: 'found the paste dialog but no way to close it' };
}

/**
 * The same implementation, packaged for page.evaluate.
 *
 * One implementation, two runners — tested here in Node, shipped into the page
 * via toString(), exactly as the console-focus script is.
 */
export function consolePastePageScript(text: string): string {
  return `(() => {
  const PASTE_COMPONENT_TAG = ${JSON.stringify(PASTE_COMPONENT_TAG)};
  const PASTE_TEXTAREA_REF = ${JSON.stringify(PASTE_TEXTAREA_REF)};
  const tag = ${tag.toString()};
  ${deepFind.toString()}
  ${pasteIntoConsole.toString()}
  return pasteIntoConsole(document, ${JSON.stringify(text)}, (type) => new Event(type, { bubbles: true }));
})()`;
}

/** Companion script that dismisses the dialog, for the failure paths. */
export function consolePasteClosePageScript(): string {
  return `(() => {
  const PASTE_COMPONENT_TAG = ${JSON.stringify(PASTE_COMPONENT_TAG)};
  const tag = ${tag.toString()};
  ${deepFind.toString()}
  ${closeConsolePaste.toString()}
  return closeConsolePaste(document);
})()`;
}
