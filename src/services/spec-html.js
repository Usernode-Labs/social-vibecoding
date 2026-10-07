// HTML specs (#3699): the server half.
//
// A spec author may write its spec as a small HTML document instead of
// markdown, so the User-facing half can lead with before/after screens and
// the Technical half with diagrams and tables. The dialect is deliberately
// narrow and is described to the author in SPEC_HTML_CONTRACT (prompts.js):
//
//   <article data-spec>
//     <h1>Title</h1>
//     <p>Optional one or two sentence summary.</p>
//     <section data-spec-tab="user">
//       <figure data-screens>
//         <ol data-changes>
//           <li data-change="1" data-steps="Dev board → a proposal">What a person sees</li>
//         </ol>
//         <template data-screen data-size="desktop" data-focus="840 60 440 310">
//           …one markup tree; parts carry data-side="before|after" and
//            changed parts data-change="1"…
//         </template>
//       </figure>
//       <h3>…</h3><p>…</p><ul>…</ul>
//     </section>
//     <section data-spec-tab="tech">
//       <figure><svg viewBox="…" role="img"><title>…</title>…</svg></figure>
//       <table>…</table>
//     </section>
//   </article>
//
// The server never renders this. It stores the document beside a MARKDOWN
// PROJECTION of it, and the projection goes where the markdown spec always
// went (chat_sessions.spec_md, chat_session_specs.content). That is what keeps
// every existing reader of spec text working unchanged: the build prompt, the
// Mayor, PR metadata, the bot's GitHub comment and PR body, previews, share
// snippets, "Copy markdown", specHasBlockingQuestions. The browser renders the
// HTML itself (frontend/src/lib/spec-html.ts), sanitizing the prose and
// drawing each screen in a sandboxed frame.
//
// There is no HTML parser among the server's dependencies, and the projection
// does not need one: a tolerant tokenizer over this dialect is enough, and an
// author who strays from it still gets readable text, never an exception.

const MAX_SPEC_HTML_CHARS = 600000;

// The two screen sizes the viewer draws, matching the before/after shots'
// desktop and phone viewports. data-height may make a screen taller (a long
// page), within reason.
const SCREEN_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800 }),
  phone: Object.freeze({ width: 390, height: 844 }),
});
const MAX_SCREEN_HEIGHT = 2400;

// ```html … ``` around the whole document: the same failure mode
// stripSpecWrapperFence undoes for markdown, in the other language.
function stripHtmlWrapperFence(content) {
  if (typeof content !== 'string') return content;
  const text = content.trim();
  const m = /^([`~]{3,})\s*(html|htm)?\s*\n([\s\S]*?)\n\1[`~]*\s*$/i.exec(text);
  if (!m) return content;
  const inner = m[3].trim();
  return /^<article\b/i.test(inner) ? inner : content;
}

// Characters that show nothing and that a model's final message has carried
// into a spec: a zero-width space INSIDE a closing tag ("</artic​le>",
// App bench run 9, trial 1246), and a byte-order mark. U+200B, U+2060 and
// U+FEFF are removed wherever they are. U+200C and U+200D also join or keep
// apart the letters of some scripts and build emoji sequences, so they are
// removed only beside an ASCII character (a tag, a Latin word, punctuation)
// or at an edge, where they never do either. Visible text is never touched.
const ALWAYS_INVISIBLE_RE = /[​⁠﻿]/g;
const JOINER_RE = /[‌‍]/g;

/** `text` without the invisible characters above. Pure. */
function stripInvisible(text) {
  if (typeof text !== 'string') return text;
  const asciiOrEdge = (ch) => ch === undefined || ch.charCodeAt(0) < 0x80;
  return text
    .replace(ALWAYS_INVISIBLE_RE, '')
    .replace(JOINER_RE, (ch, at, s) => (asciiOrEdge(s[at - 1]) || asciiOrEdge(s[at + 1]) ? '' : ch));
}

const ARTICLE_OPEN_RE = /<article\b[^>]*\bdata-spec\b[^>]*>/i;
const ARTICLE_CLOSE = '</article>';

// What may come before an <article data-spec> that does not open the
// message: stray markup with no words in it (`<aside support id="x-0">
// </aside>`, App bench run 8, trial 1240), or a line or two of preamble, and
// at most a code fence opened just before the article. Never a markdown
// document that only mentions the format: one with a heading, or with the
// opening tag in the middle of a sentence or in inline code.
function strayLead(before) {
  if (before.length > 4000) return false;
  // A fence opened on the line just before the article wraps it.
  const lead = before.replace(/(?:^|\n)[ \t]*[`~]{3,}[\w-]*[ \t]*\n?[ \t]*$/, '\n');
  if (/^[ \t]{0,3}#{1,6}[ \t]/m.test(lead) || /[`~]{3,}/.test(lead)) return false;
  // The tag starts a line or follows other markup.
  const tail = lead.replace(/[ \t]+$/, '');
  if (tail && !/[>\n]$/.test(tail)) return false;
  return lead.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length <= 400;
}

/**
 * The <article data-spec> document in `text`, or null when it holds none:
 * the whole of it when it opens the message (fenced or not, as before), or
 * found further in after stray markup or a short preamble (strayLead). It
 * runs to the last </article>, and whatever follows that is dropped. One
 * found further in must close. Invisible characters are removed first
 * (stripInvisible). Pure.
 */
function extractHtmlSpec(text) {
  if (typeof text !== 'string') return null;
  const t = stripHtmlWrapperFence(stripInvisible(text)).trim();
  const upTo = (start, mustClose) => {
    const end = t.toLowerCase().lastIndexOf(ARTICLE_CLOSE);
    if (end < start) return mustClose ? null : t.slice(start);
    return t.slice(start, end + ARTICLE_CLOSE.length);
  };
  if (/^<article\b[^>]*\bdata-spec\b/i.test(t)) return upTo(0, false);
  const m = ARTICLE_OPEN_RE.exec(t);
  if (!m || !strayLead(t.slice(0, m.index))) return null;
  return upTo(m.index, true);
}

/** True when `text` is an HTML spec document (extractHtmlSpec finds one). */
function isHtmlSpec(text) {
  return extractHtmlSpec(text) !== null;
}

// ── Tokenizer ───────────────────────────────────────────────────────────
// Yields {type:'text', text} | {type:'open', name, attrs, selfClosing} |
// {type:'close', name}. Comments and doctypes are dropped. The contents of
// <script> and <style> are dropped; the contents of <template> and <svg> are
// kept whole as a single raw token so callers decide what to do with them.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_DROP = new Set(['script', 'style']);
const RAW_KEEP = new Set(['template', 'svg']);

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    const value = m[2] ?? m[3] ?? m[4];
    attrs[name] = value === undefined ? '' : decodeEntities(value);
  }
  return attrs;
}

function tokenize(html) {
  const out = [];
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out.push({ type: 'text', text: s.slice(i) }); break; }
    if (lt > i) out.push({ type: 'text', text: s.slice(i, lt) });
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const end = s.indexOf('>', lt);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(s.slice(lt, lt + 200));
    if (close) {
      out.push({ type: 'close', name: close[1].toLowerCase() });
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(s.slice(lt));
    if (!open) {
      // A stray "<" in prose ("a < b"): keep it as text.
      out.push({ type: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    const name = open[1].toLowerCase();
    const attrs = parseAttrs(open[2] || '');
    const selfClosing = open[3] === '/' || VOID.has(name);
    i = lt + open[0].length;
    if (!selfClosing && (RAW_DROP.has(name) || RAW_KEEP.has(name))) {
      const endRe = new RegExp(`</${name}\\s*>`, 'i');
      const rest = s.slice(i);
      const em = endRe.exec(rest);
      const raw = em ? rest.slice(0, em.index) : rest;
      i = em ? i + em.index + em[0].length : s.length;
      if (RAW_KEEP.has(name)) out.push({ type: 'raw', name, attrs, raw });
      continue;
    }
    out.push({ type: 'open', name, attrs, selfClosing });
  }
  return out;
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  rarr: '→', larr: '←', harr: '↔', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', check: '✓',
  bull: '•', copy: '©', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

// ── Screens ─────────────────────────────────────────────────────────────

function parseFocus(value, size) {
  const nums = String(value || '').trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  let [x, y, w, h] = nums.map((n) => Math.round(n));
  x = Math.max(0, Math.min(x, size.width - 1));
  y = Math.max(0, Math.min(y, size.height - 1));
  w = Math.max(1, Math.min(w, size.width - x));
  h = Math.max(1, Math.min(h, size.height - y));
  return [x, y, w, h];
}

/** A screen's declared size and close-up frame, with defaults and bounds applied. */
function screenGeometry(attrs) {
  const kind = String((attrs && attrs['data-size']) || 'desktop').toLowerCase() === 'phone' ? 'phone' : 'desktop';
  const base = SCREEN_SIZES[kind];
  const wantH = parseInt(attrs && attrs['data-height'], 10);
  const height = Number.isFinite(wantH) ? Math.max(base.height, Math.min(MAX_SCREEN_HEIGHT, wantH)) : base.height;
  const size = { width: base.width, height };
  return { kind, width: size.width, height: size.height, focus: parseFocus(attrs && attrs['data-focus'], size) };
}

// ── Markdown projection ────────────────────────────────────────────────

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'details', 'summary', 'dl', 'dt', 'dd']);

function cleanInline(text) {
  return text.replace(/[ \t\r\n]+/g, ' ');
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').trim();
}

function svgTitle(raw) {
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw || '');
  const d = /<desc\b[^>]*>([\s\S]*?)<\/desc>/i.exec(raw || '');
  const pick = (t && t[1]) || (d && d[1]) || '';
  return cleanInline(decodeEntities(pick.replace(/<[^>]*>/g, ''))).trim();
}

/**
 * The markdown projection of an HTML spec. Shaped like a conforming markdown
 * spec ("# Title", "## User-facing changes", "## Technical implementation",
 * ### and deeper inside), so the readers that parse those headings keep
 * working. Each screen's changes are listed in words in the User-facing half;
 * the screens' markup goes at the end of the Technical half, where the build
 * agent finds it and a non-developer reading the User-facing half does not.
 */
function specHtmlToMarkdown(html) {
  const tokens = tokenize(stripHtmlWrapperFence(String(html || '')).trim());
  const out = [];
  let line = '';
  const listStack = [];
  let pre = null;
  let link = null;
  let table = null;
  let row = null;
  let cell = null;
  let quote = 0;
  let inChanges = 0;
  let change = null;
  const screens = [];
  let sawUser = false;
  let sawTech = false;

  const flush = () => {
    const text = line.replace(/[ \t]+$/g, '').replace(/^ +/, '');
    if (text) out.push((quote ? '> ' : '') + text);
    line = '';
  };
  const blank = () => {
    flush();
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  const emit = (text) => {
    if (cell !== null) { cell += text; return; }
    if (change) { change.text += text; return; }
    line += text;
  };

  for (const tok of tokens) {
    if (pre !== null) {
      if (tok.type === 'close' && tok.name === 'pre') {
        blank();
        out.push('```', pre.replace(/\n+$/, ''), '```', '');
        pre = null;
      } else if (tok.type === 'text') {
        pre += decodeEntities(tok.text);
      } else if (tok.type === 'open' && tok.name === 'br') {
        pre += '\n';
      }
      continue;
    }
    if (tok.type === 'text') {
      const text = cleanInline(decodeEntities(tok.text));
      if (!text.trim() && !line && cell === null && !change) continue;
      emit(text);
      continue;
    }
    if (tok.type === 'raw') {
      if (tok.name === 'svg') {
        const title = svgTitle(tok.raw);
        blank();
        out.push(title ? `*Diagram: ${title}*` : '*Diagram*', '');
      } else if (tok.name === 'template' && 'data-screen' in tok.attrs) {
        screens.push({ geometry: screenGeometry(tok.attrs), markup: tok.raw.trim() });
      }
      continue;
    }
    const { name } = tok;
    const attrs = tok.attrs || {};
    if (tok.type === 'open') {
      if (name === 'section' && attrs['data-spec-tab']) {
        const which = String(attrs['data-spec-tab']).toLowerCase();
        blank();
        if (which === 'tech' || which === 'technical') { out.push('## Technical implementation', ''); sawTech = true; }
        else { out.push('## User-facing changes', ''); sawUser = true; }
        continue;
      }
      if (name === 'ol' && 'data-changes' in attrs) { blank(); out.push('**Before and after** (numbered as on the screens):', ''); inChanges += 1; continue; }
      if (name === 'li' && inChanges) {
        change = { n: attrs['data-change'] || '', steps: attrs['data-steps'] || '', text: '' };
        continue;
      }
      if (/^h[1-6]$/.test(name)) {
        blank();
        const level = Number(name[1]);
        line = level === 1 ? '# ' : level === 4 ? '#### ' : level >= 5 ? '##### ' : '### ';
        continue;
      }
      if (name === 'pre') { blank(); pre = ''; continue; }
      if (name === 'br') { if (cell !== null) cell += ' '; else flush(); continue; }
      if (name === 'hr') { blank(); out.push('---', ''); continue; }
      if (name === 'ul' || name === 'ol') { if (!listStack.length) blank(); else flush(); listStack.push({ ordered: name === 'ol', n: 0 }); continue; }
      if (name === 'li') {
        flush();
        const top = listStack[listStack.length - 1] || { ordered: false, n: 0 };
        top.n += 1;
        line = '  '.repeat(Math.max(0, listStack.length - 1)) + (top.ordered ? `${top.n}. ` : '- ');
        continue;
      }
      if (name === 'table') { blank(); table = []; continue; }
      if (name === 'tr' && table) { row = []; continue; }
      if ((name === 'td' || name === 'th') && row) { cell = ''; continue; }
      if (name === 'blockquote') { blank(); quote += 1; continue; }
      if (name === 'strong' || name === 'b') { emit('**'); continue; }
      if (name === 'em' || name === 'i') { emit('*'); continue; }
      if (name === 'code') { emit('`'); continue; }
      if (name === 'a') {
        const href = String(attrs.href || '');
        link = /^https?:\/\//i.test(href) ? href : null;
        if (link) emit('[');
        continue;
      }
      if (name === 'img') { if (attrs.alt) emit(`[image: ${cleanInline(attrs.alt).trim()}]`); continue; }
      if (name === 'figcaption') { blank(); line = '*'; continue; }
      if (BLOCK.has(name)) { blank(); continue; }
      continue;
    }
    // close
    if (name === 'li' && change) {
      const text = cleanInline(change.text).trim();
      const steps = cleanInline(change.steps).trim();
      const n = String(change.n).trim();
      out.push(`${n ? `${n}.` : '-'} ${text}${steps ? ` (${steps})` : ''}`);
      change = null;
      continue;
    }
    if (name === 'ol' && inChanges && !listStack.length) { inChanges -= 1; blank(); continue; }
    if (/^h[1-6]$/.test(name)) { blank(); continue; }
    if (name === 'ul' || name === 'ol') { listStack.pop(); if (!listStack.length) blank(); else flush(); continue; }
    if (name === 'li') { flush(); continue; }
    if ((name === 'td' || name === 'th') && row && cell !== null) { row.push(escapeCell(cleanInline(cell))); cell = null; continue; }
    if (name === 'tr' && table && row) { table.push(row); row = null; continue; }
    if (name === 'table' && table) {
      const width = Math.max(0, ...table.map((r) => r.length));
      if (width) {
        const pad = (r) => Array.from({ length: width }, (_, k) => r[k] || '');
        const [head, ...body] = table;
        out.push(`| ${pad(head).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`);
        for (const r of body) out.push(`| ${pad(r).join(' | ')} |`);
        out.push('');
      }
      table = null;
      continue;
    }
    if (name === 'blockquote') { blank(); quote = Math.max(0, quote - 1); continue; }
    if (name === 'strong' || name === 'b') { emit('**'); continue; }
    if (name === 'em' || name === 'i') { emit('*'); continue; }
    if (name === 'code') { emit('`'); continue; }
    if (name === 'a') { if (link) emit(`](${link})`); link = null; continue; }
    if (name === 'figcaption') { line = line.replace(/\s+$/, ''); if (line === '*') line = ''; else line += '*'; blank(); continue; }
    if (name === 'section' && (sawUser || sawTech)) { blank(); continue; }
    if (BLOCK.has(name)) { blank(); continue; }
  }
  flush();

  if (screens.length) {
    if (!sawTech) out.push('', '## Technical implementation', '');
    out.push('', '### Screen markup', '',
      'The before/after screens above, as the spec drew them. One markup tree per screen: parts marked data-side="before" or data-side="after" show on that side only, and data-change="N" marks change N.', '');
    for (const s of screens) {
      const g = s.geometry;
      const focus = g.focus ? `, close-up ${g.focus.join(' ')}` : '';
      out.push(`${g.kind === 'phone' ? 'Phone' : 'Desktop'} ${g.width}×${g.height}${focus}:`, '', '```html', s.markup, '```', '');
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\*\*\s*\*\*/g, '').trim() + '\n';
}

// Which stylesheet a spec's screens are drawn with, stamped on the article at
// publication (persistScoutPublication), where the app is known. The
// platform's own app draws its screens with the shell's stylesheets, which
// ARE that app's. Any other app's screens get only the native UI kit, which
// every app shares: its own stylesheet lives on its own address (and is often
// Tailwind run as a script, which the frames do not run), so its spec carries
// the styles it needs in a <style> block of each screen. The browser half
// reads the stamp (frontend/src/lib/spec-html.ts, frameDoc).
const SPEC_STYLES = Object.freeze(['platform', 'kit']);
// config.js SELF_APP_SLUG, which is never overridable; homeroom-bot.js keeps
// the same constant. A self-hosted fork's own app is marked self_hosted.
const PLATFORM_APP_SLUG = 'usernode-2d5619';

/** 'platform' for the platform's own app, 'kit' for every other: `app` is { slug, self_hosted }. */
function specStylesFor(app) {
  return app && (app.self_hosted === true || app.slug === PLATFORM_APP_SLUG) ? 'platform' : 'kit';
}

function stampSpecStyles(html, mode) {
  if (typeof html !== 'string' || !SPEC_STYLES.includes(mode)) return html;
  return html.replace(/^(\s*<article\b)([^>]*)>/i, (whole, open, attrs) => {
    const rest = attrs.replace(/\s+data-spec-styles\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `${open} data-spec-styles="${mode}"${rest}>`;
  });
}

/** Whether the spec author for `appSlug` is asked for an HTML spec (config.htmlSpecApps). */
function htmlSpecsEnabledFor(config, appSlug) {
  const list = config && Array.isArray(config.htmlSpecApps) ? config.htmlSpecApps : [];
  if (list.includes('*')) return true;
  return !!appSlug && list.includes(String(appSlug));
}

/**
 * What the capture path stores for an author's final message. A markdown spec
 * comes back as it went in (`html: null`); an HTML spec comes back as its
 * projection plus the document. A document over the size cap is stored as its
 * projection alone, so it still reads as a spec rather than failing.
 */
function normalizeSpecOutput(text) {
  const html = extractHtmlSpec(text);
  if (html === null) return { markdown: stripInvisible(text), html: null };
  const markdown = specHtmlToMarkdown(html);
  if (html.length > MAX_SPEC_HTML_CHARS) return { markdown, html: null };
  return { markdown, html };
}

// ── How much a spec's drawn screens hold ───────────────────────────────
//
// A first version's spec draws up to two screens in full (prompts.js
// FIRST_VERSION_SCREENS_BRIEF), each asked to stay within about
// SCREEN_CHAR_BUDGET characters, its <style> included. Nothing is cut or
// dropped for going over: a dropped screen would leave the build with no
// target, and the spec turn's clock already bounds what it can write. It is
// measured instead, and a screen more than twice the budget is flagged.
const SCREEN_CHAR_BUDGET = 20000;
const SVG_SHAPE_RE = /<(?:path|rect|circle|ellipse|line|polyline|polygon)\b/gi;

/**
 * Each drawn screen of an HTML spec: its size, its height, its markup's
 * characters (its <style> included), how many inline <svg> it holds and how
 * many shapes they draw together, and whether it is over budget (more than
 * twice SCREEN_CHAR_BUDGET). [] for anything that is not an HTML spec. Pure.
 */
function screenStats(text) {
  const html = typeof text === 'string' ? extractHtmlSpec(text) : null;
  if (!html) return [];
  return tokenize(html)
    .filter((tok) => tok.type === 'raw' && tok.name === 'template' && 'data-screen' in tok.attrs)
    .map((tok) => {
      const g = screenGeometry(tok.attrs);
      const markup = String(tok.raw || '');
      return {
        size: g.kind,
        height: g.height,
        chars: markup.length,
        svgs: (markup.match(/<svg\b/gi) || []).length,
        shapes: (markup.match(SVG_SHAPE_RE) || []).length,
        overBudget: markup.length > 2 * SCREEN_CHAR_BUDGET,
      };
    });
}

module.exports = {
  MAX_SPEC_HTML_CHARS,
  SCREEN_SIZES,
  SCREEN_CHAR_BUDGET,
  isHtmlSpec,
  extractHtmlSpec,
  stripInvisible,
  screenStats,
  normalizeSpecOutput,
  screenGeometry,
  specHtmlToMarkdown,
  stripHtmlWrapperFence,
  tokenize,
  decodeEntities,
  htmlSpecsEnabledFor,
  specStylesFor,
  stampSpecStyles,
};
