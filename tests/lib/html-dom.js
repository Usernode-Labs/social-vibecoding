'use strict';

// A document just big enough for `decorateRefs` / `linkRefsInHtml` (#5728):
// elements, text nodes, fragments, simple attributes, and a tiny parser for
// the markup marked emits in these tests. Not an HTML5 parser: tags close by
// name, void elements are not modelled, entities are the five marked writes.
//
// The tree is the shape tests/messages-ref-chips.test.js already drives
// decorateRefs with, so a test can assert a serialized result either way.

const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*>/g;
const ATTR = /([\w:-]+)="([^"]*)"/g;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

function unescapeText(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITY[name]);
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function makeHtmlDocument() {
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
    set textContent(value) { this.childNodes = []; this.appendChild(new Text(value)); }
    set innerHTML(value) {
      this.childNodes = [];
      parseInto(this, String(value));
    }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
  }

  function parseInto(root, text) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    let pos = 0;
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(text)) !== null) {
      const between = text.slice(pos, m.index);
      if (between) top().appendChild(new Text(unescapeText(between)));
      pos = m.index + m[0].length;
      const [, closing, tag, rawAttrs] = m;
      if (closing) {
        const at = stack.map((n) => n.tagName).lastIndexOf(tag.toUpperCase());
        if (at > 0) stack.length = at;
        continue;
      }
      const el = new Element(tag);
      let a;
      ATTR.lastIndex = 0;
      while ((a = ATTR.exec(rawAttrs || '')) !== null) el.setAttribute(a[1], unescapeText(a[2]));
      top().appendChild(el);
      stack.push(el);
    }
    const rest = text.slice(pos);
    if (rest) top().appendChild(new Text(unescapeText(rest)));
  }

  function serialize(node) {
    if (node.nodeType === 3) return escapeText(node.nodeValue);
    const inner = node.childNodes.map(serialize).join('');
    if (node.isFragment || node.root) return inner;
    const tag = node.tagName.toLowerCase();
    const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (value) => new Text(value);
  doc.createDocumentFragment = () => new Fragment();
  doc.serialize = serialize;
  return doc;
}

module.exports = { makeHtmlDocument };
