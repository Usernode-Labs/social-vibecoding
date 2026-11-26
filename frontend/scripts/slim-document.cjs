// Takes the developer comments out of the shell document's <head> as it is
// built (request #7165, point 4). frontend/src/head.html explains itself at
// length, which is right for the source and 30 KB of every page load when
// it is served: the document is sent `no-cache`, so a phone fetches it again
// on each visit.
//
// What it removes, in the head and nowhere else:
//
//   - HTML comments;
//   - `//` and `/* */` comments inside an inline <script>;
//   - `/* */` comments inside an inline <style>.
//
// What it leaves exactly as written: every tag, every attribute, the order
// of the tags, and every byte of code. A comment that had lines to itself
// takes those lines with it; a comment after code takes the spaces before
// it. Nothing is renamed, reflowed or minified, so the suites that read an
// inline script out of the built document still find it.
//
// What it never touches:
//
//   - the <body>. React hydrates it, and the markers React writes into
//     markup (`<!-- -->`, `<!--$-->`) are comments;
//   - a comment a caller names in `keep` (the build keeps the stamp and the
//     generated-file notice by composing them outside this call);
//   - a conditional comment (`<!--[if …]>`) and a legal comment (`/*! … */`,
//     `//! …`), which are instructions or licences, not notes;
//   - a <script> with a `src`, or with a type that is not JavaScript.
//
// The scanner for scripts is small, and telling a regular expression from a
// division by hand can be wrong. So nothing here is trusted: each inline
// script and style is handed to esbuild before and after, with its own
// comments dropped, and the two results must be the same text. If they are
// not, the build fails and names the block. A comment is only ever removed
// where a real parser agrees the code did not change.

'use strict';

const JS_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

// A `/` after one of these starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

function isWordChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch) || ch > '\x7f';
}

// Removes source[from, to) from `out`, which holds everything before `from`.
// A comment alone on its lines takes the lines; one after code takes the
// blanks before it and, when it spanned lines, leaves one line break so the
// code on either side stays on separate lines.
function dropComment(out, source, from, to) {
  const lineStart = out.lastIndexOf('\n') + 1;
  const before = out.slice(lineStart);
  const comment = source.slice(from, to);
  const ownLine = /^[ \t]*$/.test(before);
  let end = to;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
  const atLineEnd = end >= source.length || source[end] === '\n' || source[end] === '\r';
  if (ownLine && atLineEnd && end < source.length) {
    if (source[end] === '\r' && source[end + 1] === '\n') end += 1;
    return { out: out.slice(0, lineStart), next: end + 1 };
  }
  if (atLineEnd) {
    return { out: out.replace(/[ \t]+$/, ''), next: end };
  }
  // Code follows on the same line: keep the two sides apart.
  if (comment.includes('\n')) return { out: `${out}\n`, next: to };
  return { out: /\s$/.test(out) ? out : `${out} `, next: to };
}

function stripJsComments(source) {
  let out = '';
  let i = 0;
  // What the last piece of code was, to tell `/` the divider from `/` the
  // start of a regular expression: 'value' (a name, a number, a closing
  // bracket) or 'operator' (anything a value may follow).
  let last = 'operator';
  // One entry per open template literal: the depth of `{` inside its `${`.
  const templates = [];
  let braceDepth = 0;

  const readString = (quote) => {
    let j = i + 1;
    while (j < source.length && source[j] !== quote) {
      if (source[j] === '\\') j += 1;
      else if (source[j] === '\n') break;
      j += 1;
    }
    out += source.slice(i, j + 1);
    i = j + 1;
    last = 'value';
  };

  // From just inside a template literal to its closing backtick or the `${`
  // that opens an expression.
  const readTemplate = () => {
    let j = i;
    while (j < source.length) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '`') {
        out += source.slice(i, j + 1);
        i = j + 1;
        last = 'value';
        return;
      }
      if (source[j] === '$' && source[j + 1] === '{') {
        out += source.slice(i, j + 2);
        i = j + 2;
        templates.push(braceDepth);
        braceDepth = 0;
        last = 'operator';
        return;
      }
      j += 1;
    }
    out += source.slice(i);
    i = source.length;
  };

  const readRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') break;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      j += 1;
    }
    j += 1;
    while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
    out += source.slice(i, j);
    i = j;
    last = 'value';
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      if (source[end - 1] === '\r') end -= 1;
      if (source[i + 2] === '!') {
        out += source.slice(i, end);
        i = end;
      } else {
        const dropped = dropComment(out, source, i, end);
        out = dropped.out;
        i = dropped.next;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      if (source[i + 2] === '!') {
        out += source.slice(i, end);
        i = end;
      } else {
        const dropped = dropComment(out, source, i, end);
        out = dropped.out;
        i = dropped.next;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { readString(ch); continue; }
    if (ch === '`') {
      out += ch;
      i += 1;
      readTemplate();
      continue;
    }
    if (ch === '/') {
      if (last === 'operator') { readRegex(); continue; }
      out += ch;
      i += 1;
      last = 'operator';
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      out += ch;
      i += 1;
      last = 'operator';
      continue;
    }
    if (ch === '}') {
      if (braceDepth === 0 && templates.length) {
        // The end of a `${ … }`: back into the template's text.
        braceDepth = templates.pop();
        out += ch;
        i += 1;
        readTemplate();
        continue;
      }
      braceDepth -= 1;
      out += ch;
      i += 1;
      // A block's end is followed by a statement far more often than an
      // object's end is divided by something.
      last = 'operator';
      continue;
    }
    if (isWordChar(ch)) {
      let j = i + 1;
      while (j < source.length && isWordChar(source[j])) j += 1;
      const word = source.slice(i, j);
      out += word;
      i = j;
      last = REGEX_AFTER_WORD.has(word) ? 'operator' : 'value';
      continue;
    }
    if (ch === ')' || ch === ']') {
      out += ch;
      i += 1;
      last = 'value';
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
    last = 'operator';
  }
  return out;
}

function stripCssComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '\n') break;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // An unquoted url( … ) may hold `/*` as part of an address.
    if (/^url\(\s*[^"'\s)]/i.test(source.slice(i, i + 12)) && !isWordChar(source[i - 1] || ' ')) {
      let j = source.indexOf(')', i);
      if (j === -1) j = source.length - 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      if (source[i + 2] === '!') {
        out += source.slice(i, end);
        i = end;
      } else {
        const dropped = dropComment(out, source, i, end);
        out = dropped.out;
        i = dropped.next;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// The same code, as a parser prints it with every comment gone. Two sources
// that differ only in comments and blank space print the same.
function printed(esbuild, source, loader) {
  return esbuild.transformSync(source, {
    loader,
    minifyWhitespace: true,
    minifySyntax: false,
    minifyIdentifiers: false,
    legalComments: 'none',
    charset: 'utf8',
  }).code;
}

function checked(esbuild, before, after, loader, where) {
  let same = false;
  let reason = 'the code no longer reads the same';
  try {
    same = printed(esbuild, before, loader) === printed(esbuild, after, loader);
  } catch (err) {
    reason = String((err && err.message) || err).split('\n')[0];
  }
  if (!same) {
    throw new Error(`slim-document: taking the comments out of ${where} changed it (${reason}). `
      + 'The scanner in frontend/scripts/slim-document.cjs misread something there; fix the scanner, '
      + 'do not skip the check.');
  }
  return after;
}

function attribute(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=\\s|$)`, 'i').exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

// Where a tag that opens at `lt` ends, quotes respected.
function tagEnd(html, lt) {
  let quote = '';
  for (let j = lt + 1; j < html.length; j += 1) {
    const ch = html[j];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    }
  }
  return html.length - 1;
}

function isKept(comment, keep) {
  if (/^<!--\[if\b/i.test(comment) || /<!\[endif\]-->$/i.test(comment)) return true;
  return keep.some((rule) => (typeof rule === 'string' ? comment.includes(rule) : rule.test(comment)));
}

// `head` is markup for the inside of <head>. `esbuild` is required: without
// a parser to check against, nothing is removed from a script or a style.
function slimHead(head, { esbuild, keep = [] } = {}) {
  if (!esbuild || typeof esbuild.transformSync !== 'function') {
    throw new Error('slim-document: esbuild is needed to check each inline script and style');
  }
  const html = String(head);
  let out = '';
  let i = 0;
  let scripts = 0;
  let styles = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      const end = close === -1 ? html.length : close + 3;
      const comment = html.slice(lt, end);
      if (isKept(comment, keep)) {
        out += comment;
        i = end;
      } else {
        const dropped = dropComment(out, html, lt, end);
        out = dropped.out;
        i = dropped.next;
      }
      continue;
    }
    const open = /^<(script|style)\b/i.exec(html.slice(lt, lt + 8));
    if (!open) {
      if (/^<\/?[A-Za-z!]/.test(html.slice(lt, lt + 3))) {
        const gt = tagEnd(html, lt);
        out += html.slice(lt, gt + 1);
        i = gt + 1;
      } else {
        out += '<';
        i = lt + 1;
      }
      continue;
    }
    const name = open[1].toLowerCase();
    const gt = tagEnd(html, lt);
    const attrs = html.slice(lt + 1 + name.length, gt);
    const closeAt = html.toLowerCase().indexOf(`</${name}`, gt + 1);
    if (closeAt === -1) throw new Error(`slim-document: a <${name}> in the head is never closed`);
    const content = html.slice(gt + 1, closeAt);
    let slim = content;
    if (name === 'style') {
      styles += 1;
      slim = checked(esbuild, content, stripCssComments(content), 'css', `inline <style> ${styles}`);
    } else if (attribute(attrs, 'src') === null
      && JS_TYPES.has(String(attribute(attrs, 'type') || '').trim().toLowerCase())) {
      scripts += 1;
      slim = checked(esbuild, content, stripJsComments(content), 'js', `inline <script> ${scripts}`);
    }
    out += html.slice(lt, gt + 1) + slim;
    i = closeAt;
  }
  return out;
}

module.exports = { slimHead, stripJsComments, stripCssComments };
