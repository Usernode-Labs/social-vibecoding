'use strict';

// #2478 — the board's "+" announces itself.
//
// `#dev-plus-btn` (frontend/src/features/dev-board/actions-row.tsx) is a
// 36px square whose only child is the literal `+`. It carried a `title` and
// `aria-haspopup`, and nothing else: a `title` is a TOOLTIP, and no assistive
// technology is obliged to fall back to it for an accessible name — VoiceOver
// in Safari does not — so the button was announced as "plus". Every other
// glyph-only trigger on this board already pairs `title` with a matching
// `aria-label`; this was the last one without.
//
// Two tests here, and they are deliberately different in kind:
//
//   1. The ANCHOR. Render the real component in both states its label is
//      conditional on and read the attribute off the produced markup. It
//      asserts the name exists, that it is not the glyph, and that it says
//      the same thing the sighted user's tooltip says — the drift a
//      hand-copied second string would have introduced.
//   2. The GUARD. Every `aria-haspopup` trigger under
//      frontend/src/features/dev-board/** must have a name from SOMEWHERE:
//      an `aria-label`, or real text content. A trigger whose only literal
//      children are a glyph and `aria-hidden` icons is the shape this issue
//      was, and it is cheap to keep it from coming back on the next one.
//      Triggers whose label is a JSX expression are reported, not judged —
//      see the note on the guard.
//
// The legacy co-owner is not disturbed. `AppView._wirePlusMenu`
// (public/js/app-view.js) binds this node's click handler and writes
// `aria-expanded` to it; it never touches `aria-label` and never replaces the
// node's attributes wholesale, so a static `aria-label` rendered by React has
// exactly one owner.
//
// Run with: node --test tests/dev-plus-accessible-name.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { decodeEntities } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');
const BOARD = path.join(ROOT, 'frontend', 'src', 'features', 'dev-board');

const { DevActionsRow } = loadTsx('frontend/src/features/dev-board/actions-row.tsx');

const BASE = {
  selfHosted: false, canCollaborate: true, showsMembers: true,
  cardCls: '', cardHoverCls: '',
};

// The "+"'s own open tag, out of the rendered row.
function plusTag(props) {
  const html = renderToHtml(createElement(DevActionsRow, { ...BASE, ...props }));
  const m = html.match(/<button id="dev-plus-btn"[^>]*>/);
  assert.ok(m, 'the row renders #dev-plus-btn');
  return m[0];
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};

// ── 1. the anchor ────────────────────────────────────────────────────────

test('the + button has an accessible name, and it is the tooltip it shows', () => {
  // Both branches of the label's one conditional. A read-only viewer's menu
  // holds Fork alone, so the two say genuinely different things and a test
  // that only rendered one of them would miss half the fix.
  for (const props of [
    { readOnly: false },
    { readOnly: true, canCollaborate: false },
  ]) {
    const tag = plusTag(props);
    const label = attr(tag, 'aria-label');
    const title = attr(tag, 'title');
    assert.ok(label, `#dev-plus-btn has an aria-label (readOnly=${props.readOnly})`);
    assert.equal(label, title,
      'the accessible name and the tooltip are the same string');
    assert.match(label, /[A-Za-z]{3}/,
      'the name is words, not the "+" glyph the button draws');
  }
});

test('the two states name the two different menus', () => {
  const open = attr(plusTag({ readOnly: false }), 'aria-label');
  const ro = attr(plusTag({ readOnly: true, canCollaborate: false }), 'aria-label');
  assert.notEqual(open, ro,
    'a read-only viewer, whose menu is Fork alone, is told so');
});

test('nothing outside React writes aria-label to #dev-plus-btn', () => {
  // The ownership rule, checked rather than asserted in prose: _wirePlusMenu
  // co-owns this node. It may write aria-expanded — a DIFFERENT attribute,
  // which is fine — but a second writer of aria-label would be a torn
  // attribute, and AGENTS.md forbids it.
  const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');
  const wire = view.slice(view.indexOf('_wirePlusMenu(content) {'));
  assert.ok(wire.startsWith('_wirePlusMenu(content) {'), 'found _wirePlusMenu');
  const body = wire.slice(0, wire.indexOf('\n  _', 1));
  assert.match(body, /btn\.setAttribute\('aria-expanded'/,
    'the legacy owner writes aria-expanded, as it always has');
  assert.doesNotMatch(body, /aria-label/,
    'and never aria-label, which React now renders');
});

// ── 2. the guard ─────────────────────────────────────────────────────────

// Where a JSX open tag that starts at `start` ends. Attribute values can hold
// braces and quotes with `>` inside them (`title={a ? '>' : b}`), so this
// tracks both rather than reaching for the next `>`.
function openTagEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < src.length; i += 1) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth += 1; continue; }
    if (c === '}') { depth -= 1; continue; }
    if (depth === 0 && c === '>') return { end: i, selfClosing: src[i - 1] === '/' };
  }
  throw new Error(`unterminated JSX tag at ${start}`);
}

// Drop every subtree rooted at an element carrying aria-hidden: an icon
// contributes nothing to the name, so it must not count as content either.
// Elements marked aria-hidden here never nest inside another of the same
// name, so the first matching close tag is the right one.
function stripHidden(src) {
  let out = src;
  for (;;) {
    let cut = null;
    const re = /<([A-Za-z][\w.]*)\b/g;
    let m;
    while ((m = re.exec(out))) {
      const tag = openTagEnd(out, m.index);
      if (!/\saria-hidden[=\s]/.test(out.slice(m.index, tag.end + 1))) continue;
      if (tag.selfClosing) { cut = [m.index, tag.end + 1]; break; }
      const close = out.indexOf(`</${m[1]}>`, tag.end);
      if (close < 0) continue;
      cut = [m.index, close + m[1].length + 3];
      break;
    }
    if (!cut) return out;
    out = out.slice(0, cut[0]) + out.slice(cut[1]);
  }
}

// Remove balanced {…} children, reporting whether there were any.
function splitExpressions(src) {
  let out = '';
  let depth = 0;
  let dynamic = false;
  for (const c of src) {
    if (c === '{') { depth += 1; dynamic = true; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) out += c;
  }
  return { literal: out, dynamic };
}

function tsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function popupTriggers() {
  const found = [];
  for (const file of tsxFiles(BOARD)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (let at = src.indexOf('aria-haspopup'); at !== -1; at = src.indexOf('aria-haspopup', at + 1)) {
      let open = at;
      while (open > 0 && !(src[open] === '<' && /[A-Za-z]/.test(src[open + 1] || ''))) open -= 1;
      const tag = openTagEnd(src, open);
      if (tag.end < at) continue; // an `aria-haspopup` in prose, not on this tag
      const name = /^<([A-Za-z][\w.]*)/.exec(src.slice(open))[1];
      const head = src.slice(open, tag.end + 1);
      // A button never nests a button, so the next close tag is this one's.
      const close = tag.selfClosing ? tag.end : src.indexOf(`</${name}>`, tag.end);
      const inner = tag.selfClosing || close < 0 ? '' : src.slice(tag.end + 1, close);
      const { literal, dynamic } = splitExpressions(
        stripHidden(inner).replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      );
      const text = literal.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      found.push({
        where: `${rel}:${src.slice(0, at).split('\n').length}`,
        labelled: /\saria-label[=\s]/.test(head),
        // Two letters is the line between a word and a glyph: "+", "×" and
        // "⋯" are drawings, "Ask" and "More" are names.
        texted: /[A-Za-z0-9]{2}/.test(text),
        dynamic,
        text,
      });
    }
  }
  return found;
}

test('every aria-haspopup trigger on the dev board has an accessible name', () => {
  const triggers = popupTriggers();
  // A floor, so that a refactor which renames the attribute or moves the
  // board cannot turn this test into one that inspects nothing.
  assert.ok(triggers.length >= 8,
    `found ${triggers.length} aria-haspopup triggers on the dev board`);
  assert.ok(triggers.some((t) => t.where.startsWith('frontend/src/features/dev-board/actions-row.tsx')),
    'the "+" is among them');

  // The rule, and ONLY over triggers this can read honestly. A label built
  // from a JSX expression (`{voted ? \`Voted ${voted}\` : 'Vote'}`) is a name
  // a source scan cannot evaluate, so those are not judged here — reading the
  // ternary's own source text as if it were rendered content is how a guard
  // like this passes for the wrong reason.
  const nameless = triggers.filter((t) => !t.labelled && !t.texted && !t.dynamic);
  assert.deepEqual(nameless, [],
    'a glyph-only popup trigger needs an aria-label:\n'
      + nameless.map((t) => `  ${t.where} renders ${JSON.stringify(t.text)}`).join('\n'));
});
