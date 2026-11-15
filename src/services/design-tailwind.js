'use strict';

// #6681: an app styled by Homeroom's hosted Tailwind runtime (a <script>
// src, with an inline tailwind.config) draws unstyled in a design. The
// preview has no network and a plan drops scripts, so the runtime never
// runs: every utility class in markup copied from the app does nothing, and
// a header icon sized only by w-5 h-5 stretches to fill the panel.
//
// This module is what the design bot uses instead: it recognises the
// runtime and its inline settings (tailwindRuntime), compiles the utilities
// the drawn markup uses with those settings (compileFor), pulls the markup
// an app's own scripts build out of their string literals (scriptMarkup),
// and checks a version's classes against the styles it was given
// (styleGaps). Nothing here evaluates app code: the config is parsed as a
// literal, and a value that is not one is left out.

const log = require('./logger');

const PLATFORM_PLACEHOLDER = '__USERNODE_PLATFORM_ORIGIN__';
// The app's own <style type="text/tailwindcss"> (@layer, @apply), capped.
const MAX_RUNTIME_CSS = 50_000;
// A compiled sheet is a Homeroom-owned <style> block, at the size its
// siblings cap at (design-bot.js MAX_SHEET_CHARS).
const MAX_COMPILED_CHARS = 200_000;
// The markup a first drawing's prompt gives from the app's scripts.
const SCRIPT_MARKUP_CHARS = 24_000;
// A version with at least this many distinct classes is checked, and fails
// when more than half of them match no selector.
const MIN_CLASSES_TO_CHECK = 8;

/** Pure: a platform-hosted asset's path from any form of its href, or null. */
function platformAssetPath(href) {
  let path = String(href || '').trim();
  if (!path) return null;
  if (path.startsWith(PLATFORM_PLACEHOLDER)) path = path.slice(PLATFORM_PLACEHOLDER.length);
  else if (/^https?:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { return null; }
  } else if (path.startsWith('//')) return null; // another site, no scheme
  path = path.split(/[?#]/)[0];
  return path.startsWith('/usernode-native/') || path.startsWith('/usernode-tailwind/') ? path : null;
}

/** Pure: the value of a tag's attribute, quoted or not. */
function attr(tag, name) {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  if (quoted) return quoted[1];
  return new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag)?.[1] || '';
}

/** Pure: the document without its comments, so a commented-out tag is not read as loaded. */
function withoutComments(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Pure: the app's hosted Tailwind runtime on this page, as { config, css },
 * or null. `config` is the object after `tailwind.config =` (a literal; a
 * value that is not one is left out), `css` the text of the page's own
 * `<style type="text/tailwindcss">` blocks. The old cdn.tailwindcss.com tag
 * counts too, as the spec treats apps on it the same.
 */
function tailwindRuntime(html) {
  const doc = withoutComments(html);
  let found = false;
  for (const [tag] of doc.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(tag, 'src');
    if (!src) continue;
    const asset = platformAssetPath(src);
    if ((asset && asset.startsWith('/usernode-tailwind/')) || /^(?:https?:)?\/\/cdn\.tailwindcss\.com(?:\/|$)/i.test(src)) {
      found = true;
      break;
    }
  }
  if (!found) return null;
  const config = configIn(doc) || {};
  delete config.plugins;
  delete config.content;
  return { config, css: runtimeCss(doc).slice(0, MAX_RUNTIME_CSS) };
}

/** Pure: the object after `tailwind.config =`, parsed as a literal, or null. */
function configIn(doc) {
  const at = /\btailwind\s*\.\s*config\s*=\s*/g.exec(doc);
  if (!at) return null;
  const start = doc.indexOf('{', at.index + at[0].length);
  if (start < 0) return null;
  const body = balanced(doc, start);
  if (!body) return null;
  const parsed = parseLiteral(body);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** Pure: the text from `start` (a brace) through its matching brace, or null. */
function balanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (!depth) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pure: a JS literal parsed without evaluating it. Objects, arrays, quoted
 * strings, template strings with no `${}`, numbers, booleans, null, bare or
 * quoted keys, comments and trailing commas are taken; a property whose value
 * is not a literal is dropped. Null when the text is not one.
 */
function parseLiteral(text) {
  const p = { s: String(text || ''), i: 0 };
  const value = parseValue(p);
  return value.ok ? value.value : null;
}

function skipSpace(p) {
  for (;;) {
    while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i += 1;
    if (p.s[p.i] === '/' && p.s[p.i + 1] === '/') {
      const at = p.s.indexOf('\n', p.i);
      p.i = at < 0 ? p.s.length : at + 1;
      continue;
    }
    if (p.s[p.i] === '/' && p.s[p.i + 1] === '*') {
      const at = p.s.indexOf('*/', p.i + 2);
      p.i = at < 0 ? p.s.length : at + 2;
      continue;
    }
    return;
  }
}

/** Read a value; on something that is not a literal, advance past it. */
function parseValue(p) {
  skipSpace(p);
  const c = p.s[p.i];
  if (c === '{') return parseObject(p);
  if (c === '[') return parseArray(p);
  if (c === '"' || c === "'") return parseQuoted(p, c);
  if (c === '`') return parseTemplate(p);
  const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(p.s.slice(p.i));
  if (number) { p.i += number[0].length; return { ok: true, value: Number(number[0]) }; }
  const word = /^[A-Za-z_$][\w$]*/.exec(p.s.slice(p.i));
  if (word) {
    p.i += word[0].length;
    if (word[0] === 'true') return { ok: true, value: true };
    if (word[0] === 'false') return { ok: true, value: false };
    if (word[0] === 'null' || word[0] === 'undefined') return { ok: true, value: null };
    skipPastValue(p);
    return { ok: false };
  }
  skipPastValue(p);
  return { ok: false };
}

/** Skip whatever value is at the cursor, to the next top-level comma or closer. */
function skipPastValue(p) {
  let depth = 0;
  let quote = null;
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (quote) {
      if (c === '\\') p.i += 1;
      else if (c === quote) quote = null;
      p.i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; p.i += 1; continue; }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      if (!depth) return;
      depth -= 1;
    } else if (c === ',' && !depth) return;
    p.i += 1;
  }
}

function parseQuoted(p, quote) {
  p.i += 1;
  let out = '';
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '\\') {
      const next = p.s[p.i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
      p.i += 2;
      continue;
    }
    p.i += 1;
    if (c === quote) return { ok: true, value: out };
    out += c;
  }
  return { ok: false };
}

function parseTemplate(p) {
  p.i += 1;
  let out = '';
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === '\\') { out += p.s[p.i + 1] ?? ''; p.i += 2; continue; }
    if (c === '`') { p.i += 1; return { ok: true, value: out }; }
    if (c === '$' && p.s[p.i + 1] === '{') { skipPastValue(p); return { ok: false }; }
    out += c;
    p.i += 1;
  }
  return { ok: false };
}

function parseObject(p) {
  p.i += 1;
  const out = {};
  for (;;) {
    skipSpace(p);
    if (p.s[p.i] === '}') { p.i += 1; return { ok: true, value: out }; }
    let key;
    if (p.s[p.i] === '"' || p.s[p.i] === "'") {
      const quoted = parseQuoted(p, p.s[p.i]);
      if (!quoted.ok) return { ok: false };
      key = quoted.value;
    } else {
      const bare = /^[\w$-]+/.exec(p.s.slice(p.i));
      if (!bare) return { ok: false };
      key = bare[0];
      p.i += bare[0].length;
    }
    skipSpace(p);
    if (p.s[p.i] !== ':') return { ok: false };
    p.i += 1;
    const value = parseValue(p);
    if (value.ok) out[key] = value.value;
    skipSpace(p);
    if (p.s[p.i] === ',') { p.i += 1; continue; }
    if (p.s[p.i] === '}') { p.i += 1; return { ok: true, value: out }; }
    return { ok: false };
  }
}

function parseArray(p) {
  p.i += 1;
  const out = [];
  for (;;) {
    skipSpace(p);
    if (p.s[p.i] === ']') { p.i += 1; return { ok: true, value: out }; }
    const value = parseValue(p);
    if (value.ok) out.push(value.value);
    skipSpace(p);
    if (p.s[p.i] === ',') { p.i += 1; continue; }
    if (p.s[p.i] === ']') { p.i += 1; return { ok: true, value: out }; }
    return { ok: false };
  }
}

/** Pure: the text of the page's <style type="text/tailwindcss"> blocks. */
function runtimeCss(doc) {
  const out = [];
  for (const [block, attrs, css] of String(doc).matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    if (/\btype\s*=\s*["']?text\/tailwindcss/i.test(attrs)) out.push(css);
  }
  return out.join('\n');
}

/** The postcss tailwindcss itself depends on, so no new dependency is declared. */
function postcssOf() {
  const path = require('node:path');
  const tailwindPackage = require.resolve('tailwindcss/package.json');
  const postcssPath = require.resolve('postcss', { paths: [path.dirname(tailwindPackage)] });
  return require(postcssPath);
}

/** One compile with the app's settings, or null. Never throws. */
async function compile(input, config, markup) {
  try {
    const postcss = postcssOf();
    const tailwind = require('tailwindcss');
    const settings = {
      ...(config && typeof config === 'object' ? config : {}),
      content: [{ raw: String(markup || ''), extension: 'html' }],
    };
    delete settings.plugins;
    const result = await postcss([tailwind(settings)]).process(input, { from: undefined });
    const css = String(result.css || '');
    if (!css.trim()) return null;
    return css.length > MAX_COMPILED_CHARS ? css.slice(0, MAX_COMPILED_CHARS) : css;
  } catch (err) {
    log.info('design-tailwind', 'A drawing\'s Tailwind could not be compiled', { err: String(err?.message || err).slice(0, 200) });
    return null;
  }
}

/**
 * The CSS the drawn markup needs, compiled with the app's own settings, or
 * null when it cannot be compiled. Never throws.
 */
async function compileFor(markup, runtime) {
  if (!runtime) return null;
  const input = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${runtime.css || ''}`;
  const compiled = await compile(input, runtime.config, markup);
  if (compiled != null) return compiled;
  // The app's own @layer/@apply blocks may be what fails: retry without them.
  if (!runtime.css) return null;
  return compile('@tailwind base;\n@tailwind components;\n@tailwind utilities;', runtime.config, markup);
}

/** Pure: the markup a drawing's utilities are compiled from: its body, scripts and styles left out. */
function drawingMarkup(html) {
  let doc = String(html || '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  doc = doc.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const body = /<body\b([^>]*)>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(doc);
  if (body) return body[2];
  return doc.replace(/<\/?(?:!doctype|html|head|body)\b[^>]*>/gi, '');
}

/**
 * Pure: the string and template literals in a script that contain an HTML
 * tag with a class attribute, in source order, deduplicated. These are the
 * markup the script builds.
 */
function scriptMarkup(js) {
  const out = [];
  const text = String(js || '');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const at = text.indexOf('\n', i);
      i = at < 0 ? text.length : at + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const at = text.indexOf('*/', i + 2);
      i = at < 0 ? text.length : at + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const { value, end } = readString(text, i, c);
      if (end < 0) break;
      if (looksLikeMarkup(value) && !out.includes(value)) out.push(value);
      i = end;
      continue;
    }
    if (c === '`') {
      const { value, end, dynamic } = readTemplate(text, i);
      if (end < 0) break;
      // A template with ${} is markup split by its values: keep the literal
      // parts around each hole, so a card built from them still shows.
      if (dynamic) {
        for (const part of value) if (looksLikeMarkup(part) && !out.includes(part)) out.push(part);
      } else if (looksLikeMarkup(value) && !out.includes(value)) out.push(value);
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

function readString(text, start, quote) {
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
    if (c === quote) return { value: out, end: i + 1 };
    if (c === '\n') return { value: out, end: i };
    out += c;
    i += 1;
  }
  return { value: out, end: -1 };
}

function readTemplate(text, start) {
  let i = start + 1;
  const parts = [];
  let out = '';
  let dynamic = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
    if (c === '`') { parts.push(out); return { value: dynamic ? parts : out, end: i + 1, dynamic }; }
    if (c === '$' && text[i + 1] === '{') {
      dynamic = true;
      parts.push(out);
      out = '';
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return { value: parts, end: -1, dynamic: true };
}

/** Pure: whether a literal reads as markup with a class attribute. */
function looksLikeMarkup(value) {
  const text = String(value || '');
  return /<[a-z][\w-]*\b[^>]*\bclass\s*=/i.test(text);
}

/** Pure: a CSS class selector, unescaped, from a run of CSS. */
function selectorClasses(css) {
  const out = new Set();
  for (const m of String(css || '').matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
    out.add(m[1].replace(/\\([\s\S])/g, '$1'));
  }
  return out;
}

/**
 * Pure: how a version's styling stands against the styles it was given:
 * `{ unmatched, total, unsizedSvgs }`. `linkedCss` is the text of the
 * stylesheets its links point at (the kit, app.css, a compiled Tailwind).
 */
function styleGaps(html, { linkedCss = '' } = {}) {
  // A script's own strings are not markup the screen draws.
  const doc = String(html || '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const used = new Set();
  for (const m of doc.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)) {
    for (const name of m[1].split(/\s+/)) if (name) used.add(name);
  }
  const ownCss = [...doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join('\n');
  const known = selectorClasses(`${ownCss}\n${linkedCss}`);
  const unmatched = [...used].filter((name) => !known.has(name));
  // An svg with no width/height of its own, no class that could size it, and
  // no rule for svg itself stretches to fill its box. A rule for an svg
  // inside one component (app.css has plenty: `.messages-send svg`) does not
  // size this icon, so only a selector whose subject is the svg counts.
  let unsizedSvgs = 0;
  const css = `${ownCss}\n${linkedCss}`;
  const genericSvgRule = sizesEverySvg(css);
  for (const [tag] of doc.matchAll(/<svg\b[^>]*>/gi)) {
    const hasSize = /\b(?:width|height)\s*=\s*["']?[\d.]+/i.test(tag) || /\bstyle\s*=\s*["'][^"']*\b(?:width|height)\s*:/i.test(tag);
    if (hasSize) continue;
    const classes = attr(tag, 'class').split(/\s+/).filter(Boolean);
    if (classes.some((name) => known.has(name))) continue;
    if (genericSvgRule) continue;
    unsizedSvgs += 1;
  }
  return { unmatched, total: used.size, unsizedSvgs };
}

/** Pure: whether a rule sizes every svg (a selector `svg` itself sets a width or height). */
function sizesEverySvg(css) {
  for (const rule of String(css || '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(?:^|;)\s*(?:width|height)\s*:/i.test(rule[2])) continue;
    const selectors = rule[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ').toLowerCase());
    if (selectors.includes('svg')) return true;
  }
  return false;
}

/** Pure: whether a version's styling is broken enough to send back once. */
function styleFails({ unmatched = [], total = 0, unsizedSvgs = 0 } = {}) {
  return unsizedSvgs > 0 || (total >= MIN_CLASSES_TO_CHECK && unmatched.length > total / 2);
}

module.exports = {
  PLATFORM_PLACEHOLDER,
  MAX_RUNTIME_CSS,
  MAX_COMPILED_CHARS,
  SCRIPT_MARKUP_CHARS,
  MIN_CLASSES_TO_CHECK,
  platformAssetPath,
  tailwindRuntime,
  configIn,
  parseLiteral,
  compileFor,
  drawingMarkup,
  scriptMarkup,
  styleGaps,
  styleFails,
};
