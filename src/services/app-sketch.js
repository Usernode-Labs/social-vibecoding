'use strict';

/**
 * The sketch: something of theirs, about half a minute after "Make it".
 *
 * Somebody who makes a project in their first session (first-session
 * make.tsx, POST /api/apps with `from: 'first-session'`) is shown a sketch of
 * its main screen while the real app is built, or while it waits for someone
 * to build it. One Haiku call turns the name and the description into
 *
 *   design  the screen's one job and primary action, an accent for each look,
 *           its signature element, the layout top to bottom, and its words;
 *   html    the screen itself, as static markup.
 *
 * ONE VOCABULARY, TWO RENDERINGS. The markup may use only the starter's
 * design kit (btn-primary, list, card, ...) and a short list of Tailwind
 * utilities (SKETCH_CLASSES); sanitizeSketchHtml drops every other tag,
 * attribute and class. That is what lets the same markup render twice and
 * look the same:
 *   - in the made screen, from SKETCH_CSS, plain CSS written here for exactly
 *     that vocabulary (the platform has no Tailwind compiler at run time);
 *   - in the app itself, where getTemplateFiles puts it in place of the
 *     starter's placeholder screen and the app's own Tailwind build compiles
 *     the same class names from its markup.
 *
 * SAFE TO SHOW. The sketch is model output from a user's description, so it
 * is treated as untrusted HTML: sanitized here (no scripts, no handlers, no
 * links, no URLs at all), served with a sandbox CSP that allows no script and
 * no network (routes/apps.js), and framed with an empty `sandbox` attribute.
 *
 * WHAT THE BUILD DOES WITH IT. The repository gets design/sketch.html and
 * design/sketch.json, the "## Design" notes are filled from it, and the
 * starter's accent is set to it (contrast-checked). The first version's
 * request names it as the design target (homeroom-bot-dm.js
 * firstVersionIssue), and the build prompts say to keep it.
 *
 * Never a reason creation fails: no key, a refusal, a timeout or an unusable
 * reply is a `failed` row, and the made screen shows the build's progress
 * instead, as it did before.
 */

const log = require('./logger');

const SKETCH_MODEL = 'claude-haiku-4-5';
// How long app creation waits for the sketch before seeding the repository
// without it (app-creator.js). A late sketch is committed on its own.
const SKETCH_WAIT_MS = 30 * 1000;
const LATE_COMMIT_WAIT_MS = 3 * 60 * 1000;
const HTML_MAX = 24 * 1024;
// How the page is served (routes/apps.js): sandboxed with nothing allowed,
// so no script runs and it has an opaque origin; no request leaves it but
// its inline style; framed only by the platform's own pages.
const SKETCH_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const MAX_DEPTH = 24;

// ── The vocabulary ───────────────────────────────────────────────────────

const KIT_CLASSES = [
  'btn-primary', 'btn-secondary', 'field', 'list', 'list-row', 'card', 'section-label',
  'skeleton', 'state-empty',
];

// Tailwind 3 utilities, each compiled by the app's own build (its config
// names the colour tokens and the four type sizes) and written out below as
// plain CSS for the preview. Spacing is Tailwind's 0.25rem scale.
const SPACING = { 0: '0', 1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 6: '1.5rem', 8: '2rem' };
const SIZES = { 1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 8: '2rem', 10: '2.5rem', 12: '3rem', 16: '4rem' };
const FRACTIONS = { '1/4': '25%', '1/3': '33.333333%', '1/2': '50%', '2/3': '66.666667%', '3/4': '75%', full: '100%' };

function cls(name) {
  return `.${name.replace(/[/:.]/g, (c) => `\\${c}`)}`;
}

function utilityRules() {
  const rules = [
    ['text-title', 'font-size:1.75rem;line-height:2.25rem;font-weight:700'],
    ['text-heading', 'font-size:1.25rem;line-height:1.75rem;font-weight:600'],
    ['text-body', 'font-size:1rem;line-height:1.5rem'],
    ['text-small', 'font-size:0.875rem;line-height:1.25rem'],
    ['font-medium', 'font-weight:500'],
    ['font-semibold', 'font-weight:600'],
    ['font-bold', 'font-weight:700'],
    ['text-center', 'text-align:center'],
    ['text-right', 'text-align:right'],
    ['tabular-nums', 'font-variant-numeric:tabular-nums'],
    ['truncate', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'],
    ['line-through', 'text-decoration-line:line-through'],
    ['text-fg', 'color:rgb(var(--fg))'],
    ['text-muted', 'color:rgb(var(--muted))'],
    ['text-accent', 'color:rgb(var(--accent))'],
    ['text-on-accent', 'color:rgb(var(--on-accent))'],
    ['text-danger', 'color:rgb(var(--danger))'],
    ['bg-ground', 'background-color:rgb(var(--ground))'],
    ['bg-surface', 'background-color:rgb(var(--surface))'],
    ['bg-raised', 'background-color:rgb(var(--raised))'],
    ['bg-line', 'background-color:rgb(var(--line))'],
    ['bg-accent', 'background-color:rgb(var(--accent))'],
    ['bg-accent/10', 'background-color:rgb(var(--accent) / 0.1)'],
    ['bg-accent/20', 'background-color:rgb(var(--accent) / 0.2)'],
    ['border', 'border-width:1px'],
    ['border-t', 'border-top-width:1px'],
    ['border-b', 'border-bottom-width:1px'],
    ['border-line', 'border-color:rgb(var(--line))'],
    ['border-accent', 'border-color:rgb(var(--accent))'],
    ['rounded-md', 'border-radius:0.375rem'],
    ['rounded-lg', 'border-radius:0.5rem'],
    ['rounded-xl', 'border-radius:0.75rem'],
    ['rounded-full', 'border-radius:9999px'],
    ['flex', 'display:flex'],
    ['inline-flex', 'display:inline-flex'],
    ['grid', 'display:grid'],
    ['flex-col', 'flex-direction:column'],
    ['flex-wrap', 'flex-wrap:wrap'],
    ['items-center', 'align-items:center'],
    ['items-start', 'align-items:flex-start'],
    ['items-end', 'align-items:flex-end'],
    ['items-baseline', 'align-items:baseline'],
    ['justify-between', 'justify-content:space-between'],
    ['justify-center', 'justify-content:center'],
    ['justify-end', 'justify-content:flex-end'],
    ['grow', 'flex-grow:1'],
    ['shrink-0', 'flex-shrink:0'],
    ['self-start', 'align-self:flex-start'],
    ['grid-cols-2', 'grid-template-columns:repeat(2,minmax(0,1fr))'],
    ['grid-cols-3', 'grid-template-columns:repeat(3,minmax(0,1fr))'],
    ['grid-cols-4', 'grid-template-columns:repeat(4,minmax(0,1fr))'],
    ['col-span-2', 'grid-column:span 2 / span 2'],
    ['min-w-0', 'min-width:0'],
    ['overflow-hidden', 'overflow:hidden'],
    ['opacity-60', 'opacity:0.6'],
    ['ml-auto', 'margin-left:auto'],
  ];
  for (const [key, value] of Object.entries(SPACING)) {
    if (key !== '0') rules.push([`gap-${key}`, `gap:${value}`]);
    rules.push([`p-${key}`, `padding:${value}`]);
    rules.push([`px-${key}`, `padding-left:${value};padding-right:${value}`]);
    rules.push([`py-${key}`, `padding-top:${value};padding-bottom:${value}`]);
    rules.push([`mt-${key}`, `margin-top:${value}`]);
    rules.push([`mb-${key}`, `margin-bottom:${value}`]);
  }
  for (const [key, value] of Object.entries(SIZES)) {
    rules.push([`h-${key}`, `height:${value}`]);
    rules.push([`w-${key}`, `width:${value}`]);
  }
  for (const [key, value] of Object.entries(FRACTIONS)) rules.push([`w-${key}`, `width:${value}`]);
  return rules;
}

const UTILITY_RULES = Object.freeze(utilityRules());
const SKETCH_CLASSES = Object.freeze(new Set([...KIT_CLASSES, ...UTILITY_RULES.map(([name]) => name)]));

// The starter's tokens (template.js DESIGN_KIT_CSS), as "R G B" channels.
const BASE_TOKENS = Object.freeze({
  light: {
    ground: '250 250 249', surface: '255 255 255', raised: '245 245 244', fg: '28 25 23',
    muted: '87 83 78', line: '231 229 228', accent: '15 118 110', 'on-accent': '255 255 255',
    danger: '185 28 28', 'on-danger': '255 255 255', focus: '13 148 136',
  },
  dark: {
    ground: '12 10 9', surface: '28 25 23', raised: '41 37 36', fg: '245 245 244',
    muted: '168 162 158', line: '68 64 60', accent: '45 212 191', 'on-accent': '4 47 46',
    danger: '248 113 113', 'on-danger': '69 10 10', focus: '94 234 212',
  },
});

// The kit's components (template.js DESIGN_KIT_CSS @apply lists), in plain
// CSS. Components before utilities, as Tailwind orders them, so `card p-3`
// means what it means in the app.
const KIT_CSS = `
.btn-primary,.btn-secondary{display:inline-flex;min-height:2.75rem;min-width:2.75rem;align-items:center;justify-content:center;gap:0.5rem;border-radius:0.5rem;padding:0 1rem;font-size:1rem;line-height:1.5rem;font-weight:500}
.btn-primary{background-color:rgb(var(--accent));color:rgb(var(--on-accent))}
.btn-secondary{border:1px solid rgb(var(--line));background-color:rgb(var(--surface));color:rgb(var(--fg))}
.field{display:block;min-height:2.75rem;width:100%;border-radius:0.5rem;border:1px solid rgb(var(--line));background-color:rgb(var(--surface));padding:0.5rem 0.75rem;font-size:1rem;line-height:1.5rem;color:rgb(var(--fg))}
.field::placeholder{color:rgb(var(--muted))}
.list{overflow:hidden;border-radius:0.75rem;border:1px solid rgb(var(--line));background-color:rgb(var(--surface))}
.list>*+*{border-top:1px solid rgb(var(--line))}
.list-row{display:flex;min-height:2.75rem;align-items:center;gap:0.75rem;padding:0.75rem 1rem}
.card{border-radius:0.75rem;border:1px solid rgb(var(--line));background-color:rgb(var(--surface));padding:1rem}
.section-label{margin-bottom:0.5rem;padding:0 0.25rem;font-size:0.875rem;line-height:1.25rem;font-weight:500;color:rgb(var(--muted))}
.skeleton{border-radius:0.375rem;background-color:rgb(var(--line))}
.state-empty{display:flex;flex-direction:column;align-items:center;gap:0.5rem;padding:2rem 1rem;text-align:center}
`.trim();

// Tailwind's preflight, the parts this vocabulary meets.
const PREFLIGHT_CSS = `
*,::before,::after{box-sizing:border-box;border:0 solid rgb(229 231 235);margin:0;padding:0}
html{-webkit-text-size-adjust:100%;font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji";line-height:1.5}
body{background-color:rgb(var(--ground));color:rgb(var(--fg))}
h1,h2,h3,h4{font-size:inherit;font-weight:inherit}
ol,ul{list-style:none}
button,input,select,textarea{font:inherit;color:inherit;background-color:transparent}
button{cursor:default}
table{border-collapse:collapse;width:100%}
hr{border-top-width:1px;border-color:rgb(var(--line))}
[hidden]{display:none!important}
.sketch-screen{margin:0 auto;display:flex;max-width:28rem;flex-direction:column;gap:2rem;padding:2.5rem 1rem}
`.trim();

const SKETCH_CSS_BODY = [KIT_CSS, ...UTILITY_RULES.map(([name, body]) => `${cls(name)}{${body}}`)].join('\n');

// ── Colour ───────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channels(rgb) {
  return rgb.map((v) => Math.round(v)).join(' ');
}

function parseChannels(str) {
  return String(str).split(' ').map(Number);
}

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(rgb, toward, amount) {
  return rgb.map((v, i) => v + (toward[i] - v) * amount);
}

/**
 * The accent a sketch asks for, made to meet the kit's contrast rule in one
 * look: 4.5:1 on the ground and the surface, and its on-accent text 4.5:1 on
 * it. Darkened (light look) or lightened (dark look) in small steps until it
 * does; null when the colour is unusable. Returns { accent, onAccent } as
 * "R G B" channels.
 */
function fitAccent(hex, look) {
  let rgb = hexToRgb(hex);
  if (!rgb) return null;
  const base = BASE_TOKENS[look];
  const ground = parseChannels(base.ground);
  const surface = parseChannels(base.surface);
  const toward = look === 'light' ? [0, 0, 0] : [255, 255, 255];
  const textOptions = look === 'light'
    ? [[255, 255, 255], parseChannels(BASE_TOKENS.light.fg)]
    : [parseChannels(BASE_TOKENS.light.fg), [255, 255, 255]];
  for (let step = 0; step <= 20; step += 1) {
    const onGround = Math.min(contrast(rgb, ground), contrast(rgb, surface));
    const text = textOptions.map((t) => [t, contrast(t, rgb)]).sort((a, b) => b[1] - a[1])[0];
    if (onGround >= 4.5 && text[1] >= 4.5) return { accent: channels(rgb), onAccent: channels(text[0]) };
    rgb = mix(rgb, toward, 0.08);
  }
  return null;
}

/** The token overrides a design asks for, per look: { light: {...}, dark: {...} }. */
function accentTokens(design) {
  const out = { light: {}, dark: {} };
  for (const look of ['light', 'dark']) {
    const fitted = design?.accent ? fitAccent(design.accent[look], look) : null;
    if (fitted) {
      out[look] = { accent: fitted.accent, 'on-accent': fitted.onAccent, focus: fitted.accent };
    }
  }
  return out;
}

function tokenBlock(selector, tokens) {
  return `${selector}{${Object.entries(tokens).map(([k, v]) => `--${k}:${v}`).join(';')}}`;
}

/** The preview's whole stylesheet: tokens for the look(s), then the kit and the utilities. */
function sketchCss(design, theme = null) {
  const accents = accentTokens(design);
  const light = { ...BASE_TOKENS.light, ...accents.light };
  const dark = { ...BASE_TOKENS.dark, ...accents.dark };
  let tokens;
  if (theme === 'dark') tokens = tokenBlock(':root', dark);
  else if (theme === 'light') tokens = tokenBlock(':root', light);
  else tokens = `${tokenBlock(':root', light)}\n@media (prefers-color-scheme: dark){${tokenBlock(':root', dark)}}`;
  return [tokens, PREFLIGHT_CSS, SKETCH_CSS_BODY].join('\n');
}

// ── Sanitizing ───────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'header', 'footer', 'nav', 'section', 'article', 'aside', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4',
  'strong', 'em', 'b', 'i', 'small', 'ul', 'ol', 'li', 'button', 'input', 'textarea', 'select', 'option',
  'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'time', 'figure', 'figcaption',
]);
const VOID_TAGS = new Set(['input', 'hr', 'br']);
// Removed with everything inside them.
const DROPPED_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
  'head', 'title', 'link', 'meta', 'base', 'canvas', 'audio', 'video', 'picture', 'img', 'source', 'map',
]);
const GLOBAL_ATTRS = new Set(['class', 'aria-label', 'aria-hidden', 'role', 'title']);
const TAG_ATTRS = {
  input: new Set(['type', 'placeholder', 'value', 'checked', 'disabled', 'readonly', 'min', 'max', 'step']),
  textarea: new Set(['placeholder', 'rows', 'disabled', 'readonly']),
  select: new Set(['disabled']),
  option: new Set(['selected', 'value']),
  button: new Set(['type', 'disabled']),
  th: new Set(['colspan']),
  td: new Set(['colspan']),
};
const INPUT_TYPES = new Set(['text', 'number', 'date', 'time', 'email', 'search', 'checkbox', 'radio', 'range', 'tel']);
const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'readonly', 'selected', 'aria-hidden']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+\d*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : whole;
  });
}

// Emoji drawn as pictures (the benchmark's tells lint counts the same
// ranges, worker/usernode-bench-capture.js), and the joiners that held them.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}\u{200D}]/gu;

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function cleanAttrs(tag, raw) {
  const out = [];
  const seen = new Set();
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    if (!GLOBAL_ATTRS.has(name) && !(TAG_ATTRS[tag] && TAG_ATTRS[tag].has(name))) continue;
    seen.add(name);
    let value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if (name === 'class') {
      value = [...new Set(value.split(/\s+/).filter((c) => SKETCH_CLASSES.has(c)))].join(' ');
      if (!value) continue;
    } else if (name === 'type' && tag === 'input') {
      value = value.toLowerCase();
      if (!INPUT_TYPES.has(value)) value = 'text';
    } else if (name === 'type' && tag === 'button') {
      value = 'button';
    } else if (name === 'colspan') {
      const n = Number.parseInt(value, 10);
      if (!(n >= 1 && n <= 6)) continue;
      value = String(n);
    } else if (name === 'rows') {
      const n = Number.parseInt(value, 10);
      if (!(n >= 1 && n <= 12)) continue;
      value = String(n);
    }
    value = value.replace(/[\u0000-\u001f]/g, ' ').replace(EMOJI_RE, '').slice(0, 300);
    out.push(BOOLEAN_ATTRS.has(name) && name !== 'aria-hidden' ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`);
  }
  return out.join('');
}

const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|[^<]+|</g;

/**
 * Keep only the sketch vocabulary: allowed tags and attributes, classes from
 * SKETCH_CLASSES, text escaped, every element closed. Scripts, styles,
 * frames, images, SVG and links go with their contents; any other unknown
 * tag goes but its text stays. Never throws.
 */
function sanitizeSketchHtml(input) {
  const html = String(input || '').slice(0, HTML_MAX * 2);
  const out = [];
  const stack = [];
  let dropping = null;
  let dropDepth = 0;
  for (const m of html.matchAll(TOKEN_RE)) {
    const token = m[0];
    const closeName = m[1] && m[1].toLowerCase();
    const openName = m[2] && m[2].toLowerCase();
    if (dropping) {
      if (openName === dropping && !/\/>$/.test(token)) dropDepth += 1;
      else if (closeName === dropping) {
        dropDepth -= 1;
        if (dropDepth === 0) dropping = null;
      }
      continue;
    }
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    if (openName) {
      if (DROPPED_WITH_CONTENT.has(openName)) {
        if (!VOID_TAGS.has(openName) && !/\/>$/.test(token) && !['img', 'link', 'meta', 'base', 'source'].includes(openName)) {
          dropping = openName;
          dropDepth = 1;
        }
        continue;
      }
      if (!ALLOWED_TAGS.has(openName) || stack.length >= MAX_DEPTH) continue;
      out.push(`<${openName}${cleanAttrs(openName, m[3] || '')}>`);
      if (!VOID_TAGS.has(openName)) stack.push(openName);
      continue;
    }
    if (closeName) {
      const at = stack.lastIndexOf(closeName);
      if (at === -1) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    // Text, or a stray '<'.
    const text = (token === '<' ? '<' : decodeEntities(token)).replace(EMOJI_RE, '');
    if (stack[stack.length - 1] === 'select' && text.trim()) continue;
    out.push(escapeText(text));
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  const cleaned = out.join('').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > HTML_MAX ? '' : cleaned;
}

/** Visible words in sanitized markup, for "is there anything here". */
function textOf(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ── The design record ────────────────────────────────────────────────────

function oneLine(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** The model's design object, kept to known fields and sizes; null when it has no job. */
function normalizeDesign(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const job = oneLine(raw.job, 200);
  if (!job) return null;
  const hex = (v) => (hexToRgb(v) ? `#${String(v).trim().replace(/^#/, '').toLowerCase()}` : null);
  const accent = raw.accent && typeof raw.accent === 'object'
    ? { light: hex(raw.accent.light), dark: hex(raw.accent.dark) }
    : { light: null, dark: null };
  const layout = Array.isArray(raw.layout) ? raw.layout.map((l) => oneLine(l, 160)).filter(Boolean).slice(0, 8) : [];
  const words = {};
  if (raw.words && typeof raw.words === 'object' && !Array.isArray(raw.words)) {
    for (const [k, v] of Object.entries(raw.words).slice(0, 12)) {
      const key = oneLine(k, 40);
      const value = oneLine(v, 60);
      if (key && value) words[key] = value;
    }
  }
  return {
    job,
    primaryAction: oneLine(raw.primaryAction, 80),
    accent,
    accentName: oneLine(raw.accentName, 40),
    signature: oneLine(raw.signature, 200),
    layout,
    words,
  };
}

// ── The prompt ───────────────────────────────────────────────────────────

const SKETCH_SYSTEM = `You sketch the main screen of a small web app a group of people will use together, from its name and its creator's description, so its creator sees something of theirs within seconds while the real app is built. The real app will keep your layout, your words and your accent, so decide them well: plain, specific to this app, and useful on a phone.

Respond with ONLY a JSON object, no prose before or after:
{
  "design": {
    "job": "the main screen's one job, in a short sentence",
    "primaryAction": "the one primary action's label, e.g. Log a run",
    "accentName": "the accent colour in plain words, e.g. tomato red",
    "accent": { "light": "#rrggbb", "dark": "#rrggbb" },
    "signature": "ONE element drawn from the app's subject that a generic app would not have",
    "layout": ["the screen top to bottom, a few plain lines"],
    "words": { "the thing": "the exact word the screen uses for it" }
  },
  "html": "the screen's markup"
}

The accent: one colour chosen for this app, with a darker shade for the light look and a lighter one for the dark look. Not teal unless the subject calls for it.

The markup is STATIC HTML for the body of the screen at phone width, filled with believable example content for this group (names, numbers, dates), never lorem ipsum. Rules:
- Tags: header, section, div, span, p, h1, h2, h3, strong, em, small, ul, ol, li, button, input, textarea, select, option, label, table, thead, tbody, tr, th, td, hr, time. Nothing else: no script, no style, no img, no svg, no links, no style attributes, no ids, no event handlers.
- Classes: ONLY these, exactly as written. Components: btn-primary (the one primary action, once), btn-secondary, field (inputs), list with list-row children (the usual way to show several things), card (one self-contained thing; never a card inside a card or a list), section-label (a label above a section), skeleton, state-empty. Type: text-title (once, the screen's title), text-heading, text-body, text-small, font-medium, font-semibold, font-bold, text-center, text-right, tabular-nums, truncate, line-through. Colour: text-fg, text-muted, text-accent, text-on-accent, text-danger, bg-surface, bg-raised, bg-line, bg-accent, bg-accent/10, bg-accent/20, border, border-t, border-b, border-line, border-accent, rounded-md, rounded-lg, rounded-xl, rounded-full, opacity-60. Layout: flex, inline-flex, grid, flex-col, flex-wrap, items-center, items-start, items-end, items-baseline, justify-between, justify-center, justify-end, grow, shrink-0, self-start, grid-cols-2, grid-cols-3, grid-cols-4, col-span-2, min-w-0, overflow-hidden, ml-auto, gap-1, gap-2, gap-3, gap-4, gap-6, p-/px-/py-/mt-/mb- with 0, 1, 2, 3, 4, 6 or 8, h- and w- with 1, 2, 3, 4, 8, 10, 12 or 16, w-1/4, w-1/3, w-1/2, w-2/3, w-3/4, w-full.
- The screen's top-level elements are siblings, spaced by the page (do not wrap everything in one div). Start with a header holding the title and one short line under it in text-muted.
- No emoji. No uppercase labels. Accent only for the primary action, the signature element and small highlights.
- At most about 60 elements. A bar or meter is a bg-line rounded-full h-2 track holding a bg-accent rounded-full h-2 fill with a w- fraction.`;

function sketchUserPrompt({ name, brief, audience }) {
  return [
    `APP NAME:\n${String(name || '').slice(0, 120)}`,
    audience ? `WHO IT IS FOR:\n${String(audience).slice(0, 120)}` : null,
    `WHAT IT SHOULD DO (the creator's words):\n${String(brief || '').slice(0, 4000)}`,
  ].filter(Boolean).join('\n\n');
}

/** The model's reply as { design, html }, or null when it is not usable. */
function parseSketchReply(text) {
  const out = String(text || '');
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  let obj;
  try {
    obj = JSON.parse(out.slice(first, last + 1));
  } catch {
    return null;
  }
  const design = normalizeDesign(obj.design);
  const html = sanitizeSketchHtml(obj.html);
  // Something to look at: a title and a few more words than that.
  if (!design || textOf(html).split(' ').length < 8) return null;
  return { design, html };
}

// ── Documents ────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return escapeAttr(String(text ?? ''));
}

/**
 * The sketch as a page of its own: what the made screen frames, and the
 * repository's design/sketch.html. `theme` pins one look; without it the
 * page follows the device.
 */
function sketchDocument({ name, design, html, theme = null }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}: a sketch</title>
<!-- A sketch Homeroom made from this app's description when it was created,
     so its creator saw something of theirs straight away. Static: nothing on
     it works. The first version keeps its layout, its words and its accent
     (design/sketch.json says them in words). -->
<style>
${sketchCss(design, theme)}
</style>
</head>
<body>
<main class="sketch-screen">
${html}
</main>
</body>
</html>
`;
}

/** design/sketch.json: the design record, for the build to adopt. */
function sketchRecord({ design, model, createdAt }) {
  const tokens = accentTokens(design);
  return `${JSON.stringify({
    note: 'The sketch this app\'s creator was shown when they made it (design/sketch.html). The first version keeps its layout, its words and its accent; any deviation is listed under Assumptions with the reason.',
    ...design,
    tokens,
    model: model || SKETCH_MODEL,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
  }, null, 2)}\n`;
}

/**
 * The starter's placeholder screen, replaced by the sketch: the markup that
 * goes between the usernode-starter-notice@1 sentinels of public/index.html.
 * The app's own Tailwind build compiles these class names from it.
 */
function starterBlock({ name, html }) {
  return `<div class="flex flex-col items-start gap-2">
      <p class="rounded-full bg-raised px-3 py-1 text-small font-medium text-muted">A sketch of ${escapeHtml(name)}</p>
      <p class="text-small text-muted">Homeroom sketched this from the app's description. Nothing on it works yet: to build it, ask Homeroom bot (tap the <strong class="font-semibold text-fg">Homeroom icon</strong>, then <strong class="font-semibold text-fg">Ask for a change</strong>).</p>
    </div>
    ${html}`;
}

/** The kit's token lines, re-pointed at the sketch's accent where it fits. */
function retokenKitCss(kitCss, design) {
  const tokens = accentTokens(design);
  let css = kitCss;
  for (const look of ['light', 'dark']) {
    const selector = look === 'light' ? ':root {' : '.dark {';
    const start = css.indexOf(selector);
    if (start === -1) continue;
    const end = css.indexOf('}', start);
    let block = css.slice(start, end);
    for (const [key, value] of Object.entries(tokens[look])) {
      block = block.replace(new RegExp(`(--${key}:\\s*)[0-9 ]+;`), `$1${value};`);
    }
    css = css.slice(0, start) + block + css.slice(end);
  }
  return css;
}

// ── Generation ───────────────────────────────────────────────────────────

const pending = new Map();
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

/**
 * A staging preview has no model key, so a project made there gets this
 * obviously fake sketch instead, and reviewers can see the screen.
 */
function stagingDemoSketch(name) {
  const design = normalizeDesign({
    job: 'Staging demo: show the week at a glance and add to it',
    primaryAction: 'Add one',
    accentName: 'indigo',
    accent: { light: '#4338ca', dark: '#a5b4fc' },
    signature: 'Staging demo: a large count for the week',
    layout: ['Title and one line under it', 'This week\'s count with Add one', 'The latest entries'],
    words: { entry: 'entry', week: 'this week' },
  });
  const html = sanitizeSketchHtml(`
<header class="flex flex-col gap-1"><h1 class="text-title">${escapeHtml(name)}</h1><p class="text-body text-muted">Staging demo sketch. On Homeroom it is drawn from the app's description.</p></header>
<section class="card flex items-center justify-between gap-4 bg-accent/10 border-accent"><div><p class="text-small text-muted">This week</p><p class="text-title tabular-nums">12</p></div><button class="btn-primary">Add one</button></section>
<section><h2 class="section-label">Latest</h2><ul class="list"><li class="list-row justify-between"><span class="text-body">Staging demo entry</span><span class="text-small text-muted">Today</span></li><li class="list-row justify-between"><span class="text-body">Another demo entry</span><span class="text-small text-muted">Tuesday</span></li></ul></section>`);
  return { design, html };
}

// A pending row older than this was left by a process that stopped while
// drawing it; it reads as failed, and nothing waits on it.
const STALE_PENDING_MS = 3 * 60 * 1000;

function stillDrawing(row, now = Date.now()) {
  return !!row && row.status === 'pending' && now - new Date(row.created_at).getTime() < STALE_PENDING_MS;
}

/** What the made screen is told: 'pending', 'ready' or 'failed' (a stale pending row is failed). */
function sketchStatus(row, now = Date.now()) {
  if (!row) return 'none';
  if (row.status === 'pending') return stillDrawing(row, now) ? 'pending' : 'failed';
  return row.status;
}

async function readSketch(pool, appId) {
  const { rows } = await pool.query(
    `SELECT app_id, status, design, html, model, error, committed_at, created_at, ready_at
       FROM app_sketches WHERE app_id = $1`,
    [appId]
  );
  return rows[0] || null;
}

async function generate(pool, { app, user, brief, audience, deps }) {
  const llm = deps.llm || require('./llm');
  const limits = deps.limits || require('./limits');
  let result = null;
  let usage = null;
  let model = SKETCH_MODEL;
  let error = null;
  try {
    const reply = await llm.generateAppSketch({
      system: SKETCH_SYSTEM,
      user: sketchUserPrompt({ name: app.name, brief, audience }),
      model: SKETCH_MODEL,
      telemetryContext: { pool, appId: app.id },
    });
    usage = reply.usage || null;
    model = reply.model || SKETCH_MODEL;
    result = parseSketchReply(reply.text);
    if (!result) error = 'unusable_reply';
  } catch (err) {
    error = String(err && err.message || 'failed').slice(0, 200);
  }
  if (usage) {
    try {
      await limits.recordSpend(pool, user.id, llm.estimateCostCents(usage, model), { byok: false });
    } catch (err) {
      log.warn('app-sketch', 'Spend not recorded', { appId: app.id, err: err.message });
    }
  }
  if (!result) {
    await pool.query(
      `UPDATE app_sketches SET status = 'failed', error = $2, model = $3, ready_at = NOW() WHERE app_id = $1`,
      [app.id, error, model]
    );
    log.warn('app-sketch', 'No sketch', { appId: app.id, error });
    return null;
  }
  await pool.query(
    `UPDATE app_sketches
        SET status = 'ready', design = $2::jsonb, html = $3, model = $4, error = NULL, ready_at = NOW()
      WHERE app_id = $1`,
    [app.id, JSON.stringify(result.design), result.html, model]
  );
  log.info('app-sketch', 'Sketch ready', { appId: app.id });
  return readSketch(pool, app.id);
}

/**
 * Start a project's sketch, once. Returns at once; the work runs on. A
 * project with a sketch row already (a retried create) is left alone.
 */
async function startSketch(pool, { app, user, brief, audience = null }, deps = {}) {
  const llm = deps.llm || require('./llm');
  if (!llm.isEnabled()) {
    if (!(deps.staging ?? IS_STAGING)) return false;
    const demo = stagingDemoSketch(app.name);
    await pool.query(
      `INSERT INTO app_sketches (app_id, user_id, status, design, html, model, ready_at)
       VALUES ($1, $2, 'ready', $3::jsonb, $4, 'staging-demo', NOW())
       ON CONFLICT (app_id) DO NOTHING`,
      [app.id, user.id, JSON.stringify(demo.design), demo.html]
    );
    return true;
  }
  const { rows } = await pool.query(
    `INSERT INTO app_sketches (app_id, user_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (app_id) DO NOTHING
     RETURNING app_id`,
    [app.id, user.id]
  );
  if (!rows.length) return false;
  const work = generate(pool, { app, user, brief, audience, deps }).catch((err) => {
    log.warn('app-sketch', 'Sketch failed', { appId: app.id, err: err.message });
    return null;
  });
  pending.set(app.id, work);
  work.finally(() => setTimeout(() => pending.delete(app.id), LATE_COMMIT_WAIT_MS).unref?.());
  return true;
}

/**
 * The project's sketch once it is ready, waiting up to `ms` for one still
 * being drawn by this process; null when there is none (or not in time).
 */
async function whenReady(pool, appId, ms = SKETCH_WAIT_MS, { pollMs = 1000 } = {}) {
  const deadline = Date.now() + ms;
  const work = pending.get(appId);
  if (work) {
    let timer;
    await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }
  let row = await readSketch(pool, appId).catch(() => null);
  // Drawn by another process (a create retried on another Pod): watch the
  // row instead, until the same deadline.
  while (stillDrawing(row) && Date.now() + pollMs <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    row = await readSketch(pool, appId).catch(() => null);
  }
  return row && row.status === 'ready' ? row : null;
}

/** The repository's design files for a ready sketch. */
function designFiles({ name, sketch }) {
  return [
    { path: 'design/sketch.html', content: sketchDocument({ name, design: sketch.design, html: sketch.html }) },
    { path: 'design/sketch.json', content: sketchRecord({ design: sketch.design, model: sketch.model, createdAt: sketch.ready_at }) },
  ];
}

async function markCommitted(pool, appId) {
  await pool.query('UPDATE app_sketches SET committed_at = NOW() WHERE app_id = $1 AND committed_at IS NULL', [appId]);
}

/**
 * A sketch that missed the repository's first commit: committed on its own
 * when it is ready (the design files only; the starter screen is left as it
 * is). Best effort, never throws.
 */
async function commitWhenReady(pool, { appId, name, owner, repo }, deps = {}) {
  try {
    const sketch = await whenReady(pool, appId, LATE_COMMIT_WAIT_MS);
    if (!sketch || sketch.committed_at) return false;
    const github = deps.github || require('./github');
    await github.pushFiles(owner, repo, designFiles({ name, sketch }), {
      message: `Add the sketch ${name} was made from`,
    });
    await markCommitted(pool, appId);
    return true;
  } catch (err) {
    log.warn('app-sketch', 'Late sketch not committed', { appId, err: err.message });
    return false;
  }
}

module.exports = {
  SKETCH_MODEL,
  SKETCH_WAIT_MS,
  SKETCH_CSP,
  SKETCH_CLASSES,
  SKETCH_SYSTEM,
  BASE_TOKENS,
  sanitizeSketchHtml,
  textOf,
  normalizeDesign,
  parseSketchReply,
  sketchUserPrompt,
  fitAccent,
  accentTokens,
  sketchCss,
  sketchDocument,
  sketchRecord,
  starterBlock,
  retokenKitCss,
  readSketch,
  sketchStatus,
  stagingDemoSketch,
  startSketch,
  whenReady,
  designFiles,
  markCommitted,
  commitWhenReady,
};
