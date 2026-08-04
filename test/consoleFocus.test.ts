/**
 * Keyboard input reached nothing, silently.
 *
 * The vKVM client renders the server's video into `canvas#kvmCanvas` and listens
 * for key events there. That canvas sits TWO shadow roots deep:
 *
 *   body > div#kvmApplicationDiv > kvm-ui (shadow) > div#contents
 *        > kvm-video (shadow) > canvas#kvmCanvas
 *
 * `querySelector` does not cross a shadow boundary, so the old code — which
 * searched only `kvm-ui`'s own root — found no canvas and fell back to "first
 * element with a tabindex", a div in the page header. Verified live: focus sat on
 * `div#contents` while `browser_send_keys` reported `consoleFocused: true`,
 * because the check compared against that same wrong element.
 *
 * Nothing threw. Keys were dispatched, acknowledged, and dropped.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  findConsoleTarget,
  focusConsoleTarget,
  describeNode,
  type FocusableLike,
  type RootLike,
} from '../src/utils/consoleFocus.js';

/** A DOM-ish node good enough for the traversal under test. */
function node(tagName: string, opts: { id?: string; children?: FakeNode[]; shadow?: FakeNode[]; tabindex?: string } = {}) {
  return new FakeNode(tagName, opts);
}

class FakeNode implements FocusableLike {
  tagName: string;
  id?: string;
  children: FakeNode[];
  shadowRoot: FakeRoot | null;
  private attrs: Record<string, string> = {};
  private owner: FakeRoot | null = null;

  constructor(tagName: string, opts: { id?: string; children?: FakeNode[]; shadow?: FakeNode[]; tabindex?: string }) {
    this.tagName = tagName.toUpperCase();
    this.id = opts.id;
    this.children = opts.children ?? [];
    if (opts.tabindex !== undefined) {
      this.attrs.tabindex = opts.tabindex;
    }
    this.shadowRoot = opts.shadow ? new FakeRoot(opts.shadow) : null;
    if (this.shadowRoot) {
      this.shadowRoot.claim(this.shadowRoot);
    }
  }

  setOwner(root: FakeRoot) {
    this.owner = root;
  }
  getRootNode() {
    return (this.owner ?? new FakeRoot([])) as unknown as { activeElement?: FocusableLike | null };
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  focus() {
    this.owner?.setActive(this);
  }
  /** Depth-first descendants within THIS root (does not cross shadow boundaries). */
  descendants(): FakeNode[] {
    const out: FakeNode[] = [];
    for (const c of this.children) {
      out.push(c, ...c.descendants());
    }
    return out;
  }
  matches(sel: string): boolean {
    const [tag, id] = sel.split('#');
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (id && this.id !== id) return false;
    return true;
  }
}

class FakeRoot implements RootLike {
  activeElement: FocusableLike | null = null;
  constructor(private readonly roots: FakeNode[]) {}
  claim(root: FakeRoot) {
    for (const n of this.all()) {
      n.setOwner(root);
    }
  }
  private all(): FakeNode[] {
    const out: FakeNode[] = [];
    for (const r of this.roots) {
      out.push(r, ...r.descendants());
    }
    return out;
  }
  setActive(el: FocusableLike) {
    this.activeElement = el;
  }
  querySelector(sel: string) {
    return this.all().find((n) => n.matches(sel)) ?? null;
  }
  querySelectorAll(_sel: string) {
    return this.all();
  }
}

/** The real Intersight structure, as observed on a live console. */
function intersightConsole() {
  const canvas = node('canvas', { id: 'kvmCanvas' });
  const kvmVideo = node('kvm-video', { shadow: [canvas] });
  const header = node('div', { id: 'header', tabindex: '0' });
  const contents = node('div', { id: 'contents', tabindex: '0', children: [kvmVideo] });
  const kvmUi = node('kvm-ui', { id: 'kvmUiComponent', shadow: [header, contents] });
  const body = node('div', { id: 'kvmApplicationDiv', children: [kvmUi] });
  const doc = new FakeRoot([body]);
  doc.claim(doc);
  return { doc, canvas, contents, header };
}

describe('console focus target', () => {
  it('finds the canvas two shadow roots deep', () => {
    const { doc, canvas } = intersightConsole();
    assert.equal(findConsoleTarget(doc), canvas, 'must pierce nested shadow roots');
  });

  it('does NOT settle for a focusable element in the page chrome', () => {
    const { doc, contents, header } = intersightConsole();
    const found = findConsoleTarget(doc);
    assert.notEqual(found, contents, 'div#contents is chrome — keys sent there are dropped');
    assert.notEqual(found, header, 'nor the header');
  });

  it('focuses the canvas and reports which element it focused', () => {
    const { doc, canvas } = intersightConsole();
    const r = focusConsoleTarget(doc);
    assert.equal(r.focused, true);
    assert.equal(r.target, 'canvas#kvmCanvas', 'the answer must name the element, not just say "true"');
    assert.equal(r.isConsoleCanvas, true);
    assert.equal(canvas.getAttribute('tabindex'), '-1', 'a canvas needs a tabindex to take focus');
  });

  it('verifies focus against the canvas OWN root, not document.activeElement', () => {
    // document.activeElement only ever reports the outermost host, so a check
    // against it cannot tell the canvas from its shadow host.
    const { doc, canvas } = intersightConsole();
    focusConsoleTarget(doc);
    assert.equal(canvas.getRootNode().activeElement, canvas);
  });

  it('reports honestly when there is no console canvas at all', () => {
    const doc = new FakeRoot([node('div', { id: 'nothing', tabindex: '0' })]);
    doc.claim(doc);
    const r = focusConsoleTarget(doc);
    assert.equal(r.focused, false);
    assert.equal(r.target, null);
    assert.equal(r.isConsoleCanvas, false);
  });

  it('falls back to a plain canvas or video when the id differs', () => {
    for (const tag of ['canvas', 'video']) {
      const inner = node(tag);
      const host = node('some-host', { shadow: [inner] });
      const doc = new FakeRoot([host]);
      doc.claim(doc);
      assert.equal(findConsoleTarget(doc), inner, `should still find a bare <${tag}>`);
    }
  });

  it('survives a cyclic tree without spinning', () => {
    const host = node('kvm-ui', { shadow: [node('div')] });
    const doc = new FakeRoot([host]);
    doc.claim(doc);
    // Point the shadow root back at the document: a naive walk would loop.
    (host as any).shadowRoot = doc;
    assert.equal(findConsoleTarget(doc), null);
  });

  it('describes nodes readably', () => {
    assert.equal(describeNode(node('canvas', { id: 'kvmCanvas' })), 'canvas#kvmCanvas');
    assert.equal(describeNode(node('video')), 'video');
    assert.equal(describeNode(null), null);
  });
});
