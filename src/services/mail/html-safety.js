'use strict';

// Email HTML safety: the gate an admin's template or layout HTML passes before
// the store keeps it (src/routes/admin-email-templates.js, through
// ./template-validation.js).
//
// Like ../svg-safety.js it only ever REFUSES: nothing is stripped or rewritten,
// so the bytes that go out are the bytes that were checked, and the editor can
// show the admin exactly what was wrong. Unlike it, this is a blocklist, because
// email HTML is wide (tables, inline styles, conditional comments for Outlook)
// and an allowlist would refuse ordinary mail. What it blocks is what can run
// code, load another document or stylesheet, or post a form from a mail client
// or the console's preview: script and its relatives, frames, objects, forms,
// link/meta/base, inline SVG and MathML (whose parsing differs from HTML's),
// event-handler attributes, script and data URLs, and @import.
//
// The tokenizer follows the HTML parser's own rules where they decide what is
// a tag and what is text: names end at whitespace, "/" or ">", attribute values
// may be quoted or not, comments end at "-->" or "--!>" (and "<!-->" is a whole
// comment), and the text of <style>, <textarea> and <title> runs to its end
// tag. Attribute values are checked after entity decoding, so
// `java&#115;cript:` is read the way a browser reads it.
//
// It also reports where each tag, attribute value and style block sits, so the
// template validation can tell which context a placeholder lands in.

// Gmail clips a message near 102 KB; past it the reader sees "[Message clipped]"
// and the end of the mail, with its unsubscribe link, is hidden.
const MAX_EMAIL_HTML_BYTES = 100 * 1024;

const BLOCKED_ELEMENTS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'link', 'meta', 'base',
  // Parsed as raw text by a browser with scripting and as markup by one without,
  // so the two can disagree about where a tag is.
  'noscript', 'noembed', 'noframes', 'xmp', 'plaintext',
  // Foreign content: its own parsing rules, and SVG can set a link to a script
  // URL through animation.
  'svg', 'math',
  // Inert or hiding containers with no use in a mail: what follows an open one
  // is never shown (a <template>) or shown as a control, not as the mail.
  'template', 'select', 'option', 'optgroup', 'datalist',
]);

// Elements that have no end tag.
// <image> is one too: a browser reads it as <img>.
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'image', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// Whose text runs to the matching end tag, unparsed.
const RAW_TEXT_ELEMENTS = new Set(['style', 'textarea', 'title']);

// Attributes a mail client or browser follows as an address.
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'background', 'poster', 'cite', 'longdesc',
  'lowsrc', 'dynsrc', 'usemap', 'data', 'codebase', 'manifest', 'icon', 'xlink:href', 'ping',
]);

// What a browser skips or folds while it reads a URL scheme or a CSS word
// ("java\tscript:"), the same set ../svg-safety.js uses.
// eslint-disable-next-line no-control-regex
const IGNORABLE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/g;

// The named references that can spell part of a URL scheme or CSS. Any other
// named reference stays as written, which cannot form one of the words below.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: '\u00a0',
  lpar: '(', rpar: ')', sol: '/', bsol: '\\', period: '.', comma: ',', excl: '!', num: '#', percnt: '%',
  semi: ';', equals: '=', commat: '@',
};

const TEMPLATE_TAG = /\{\{[^}]*\}\}/g;

const reject = (reason) => ({ ok: false, reason });
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const isLetter = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const shown = (name) => (name.length > 40 ? `${name.slice(0, 40)}...` : name);

// One pass of character references, as the browser decodes text and attribute values:
// numeric ones with or without their semicolon, and the named ones above.
function decodeEntities(text) {
  // Any number of digits, as the HTML parser reads them: `&#0000000106;` is
  // "j". Zero and anything past U+10FFFF become U+FFFD, as they do there.
  return text.replace(/&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z]{2,8});?)/g, (match, dec, hex, name) => {
    if (dec || hex) {
      const digits = (dec || hex).replace(/^0+/, '');
      if (digits.length > 8) return '\ufffd';
      const cp = digits ? parseInt(digits, dec ? 10 : 16) : 0;
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    }
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED, key) ? NAMED[key] : match;
  });
}

// CSS escapes ("\69" is "i", "\:" is ":"), so @\69mport is read as @import.
function decodeCssEscapes(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (match, hex, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    }
    return ch;
  });
}

const fold = (text) => text.replace(IGNORABLE, '').toLowerCase();

// Why a piece of CSS is refused, or null. A <style> block (`block`) is held
// tighter than a style attribute: its selectors can test an attribute's value
// (`a[href*="00"]`) and fetch an address for each match on open, which would
// spell a link's secret out to another site one piece at a time. So a block
// may use no attribute selector and load nothing (no url() or image-set()).
function cssProblem(css, where, { block = false } = {}) {
  const plain = fold(decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  const raw = fold(decodeCssEscapes(css));
  for (const text of [plain, raw]) {
    if (text.includes('@import')) return `${where} uses @import, which loads a stylesheet from elsewhere.`;
    if (text.includes('javascript:') || text.includes('vbscript:')) return `${where} contains a script URL.`;
    if (text.includes('data:')) return `${where} contains a data URL. Upload the image and link to it instead.`;
    if (text.includes('expression(')) return `${where} contains a CSS expression, which runs script in old Outlook.`;
    if (text.includes('-moz-binding') || text.includes('behavior:')) return `${where} attaches script through CSS.`;
    // attr() reads an attribute's value (a link's address) into the styling.
    if (text.includes('attr(')) return `${where} uses attr(), which could read a link's address into the styling.`;
  }
  if (block) {
    for (const text of [plain, raw]) {
      if (text.includes('[')) return `${where} cannot use an attribute selector ([...]): it could read a link's address and report it elsewhere.`;
      if (['url(', 'image-set(', 'image(', 'src(', 'cross-fade(', 'element('].some((fn) => text.includes(fn))) return `${where} cannot load anything (url(), image-set(), image(), src()). Use an image with an https address, or a style attribute.`;
    }
  }
  return null;
}

// A data: URL at the start of the value or, in srcset, of any candidate.
function startsWithData(name, folded) {
  const candidates = name === 'srcset' ? folded.split(',') : [folded];
  return candidates.some((candidate) => candidate.startsWith('data:'));
}

// Why one attribute is refused, or null. A value is checked as written and with
// its placeholders taken out, since a placeholder can render as nothing.
function attributeProblem(name, value) {
  if (name.startsWith('on')) return `The ${shown(name)} attribute runs script, which email cannot use.`;
  if (name === 'srcdoc') return 'The srcdoc attribute holds a whole document, which email cannot use.';
  if (name === 'ping') return 'The ping attribute reports every click to another address, which email cannot use.';
  for (const variant of [value, value.replace(TEMPLATE_TAG, '')]) {
    const decoded = decodeEntities(variant);
    const folded = fold(decoded);
    if (folded.includes('javascript:') || folded.includes('vbscript:')
        || (URL_ATTRIBUTES.has(name) && startsWithData(name, folded))) {
      return `The ${shown(name)} attribute contains a script or data URL.`;
    }
    if (name === 'style') {
      const problem = cssProblem(decoded, 'A style attribute');
      if (problem) return problem;
    }
  }
  return null;
}

// Where a comment that opens at `i` ("<!--") ends, as the browser decides it:
// "<!-->" and "<!--->" end at once, otherwise the first "-->" or "--!>".
function commentEnd(s, i) {
  if (s.startsWith('<!-->', i)) return { bodyStart: i + 4, bodyEnd: i + 4, end: i + 5 };
  if (s.startsWith('<!--->', i)) return { bodyStart: i + 4, bodyEnd: i + 4, end: i + 6 };
  const a = s.indexOf('-->', i + 4);
  const b = s.indexOf('--!>', i + 4);
  if (a === -1 && b === -1) return null;
  if (b !== -1 && (a === -1 || b < a)) return { bodyStart: i + 4, bodyEnd: b, end: b + 4 };
  return { bodyStart: i + 4, bodyEnd: a, end: a + 3 };
}

// Reads the tag that opens at `i` ("<" then a letter, or "</" then a letter).
// Returns { tag, next } or { reason }.
function readTag(s, i, closing) {
  const n = s.length;
  let j = i + (closing ? 2 : 1);
  const nameStart = j;
  while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  const name = s.slice(nameStart, j).toLowerCase();
  const attributes = [];
  for (;;) {
    while (j < n && (isSpace(s[j]) || s[j] === '/')) j++;
    if (j >= n) return { reason: 'The HTML ends in the middle of a tag.' };
    if (s[j] === '>') { j++; break; }
    const attrStart = j;
    // The first character may be "=", as in the browser; after it, a name ends
    // at whitespace, "/", ">" or "=".
    j++;
    while (j < n && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
    const attr = { name: s.slice(attrStart, j).toLowerCase(), start: attrStart, quote: null, valueStart: j, valueEnd: j, value: '' };
    let k = j;
    while (k < n && isSpace(s[k])) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && isSpace(s[k])) k++;
      if (k >= n) return { reason: 'The HTML ends in the middle of a tag.' };
      if (s[k] === '"' || s[k] === "'") {
        const close = s.indexOf(s[k], k + 1);
        if (close === -1) return { reason: 'The HTML ends inside a quoted attribute value.' };
        Object.assign(attr, { quote: s[k], valueStart: k + 1, valueEnd: close, value: s.slice(k + 1, close) });
        j = close + 1;
      } else {
        let e = k;
        while (e < n && !isSpace(s[e]) && s[e] !== '>') e++;
        Object.assign(attr, { quote: '', valueStart: k, valueEnd: e, value: s.slice(k, e) });
        j = e;
      }
    }
    attributes.push(attr);
  }
  return { tag: { name, start: i, end: j, closing, attributes }, next: j };
}

function scanInto(s, offset, out, depth) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    const next = s[i + 1];
    if (s.startsWith('<!--', i)) {
      const comment = commentEnd(s, i);
      if (!comment) return reject('A comment is never closed.');
      // Outlook reads what is inside a conditional comment as markup, so the
      // inside of every comment is held to the same rules.
      if (depth < 2) {
        const inner = scanInto(s.slice(comment.bodyStart, comment.bodyEnd), offset + comment.bodyStart, out, depth + 1);
        if (!inner.ok) return reject(`Inside a comment: ${inner.reason}`);
      }
      out.comments.push({ start: i + offset, end: comment.end + offset });
      i = comment.end;
    } else if (next === '!' || next === '?' || (next === '/' && !isLetter(s[i + 2] || ''))) {
      // A doctype, a "<![endif]>", or another bogus comment: up to the next ">",
      // or to the end, where the browser ends it too (the inside of a comment
      // ends with "<![endif]" and no ">").
      const end = s.indexOf('>', i + 2);
      const stop = end === -1 ? n : end + 1;
      if (end === -1 && depth === 0) out.open = 'inside an unfinished <! or <? declaration';
      out.comments.push({ start: i + offset, end: stop + offset });
      i = stop;
    } else if (isLetter(next || '') || (next === '/' && isLetter(s[i + 2] || ''))) {
      const closing = next === '/';
      const read = readTag(s, i, closing);
      if (read.reason) return reject(read.reason);
      const { tag } = read;
      if (BLOCKED_ELEMENTS.has(tag.name)) return reject(`The <${shown(tag.name)}> element is not allowed in email.`);
      if (!closing) {
        for (const attr of tag.attributes) {
          const problem = attributeProblem(attr.name, attr.value);
          if (problem) return reject(problem);
        }
      }
      out.tags.push({
        ...tag,
        // Inside a comment: Outlook's markup, not the mail's structure.
        inComment: depth > 0,
        start: tag.start + offset,
        end: tag.end + offset,
        attributes: tag.attributes.map((a) => ({ ...a, start: a.start + offset, valueStart: a.valueStart + offset, valueEnd: a.valueEnd + offset })),
      });
      i = read.next;
      if (!closing && RAW_TEXT_ELEMENTS.has(tag.name)) {
        const endTag = new RegExp(`</${tag.name}(?=[\\s/>])`, 'ig');
        endTag.lastIndex = i;
        const m = endTag.exec(s);
        const textEnd = m ? m.index : n;
        if (!m && depth === 0) out.open = `inside a <${tag.name}> that is never closed`;
        const text = s.slice(i, textEnd);
        // A title or textarea is text, but a browser and the check could
        // disagree about where it ends, so it holds no markup at all.
        if (tag.name !== 'style' && text.includes('<')) {
          return reject(`A <${tag.name}> may hold plain text only, without the < character.`);
        }
        if (tag.name === 'style') {
          const problem = cssProblem(text, 'A <style> block', { block: true });
          if (problem) return reject(problem);
        }
        out.rawTexts.push({ name: tag.name, start: i + offset, end: textEnd + offset });
        i = textEnd;
      }
    } else {
      // A "<" with nothing after it is text here, but the start of a tag once
      // something is put after it.
      if (i === n - 1 && depth === 0) out.open = 'with a "<" that the next part would turn into a tag';
      i += 1;
    }
  }
  return { ok: true };
}

/**
 * Tokenizes `html` and checks it. `{ ok: true, tags, rawTexts }` where each tag
 * is `{ name, start, end, closing, attributes: [{ name, quote, valueStart,
 * valueEnd, value }] }` (`quote` is '"', "'", '' for an unquoted value, or null
 * for none) and each raw text block is `{ name, start, end }` and each comment (bogus
 * ones such as `<!x>` included) `{ start, end }`, all by offset in
 * `html`; or `{ ok: false, reason }`.
 */
function scanHtml(html) {
  if (typeof html !== 'string') return reject('The HTML must be text.');
  if (html.includes('\u0000')) return reject('The HTML contains a NUL character.');
  const out = { tags: [], rawTexts: [], comments: [] };
  const result = scanInto(html, 0, out, 0);
  if (!result.ok) return result;
  out.tags.sort((a, b) => a.start - b.start);
  out.comments.sort((a, b) => a.start - b.start);
  return { ok: true, open: null, ...out };
}

/**
 * Why `html`, as one part of a mail that others follow, would not leave the
 * parser reading ordinary text at its end (inside a tag, a declaration or an
 * unclosed style, title or textarea), so the next part would be read as part
 * of it; or null. A part that fails the check itself is reported by
 * validateEmailHtml, not here.
 */
function openAtEnd(html) {
  const scan = scanHtml(html);
  if (!scan.ok) return null;
  if (scan.open) return `The HTML ends ${scan.open}, so what follows it would be read as part of it.`;
  // Every element a part opens it closes, and it closes none it did not open,
  // so the next part is never inside one of its elements (a hidden div, a
  // link) and never breaks out of the layout's.
  const stack = [];
  for (const tag of scan.tags) {
    if (tag.inComment || VOID_ELEMENTS.has(tag.name)) continue;
    if (!tag.closing) { stack.push(tag.name); continue; }
    if (stack[stack.length - 1] !== tag.name) {
      return stack.length
        ? `The HTML closes </${tag.name}> while <${stack[stack.length - 1]}> is still open. Close each element in the order it was opened.`
        : `The HTML closes </${tag.name}>, which it did not open, so it would close part of the layout around it.`;
    }
    stack.pop();
  }
  if (stack.length) return `The HTML leaves <${stack[stack.length - 1]}> open, so what follows it would be inside it. Close every element it opens.`;
  return null;
}

/** `{ ok: true }` or `{ ok: false, reason }`, a sentence for the admin. */
function validateEmailHtml(html) {
  if (typeof html !== 'string') return reject('The HTML must be text.');
  if (Buffer.byteLength(html, 'utf8') > MAX_EMAIL_HTML_BYTES) {
    return reject('The HTML is over 100 KB. Gmail cuts off messages near 102 KB, hiding their end.');
  }
  const scan = scanHtml(html);
  return scan.ok ? { ok: true } : scan;
}

module.exports = { validateEmailHtml, scanHtml, openAtEnd, decodeEntities, MAX_EMAIL_HTML_BYTES, URL_ATTRIBUTES };
