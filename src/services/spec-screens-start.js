'use strict';

// Newcomer run five (13 Oct 2026), item 8: a first version's build starts
// from the screens its spec drew, instead of drawing them again.
//
// A first version's spec draws up to two finished screens as HTML (prompts.js
// FIRST_VERSION_SCREENS_BRIEF): 42,237 characters in run five. Its build then
// wrote those screens again from scratch: in run four about 43k of the build's
// 86k output tokens were file contents, and build time follows output. So
// between the spec turn and the build turn the platform writes the drawn
// screens into the new app's repository as its starting files, by a
// mechanical mapping with no model call, and the build turn is told they are
// in place (homeroom-bot-live.js STARTING_SCREENS_LINES): it wires data,
// state, actions and the empty and error states rather than drawing.
//
// THE MAPPING, onto the Empty starter (services/template.js), whose
// `public/index.html` still carries its `usernode-starter-notice@1` block:
//
//   public/index.html          its <main>, the starter's placeholder screen,
//                              becomes screen 1 as drawn, wrapped in
//                              <div data-spec-screen="1">; screen 2, if the
//                              spec drew one, follows inside an inert
//                              <template data-spec-screen="2"> for the build
//                              to move where that view belongs. A link to
//                              /screens.css goes right after /tailwind.css.
//   public/screens.css         every screen's <style> block, in order, the
//                              second screen's rules that repeat the first's
//                              left out. Selectors on the drawing's marks
//                              ([data-side], [data-change]) now name the
//                              wrapper ([data-spec-screen]).
//   styles/tailwind-input.css  the light look's colour tokens the drawing
//                              set (`--accent: 15 118 110` on :root, html,
//                              body or the screen's outermost element) set
//                              the kit's :root values; a token the kit has
//                              not got is added there. The dark look stays
//                              the kit's until the build sets it from the
//                              spec's Design subsection.
//
// The drawing's marks (data-side="after", data-change="N") are dropped from
// the markup. Anything else is left exactly as drawn: the build changes it
// only where behaviour needs it.
//
// WHEN IT DOES NOTHING (the build then draws the screens, as before): the
// spec drew no screen; the repository is not the untouched Empty starter (a
// starter's own screen, or a first version already built); or a screen is not
// safe to carry into a running app. A screen is refused whole, never cleaned:
// a script, an event handler, a javascript: URL, an external URL, an embedded
// document, a @import, a "before" side, an unfilled placeholder, or more than
// MAX_SCREEN_CHARS. The spec's screens render with scripts off and no network
// (spec-html.js); the app runs them for real, so nothing that could run or
// load is ever carried over. Screen 1 refused means nothing is placed; screen
// 2 refused leaves screen 1 placed and the spec's copy of screen 2 to draw.
//
// It is the build's own first commit, pushed before its turn starts, because
// every turn starts on the session branch as GitHub has it
// (worker/session-branch.sh usernode_start_turn_on_session_branch).
// HOMEROOM_BOT_SPEC_SCREENS=0 turns it off.

const log = require('./logger');

const NOTICE = 'usernode-starter-notice@1';
const SENTINEL = 'usernode-spec-screens@1';
const INDEX_PATH = 'public/index.html';
const INPUT_CSS_PATH = 'styles/tailwind-input.css';
const SCREENS_CSS_PATH = 'public/screens.css';
const TAILWIND_LINK_RE = /<link\b[^>]*\bhref\s*=\s*["']\/tailwind\.css["'][^>]*>/i;
// A screen of more than this is not carried over (spec-html.js flags a screen
// over twice SCREEN_CHAR_BUDGET, 40,000; this is twice that again).
const MAX_SCREEN_CHARS = 80 * 1000;
const MAX_FILE_CHARS = 400 * 1000;
// App bench run 193 (14 Oct 2026): a screen is drawn at phone width, and on a
// desktop window its rows, fields and buttons stretched across the whole
// window, the reviewer's most common round-1 finding (8 of 15 reviewed first
// versions) and the blind judge's on every brief. The screens' stylesheet
// opens with this, so each screen stays one centred column; the drawing's own
// rules come after it and win where they set the same thing.
const SCREEN_COLUMN_CSS = [
  '/* Each screen is one centred column: the phone width it was drawn at grows',
  '   to a readable column on a wider window, never rows and buttons stretched',
  '   across the window. Remove this only for an app that fills the window by',
  '   design, such as a map. */',
  '[data-spec-screen] {',
  '  width: 100%;',
  '  max-width: 42rem;',
  '  margin-inline: auto;',
  '}',
].join('\n');
// The design kit's colour tokens (template.js DESIGN_KIT_CSS).
const KIT_TOKENS = Object.freeze([
  'ground', 'surface', 'raised', 'fg', 'muted', 'line', 'accent', 'on-accent', 'danger', 'on-danger', 'focus',
]);
const MARKER = '__USERNODE_SPEC_SCREENS__';
const READ_SCRIPT_PATH = '/tmp/usernode-spec-screens-read.js';
const WRITE_SCRIPT_PATH = '/tmp/usernode-spec-screens-write.js';
const COMMIT_MESSAGE = 'Homeroom: start from the screens the spec drew';
const GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'usernode-bot',
  GIT_AUTHOR_EMAIL: 'usernode-bot@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'usernode-bot',
  GIT_COMMITTER_EMAIL: 'usernode-bot@users.noreply.github.com',
});

/** Whether the build starts from the spec's screens (HOMEROOM_BOT_SPEC_SCREENS=0 turns it off). */
function enabled(env = process.env) {
  return String(env.HOMEROOM_BOT_SPEC_SCREENS ?? '').trim() !== '0';
}

// ── The spec's screens ────────────────────────────────────────────────────

/** Each screen a spec drew, in order: [{ n, markup }]. [] for none. Pure. */
function screensOf(specHtml) {
  const specHtmlLib = require('./spec-html');
  const html = typeof specHtml === 'string' ? specHtmlLib.extractHtmlSpec(specHtml) : null;
  if (!html) return [];
  return specHtmlLib.tokenize(html)
    .filter((tok) => tok.type === 'raw' && tok.name === 'template' && 'data-screen' in tok.attrs)
    .map((tok, i) => ({ n: i + 1, markup: String(tok.raw || '') }));
}

// What a screen may not hold, to be carried into a running app.
const UNSAFE = Object.freeze([
  [/<\s*script\b/i, 'a script'],
  [/<\s*(?:iframe|object|embed|frame|frameset|applet|portal)\b/i, 'an embedded document'],
  [/<\s*(?:link|meta|base|html|head|body)\b/i, 'a document-level tag'],
  [/<\s*template\b/i, 'a nested template (an unfilled placeholder)'],
  [/\son[a-z]+\s*=/i, 'an event handler'],
  [/javascript\s*:/i, 'a javascript: URL'],
  // A link out (<a href="https://…">) loads nothing; anything else from
  // elsewhere would, and a data: image is the only scheme a drawing needs.
  [/\b(?:src|action|formaction|srcset|poster|data|xlink:href)\s*=\s*["']?\s*(?!data:image\/)(?:[a-z][a-z0-9+.-]*:|\/\/)/i, 'an external URL'],
  [/\bhref\s*=\s*["']?\s*(?!https?:\/\/|data:image\/)(?:[a-z][a-z0-9+.-]*:|\/\/)/i, 'a link that is not https'],
  [/url\(\s*["']?\s*(?!data:)(?:[a-z][a-z0-9+.-]*:|\/\/)/i, 'an external URL in its styles'],
  [/@import\b/i, 'an @import'],
  [/expression\s*\(/i, 'a CSS expression'],
  [/\bdata-side\s*=\s*["']?before\b/i, 'a "before" side'],
]);

/** Why a screen's markup cannot be carried over, or null when it can. Pure. */
function unsafeWhy(markup) {
  const text = String(markup || '');
  if (!text.trim()) return 'it is empty';
  if (text.length > MAX_SCREEN_CHARS) return `it is over ${MAX_SCREEN_CHARS} characters`;
  for (const [re, why] of UNSAFE) if (re.test(text)) return `it holds ${why}`;
  return null;
}

/** A screen's <style> blocks and the rest of its markup: { css, body }. Pure. */
function splitStyles(markup) {
  const css = [];
  const body = String(markup || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (whole, inner) => {
    css.push(inner.trim());
    return '';
  });
  return { css: css.filter(Boolean).join('\n\n'), body: body.trim() };
}

/** The markup without the drawing's marks (data-side, data-change). Pure. */
function stripMarks(body) {
  return String(body || '').replace(/<([a-zA-Z][\w:-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g,
    (whole, name, attrs, slash) => {
      if (!/\bdata-(?:side|change)\b/i.test(attrs)) return whole;
      const kept = attrs.replace(/\s+data-(?:side|change)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi, '');
      return `<${name}${kept}${slash ? ' /' : ''}>`;
    });
}

/** CSS selectors on the drawing's marks, pointed at the screen's wrapper. Pure. */
function retargetMarks(css) {
  return String(css || '').replace(/\[\s*data-(?:side|change)\s*(?:[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*)?\]/gi, '[data-spec-screen]');
}

// ── CSS, at its top level ─────────────────────────────────────────────────

/**
 * A stylesheet's top-level parts, in order: { prelude, body } for a rule or
 * an at-rule with a block, { text } for anything else (a statement, a
 * comment, leftover text). Comments and strings are respected. Pure.
 */
function topLevel(css) {
  const s = String(css || '');
  const parts = [];
  let i = 0;
  let start = 0;
  let depth = 0;
  let open = -1;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        parts.push({ prelude: s.slice(start, open).trim(), body: s.slice(open + 1, i) });
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const text = s.slice(start, i + 1).trim();
      if (text) parts.push({ text });
      start = i + 1;
    }
    i += 1;
  }
  if (depth !== 0) return null;
  const rest = s.slice(start).trim();
  if (rest) parts.push({ text: rest });
  return parts;
}

/** A rule body's declarations: [{ name, value }] (comments dropped). Pure. */
function declarations(body) {
  const out = [];
  const s = String(body || '').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let quote = null;
  let start = 0;
  const push = (text) => {
    const k = text.indexOf(':');
    if (k > 0) out.push({ name: text.slice(0, k).trim(), value: text.slice(k + 1).trim() });
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { push(s.slice(start, i)); start = i + 1; }
  }
  push(s.slice(start));
  return out;
}

/** A colour as the kit writes it ("R G B"), from "R G B", #rgb, #rrggbb or rgb(), or null. Pure. */
function channels(value) {
  const v = String(value || '').trim().replace(/\s*!important$/i, '');
  let rgb = null;
  let m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(v);
  if (m) rgb = [m[1], m[2], m[3]].map(Number);
  m = !rgb && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) {
    const hex = m[1].length === 3 ? m[1].split('').map((h) => h + h).join('') : m[1];
    rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  }
  m = !rgb && /^rgb\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)$/i.exec(v);
  if (m) rgb = [m[1], m[2], m[3]].map(Number);
  if (!rgb || rgb.some((n) => n > 255)) return null;
  return rgb.join(' ');
}

/** The classes of a screen's outermost element and of the first element inside it. Pure. */
function outerClasses(body) {
  const out = new Set();
  const re = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  for (let k = 0; k < 2; k += 1) {
    const m = re.exec(String(body || ''));
    if (!m) break;
    const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[2]);
    for (const c of String(cls ? (cls[1] ?? cls[2] ?? cls[3]) : '').split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

/** Whether every selector in a list sets the page's own values: :root, html, body, the screen's wrapper or outermost element. Pure. */
function rootLike(prelude, classes) {
  const parts = String(prelude || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => /^(?::root|html|body|:host|\*|\[data-spec-screen\])$/i.test(p)
    || (/^\.[\w-]+$/.test(p) && classes.has(p.slice(1))));
}

/**
 * A screen's stylesheet with its light colour tokens lifted out: every
 * custom property on a root-like rule (rootLike) whose value is a colour,
 * and every kit token there whatever its value (a kit token written as hex
 * would break the kit's `rgb(var(--accent) / …)`; one that is not a colour
 * at all is dropped). `{ css, tokens: Map(name → "R G B"), dropped: [name] }`,
 * or null for a stylesheet that does not parse. Pure.
 */
function liftTokens(css, classes = new Set()) {
  const parts = topLevel(css);
  if (!parts) return null;
  const tokens = new Map();
  const dropped = [];
  const kept = [];
  for (const part of parts) {
    if (part.text != null || part.prelude.startsWith('@') || !rootLike(part.prelude, classes)) {
      kept.push(part.text != null ? part.text : `${part.prelude} {${part.body}}`);
      continue;
    }
    const rest = [];
    for (const d of declarations(part.body)) {
      const custom = /^--([a-z][a-z0-9-]*)$/i.exec(d.name);
      if (!custom) { rest.push(d); continue; }
      const name = custom[1].toLowerCase();
      const value = channels(d.value);
      if (value) { if (!tokens.has(name)) tokens.set(name, value); continue; }
      if (KIT_TOKENS.includes(name)) { dropped.push(name); continue; }
      rest.push(d);
    }
    if (rest.length) kept.push(`${part.prelude} {\n${rest.map((d) => `  ${d.name}: ${d.value};`).join('\n')}\n}`);
  }
  return { css: kept.join('\n\n'), tokens, dropped };
}

/** A stylesheet's top-level parts as normalised text, to tell a repeated rule. Pure. */
function ruleKeys(css) {
  return new Set((topLevel(css) || []).map((p) => (p.text != null ? p.text : `${p.prelude}{${p.body}}`).replace(/\s+/g, ' ').trim()));
}

/** `css` without the top-level rules `seen` already holds. Pure. */
function withoutRepeats(css, seen) {
  const parts = topLevel(css);
  if (!parts) return css;
  return parts
    .filter((p) => !seen.has((p.text != null ? p.text : `${p.prelude}{${p.body}}`).replace(/\s+/g, ' ').trim()))
    .map((p) => (p.text != null ? p.text : `${p.prelude} {${p.body}}`))
    .join('\n\n');
}

/**
 * The kit's input stylesheet with `tokens` set on its light look (the first
 * :root block): a token it has is given the new value, one it has not is
 * added at the end. Null when it has no :root block. Pure.
 */
function setKitTokens(inputCss, tokens) {
  const s = String(inputCss || '');
  const m = /:root\s*\{/.exec(s);
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = s.indexOf('}', open);
  if (close === -1) return null;
  let block = s.slice(open, close);
  const added = [];
  for (const [name, value] of tokens) {
    const re = new RegExp(`(^|[\\s;{])(--${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;]*)(;)`, 'm');
    if (re.test(block)) block = block.replace(re, (whole, lead, head, old, semi) => `${lead}${head}${value}${semi}`);
    else added.push(`    --${name}: ${value}; /* from the spec's screens */`);
  }
  if (added.length) block = `${block.replace(/\s*$/, '')}\n${added.join('\n')}\n  `;
  return s.slice(0, open) + block + s.slice(close);
}

// ── The mapping ───────────────────────────────────────────────────────────

/**
 * The starting files for a first version's build, from its spec's screens
 * and the repository's own files as they are (`files`: { index, inputCss },
 * each a string or null). Resolves:
 *   { placed: false, why }                        nothing to write;
 *   { placed: true, already: true, screens }      written by an earlier run;
 *   { placed: true, files: [{ path, content }], screens: [1, 2], tokens,
 *     droppedTokens, skipped: [{ n, why }] }       to be written.
 * No model call and no I/O. Pure.
 */
function mapScreens({ specHtml, files }) {
  const index = typeof files?.index === 'string' ? files.index : null;
  const inputCss = typeof files?.inputCss === 'string' ? files.inputCss : null;
  if (index && index.includes(SENTINEL)) {
    return { placed: true, already: true, screens: /data-spec-screen\s*=\s*["']?2\b/.test(index) ? [1, 2] : [1] };
  }
  const drawn = screensOf(specHtml).slice(0, 2);
  if (!drawn.length) return { placed: false, why: 'the spec drew no screen' };
  if (!index || !index.includes(NOTICE)) return { placed: false, why: 'the repository is not the untouched starter' };
  const mainOpen = /<main\b[^>]*>/i.exec(index);
  const mainClose = index.toLowerCase().lastIndexOf('</main>');
  if (!mainOpen || mainClose < mainOpen.index || !TAILWIND_LINK_RE.test(index)) {
    return { placed: false, why: 'the starter page is not the one this maps onto' };
  }
  if (!inputCss || !/:root\s*\{/.test(inputCss)) return { placed: false, why: 'the starter has no design kit tokens' };

  const skipped = [];
  const placed = [];
  for (const screen of drawn) {
    const why = unsafeWhy(screen.markup);
    if (why) {
      skipped.push({ n: screen.n, why });
      if (screen.n === 1) break;
      continue;
    }
    const { css, body } = splitStyles(screen.markup);
    const classes = outerClasses(body);
    const lifted = liftTokens(retargetMarks(css), classes);
    if (!lifted) {
      skipped.push({ n: screen.n, why: 'its styles do not parse' });
      if (screen.n === 1) break;
      continue;
    }
    placed.push({ n: screen.n, body: stripMarks(body), ...lifted });
  }
  if (!placed.length || placed[0].n !== 1) {
    return { placed: false, why: `screen 1 cannot be carried over: ${skipped[0]?.why || 'unknown'}` };
  }

  // The first screen's tokens win; a token only the second sets is added.
  const tokens = new Map(placed[0].tokens);
  for (const p of placed.slice(1)) for (const [k, v] of p.tokens) if (!tokens.has(k)) tokens.set(k, v);
  const nextInput = tokens.size ? setKitTokens(inputCss, tokens) : inputCss;
  if (nextInput == null) return { placed: false, why: 'the starter has no design kit tokens' };

  const seen = ruleKeys(placed[0].css);
  const cssParts = [
    '/* The screens the spec drew, carried over by the platform before the first',
    '   version was built (screen 1 is public/index.html\'s main screen; screen 2,',
    '   if any, its <template data-spec-screen="2">). Colours are the design kit\'s',
    '   tokens, rgb(var(--accent)), so they follow the light and the dark look. */',
    '',
    SCREEN_COLUMN_CSS,
    '',
    placed[0].css,
  ];
  for (const p of placed.slice(1)) {
    const own = withoutRepeats(p.css, seen);
    if (own.trim()) cssParts.push('', `/* Screen ${p.n}: its rules the first screen has not got. */`, '', own);
  }
  const screensCss = `${cssParts.join('\n').trim()}\n`;

  const indent = (text, pad) => text.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
  const blocks = [
    `  <!-- ${SENTINEL}: the screens the spec drew, carried over by the platform as this`,
    '       first version\'s starting point. Their styles are in public/screens.css.',
    '       Change them where behaviour needs it; do not redraw them. -->',
    '  <div data-spec-screen="1">',
    indent(placed[0].body, '    '),
    '  </div>',
  ];
  for (const p of placed.slice(1)) {
    blocks.push(
      `  <!-- Screen ${p.n} as the spec drew it: inert until moved where that view belongs. -->`,
      `  <template data-spec-screen="${p.n}">`,
      `    <div data-spec-screen="${p.n}">`,
      indent(p.body, '      '),
      '    </div>',
      '  </template>',
    );
  }
  blocks.push(`  <!-- /${SENTINEL} -->`);
  const nextIndex = index.slice(0, mainOpen.index)
    + blocks.join('\n').replace(/^ {2}/, '')
    + index.slice(mainClose + '</main>'.length);
  const linked = nextIndex.replace(TAILWIND_LINK_RE, (link) => `${link}\n  <link rel="stylesheet" href="/screens.css">`);

  const out = [
    { path: INDEX_PATH, content: linked },
    { path: SCREENS_CSS_PATH, content: screensCss },
  ];
  if (nextInput !== inputCss) out.push({ path: INPUT_CSS_PATH, content: nextInput });
  if (out.some((f) => f.content.length > MAX_FILE_CHARS)) return { placed: false, why: 'the starting files would be too large' };
  return {
    placed: true,
    files: out,
    screens: placed.map((p) => p.n),
    tokens: [...tokens.keys()],
    droppedTokens: [...new Set(placed.flatMap((p) => p.dropped))],
    skipped,
  };
}

/**
 * The spec as the build reads it once its screens are in the repository:
 * its "### Screen markup" (the drawn screens' HTML, spec-html.js
 * specHtmlToMarkdown, always the spec's last section) replaced by a line
 * saying where they are. Unchanged when it has none. Pure.
 */
function specWithoutScreenMarkup(specMd) {
  const text = String(specMd || '');
  const at = text.search(/^### Screen markup\s*$/m);
  if (at === -1) return text;
  return `${text.slice(0, at).replace(/\s+$/, '')}\n\n### Screen markup\n\n`
    + 'Already in the repository: the platform wrote these screens into public/index.html and public/screens.css before this build (see "THE SPEC\'S SCREENS ARE IN PLACE").\n';
}

// ── In the worker ─────────────────────────────────────────────────────────

const READ_SOURCE = `'use strict';
const fs = require('fs');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
process.stdout.write(${JSON.stringify(MARKER)} + ' ' + JSON.stringify({
  index: read(${JSON.stringify(INDEX_PATH)}),
  inputCss: read(${JSON.stringify(INPUT_CSS_PATH)}),
}) + '\\n');
`;

/** The marker line's JSON from a worker script's stdout, or null. Pure. */
function readMarker(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(`${MARKER} `)) continue;
    try { return JSON.parse(lines[i].slice(MARKER.length + 1)); } catch { return null; }
  }
  return null;
}

/**
 * The script that writes the starting files and commits them on `branch`,
 * in the checkout (its working directory). It refuses, writing nothing,
 * when the checkout is on another branch or has changes of its own to the
 * files it writes. Pure.
 */
function writeSource(files, branch, message = COMMIT_MESSAGE) {
  const payload = files.map((f) => ({ path: f.path, b64: Buffer.from(f.content, 'utf8').toString('base64') }));
  return `'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FILES = ${JSON.stringify(payload)};
const BRANCH = ${JSON.stringify(String(branch))};
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = (o) => process.stdout.write(${JSON.stringify(MARKER)} + ' ' + JSON.stringify(o) + '\\n');
try {
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head !== BRANCH) { say({ ok: false, why: 'the checkout is on ' + head }); process.exit(0); }
  const dirty = git(['status', '--porcelain', '--', ...FILES.map((f) => f.path)]);
  if (dirty) { say({ ok: false, why: 'the starting files already have changes' }); process.exit(0); }
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, Buffer.from(f.b64, 'base64').toString('utf8'));
  }
  git(['add', '--', ...FILES.map((f) => f.path)]);
  git(['commit', '--quiet', '-m', ${JSON.stringify(message)}, '--', ...FILES.map((f) => f.path)]);
  say({ ok: true, sha: git(['rev-parse', 'HEAD']) });
} catch (err) {
  say({ ok: false, why: String(err && err.message || err).slice(0, 300) });
}
`;
}

/**
 * Before a first version's build turn: read the repository's starter files
 * off the build's worker, map the spec's screens onto them (mapScreens), and
 * commit and push the result on the session branch. Resolves what the build
 * prompt is told (`{ screens, tokens, sha }`, `already` for a run resumed
 * after it), or null when the build draws the screens itself. Never throws.
 */
async function startFromScreens({
  worker, containerName, sessionId, branchName, specHtml, env = process.env, timeoutMs = 60 * 1000,
}) {
  try {
    if (!enabled(env)) return null;
    if (!worker || typeof worker.runBenchCapture !== 'function' || typeof worker.execPushFromWorker !== 'function') return null;
    if (!containerName || !branchName) return null;
    const files = readMarker(await worker.runBenchCapture(containerName, {
      source: READ_SOURCE, env: {}, timeoutMs, scriptPath: READ_SCRIPT_PATH, maxBuffer: 4 * MAX_FILE_CHARS,
    }));
    if (!files) return null;
    const mapped = mapScreens({ specHtml, files });
    if (!mapped.placed) {
      if (screensOf(specHtml).length) log.info('spec-screens-start', 'The build draws the screens itself', { sessionId, why: mapped.why });
      return null;
    }
    if (mapped.already) return { screens: mapped.screens, already: true };
    const wrote = readMarker(await worker.runBenchCapture(containerName, {
      source: writeSource(mapped.files, branchName), env: { ...GIT_ENV }, timeoutMs, scriptPath: WRITE_SCRIPT_PATH,
    }));
    if (!wrote || !wrote.ok) {
      log.warn('spec-screens-start', 'Could not write the spec\'s screens into the repository', { sessionId, why: wrote?.why || 'no answer' });
      return null;
    }
    await worker.execPushFromWorker(sessionId, branchName);
    log.info('spec-screens-start', 'The build starts from the spec\'s screens', {
      sessionId, screens: mapped.screens, tokens: mapped.tokens.length, skipped: mapped.skipped.length, sha: String(wrote.sha || '').slice(0, 8),
    });
    return {
      screens: mapped.screens, tokens: mapped.tokens, droppedTokens: mapped.droppedTokens,
      skipped: mapped.skipped, sha: wrote.sha || null,
    };
  } catch (err) {
    log.warn('spec-screens-start', 'Could not start the build from the spec\'s screens', { sessionId, err: err.message });
    return null;
  }
}

module.exports = {
  SENTINEL,
  NOTICE,
  KIT_TOKENS,
  MAX_SCREEN_CHARS,
  INDEX_PATH,
  INPUT_CSS_PATH,
  SCREENS_CSS_PATH,
  SCREEN_COLUMN_CSS,
  COMMIT_MESSAGE,
  enabled,
  screensOf,
  unsafeWhy,
  splitStyles,
  stripMarks,
  retargetMarks,
  topLevel,
  declarations,
  channels,
  liftTokens,
  setKitTokens,
  mapScreens,
  specWithoutScreenMarkup,
  readMarker,
  writeSource,
  startFromScreens,
};
