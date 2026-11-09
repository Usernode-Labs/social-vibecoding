#!/usr/bin/env node
'use strict';

/**
 * The frame's kit and its nine looks, compiled into app.css.
 *
 * frontend/looks/kit.css and one file per look (glass.css, brandkit.css …)
 * are the 2026-11-06 screen tour's own stylesheets, kept in the tour's
 * notation so a look in the product is the look the tour drew, rule for
 * rule. The tour styles a mock: a fixed `.hr` box, `.hr.dark` for dark,
 * `.hr.phone` for a phone, bare class names and bare token names. This
 * script rewrites that for the shell and writes the result between the
 * `looks:begin` and `looks:end` marks of public/css/app.css:
 *
 *   .hr { --x }            →  html[data-skin="<id>"] { --fr-x }      (any look: html[data-skin])
 *   .hr.dark { --x }       →  html[data-skin="<id>"].dark { --fr-x }
 *   .hr { font, color }    →  html[data-skin="<id>"] .fr { … }       (the frame root, never <html>:
 *                                                                     rem sizes hang off the document)
 *   .row .t                →  html[data-skin="<id>"] .fr-row .fr-t
 *   .dark .row             →  html[data-skin="<id>"].dark .fr-row
 *   .phone .row            →  @media (max-width: 767.98px) { html[data-skin="<id>"][data-skin] .fr-row }
 *   var(--x)               →  var(--fr-x)
 *
 * WEIGHT IS KEPT. In the tour a kit rule and a look's rule weigh the same
 * and the look wins by coming later, while `.phone .x` and `.dark .x`
 * outweigh a plain `.x` by one class whichever file they are in. Here every
 * rule carries the same one attribute on html, `.dark` adds its class, and a
 * phone rule repeats the attribute (`[data-skin][data-skin]`), so each rule
 * beats exactly the rules it beat in the tour.
 *
 * The mock's own machinery (its fixed box, the `.full` tall variant, its
 * background, which is the product's wallpaper here) is dropped.
 *
 *   node scripts/build-looks-css.js           rewrite the section
 *   node scripts/build-looks-css.js --check   exit 1 if the section is stale
 *
 * tests/looks-css.test.js holds the mapping and holds app.css to this output.
 */

const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'frontend', 'looks');
const APP_CSS = path.join(ROOT, 'public', 'css', 'app.css');
const BEGIN = '/* looks:begin';
const END = '/* looks:end */';
const PHONE = '@media (max-width: 767.98px)';
const WIDE = '@media (min-width: 768px)';

const config = JSON.parse(fs.readFileSync(path.join(SRC, 'looks.json'), 'utf8'));

// Classes of the mock itself; everything else is a kit class.
const MOCK = new Set(['hr', 'dark', 'phone', 'full']);
// What the mock's root sets for its own box, not for what is drawn in it.
const MOCK_ROOT_PROPS = new Set(['width', 'height', 'position', 'overflow', 'background', 'color-scheme']);

const flag = (id) => (id ? `html[data-skin="${id}"]` : 'html[data-skin]');
const renameClasses = (sel) => sel.replace(/\.([a-zA-Z][\w-]*)/g, (m, name) => (MOCK.has(name) ? m : `.fr-${name}`));

/**
 * One selector of the tour → where it lands: { media: null | 'phone' | 'wide', selector },
 * or null when it only sizes the mock. `id` is the look, null for the kit.
 */
function mapSelector(raw, id) {
  let sel = raw.trim().replace(/\s+/g, ' ');
  if (/\.full\b/.test(sel)) return null;
  let media = null;
  let dark = false;
  if (/^\.hr:not\(\.phone\) /.test(sel)) { media = 'wide'; sel = sel.replace(/^\.hr:not\(\.phone\) /, ''); }
  if (/^\.hr\.phone /.test(sel)) { media = 'phone'; sel = sel.replace(/^\.hr\.phone /, ''); }
  if (sel === '.hr.phone') return null;
  if (/^\.hr /.test(sel)) sel = `.fr ${sel.slice(4)}`;
  if (/^\.phone /.test(sel)) { media = 'phone'; sel = sel.replace(/^\.phone /, ''); }
  if (/^\.dark /.test(sel)) { dark = true; sel = sel.replace(/^\.dark /, ''); }
  if (/\.(hr|phone|dark)\b/.test(sel)) throw new Error(`build-looks-css: cannot place "${raw}"`);
  // `.hr *` is the kit's reset: kept, inside a frame root.
  sel = sel.replace(/^\.fr /, '\u0000');
  sel = renameClasses(sel).replace('\u0000', '.fr ');
  const head = `${flag(id)}${media ? '[data-skin]' : ''}${dark ? '.dark' : ''}`;
  return { media, selector: `${head} ${sel}` };
}

/**
 * A mapped selector → the same rule for the product's own markup, or null.
 * looks.json "wear" names the kit components the product draws with its own
 * renderer (a message, a day's label, an open item's head, the composer):
 * the component's class becomes the product's, its inner classes the
 * product's too, and any other kit class stays (an avatar in a message is
 * the kit's own). `raw` is the tour's selector, for the skip list.
 */
function wornSelector(mapped, raw = null) {
  const at = mapped.indexOf(' ');
  // The kit's rules are any look's, and "brand" (the New look) carries the
  // attribute without being one: it draws no kit markup, so only a worn
  // rule could reach it. :where() leaves it out at no weight.
  const head = mapped.slice(0, at) + (mapped.startsWith('html[data-skin=') ? '' : ':where(:not([data-skin="brand"]))');
  let sel = mapped.slice(at);
  const names = (sel.match(/\.fr-[\w-]+/g) || []).map((c) => c.slice(4));
  const key = names.find((name) => config.wear.roots[name]);
  if (!key) return null;
  const root = config.wear.roots[key];
  const plain = raw == null ? sel.trim().replace(/\.fr-/g, '.') : raw.trim().replace(/\s+/g, ' ').replace(/^\.(hr|phone|dark) /, '');
  if ((root.skip || []).includes(plain)) return null;
  const to = { [key]: root.to, ...(root.parts || {}) };
  sel = sel.replace(/\.fr-([\w-]+)/g, (m, name) => (Object.prototype.hasOwnProperty.call(to, name) ? to[name] : m));
  return head + sel;
}

/** One declaration → [prop, value], tokens namespaced where set and where read. */
function mapDeclaration(prop, value) {
  const p = prop.startsWith('--') ? `--fr-${prop.slice(2)}` : prop;
  return [p, value.replace(/var\(--([a-zA-Z0-9-]+)/g, 'var(--fr-$1')];
}

// The tour is drawn left to right only; app.css mirrors. A physical side
// becomes its logical twin, and a four-sided shorthand whose two sides
// differ is split, so every look reads the right way round in Arabic.
const SIDE = {
  'margin-left': 'margin-inline-start', 'margin-right': 'margin-inline-end',
  'padding-left': 'padding-inline-start', 'padding-right': 'padding-inline-end',
  'border-left': 'border-inline-start', 'border-right': 'border-inline-end',
  'border-left-color': 'border-inline-start-color', 'border-right-color': 'border-inline-end-color',
  'border-left-width': 'border-inline-start-width', 'border-right-width': 'border-inline-end-width',
  'border-top-left-radius': 'border-start-start-radius', 'border-top-right-radius': 'border-start-end-radius',
  'border-bottom-left-radius': 'border-end-start-radius', 'border-bottom-right-radius': 'border-end-end-radius',
  left: 'inset-inline-start', right: 'inset-inline-end',
};
// Top-level words of a value: spaces inside calc(…) or var(…) do not split it.
function words(value) {
  const out = [];
  let depth = 0;
  let word = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) { if (word) out.push(word); word = ''; } else word += ch;
  }
  if (word) out.push(word);
  return out;
}

/** One declaration of the tour → the shell's, as one or more [prop, value]. */
function mapDeclarations(prop, value) {
  const [p, v] = mapDeclaration(prop, value);
  const important = /!important$/.test(v) ? '!important' : '';
  const bare = important ? v.slice(0, -'!important'.length).trim() : v;
  if ((p === 'left' || p === 'right') && bare === '50%') return [[p, v]];
  if (SIDE[p]) return [[SIDE[p], v]];
  if (p === 'text-align' && (bare === 'left' || bare === 'right')) return [[p, (bare === 'left' ? 'start' : 'end') + important]];
  const four = words(bare);
  if ((p === 'padding' || p === 'margin') && four.length === 4 && four[1] !== four[3]) {
    const [top, right, bottom, left] = four;
    return [[`${p}-block`, `${top} ${bottom}${important}`], [`${p}-inline`, `${left} ${right}${important}`]];
  }
  if (p === 'border-radius' && four.length === 4 && !bare.includes('/') && (four[0] !== four[1] || four[2] !== four[3])) {
    const [tl, tr, br, bl] = four;
    return [
      ['border-start-start-radius', tl + important], ['border-start-end-radius', tr + important],
      ['border-end-end-radius', br + important], ['border-end-start-radius', bl + important],
    ];
  }
  return [[p, v]];
}

const declsOf = (rule) => {
  const out = [];
  rule.walkDecls((d) => out.push([d.prop, d.value + (d.important ? '!important' : '')]));
  return out;
};
const line = (selector, decls) => `${selector}{${decls.map(([p, v]) => `${p}:${v}`).join(';')}}`;

/**
 * A whole file of the tour → the shell's rules. `id` is the look, null for
 * the kit. `rootExtra` is declarations the caller adds to the light and dark
 * root rules (the document's font stack, the tint).
 */
function compile(source, id, rootExtra = { light: [], dark: [] }) {
  const base = [];
  const phone = [];
  const wide = [];
  const roots = { light: [], dark: [], frame: [] };
  postcss.parse(source).walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule') throw new Error('build-looks-css: the tour\'s files have no at-rules; add support before using one');
    const decls = declsOf(rule);
    const selectors = rule.selectors.map((s) => s.trim().replace(/\s+/g, ' '));
    const rest = [];
    for (const sel of selectors) {
      if (sel === '.hr' || sel === '.hr.dark') {
        const mode = sel === '.hr' ? 'light' : 'dark';
        for (const [p, v] of decls) {
          if (p.startsWith('--')) roots[mode].push(mapDeclaration(p, v));
          else if (!MOCK_ROOT_PROPS.has(p)) for (const d of mapDeclarations(p, v)) roots.frame.push([mode, d]);
        }
      } else rest.push(sel);
    }
    const mapped = decls.flatMap(([p, v]) => mapDeclarations(p, v));
    const byPlace = new Map();
    for (const sel of rest) {
      const to = mapSelector(sel, id);
      if (!to) continue;
      const key = to.media || '';
      if (!byPlace.has(key)) byPlace.set(key, []);
      byPlace.get(key).push(to.selector);
      const worn = wornSelector(to.selector, sel);
      if (worn) byPlace.get(key).push(worn);
    }
    for (const [key, sels] of byPlace) {
      const text = line(sels.join(','), mapped);
      (key === 'phone' ? phone : key === 'wide' ? wide : base).push(text);
    }
  });
  const out = [];
  const light = [...rootExtra.light, ...roots.light];
  const dark = [...rootExtra.dark, ...roots.dark];
  if (light.length) out.push(line(flag(id), light));
  if (dark.length) out.push(line(`${flag(id)}.dark`, dark));
  const frameLight = roots.frame.filter(([m]) => m === 'light').map(([, d]) => d);
  const frameDark = roots.frame.filter(([m]) => m === 'dark').map(([, d]) => d);
  if (frameLight.length) out.push(line(`${flag(id)} .fr`, frameLight));
  if (frameDark.length) out.push(line(`${flag(id)}.dark .fr`, frameDark));
  out.push(...base);
  if (wide.length) out.push(`${WIDE}{\n${wide.join('\n')}\n}`);
  if (phone.length) out.push(`${PHONE}{\n${phone.join('\n')}\n}`);
  return out.join('\n');
}

function faces(dir) {
  const font = config.fonts[dir];
  if (!font) throw new Error(`build-looks-css: looks.json has no font "${dir}"`);
  // Absolute urls: the build-scoped copy of this sheet (/b/<sha>/css/app.css)
  // serves only .js and .css, so a relative url would 404 there.
  return font.files.map((f) => `@font-face{font-family:'${font.family}';src:url('/fonts/${dir}/${f.file}') format('woff2');font-weight:${font.weight};font-style:normal;font-display:swap;unicode-range:${f.range}}`).join('\n');
}

const rule = (title, id) => `/* ── THE ${title} LOOK (data-skin="${id}") ── */`;

function lookBlock(id) {
  const look = config.looks[id];
  const out = [rule(look.name, id)];
  for (const dir of look.faces) out.push(faces(dir));
  out.push(compile(fs.readFileSync(path.join(SRC, `${id}.css`), 'utf8'), id, {
    light: [['font-family', `'${look.family}',${config.stack}`], ['--accent-tint', look.tint[0]]],
    dark: [['--accent-tint', look.tint[1]]],
  }));
  if (look.ground) {
    // The look's own page, moved the way the New look moves its plate: on
    // <body>, one id deep like the route rule that draws the wallpaper, with
    // --home-ground following. Dark carries :not([data-app-tone="light"]) to
    // outweigh the dark wallpaper's rule and to leave a light app its page.
    const [l, d] = look.ground;
    const lightRoot = `${flag(id)}:not(.dark):not([data-app-tone="dark"])`;
    const darkRoot = `${flag(id)}.dark:not([data-app-tone="light"])`;
    out.push(`${lightRoot} body:has(#platform-tabs){--home-ground:${l};--un-zoom-bg:${l};background:${l}}`);
    out.push(`${lightRoot} body::before{background:${l}}`);
    out.push(`${darkRoot} body:has(#platform-tabs){--home-ground:${d};--un-zoom-bg:${d};background:${d}}`);
    out.push(`${darkRoot} body::before{background:${d}}`);
  }
  if (look.opaque) {
    out.push(`@supports not (backdrop-filter: blur(1px)){\n${flag(id)}{--fr-surface:${look.opaque[0]}}\n${flag(id)}.dark{--fr-surface:${look.opaque[1]}}\n}`);
  }
  return out.join('\n');
}

/** The whole section, from its opening mark to its closing one. */
function build() {
  const ANY = 'html[data-skin]:where(:not([data-skin="brand"]))';
  const head = `${BEGIN} ── THE FRAME'S KIT AND ITS LOOKS ──────────────────────────────────────
   GENERATED by scripts/build-looks-css.js from frontend/looks/ (kit.css, one
   file per look, looks.json). Do not edit between the two marks: change a
   source file and run the script; tests/looks-css.test.js holds this
   section to its output.

   The sources are the 2026-11-06 screen tour's own stylesheets. The kit
   draws every page of the one frame (sidebar, bar, title, labelled groups
   of one row, sheets); a look is one more sheet over it: its tokens in
   light and dark, its typeface from our own origin, its shapes. Classes
   are fr-*, tokens --fr-*. A look is on when the head's window.Skin has set
   its id as data-skin on <html> (Settings › Experimental › Look, an
   admin's preview, or a ?skin= pin); without the attribute not one rule
   below matches. Kit markup exists only under a look (lib/skin.ts
   isFrameSkin), inside an element with class "fr".

   A conversation is the one thing the kit's markup does not draw: the
   product's own renderer does (a message, a day's label, an open item's
   head, the composer). looks.json "wear" maps those kit components onto
   the product's classes, and each of their rules names both.

   Weight: every rule carries one attribute on html; .dark adds a class and
   a phone rule repeats the attribute, as .dark and .phone each added a
   class in the tour, so the cascade is the tour's own. */
/* What every look shares. The product's own tokens follow the look's, so a
   screen not yet drawn in the kit takes its ink, accent and surfaces
   wherever it reads a token. The exception for the New look ("brand", the
   last block of this sheet, which is not a look of the frame) sits inside
   :where(), so the rule weighs one attribute and More contrast
   (html…[data-contrast="more"], two) still sets its inks over any look.
   --fr-ground is the page under the frame: the wallpaper's own ground. */`;
  const shared = line(ANY, [
    ['--text-primary', 'var(--fr-ink)'], ['--text-secondary', 'var(--fr-mut)'], ['--text-muted', 'var(--fr-faint)'],
    ['--border', 'var(--fr-line)'], ['--border-light', 'var(--fr-line)'],
    ['--accent', 'var(--fr-acc)'], ['--accent-ink', 'var(--fr-acc-ink)'], ['--accent-tint-ink', 'var(--fr-acc)'],
    ['--lit-ink', 'var(--fr-lit)'], ['--lit-tint', 'var(--fr-lit-t)'], ['--lit-line', 'var(--fr-line)'],
    ['--dc-sheet', 'var(--fr-surface)'], ['--dc-sheet-solid', 'var(--fr-surface)'], ['--dc-sheet-raise', 'var(--fr-surface)'],
    ['--app-sheet-line', 'var(--fr-line)'],
  ]);
  const kit = compile(fs.readFileSync(path.join(SRC, 'kit.css'), 'utf8'), null);
  // The wallpaper's ground is set on <body> by the route rules, so the
  // frame's copy of it is read there too (on <html> it would not resolve).
  const ground = `${ANY} body{--fr-ground:var(--home-ground)}`;
  const blocks = config.order.map(lookBlock);
  return [head, shared, '/* ── THE KIT (any look) ── */', kit, ground, ...blocks, END].join('\n');
}

function main() {
  const css = fs.readFileSync(APP_CSS, 'utf8');
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  if (a < 0 || b < a) {
    console.error('build-looks-css: app.css has no looks:begin … looks:end section');
    process.exit(1);
  }
  const next = css.slice(0, a) + build() + css.slice(b + END.length);
  if (process.argv.includes('--check')) {
    if (next !== css) { console.error('build-looks-css: the section in app.css is stale; run node scripts/build-looks-css.js'); process.exit(1); }
    console.log('build-looks-css: app.css is current');
    return;
  }
  fs.writeFileSync(APP_CSS, next);
  console.log(`build-looks-css: wrote ${(build().length / 1024).toFixed(0)} KB for the kit and ${config.order.length} looks`);
}

if (require.main === module) main();

module.exports = { mapSelector, mapDeclaration, mapDeclarations, wornSelector, compile, build, config };
