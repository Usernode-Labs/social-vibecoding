// Every page bounces at its foot on a phone (#3566).
//
// ── The bug ────────────────────────────────────────────────────────────
//
// A scroller with no scroll range cannot rubber-band: the drag goes to the
// document, which the installed shell holds still on purpose, so neither end
// moves. When a page's content fits one screen, Home and the other page-like
// screens therefore stopped dead at their last line. The fix is one pixel of
// scrollable overflow, hung below the scroller's edge, on a coarse pointer
// and only where the screen root is itself the scroller.
//
// A project's growing tabs use the same mechanism (#3544); this suite holds
// the general rule and the list of screens that carry it.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/app.css');
const APP = read('public/js/app.js');

/** The opening tag whose text contains `at`, balanced through braces and quotes. */
function openingTagAt(src, at) {
  const start = src.lastIndexOf('<', at);
  assert.ok(start >= 0, 'expected an element around the id');
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
  }
  assert.fail('the opening tag never closed');
}

/** The body of the rule whose `{` is at or after `index`. */
function ruleBody(src, index) {
  assert.ok(index >= 0, 'expected a rule');
  const open = src.indexOf('{', index);
  assert.ok(open >= 0, 'expected a rule body');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail('the rule body never closed');
}

/** Every `.tsx` under frontend/src, as one searchable list of [file, source]. */
function tsxSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxSources(full, out);
    else if (entry.name.endsWith('.tsx')) out.push([path.relative(ROOT, full), fs.readFileSync(full, 'utf8')]);
  }
  return out;
}

const SOURCES = tsxSources(path.join(ROOT, 'frontend/src'));

/** The opening tag that renders `id`, searched across every frontend source. */
function rootTag(id) {
  for (const [file, src] of SOURCES) {
    const at = src.indexOf(`id="${id}"`);
    if (at >= 0) return { file, tag: openingTagAt(src, at) };
  }
  assert.fail(`no frontend source renders #${id}`);
}

const SCREEN_IDS = (() => {
  const m = APP.match(/SCREEN_IDS:\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'App.SCREEN_IDS is declared in public/js/app.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

// Roots that deliberately do not carry the attribute, and why.
const EXEMPT = new Map([
  ['app-view', 'a project page scrolls in #dev-forum-scroll, which #3544 already handles; Needs you and Discussion are fitted on purpose'],
  ['messages-screen', 'the root is overflow: hidden; the list inside it carries the attribute'],
  ['global-chat-screen', 'a chat: a transcript opens on its newest line and stays there'],
  ['agent-session-screen', 'a chat: a transcript opens on its newest line and stays there'],
]);

// ── The screens ────────────────────────────────────────────────────────

test('every screen root is a page that bounces, or says why it is not', () => {
  assert.ok(SCREEN_IDS.length > 0, 'the screen list was found');

  for (const [id, reason] of EXEMPT) {
    assert.ok(SCREEN_IDS.includes(id),
      `#${id} is exempt (${reason}) but is no longer a screen root — retire the exemption`);
  }

  for (const id of SCREEN_IDS) {
    if (EXEMPT.has(id)) continue;
    const { file, tag } = rootTag(id);
    assert.match(tag, /\bdata-page-bounce=""/,
      `#${id} in ${file} is a page that scrolls itself, so it must carry `
      + 'data-page-bounce="" — otherwise a short one stops dead at its last line');
  }
});

test('All communities and the Messages list carry the attribute', () => {
  const workshop = rootTag('workshop-screen').tag;
  assert.match(workshop, /id="workshop-screen"/);
  assert.match(workshop, /\bdata-page-bounce=""/, 'All communities is a page');

  // The Messages inbox's page scroller is the list inside #messages-screen,
  // whose root is overflow: hidden.
  for (const [file, src] of SOURCES) {
    const at = src.indexOf('className="messages-list-scroll');
    if (at < 0) continue;
    const tag = openingTagAt(src, at);
    assert.match(tag, /\bdata-page-bounce=""/,
      `the .messages-list-scroll div in ${file} is the Messages page scroller`);
    return;
  }
  assert.fail('no frontend source renders .messages-list-scroll');
});

// ── The pixel ──────────────────────────────────────────────────────────

test('the pixel is hung below the scroller, on a touch screen, only where the scroller is the page', () => {
  const start = CSS.indexOf('EVERY PAGE GIVES AT ITS FOOT');
  assert.ok(start > 0, 'the rule states its reason');
  const block = CSS.slice(start, CSS.indexOf('.touch-target-32', start));
  assert.match(block, /@media \(pointer: coarse\) \{/, 'a mouse cannot rubber-band');

  const rootAt = block.indexOf('html:not([data-browser-scroller]) [data-page-bounce] {');
  assert.ok(rootAt >= 0, 'the rule is scoped out of a phone browser, where the document pages');
  const root = ruleBody(block, rootAt);
  assert.match(root, /position:\s*relative/, 'the scroller is the ::after box\u2019s containing block');
  assert.doesNotMatch(root, /:has\(/, 'the main rule stays simple');

  const afterAt = block.indexOf('html:not([data-browser-scroller]) [data-page-bounce]::after {');
  assert.ok(afterAt >= 0, 'the pixel hangs below the scroller');
  const after = ruleBody(block, afterAt);
  assert.match(after, /bottom:\s*-1px/, 'one pixel below the scroller\u2019s bottom edge');
  assert.match(after, /height:\s*1px/);
  assert.match(after, /pointer-events:\s*none/, 'the pixel cannot be tapped');

  const exemptAt = block.indexOf('html:not([data-browser-scroller]) [data-page-bounce]:has(');
  assert.ok(exemptAt >= 0, 'the Needs you feed opts out');
  const exempt = ruleBody(block, exemptAt);
  assert.match(exempt, /content:\s*none/,
    'the Communities Needs you feed is fitted to the screen and scrolls inside itself');
});

test('the paged document keeps #3591\u2019s foot and none of this pixel', () => {
  const footAt = CSS.indexOf('html[data-browser-scroller][data-browser-past-top],');
  assert.ok(footAt >= 0, 'the paged document still takes contain past the top');
  assert.match(ruleBody(CSS, footAt), /overscroll-behavior-y:\s*contain/);

  assert.doesNotMatch(CSS, /html\[data-browser-scroller\][^{,]*\[data-page-bounce\]/,
    'a phone browser pages the screen, so the pixel would only lengthen the page');
});
