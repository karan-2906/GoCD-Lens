/**
 * `el()` is the only way this extension puts data on screen, so this is where
 * the "a build log cannot become markup" property is actually enforced.
 *
 * The DOM here is a stub that records what was done to it rather than one that
 * escapes anything -- so these tests observe how `el()` builds a tree, and a
 * string that arrived as text would show up as an element if it had ever been
 * parsed as HTML.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  append(...children) {
    for (const child of children) {
      // A real DOM splices a fragment's children in and leaves the fragment
      // behind; modelling that is what lets these tests see inside one.
      if (child instanceof FakeFragment) {
        const moved = child.childNodes;
        child.childNodes = [];
        this.append(...moved);
        continue;
      }
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [new FakeText(value)];
  }

  /** Every element in the subtree, so a test can prove none were created. */
  get elements() {
    return this.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...c.elements] : []));
  }
}

class FakeFragment extends FakeNode {}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tag, namespace = null) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.namespace = namespace;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  replaceChildren(...children) {
    this.childNodes = [];
    this.append(...children);
  }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag, ns),
  createTextNode: (data) => new FakeText(data),
  createDocumentFragment: () => new FakeFragment(),
};

const { el, icon, clear, highlighted } = await import('../src/common/ui.js');

/** What a build log, a commit message or a badly named pipeline might contain. */
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '</div><script>alert(1)</script>',
  '<svg/onload=alert(1)>',
  'javascript:alert(1)',
  '"><iframe src=javascript:alert(1)>',
  '&lt;not really markup&gt;',
];

test('text given to el() stays one text node, whatever it contains', () => {
  for (const payload of PAYLOADS) {
    const node = el('div', { text: payload });
    assert.equal(node.textContent, payload, 'the text must survive byte for byte');
    assert.equal(node.childNodes.length, 1);
    assert.ok(node.childNodes[0] instanceof FakeText, `${payload} was not kept as text`);
    assert.deepEqual(node.elements, [], `${payload} created elements -- it was parsed as markup`);
  }
});

test('a bare string child is also wrapped as text, not parsed', () => {
  const node = el('span', {}, '<b>bold</b>');
  assert.equal(node.childNodes.length, 1);
  assert.ok(node.childNodes[0] instanceof FakeText);
  assert.deepEqual(node.elements, []);
});

test('el() refuses a raw-HTML prop outright rather than quietly ignoring it', () => {
  assert.throws(() => el('div', { html: '<b>x</b>' }), /does not accept raw HTML/);
});

test('handlers are attached as listeners, never as inline attributes', () => {
  let clicked = 0;
  const node = el('button', { onclick: () => (clicked += 1) });
  assert.deepEqual(Object.keys(node.attributes), [], 'no onclick="" attribute is written');
  assert.equal(node.listeners.click.length, 1);
  node.listeners.click[0]();
  assert.equal(clicked, 1);
});

test('el() maps the props it special-cases and passes the rest to attributes', () => {
  const node = el('div', {
    class: 'card edge-fail',
    dataset: { pipeline: 'web-app' },
    style: { marginTop: '6px' },
    title: 'Run history',
    'aria-current': 'true',
  });
  assert.equal(node.className, 'card edge-fail');
  assert.equal(node.dataset.pipeline, 'web-app');
  assert.equal(node.style.marginTop, '6px');
  assert.equal(node.getAttribute('title'), 'Run history');
  assert.equal(node.getAttribute('aria-current'), 'true');
});

test('null, undefined and false children are skipped so conditionals read cleanly', () => {
  // `paused && el(...)` is used all over the views; false must not render "false".
  const node = el('div', {}, 'a', null, undefined, false, 'b', [['c']]);
  assert.equal(node.textContent, 'abc');
});

test('null and false props are ignored rather than stringified', () => {
  const node = el('div', { title: null, hidden: false, 'aria-label': undefined });
  assert.deepEqual(Object.keys(node.attributes), []);
});

test('search highlighting preserves the text exactly and only wraps the hits', () => {
  const name = 'web-app-build-prod';
  const node = el('span');
  node.append(highlighted(name, [0, 4, 8, 14]));

  assert.equal(node.textContent, name, 'highlighting must not lose or reorder a character');
  const marks = node.elements.filter((e) => e.tagName === 'MARK');
  assert.equal(marks.length, 4);
  assert.deepEqual(marks.map((m) => m.textContent), ['w', 'a', 'b', 'p']);
});

test('adjacent matched characters collapse into a single mark', () => {
  const node = el('span');
  node.append(highlighted('build', [0, 1, 2]));
  const marks = node.elements.filter((e) => e.tagName === 'MARK');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, 'bui');
  assert.equal(node.textContent, 'build');
});

test('highlighting a name that contains markup still produces no elements but the mark', () => {
  const hostile = '<script>x</script>';
  const node = el('span');
  node.append(highlighted(hostile, [0]));
  assert.equal(node.textContent, hostile);
  assert.deepEqual(node.elements.map((e) => e.tagName), ['MARK']);
});

test('with nothing matched, highlighting returns plain text', () => {
  const node = el('span');
  node.append(highlighted('web-app', []));
  assert.deepEqual(node.elements, []);
  assert.equal(node.textContent, 'web-app');
});

test('icons are built as SVG nodes pointing at the bundled sprite', () => {
  const svg = icon('refresh', { size: 13 });
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('width'), '13');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');

  const use = svg.childNodes[0];
  assert.equal(use.tagName, 'USE');
  assert.equal(use.getAttribute('href'), '#i-refresh', 'a local sprite reference, not a remote URL');
});

test('clear() empties a node so a re-render cannot leave stale rows behind', () => {
  const node = el('div', {}, 'one', 'two');
  assert.equal(node.textContent, 'onetwo');
  clear(node);
  assert.deepEqual(node.childNodes, []);
});
