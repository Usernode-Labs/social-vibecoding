// Dependency-free HTML tokenizer + structural comparison helpers for the
// shell-artifact tests (shell-markup-parity, shell-id-inventory,
// shell-script-order, dapp-selectors-resolve).
//
// Why hand-rolled instead of a parser dependency: the root package installs
// with `npm ci --production` at runtime and carries only four devDependencies
// today. The shell artifact tests need to compare two HTML documents
// structurally, which is a tokenizer's job, not a full DOM's — and every
// input here is machine-generated markup from one known source. So a ~150
// line tokenizer buys the whole test suite with no new dependency and no
// package-lock churn.
//
// It is deliberately NOT a general-purpose HTML parser: no error recovery,
// no implied tags, no foreign-content quirks. It handles exactly what the
// shell uses — tags, attributes (quoted / unquoted / bare), comments,
// doctype, and the raw-text elements script/style/textarea/title.

'use strict';

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

// Parse the attribute section of a start tag into an ordered array of
// { name, value }. `value` is null for a bare attribute (`disabled`).
function parseAttributes(source) {
  const attrs = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const value = m[2] !== undefined ? m[2]
      : m[3] !== undefined ? m[3]
        : m[4] !== undefined ? m[4]
          : null;
    attrs.push({ name: m[1], value });
  }
  return attrs;
}

// Tokenize an HTML string into a flat, ordered token list. Token kinds:
//   { kind: 'open',    tag, attrs, selfClosing }
//   { kind: 'close',   tag }
//   { kind: 'text',    text }
//   { kind: 'comment', text }
//   { kind: 'doctype', text }
//   { kind: 'raw',     tag, text }   -- body of a raw-text element
function tokenize(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (i < n) tokens.push({ kind: 'text', text: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', text: html.slice(i, lt) });

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: 'comment', text: html.slice(lt + 4, stop) });
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: 'doctype', text: html.slice(lt + 2, stop) });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: 'close', tag: html.slice(lt + 2, stop).trim().toLowerCase() });
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Start tag. Scan to the matching '>' while skipping quoted values, so
    // an attribute containing '>' (a CSS selector, a comparison) can't end
    // the tag early.
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';
    const attrs = parseAttributes(body.slice(nameMatch ? nameMatch[1].length : 0));
    tokens.push({ kind: 'open', tag, attrs, selfClosing: selfClosing || VOID_ELEMENTS.has(tag) });
    i = j + 1;

    // Raw-text elements swallow everything up to their close tag.
    if (RAW_TEXT.has(tag) && !selfClosing && !VOID_ELEMENTS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const stop = m ? m.index : rest.length;
      tokens.push({ kind: 'raw', tag, text: rest.slice(0, stop) });
      if (m) {
        tokens.push({ kind: 'close', tag });
        i += m.index + m[0].length;
      } else {
        i = n;
      }
    }
  }

  return tokens;
}

// ── Structural view ────────────────────────────────────────────────────
//
// The comparison the parity test actually wants: the ordered sequence of
// ELEMENTS with their attributes, ignoring comments, ignoring whitespace-only
// text, and normalising the whitespace inside text that survives. JSX drops
// HTML comments and re-indents everything, so neither is a real difference.

// Attributes whose value is a whitespace-separated set where order carries no
// meaning to the browser. Compared as sorted sets so a converter that
// preserves semantics but not token order still passes.
const SET_VALUED = new Set(['class', 'rel']);

function normalizeAttrValue(name, value) {
  // A bare attribute and an empty one are the same node to an HTML parser:
  // `<a data-auth-back>` and `<a data-auth-back="">` both yield the attribute
  // with the value "". Hand-written markup uses the bare form; React always
  // emits the explicit one.
  if (value === null) return '';
  // Attribute values are entity-decoded by an HTML parser, and the two sides
  // spell the same character differently: hand-written markup carries a
  // literal `'`, React escapes it to `&#x27;`. Compare the decoded value.
  value = decodeEntities(value);
  if (SET_VALUED.has(name)) return value.trim().split(/\s+/).filter(Boolean).sort().join(' ');
  if (name === 'style') {
    // `color:red;font-size:1px` and `color: red; font-size: 1px;` are the
    // same declaration block. React also always emits a trailing semicolon.
    return value
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const c = d.indexOf(':');
        if (c === -1) return d;
        return `${d.slice(0, c).trim()}:${d.slice(c + 1).trim()}`;
      })
      .join(';');
  }
  return value;
}

// HTML named entities the shell actually uses, plus the always-required five.
// Decoded so `&times;` in hand-written HTML and `×` in React output compare
// equal.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', hellip: '…', larr: '←', ldquo: '“',
  rdquo: '”', rsquo: '’', lsquo: '‘', mdash: '—',
  ndash: '–', times: '×', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°',
  laquo: '«', raquo: '»', check: '✓',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[body];
    return hit === undefined ? whole : hit;
  });
}

// Reduce a document to the comparable element/text sequence described above.
function structure(html) {
  const out = [];
  for (const t of tokenize(html)) {
    if (t.kind === 'comment') continue;
    if (t.kind === 'doctype') { out.push({ kind: 'doctype' }); continue; }
    if (t.kind === 'text' || t.kind === 'raw') {
      const text = decodeEntities(t.text).replace(/\s+/g, ' ').trim();
      if (text) out.push({ kind: 'text', text });
      continue;
    }
    if (t.kind === 'close') { out.push({ kind: 'close', tag: t.tag }); continue; }
    const attrs = {};
    for (const a of t.attrs) attrs[a.name.toLowerCase()] = normalizeAttrValue(a.name.toLowerCase(), a.value);
    out.push({ kind: 'open', tag: t.tag, attrs, selfClosing: t.selfClosing });
  }
  // A self-closed void element and an explicitly-closed one are the same
  // node; drop close tokens for void elements so the sequences line up.
  const noVoidCloses = out.filter((t) => !(t.kind === 'close' && VOID_ELEMENTS.has(t.tag)));

  // Same normalisation one level up, for NON-void elements that happen to be
  // empty. Hand-written HTML self-closes SVG children (`<path d="…" />`) and
  // React always emits an explicit close (`<path d="…"></path>`); an empty
  // `<script src="…"></script>` and `<script src="…" />` are likewise the same
  // node. Collapse an open immediately followed by its own close into the
  // single element it represents, so the two spellings compare equal.
  const collapsed = [];
  for (const t of noVoidCloses) {
    const prev = collapsed[collapsed.length - 1];
    if (t.kind === 'close' && prev && prev.kind === 'open' && prev.tag === t.tag) {
      prev.selfClosing = true;
      continue;
    }
    collapsed.push(t);
  }
  return collapsed;
}

// A short human-readable label for a structural token, used in test failure
// messages so a mismatch says *what* diverged rather than just *where*.
function describe(token) {
  if (!token) return '<end of document>';
  if (token.kind === 'text') return `text ${JSON.stringify(token.text.slice(0, 60))}`;
  if (token.kind === 'close') return `</${token.tag}>`;
  if (token.kind === 'doctype') return '<!doctype>';
  const id = token.attrs.id ? `#${token.attrs.id}` : '';
  const cls = token.attrs.class ? `.${token.attrs.class.split(' ').slice(0, 3).join('.')}` : '';
  return `<${token.tag}${id}${cls}>`;
}

// Every `id` value in a document, in source order.
function idsOf(html) {
  const ids = [];
  for (const t of tokenize(html)) {
    if (t.kind !== 'open') continue;
    for (const a of t.attrs) if (a.name.toLowerCase() === 'id' && a.value) ids.push(a.value);
  }
  return ids;
}

// Every <script> tag in source order as { src, type }. `src` is null for an
// inline script.
function scriptsOf(html) {
  const out = [];
  for (const t of tokenize(html)) {
    if (t.kind !== 'open' || t.tag !== 'script') continue;
    const attrs = {};
    for (const a of t.attrs) attrs[a.name.toLowerCase()] = a.value;
    out.push({ src: attrs.src || null, type: attrs.type || null });
  }
  return out;
}

// Every <link rel="stylesheet"> href in source order.
function stylesheetsOf(html) {
  const out = [];
  for (const t of tokenize(html)) {
    if (t.kind !== 'open' || t.tag !== 'link') continue;
    const attrs = {};
    for (const a of t.attrs) attrs[a.name.toLowerCase()] = a.value;
    if ((attrs.rel || '').split(/\s+/).includes('stylesheet') && attrs.href) out.push(attrs.href);
  }
  return out;
}

module.exports = {
  tokenize, structure, describe, idsOf, scriptsOf, stylesheetsOf,
  decodeEntities, VOID_ELEMENTS, RAW_TEXT,
};
