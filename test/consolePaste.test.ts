/**
 * Use the console's OWN paste, instead of pretending to be a keyboard.
 *
 * Synthesising keystrokes cannot be made reliable: every key crosses the KVM
 * client's WebSocket as a HID report, and when that pipe stalls with a key down
 * the guest's auto-repeat fills the gap. Pacing helped and did not fix it — at
 * 100ms per key, `cat /etc/network/interfaces` still reached a Proxmox prompt as
 * `/ettttttt…ccccccc/nnnnnnn…nnnetttttt…`.
 *
 * The client already solves this. Its UI ships a paste dialog —
 * `kvm-modal-paste`, header `kvm.menu.pasteFromClipboard` — with a textarea, a
 * keyboard-layout selector, an unsupported-character handler, and a Send button.
 * Whatever rate-limiting and scancode mapping the vendor does, Send does it
 * properly. So drive that, and keep typing only as a fallback.
 *
 * The DOM structure below is copied from the live client (mapped over CDP):
 *
 *   kvm-modal-paste[ref=modalPaste] (shadow)
 *     kvm-modal-paste-ask-for-action     <- unsupported characters
 *     kvm-modal-paste-settings
 *     ucs-draggable-modal[header=kvm.menu.pasteFromClipboard]
 *       div[slot=body]   > ucs-textarea[ref=pasteTextarea] (shadow) > textarea
 *       div[slot=footer] > ucs-button "Settings" | "Cancel" | [primary] "Send"
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  closeConsolePaste,
  consolePasteClosePageScript,
  consolePastePageScript,
  pasteIntoConsole,
} from '../src/utils/consolePaste.js';

/** A hand-built stand-in for the live component tree, shadow roots included. */
function fakeConsoleDom(opts: { withComponent?: boolean; withTextarea?: boolean; withSend?: boolean } = {}) {
  const calls: string[] = [];
  const events: string[] = [];

  const textarea: any = {
    tagName: 'TEXTAREA',
    value: '',
    dispatchEvent(e: any) {
      // Behave like a real EventTarget: the live client threw "parameter 1 is not
      // of type 'Event'" on a plain object, and a fake that accepts anything is
      // exactly how that shipped.
      if (!e || e.__isEvent !== true) {
        throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
      }
      events.push(e.type);
      return true;
    },
    focus: () => calls.push('textarea.focus'),
  };

  const sendButton: any = {
    tagName: 'UCS-BUTTON',
    textContent: 'Send',
    attributes: { primary: '' },
    getAttribute: (n: string) => (n === 'primary' ? '' : null),
    hasAttribute: (n: string) => n === 'primary',
    click: () => calls.push('send.click'),
    shadowRoot: null,
  };
  const cancelButton: any = {
    tagName: 'UCS-BUTTON',
    textContent: 'Cancel',
    getAttribute: () => null,
    hasAttribute: () => false,
    click: () => calls.push('cancel.click'),
    shadowRoot: null,
  };

  const ucsTextarea: any = {
    tagName: 'UCS-TEXTAREA',
    getAttribute: (n: string) => (n === 'ref' ? 'pasteTextarea' : null),
    shadowRoot: {
      querySelectorAll: (sel: string) => (sel === '*' ? [textarea] : []),
      querySelector: (sel: string) => (sel === 'textarea' ? textarea : null),
    },
  };

  const modal: any = {
    tagName: 'KVM-MODAL-PASTE',
    getAttribute: (n: string) => (n === 'ref' ? 'modalPaste' : null),
    updateDisplayModal: (show: boolean) => calls.push(`updateDisplayModal(${show})`),
    handlePasteButtonClick: () => calls.push('handlePasteButtonClick'),
    handleCloseButtonClick: () => calls.push('handleCloseButtonClick'),
    shadowRoot: {
      querySelectorAll: (sel: string) => {
        if (sel !== '*') {
          return [];
        }
        const kids: any[] = [];
        if (opts.withTextarea !== false) {
          kids.push(ucsTextarea);
        }
        if (opts.withSend !== false) {
          kids.push(cancelButton, sendButton);
        }
        return kids;
      },
    },
  };

  const body: any = {
    tagName: 'BODY',
    querySelectorAll: (sel: string) => (sel === '*' && opts.withComponent !== false ? [modal] : []),
  };

  const makeEvent = (type: string) => ({ type, __isEvent: true, bubbles: true });
  return { document: { body } as any, calls, events, textarea, makeEvent };
}

describe('pasting through the client’s own paste dialog', () => {
  it('opens the dialog, fills it, and presses Send', async () => {
    const dom = fakeConsoleDom();
    const r = pasteIntoConsole(dom.document, 'cat /etc/network/interfaces', dom.makeEvent);

    assert.equal(r.ok, true, r.reason);
    assert.equal(dom.textarea.value, 'cat /etc/network/interfaces', 'the text must reach the textarea');
    assert.ok(dom.calls.includes('updateDisplayModal(true)'), `dialog must be opened, saw ${dom.calls.join(', ')}`);
    assert.ok(
      dom.calls.includes('send.click') || dom.calls.includes('handlePasteButtonClick'),
      `Send must be pressed, saw ${dom.calls.join(', ')}`
    );
  });

  it('fires an input event, or the component never learns about the text', async () => {
    // The Send button starts disabled and the component keeps its own state;
    // assigning .value alone leaves it thinking the box is empty.
    const dom = fakeConsoleDom();
    pasteIntoConsole(dom.document, 'ls -la', dom.makeEvent);
    assert.ok(dom.events.includes('input'), `expected an input event, saw ${dom.events.join(', ')}`);
  });

  it('reports plainly when the client has no paste dialog', async () => {
    // Then the caller falls back to typing rather than silently doing nothing.
    const dom = fakeConsoleDom({ withComponent: false });
    const r = pasteIntoConsole(dom.document, 'ls', dom.makeEvent);
    assert.equal(r.ok, false);
    assert.match(r.reason, /paste (component|dialog)|not found/i);
  });

  it('reports when the dialog exists but its textarea is missing', async () => {
    const dom = fakeConsoleDom({ withTextarea: false });
    const r = pasteIntoConsole(dom.document, 'ls', dom.makeEvent);
    assert.equal(r.ok, false);
    assert.match(r.reason, /textarea/i);
  });

  it('falls back to the component method when the Send button is absent', async () => {
    // Cisco can rename or restyle the button; the component API is the backstop.
    const dom = fakeConsoleDom({ withSend: false });
    const r = pasteIntoConsole(dom.document, 'ls', dom.makeEvent);
    assert.equal(r.ok, true, r.reason);
    assert.ok(dom.calls.includes('handlePasteButtonClick'));
  });

  it('never presses Cancel', async () => {
    const dom = fakeConsoleDom();
    pasteIntoConsole(dom.document, 'ls', dom.makeEvent);
    assert.equal(dom.calls.includes('cancel.click'), false);
  });

  it('refuses empty text rather than opening a dialog for nothing', async () => {
    const dom = fakeConsoleDom();
    const r = pasteIntoConsole(dom.document, '', dom.makeEvent);
    assert.equal(r.ok, false);
    assert.equal(dom.calls.length, 0);
  });

  it('composes into a page script that carries its own helpers', () => {
    // Same trick as the focus script: one implementation, tested here and shipped
    // into the page via toString(), so nothing is written twice.
    const script = consolePastePageScript('echo hi');
    assert.match(script, /pasteIntoConsole/);
    assert.match(script, /deepFind|querySelectorAll/);
    assert.match(script, /echo hi/);
    assert.doesNotMatch(script, /import |require\(/, 'a page script cannot import anything');
  });

  it('produces a script the browser can actually parse', () => {
    // A page script is never type-checked and never linted; a syntax error in it
    // surfaces as a mysterious runtime failure inside the console page.
    const script = consolePastePageScript(`printf 'a"b' && echo $HOME`);
    assert.doesNotThrow(() => new Function(`return ${script}`), 'the composed page script must parse');
  });

  it('escapes the text it embeds, so a quote cannot break the script', () => {
    const script = consolePastePageScript(`printf 'a"b\\n' && echo $HOME`);
    assert.doesNotMatch(script.split('\n').slice(-3).join('\n'), /[^\\]'a"b/);
    assert.match(script, /printf/);
  });

  it('dispatches REAL Event objects, which the browser insists on', () => {
    // Live failure: dispatchEvent({type:'input'}) threw "parameter 1 is not of
    // type 'Event'" on the client, while the fake DOM accepted it happily — so
    // the factory is part of the contract now.
    const dom = fakeConsoleDom();
    const seen: unknown[] = [];
    const r = pasteIntoConsole(dom.document, 'ls', (type) => {
      const ev = { type, __isEvent: true };
      seen.push(ev);
      return ev;
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(seen.length, 2, 'one input and one change');
    assert.deepEqual(dom.events, ['input', 'change']);
  });

  it('embeds a real Event constructor in the page script', () => {
    assert.match(consolePastePageScript('x'), /new Event\(/);
  });
});

describe('closing the paste dialog', () => {
  it('presses Cancel, so a fallback cannot type into the dialog', () => {
    // Observed live: the client paste failed halfway, the dialog stayed open and
    // focused, and the typed fallback put the command into the dialog's own box.
    const dom = fakeConsoleDom();
    const r = closeConsolePaste(dom.document);
    assert.equal(r.closed, true, r.reason);
    assert.ok(dom.calls.includes('cancel.click'));
  });

  it('uses the component when no Cancel button is found', () => {
    const dom = fakeConsoleDom({ withSend: false });
    const r = closeConsolePaste(dom.document);
    assert.equal(r.closed, true, r.reason);
    assert.ok(
      dom.calls.includes('handleCloseButtonClick') || dom.calls.includes('updateDisplayModal(false)'),
      dom.calls.join(', ')
    );
  });

  it('says so when there is no dialog at all', () => {
    const dom = fakeConsoleDom({ withComponent: false });
    assert.equal(closeConsolePaste(dom.document).closed, false);
  });

  it('composes into a parseable page script', () => {
    const script = consolePasteClosePageScript();
    assert.doesNotThrow(() => new Function(`return ${script}`));
    assert.match(script, /closeConsolePaste/);
  });
});
