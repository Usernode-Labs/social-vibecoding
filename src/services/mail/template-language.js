'use strict';

// The email template language: {{name}}, {{#if name}}..{{else}}..{{/if}} and
// {{#unless name}}..{{/unless}}, and nothing else. It is logic-less on
// purpose: admins edit these texts, so there are no helpers, paths or triple
// braces to get wrong, and a value is inserted as one literal piece of text
// that is never parsed again (no injection through a user-supplied value).

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

class TemplateSyntaxError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'TemplateSyntaxError';
    this.offset = offset;
  }
}

// Like `esc` in templates.js, plus the apostrophe, so a value inside a
// single-quoted attribute cannot end the attribute early.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function checkName(name, offset) {
  if (!NAME.test(name)) throw new TemplateSyntaxError(`Invalid placeholder name "${name}"`, offset);
  return name;
}

// One pass over the source with a stack of open blocks. Each block holds the
// list its content currently goes into; {{else}} swaps that list.
function parse(source) {
  const src = String(source == null ? '' : source);
  const root = { nodes: [] };
  const stack = [{ kind: 'root', list: root.nodes, offset: 0 }];
  const top = () => stack[stack.length - 1];
  let pos = 0;
  while (pos < src.length) {
    const open = src.indexOf('{{', pos);
    if (open === -1) {
      top().list.push({ type: 'text', value: src.slice(pos) });
      break;
    }
    if (open > pos) top().list.push({ type: 'text', value: src.slice(pos, open) });
    const close = src.indexOf('}}', open + 2);
    if (close === -1) throw new TemplateSyntaxError('Unclosed "{{"', open);
    const body = src.slice(open + 2, close).trim();
    pos = close + 2;
    let m;
    if ((m = /^#(if|unless)\s+(\S+)$/.exec(body))) {
      const node = { type: m[1], name: checkName(m[2], open), then: [], else: [] };
      top().list.push(node);
      stack.push({ kind: m[1], node, list: node.then, offset: open, seenElse: false });
    } else if (body === 'else') {
      const t = top();
      if (t.kind === 'root') throw new TemplateSyntaxError('"{{else}}" outside a block', open);
      if (t.seenElse) throw new TemplateSyntaxError('Second "{{else}}" in one block', open);
      t.seenElse = true;
      t.list = t.node.else;
    } else if ((m = /^\/(if|unless)$/.exec(body))) {
      const t = top();
      if (t.kind === 'root') throw new TemplateSyntaxError(`"{{/${m[1]}}}" without an opening tag`, open);
      if (t.kind !== m[1]) throw new TemplateSyntaxError(`"{{/${m[1]}}}" closes a "{{#${t.kind}}}"`, open);
      stack.pop();
    } else {
      top().list.push({ type: 'var', name: checkName(body, open) });
    }
  }
  if (stack.length > 1) {
    const t = top();
    throw new TemplateSyntaxError(`"{{#${t.kind}}}" is never closed`, t.offset);
  }
  return root;
}

// null, undefined, false and '' are false; 0 is a real value and so true.
function truthy(v) {
  return !(v === undefined || v === null || v === false || v === '');
}

// Own properties only, so {{constructor}} or {{#if toString}} cannot reach
// Object.prototype and leak or flip on built-in members.
function lookup(data, name) {
  return Object.hasOwn(data, name) ? data[name] : undefined;
}

function render(source, values, opts = {}) {
  const html = opts.mode !== 'text';
  const raw = new Set(opts.raw || []);
  const data = values || {};
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') out.push(n.value);
      else if (n.type === 'var') {
        const v = lookup(data, n.name);
        if (v === undefined || v === null) continue;
        out.push(html && !raw.has(n.name) ? escapeHtml(v) : String(v));
      } else {
        const on = truthy(lookup(data, n.name));
        walk(on === (n.type === 'if') ? n.then : n.else);
      }
    }
  };
  walk(parse(source).nodes);
  return out.join('');
}

function placeholdersIn(source) {
  const names = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.name) names.add(n.name);
      if (n.then) walk(n.then);
      if (n.else) walk(n.else);
    }
  };
  walk(parse(source).nodes);
  return names;
}

module.exports = { parse, render, placeholdersIn, escapeHtml, TemplateSyntaxError };
