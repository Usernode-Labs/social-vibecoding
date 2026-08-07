#!/usr/bin/env node
// ONE-TIME migration tool: converts the pre-migration public/index.html into
// the React sources that now generate it.
//
//   node frontend/scripts/html-to-jsx.cjs
//     → frontend/index.html   (the Vite HTML template: <head>, verbatim)
//     → frontend/src/Shell.tsx (the <body> contents as static JSX)
//
// This is NOT part of the build. It ran once, its output was committed, and
// frontend/src/Shell.tsx is hand-maintained source from that point on. It is
// kept in the tree so the mechanical conversion is reproducible and
// reviewable rather than a pile of hand edits nobody can re-derive.

'use strict';

const fs = require('fs');
const path = require('path');
const { tokenize, VOID_ELEMENTS } = require('../../tests/helpers/html-tokens.js');

const ROOT = path.join(__dirname, '..', '..');

// ── Attribute name mapping ─────────────────────────────────────────────
// HTML attribute → React prop. Anything not listed and not data-/aria- is
// passed through unchanged (which is correct for lowercase one-word attrs
// like id, src, href, alt, rel, type, name, value, title, role, width…).
const ATTR_MAP = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  autocomplete: 'autoComplete',
  autocapitalize: 'autoCapitalize',
  autocorrect: 'autoCorrect',
  autofocus: 'autoFocus',
  autoplay: 'autoPlay',
  spellcheck: 'spellCheck',
  contenteditable: 'contentEditable',
  inputmode: 'inputMode',
  enterkeyhint: 'enterKeyHint',
  novalidate: 'noValidate',
  formaction: 'formAction',
  formnovalidate: 'formNoValidate',
  accesskey: 'accessKey',
  crossorigin: 'crossOrigin',
  datetime: 'dateTime',
  srcset: 'srcSet',
  srclang: 'srcLang',
  usemap: 'useMap',
  playsinline: 'playsInline',
  allowfullscreen: 'allowFullScreen',
  referrerpolicy: 'referrerPolicy',
  frameborder: 'frameBorder',
  marginwidth: 'marginWidth',
  marginheight: 'marginHeight',
  'accept-charset': 'acceptCharset',
  'http-equiv': 'httpEquiv',
  // SVG presentation attributes
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-opacity': 'strokeOpacity',
  'stroke-miterlimit': 'strokeMiterlimit',
  'fill-rule': 'fillRule',
  'fill-opacity': 'fillOpacity',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'font-size': 'fontSize',
  'font-family': 'fontFamily',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'marker-end': 'markerEnd',
  'marker-start': 'markerStart',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'paint-order': 'paintOrder',
  'stroke-linejoin ': 'strokeLinejoin',
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  gradientunits: 'gradientUnits',
  patternunits: 'patternUnits',
  'xmlns:xlink': 'xmlnsXlink',
  'xlink:href': 'xlinkHref',
};

// Attributes React types as booleans. A bare `hidden` / `hidden=""` in HTML
// must become `hidden={true}`, not `hidden=""` (which React renders as
// present anyway, but TypeScript rejects the string).
const BOOLEAN_ATTRS = new Set([
  'disabled', 'hidden', 'checked', 'selected', 'readonly', 'multiple',
  'required', 'autofocus', 'novalidate', 'formnovalidate', 'autoplay',
  'controls', 'loop', 'muted', 'open', 'reversed', 'default', 'inert',
  'playsinline', 'allowfullscreen', 'itemscope',
]);

// Attributes whose value React types as a number.
const NUMERIC_ATTRS = new Set(['tabindex', 'colspan', 'rowspan', 'maxlength', 'minlength', 'size', 'span', 'start', 'rows', 'cols']);

function camelCaseStyleProp(prop) {
  if (prop.startsWith('--')) return prop; // CSS custom property: keep verbatim
  return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function styleToObject(value) {
  const decls = value.split(';').map((d) => d.trim()).filter(Boolean);
  const parts = [];
  for (const d of decls) {
    const c = d.indexOf(':');
    if (c === -1) continue;
    const prop = camelCaseStyleProp(d.slice(0, c).trim());
    const val = d.slice(c + 1).trim();
    const key = /^[A-Za-z][A-Za-z0-9]*$/.test(prop) ? prop : JSON.stringify(prop);
    parts.push(`${key}: ${JSON.stringify(val)}`);
  }
  return `{{ ${parts.join(', ')} }}`;
}

// Emit an attribute VALUE so React reproduces the original string exactly.
//
// A double-quoted JSX attribute literal is NOT a JavaScript string: backslash
// escapes are passed through verbatim (so `\n` would ship as two literal
// characters, not a newline) while HTML entities ARE decoded. Values
// containing either — plus a literal `"`, which would close the literal —
// must therefore go through the expression form `={"…"}`, where normal JS
// string rules apply. Three class attributes in the shell wrap across lines,
// which is exactly this case.
function jsxAttrValue(value) {
  return /["&\n\r\t\\]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

function renderAttr(name, value) {
  const lower = name.toLowerCase();

  if (lower === 'style' && value !== null) return `style=${styleToObject(value)}`;

  // data-* and aria-* keep their hyphenated names in JSX.
  if (lower.startsWith('data-') || lower.startsWith('aria-')) {
    return value === null ? `${lower}=""` : `${lower}=${jsxAttrValue(value)}`;
  }

  const prop = ATTR_MAP[lower] || lower;

  if (BOOLEAN_ATTRS.has(lower)) {
    // `disabled`, `disabled=""` and `disabled="disabled"` all mean true.
    if (value === null || value === '' || value.toLowerCase() === lower) return `${prop}={true}`;
    if (value.toLowerCase() === 'false') return `${prop}={false}`;
    return `${prop}={true}`;
  }

  if (value === null) return `${prop}={true}`;

  if (NUMERIC_ATTRS.has(lower) && /^-?\d+$/.test(value.trim())) return `${prop}={${value.trim()}}`;

  return `${prop}=${jsxAttrValue(value)}`;
}

// JSX text: braces would open an expression and backslashes would escape.
// Named HTML entities are valid in JSX text and are left alone so the source
// stays diff-comparable with the HTML it came from.
function jsxText(text) {
  return text.replace(/[{}\\]/g, (c) => `{'${c === '\\' ? '\\\\' : c}'}`);
}

function jsxComment(text, indent) {
  // `*/` inside a comment body would close the JSX comment early.
  const safe = text.replace(/\*\//g, '*​/');
  const lines = safe.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (lines.length === 1) return `${indent}{/* ${lines[0].trim()} */}`;
  const body = lines.map((l) => `${indent}    ${l.trim()}`).join('\n');
  return `${indent}{/*\n${body}\n${indent}*/}`;
}

function convert(html) {
  const tokens = tokenize(html);
  const out = [];
  let depth = 3;
  const ind = () => '  '.repeat(depth);

  for (const t of tokens) {
    if (t.kind === 'comment') {
      out.push(jsxComment(t.text, ind()));
      continue;
    }
    if (t.kind === 'text') {
      const trimmed = t.text.trim();
      if (!trimmed) continue;
      out.push(`${ind()}${jsxText(trimmed)}`);
      continue;
    }
    if (t.kind === 'raw') {
      const trimmed = t.text.trim();
      if (trimmed) out.push(`${ind()}${jsxText(trimmed)}`);
      continue;
    }
    if (t.kind === 'close') {
      if (VOID_ELEMENTS.has(t.tag)) continue;
      depth = Math.max(3, depth - 1);
      out.push(`${ind()}</${t.tag}>`);
      continue;
    }
    if (t.kind === 'open') {
      const attrs = t.attrs.map((a) => renderAttr(a.name, a.value));
      const selfClose = VOID_ELEMENTS.has(t.tag) || t.selfClosing;
      const open = `<${t.tag}`;
      let line;
      const oneLine = `${ind()}${open}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' />' : '>'}`;
      if (oneLine.length <= 118 || attrs.length <= 1) {
        line = oneLine;
      } else {
        const inner = '  '.repeat(depth + 1);
        line = `${ind()}${open}\n${attrs.map((a) => inner + a).join('\n')}\n${ind()}${selfClose ? '/>' : '>'}`;
      }
      out.push(line);
      if (!selfClose) depth++;
      continue;
    }
  }

  // A raw-text element with an empty body (<script src=…></script>) reads
  // better as a self-closing tag, and React renders the two identically.
  return out.join('\n').replace(/<script([^>]*)>\n\s*<\/script>/g, '<script$1 />');
}

// ── Split the source document ──────────────────────────────────────────
const source = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const headOpen = source.indexOf('<head>');
const headClose = source.indexOf('</head>');
// Search for the real <body> AFTER </head>: the cascade-probe script in the
// head contains the literal text "<body>" inside a comment, and indexOf would
// happily match that instead of the document's actual body element.
const bodyOpen = headClose + source.slice(headClose).search(/<body[\s>]/);
const bodyTagEnd = source.indexOf('>', bodyOpen);
const bodyClose = source.lastIndexOf('</body>');

const headInner = source.slice(headOpen + '<head>'.length, headClose);
const bodyOpenTag = source.slice(bodyOpen, bodyTagEnd + 1);
const bodyInner = source.slice(bodyTagEnd + 1, bodyClose);

// The <body> element's own attributes stay on the template's <body> tag —
// React hydrates body's CHILDREN, so it must not own body's class/style.
const bodyAttrs = {};
for (const t of tokenize(bodyOpenTag)) {
  if (t.kind === 'open' && t.tag === 'body') {
    for (const a of t.attrs) bodyAttrs[a.name.toLowerCase()] = a.value;
  }
}

const shellBody = convert(bodyInner);

const shellSource = `// The platform shell's markup, as a single static React component.
//
// GENERATED ONCE from the pre-migration public/index.html by
// frontend/scripts/html-to-jsx.cjs, then maintained here by hand. This file
// is the SOURCE OF TRUTH for the shell's markup; public/index.html is now a
// committed build artifact produced from it (see frontend/scripts/build-shell.mjs).
//
// ── Three constraints this component must keep ─────────────────────────
//
// 1. IT IS STATIC. No state, no props, no context, no effects, no event
//    handlers. React therefore never schedules a re-render after the initial
//    hydration, so nothing ever reconciles over the DOM that public/js/**
//    writes into these containers. Making this component stateful would
//    reintroduce exactly the "React clobbers the legacy DOM" class of bug the
//    migration is designed to avoid. Statefulness arrives per-region in step 2,
//    when that region's legacy module is retired in the same change.
//
// 2. IT RENDERS THE LEGACY <script> TAGS. All 47 of them, in their original
//    order, at the end of <body> — because that order is load-bearing:
//    app.js is last, so App.init() registers its DOMContentLoaded handler
//    last and therefore runs after every other module's init.
//
// 3. ITS MARKUP IS FROZEN. 422 ids, every class string, every hidden class,
//    every data-*/aria-* attribute and the sibling order of all 35 top-level
//    regions are asserted against a checked-in pre-migration fixture by
//    tests/shell-markup-parity.test.js, and the ids again by
//    tests/shell-id-inventory.test.js. dapp.json's 227 declared tests select
//    against these exact structures. Do not restructure, rename, reorder or
//    tidy anything here without changing those tests deliberately.

import { Button } from '@/components/ui/button';

export function Shell() {
  return (
    <>
${shellBody}
    </>
  );
}
`;

fs.mkdirSync(path.join(ROOT, 'frontend', 'src'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'frontend', 'src', 'Shell.generated.tsx'), shellSource);

fs.writeFileSync(path.join(ROOT, 'frontend', '.head-inner.html'), headInner);
fs.writeFileSync(path.join(ROOT, 'frontend', '.body-attrs.json'), JSON.stringify(bodyAttrs, null, 2));

console.log('[html-to-jsx] wrote frontend/src/Shell.generated.tsx');
console.log('[html-to-jsx] body attrs:', JSON.stringify(bodyAttrs));
