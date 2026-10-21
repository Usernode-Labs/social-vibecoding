'use strict';

// A DOM just big enough for the reference chips (#5728).
//
// `linkRefsInHtml` parses a reply's sanitized markup into a detached div with
// `innerHTML`, runs `decorateRefs` over it, and returns `innerHTML` again.
// Node has neither `document` nor a parser, so tests that exercise that path
// install this one: text nodes, elements with quoted attributes, fragments,
// and an `innerHTML` parser/serializer for the markup marked emits.
//
// It is deliberately not a general HTML parser — just the calls the decorator
// makes. `tests/messages-ref-chips.test.js` keeps its own older copy because
// its first tests build the markup by hand rather than parse it.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ENTITIES[e]);
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function serialize(node) {
  if (node.nodeType === 3) return escText(node.nodeValue);
  const inner = node.childNodes.map(serialize).join('');
  if (node.isFragment || node.root) return inner;
  const tag = node.tagName.toLowerCase();
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function makeDocument() {
  const doc = {};
  class Node {
    constructor() { this.parentNode = null; this.childNodes = []; this.ownerDocument = doc; }
    appendChild(node) {
      const nodes = node.isFragment ? node.childNodes.splice(0) : [node];
      for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); }
      return node;
    }
    replaceChild(next, old) {
      const nodes = next.isFragment ? next.childNodes.splice(0) : [next];
      const at = this.childNodes.indexOf(old);
      this.childNodes.splice(at, 1, ...nodes);
      for (const n of nodes) n.parentNode = this;
      old.parentNode = null;
    }
  }
  class Text extends Node {
    constructor(value) { super(); this.nodeType = 3; this.nodeValue = String(value); }
  }
  class Fragment extends Node {
    constructor() { super(); this.nodeType = 11; this.isFragment = true; }
  }
  class Element extends Node {
    constructor(tag) { super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = []; }
    set className(value) { this.setAttribute('class', value); }
    setAttribute(name, value) {
      const found = this.attrs.find((a) => a[0] === name);
      if (found) found[1] = String(value); else this.attrs.push([name, String(value)]);
    }
    getAttribute(name) {
      const found = this.attrs.find((a) => a[0] === name);
      return found ? found[1] : null;
    }
    set textContent(value) { this.childNodes = []; this.appendChild(new Text(value)); }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set innerHTML(value) {
      this.childNodes = [];
      parseHtml(doc, this, String(value));
    }
  }
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (value) => new Text(value);
  doc.createDocumentFragment = () => new Fragment();
  return doc;
}

function parseHtml(doc, root, source) {
  const token = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  const stack = [root];
  let m;
  while ((m = token.exec(source)) !== null) {
    const current = stack[stack.length - 1];
    if (m[5] != null) {
      current.appendChild(doc.createTextNode(decode(m[5])));
      continue;
    }
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = doc.createElement(m[2]);
    for (const a of (m[3] || '').matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) el.setAttribute(a[1], decode(a[2]));
    current.appendChild(el);
    if (!m[4]) stack.push(el);
  }
}

module.exports = { makeDocument, serialize };
