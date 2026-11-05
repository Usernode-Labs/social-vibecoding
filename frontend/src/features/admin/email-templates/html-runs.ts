// The visual email editor's map from an email's HTML source to the text an
// admin may retype in place. The owner's rule is that the design and the
// conditions always survive the visual tab: an admin clicks and retypes text,
// and structure changes happen in the HTML tab. So nothing here parses the HTML
// into a DOM and serializes it back, which would rewrite quotes, entities and
// attribute order the admin never touched. It finds each editable block by its
// offsets in the source and splices an edit into exactly that range, leaving
// every other byte as it was.
//
// A block is a leaf element (p, h1-h6, td, li, div, or an a whose parent is not
// one) whose content is only text, inline elements and placeholders. Table
// markup, block-level elements, comments and style text are never inside one.
// A block whose content holds a condition marker ({{#if}}, {{else}}, {{/if}},
// {{#unless}}) is structure: the editor shows it but does not let it be
// retyped, because a retype could move text across a branch.
//
// The tokenizer follows the server's (src/services/mail/html-safety.js
// scanHtml), which this bundle cannot import: tag names end at whitespace, "/"
// or ">", attribute values may be quoted or not, comments end at "-->" or
// "--!>", and the text of style, textarea and title runs to its end tag.
// tests/email-html-runs.test.js runs both over the seeds and requires them to
// agree on every tag.
//
// Every edit these functions take is HTML, not text: the visual tab reads a
// block's content back from the browser's DOM (which has escaped what was
// typed) and turns its placeholder chips back into {{name}}. Text from
// anywhere else goes through escapeText first.

export const INLINE_TAGS: ReadonlySet<string> = new Set(['b', 'i', 'em', 'strong', 'a', 'span', 'br', 'u', 'small', 'sup', 'sub']);
const BLOCK_TAGS: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'li', 'div', 'a']);
const VOID_TAGS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['style', 'textarea', 'title']);
// What a snippet inserted after a block may hold: a new paragraph, heading or
// division of text, links and images. Tables and conditions are the HTML tab's.
const SNIPPET_TAGS: ReadonlySet<string> = new Set([...INLINE_TAGS, 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'img']);

const MARKER = /^(#if\s|#unless\s|else$|\/if$|\/unless$)/;

/** Text as HTML that a browser reads back as the same text. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface Attribute { name: string; value: string }

export type Token =
  | { type: 'text'; start: number; end: number; html: string }
  | { type: 'tag'; start: number; end: number; html: string; name: string; closing: boolean; attributes: Attribute[] }
  | { type: 'comment'; start: number; end: number; html: string }
  | { type: 'raw'; start: number; end: number; html: string; name: string }
  | { type: 'placeholder'; start: number; end: number; html: string; name: string }
  | { type: 'marker'; start: number; end: number; html: string }
  // A "{{" with no "}}", or a "<" that starts nothing: text a browser shows,
  // but never what the editor writes, so an edit holding one is refused.
  | { type: 'stray'; start: number; end: number; html: string };

export interface Block {
  tag: string;
  /** The block's content, by offset in the source: `html === source.slice(start, end)`. */
  start: number;
  end: number;
  html: string;
  /** From the "<" of its opening tag to the ">" of its closing tag. */
  outerStart: number;
  outerEnd: number;
  /** The placeholder names in its content, attributes of its inline tags included, in first-seen order. */
  placeholders: string[];
  /** Its content as tokens, a placeholder one the editor shows as a chip. */
  tokens: Token[];
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const isLetter = (ch: string | undefined) => !!ch && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));

function commentEnd(s: string, i: number): number {
  if (s.startsWith('<!-->', i)) return i + 5;
  if (s.startsWith('<!--->', i)) return i + 6;
  const a = s.indexOf('-->', i + 4);
  const b = s.indexOf('--!>', i + 4);
  if (a === -1 && b === -1) return s.length;
  if (b !== -1 && (a === -1 || b < a)) return b + 4;
  return a + 3;
}

// Reads the tag that opens at `i`, as html-safety.js readTag does. A tag the
// input ends inside of runs to the end and is read as stray text.
function readTag(s: string, i: number, closing: boolean): Token {
  const n = s.length;
  let j = i + (closing ? 2 : 1);
  const nameStart = j;
  while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  const name = s.slice(nameStart, j).toLowerCase();
  const attributes: Attribute[] = [];
  for (;;) {
    while (j < n && (isSpace(s[j]) || s[j] === '/')) j++;
    if (j >= n) return { type: 'stray', start: i, end: n, html: s.slice(i) };
    if (s[j] === '>') { j++; break; }
    const attrStart = j;
    j++;
    while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
    const attr = { name: s.slice(attrStart, j).toLowerCase(), value: '' };
    let k = j;
    while (k < n && isSpace(s[k])) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && isSpace(s[k])) k++;
      if (k >= n) return { type: 'stray', start: i, end: n, html: s.slice(i) };
      if (s[k] === '"' || s[k] === "'") {
        const close = s.indexOf(s[k], k + 1);
        if (close === -1) return { type: 'stray', start: i, end: n, html: s.slice(i) };
        attr.value = s.slice(k + 1, close);
        j = close + 1;
      } else {
        let e = k;
        while (e < n && !isSpace(s[e]) && s[e] !== '>') e++;
        attr.value = s.slice(k, e);
        j = e;
      }
    }
    attributes.push(attr);
  }
  return { type: 'tag', start: i, end: j, html: s.slice(i, j), name, closing, attributes };
}

// Splits the text between tags into text, placeholders and condition markers.
function textTokens(s: string, from: number, to: number, out: Token[]) {
  let pos = from;
  while (pos < to) {
    const open = s.indexOf('{{', pos);
    if (open === -1 || open >= to) break;
    const close = s.indexOf('}}', open + 2);
    if (close === -1 || close + 2 > to) {
      if (open > pos) out.push({ type: 'text', start: pos, end: open, html: s.slice(pos, open) });
      out.push({ type: 'stray', start: open, end: to, html: s.slice(open, to) });
      return;
    }
    if (open > pos) out.push({ type: 'text', start: pos, end: open, html: s.slice(pos, open) });
    const body = s.slice(open + 2, close).trim();
    const html = s.slice(open, close + 2);
    if (MARKER.test(body)) out.push({ type: 'marker', start: open, end: close + 2, html });
    else out.push({ type: 'placeholder', start: open, end: close + 2, html, name: body });
    pos = close + 2;
  }
  if (pos < to) out.push({ type: 'text', start: pos, end: to, html: s.slice(pos, to) });
}

/** The source as a flat list of tokens that together cover every byte of it, in order. */
export function tokenize(source: string): Token[] {
  const s = source;
  const n = s.length;
  const out: Token[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (to: number) => { if (to > textStart) textTokens(s, textStart, to, out); };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    const next = s[i + 1];
    if (s.startsWith('<!--', i)) {
      flushText(i);
      const end = commentEnd(s, i);
      out.push({ type: 'comment', start: i, end, html: s.slice(i, end) });
      i = textStart = end;
    } else if (next === '!' || next === '?' || (next === '/' && !isLetter(s[i + 2]))) {
      // A doctype or another bogus comment, up to the next ">".
      flushText(i);
      const gt = s.indexOf('>', i + 2);
      const end = gt === -1 ? n : gt + 1;
      out.push({ type: 'comment', start: i, end, html: s.slice(i, end) });
      i = textStart = end;
    } else if (isLetter(next) || (next === '/' && isLetter(s[i + 2]))) {
      flushText(i);
      const tag = readTag(s, i, next === '/');
      out.push(tag);
      i = textStart = tag.end;
      if (tag.type === 'tag' && !tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
        const endTag = new RegExp(`</${tag.name}(?=[\\s/>])`, 'ig');
        endTag.lastIndex = i;
        const m = endTag.exec(s);
        const end = m ? m.index : n;
        out.push({ type: 'raw', start: i, end, html: s.slice(i, end), name: tag.name });
        i = textStart = end;
      }
    } else {
      flushText(i);
      out.push({ type: 'stray', start: i, end: i + 1, html: '<' });
      i = textStart = i + 1;
    }
  }
  flushText(n);
  return out;
}

const attributeHas = (token: Token, pattern: RegExp) => token.type === 'tag' && token.attributes.some((a) => pattern.test(a.value));
const HAS_MARKER = /\{\{\s*(#if\s|#unless\s|else\s*\}\}|\/if\s*\}\}|\/unless\s*\}\})/;

function placeholderNames(tokens: Token[]): string[] {
  const names: string[] = [];
  const add = (name: string) => { if (!names.includes(name)) names.push(name); };
  for (const token of tokens) {
    if (token.type === 'placeholder') add(token.name);
    if (token.type === 'tag') {
      for (const a of token.attributes) {
        for (const m of a.value.matchAll(/\{\{([^}]*)\}\}/g)) {
          const body = m[1].trim();
          if (!MARKER.test(body)) add(body);
        }
      }
    }
  }
  return names;
}

interface Node {
  name: string;
  open: Token & { type: 'tag' };
  close: (Token & { type: 'tag' }) | null;
  parent: Node | null;
  children: Node[];
  // Nothing but text, placeholders, markers and well-formed inline elements.
  inlineOnly: boolean;
  hasMarker: boolean;
  // Anything to read: a placeholder or text other than spaces and &nbsp;.
  hasContent: boolean;
  firstToken: number;
  lastToken: number;
}

const SAYS_SOMETHING = /[^\s ]/;
const saysSomething = (html: string) => SAYS_SOMETHING.test(html.replace(/&nbsp;?|&#160;?|&#x0*a0;?/gi, ''));

function buildTree(tokens: Token[]): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  const top = () => stack[stack.length - 1];
  const taint = () => { if (stack.length) top().inlineOnly = false; };
  const finish = (node: Node) => {
    const parent = node.parent;
    if (!parent) return;
    if (!INLINE_TAGS.has(node.name) || !node.inlineOnly || !node.close) parent.inlineOnly = false;
    if (node.hasMarker) parent.hasMarker = true;
    if (node.hasContent) parent.hasContent = true;
  };
  tokens.forEach((token, index) => {
    switch (token.type) {
      case 'tag': {
        if (!token.closing) {
          if (stack.length && attributeHas(token, HAS_MARKER)) top().hasMarker = true;
          if (VOID_TAGS.has(token.name)) {
            if (!INLINE_TAGS.has(token.name)) taint();
            return;
          }
          const node: Node = {
            name: token.name, open: token, close: null, parent: stack.length ? top() : null, children: [],
            inlineOnly: true, hasMarker: false, hasContent: false, firstToken: index + 1, lastToken: index,
          };
          (node.parent ? node.parent.children : roots).push(node);
          stack.push(node);
          if (RAW_TEXT_TAGS.has(token.name)) node.inlineOnly = false;
          return;
        }
        // A closing tag that matches the open element closes it. One that
        // matches an element further out closes everything in between, which
        // stays unclosed and so is never a block; a stray one taints its parent.
        const at = stack.map((node) => node.name).lastIndexOf(token.name);
        if (at === -1) { taint(); return; }
        while (stack.length - 1 > at) {
          const unclosed = stack.pop() as Node;
          unclosed.inlineOnly = false;
          finish(unclosed);
        }
        const node = stack.pop() as Node;
        node.close = token;
        node.lastToken = index - 1;
        finish(node);
        return;
      }
      case 'stray':
        // A lone "<" is text a browser shows; the rest end a template or a tag.
        if (token.html === '<') { if (stack.length) top().hasContent = true; } else taint();
        return;
      case 'comment':
      case 'raw':
        taint();
        return;
      case 'marker':
        if (stack.length) top().hasMarker = true;
        return;
      case 'placeholder':
        if (stack.length) top().hasContent = true;
        return;
      case 'text':
        if (stack.length && saysSomething(token.html)) top().hasContent = true;
        return;
    }
  });
  while (stack.length) {
    const unclosed = stack.pop() as Node;
    unclosed.inlineOnly = false;
    finish(unclosed);
  }
  return roots;
}

function blockOf(node: Node, tokens: Token[], source: string): Block {
  const close = node.close as Token & { type: 'tag' };
  const inner = tokens.slice(node.firstToken, node.lastToken + 1);
  return {
    tag: node.name,
    start: node.open.end,
    end: close.start,
    html: source.slice(node.open.end, close.start),
    outerStart: node.open.start,
    outerEnd: close.end,
    placeholders: placeholderNames(inner),
    tokens: inner,
  };
}

/**
 * Every block in `source`, in source order: `editable` ones an admin may retype,
 * and `structure`, the outermost blocks that hold a condition marker. An
 * editable block can sit inside a structure one (a link inside a paragraph
 * whose other text depends on a condition).
 */
export function findBlocks(source: string): { editable: Block[]; structure: Block[] } {
  const { editable, structure } = scanBlocks(source);
  return { editable, structure };
}

// As findBlocks, plus the blocks with nothing in them, which are not offered
// when an email opens but are still blocks: one an admin has just emptied can
// be typed into again.
function scanBlocks(source: string): { editable: Block[]; empty: Block[]; structure: Block[] } {
  const tokens = tokenize(source);
  const editable: Block[] = [];
  const empty: Block[] = [];
  const structure: Block[] = [];
  const visit = (node: Node, inStructure: boolean) => {
    const leaf = BLOCK_TAGS.has(node.name) && node.close && node.inlineOnly;
    if (leaf && !node.hasMarker) {
      (node.hasContent ? editable : empty).push(blockOf(node, tokens, source));
      return;
    }
    if (leaf && !inStructure) structure.push(blockOf(node, tokens, source));
    for (const child of node.children) visit(child, inStructure || !!leaf);
  };
  for (const root of buildTree(tokens)) visit(root, false);
  return { editable, empty, structure };
}

/** The blocks an admin may retype in place, in source order. */
export function editableBlocks(source: string): Block[] {
  return findBlocks(source).editable;
}

export class EditRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditRefused';
  }
}

// The block as the source holds it now. The caller's copy only says where it
// is: its placeholders and tag are read again here, so a caller cannot widen
// what an edit may drop by handing in a block it changed.
function currentBlock(source: string, block: Block): Block {
  if (source.slice(block.start, block.end) !== block.html) {
    throw new EditRefused('The email changed since this block was read. Read its blocks again.');
  }
  const { editable, empty } = scanBlocks(source);
  const found = [...editable, ...empty].find((b) => b.start === block.start && b.end === block.end);
  if (!found) throw new EditRefused('This part of the email holds a condition. Change it in the HTML tab.');
  return found;
}

// What a browser skips inside a URL's scheme ("java\tscript:"), as
// src/services/mail/html-safety.js has it.
// eslint-disable-next-line no-control-regex
const IGNORABLE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/g;
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', amp: '&', nbsp: '\u00a0' };
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'background', 'action', 'formaction', 'xlink:href']);

function decodeReferences(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

// The server refuses these too, on save; refusing them here says why while
// the admin is still looking at the link.
function scriptUrl(value: string): boolean {
  const folded = decodeReferences(value).replace(IGNORABLE, '').toLowerCase();
  return folded.startsWith('javascript:') || folded.startsWith('vbscript:');
}

// A fragment of markup: balanced tags from `allowed`, no event handlers, no
// comments, style text, conditions, or "<" and "{{" that start nothing.
function checkFragment(html: string, allowed: ReadonlySet<string>): Token[] {
  const tokens = tokenize(html);
  const open: string[] = [];
  for (const token of tokens) {
    if (token.type === 'marker') throw new EditRefused('Conditions are changed in the HTML tab.');
    if (token.type === 'comment' || token.type === 'raw') throw new EditRefused('Comments and style blocks are changed in the HTML tab.');
    if (token.type === 'stray') throw new EditRefused(`"${token.html.slice(0, 20)}" is not text the editor can keep. Write < as &lt;.`);
    if (token.type !== 'tag') continue;
    if (!allowed.has(token.name)) throw new EditRefused(`A <${token.name}> is changed in the HTML tab.`);
    if (token.closing) {
      if (open[open.length - 1] !== token.name) throw new EditRefused(`</${token.name}> closes an element the edit did not open.`);
      open.pop();
      continue;
    }
    if (token.attributes.some((a) => a.name.startsWith('on'))) throw new EditRefused('Event handler attributes are not allowed in email.');
    if (token.attributes.some((a) => URL_ATTRIBUTES.has(a.name) && scriptUrl(a.value))) {
      throw new EditRefused('A link in an email can only open web addresses (http or https) or a link placeholder.');
    }
    if (attributeHas(token, HAS_MARKER)) throw new EditRefused('Conditions are changed in the HTML tab.');
    if (!VOID_TAGS.has(token.name)) open.push(token.name);
  }
  if (open.length) throw new EditRefused(`The edit leaves <${open[open.length - 1]}> open.`);
  return tokens;
}

/**
 * `source` with `block`'s content replaced by `html`, every other byte as it
 * was. Throws when the block is stale or structure, or when `html` would change
 * the block's placeholders, hold a condition, or use markup other than inline
 * text tags, so the visual editor cannot drop the email's code. `allowAdded`
 * names the placeholders an edit may add (the ones the editor inserted).
 */
export function spliceBlock(source: string, block: Block, html: string, { allowAdded = [] }: { allowAdded?: string[] } = {}): string {
  const current = currentBlock(source, block);
  if (html === current.html) return source;
  const tokens = checkFragment(html, INLINE_TAGS);
  const names = placeholderNames(tokens);
  const before = new Set(current.placeholders);
  const missing = [...before].filter((name) => !names.includes(name));
  const added = names.filter((name) => !before.has(name) && !allowAdded.includes(name));
  if (missing.length) throw new EditRefused(`The edit drops {{${missing[0]}}}. Placeholders are kept as they are.`);
  if (added.length) throw new EditRefused(`The edit adds {{${added[0]}}}, which this email cannot use here.`);
  return source.slice(0, current.start) + html + source.slice(current.end);
}

/**
 * `source` with `snippet` (a new paragraph, link or image) inserted right after
 * `block`'s closing tag, every other byte as it was. A block that is an inline
 * link, a table cell or a list item takes no sibling here; that is the HTML
 * tab's.
 */
export function insertAfterBlock(source: string, block: Block, snippet: string): string {
  const current = currentBlock(source, block);
  if (current.tag === 'a' || current.tag === 'td' || current.tag === 'li') {
    throw new EditRefused('Nothing can be added after a link, table cell or list item here. Add it in the HTML tab.');
  }
  checkFragment(snippet, SNIPPET_TAGS);
  return source.slice(0, current.outerEnd) + snippet + source.slice(current.outerEnd);
}
