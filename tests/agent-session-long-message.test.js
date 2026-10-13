'use strict';

// "Show more" on a long message of yours, in an agent chat (#3558).
//
// The rule lives in frontend/src/features/agent-session/user-message.tsx and
// its header says why each part is the way it is. What is pinned here:
//
//   1. EIGHT LINES, MEASURED. A message folds only when the clamped box is
//      hiding something — the comment fold's own `overflowsClamp`, never a
//      character count — and the clamp is a complete literal Tailwind can see.
//   2. A SHORT MESSAGE IS UNCHANGED: the same bubble, no control, no fade.
//   3. FOLDED, the words fade and "Show more" sits in the faded line, inside
//      the bubble, taking no room (so a control that appears after the first
//      render moves nothing). OPEN, nothing is clamped and "Show less" has a
//      line of its own. Both are one real button with aria-expanded and a
//      data hook.
//   4. ONLY YOUR MESSAGES. The transcript's user rows and the outbox (what
//      you sent that the server has not shown back yet) fold; the Mayor's
//      replies do not.
//
// Run with: node --test tests/agent-session-long-message.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SRC = 'frontend/src/features/agent-session/user-message.tsx';
const source = read(SRC);
const panel = read('frontend/src/features/agent-session/index.tsx');
const mod = () => loadTsx(SRC);

// The bubble exactly as the transcript drew it before #3558, plus `relative`
// for the control that sits inside it.
const BUBBLE = 'relative max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100';
const FADE = '[mask-image:linear-gradient(to_bottom,#000_calc(100%-3em),transparent_calc(100%-1.5em))]';

const body = (props) => renderToHtml(createElement(mod().UserMessageBody, { text: 'hello\nthere', ...props }));

// ── 1. Eight lines, measured ───────────────────────────────────────────

test('eight lines, and the clamp and the fade are complete literals', () => {
  const { USER_CLAMP_LINES, USER_CLAMP_CLASS, USER_FADE_CLASS } = mod();
  assert.equal(USER_CLAMP_LINES, 8);
  // Tailwind's own clamp scale stops at six, so eight is the arbitrary
  // value; spelled out whole, because the extractor is a regex over source
  // text and an assembled name compiles to nothing.
  assert.equal(USER_CLAMP_CLASS, 'line-clamp-[8]');
  assert.match(source, /'line-clamp-\[8\]'/);
  assert.equal(USER_FADE_CLASS, FADE);
  assert.ok(source.includes(`'${FADE}'`), 'the fade is one literal in the source');
  // In the bubble's lines (1.5em): opaque through the sixth, faded across
  // the seventh, gone by the eighth, which is the row the control sits in.
  assert.match(FADE, /#000_calc\(100%-3em\),transparent_calc\(100%-1\.5em\)/);
});

test('the decision is the comment fold\'s measurement, before paint, and follows the width', () => {
  assert.match(source, /import \{ overflowsClamp \} from '\.\.\/dev-board\/comment-clamp';/,
    'one rule for "is this hiding anything", shared with the long-comment fold');
  assert.doesNotMatch(source, /text\.length|\.split\('\\n'\)/, 'never a character or newline count');
  const effect = source.slice(source.indexOf('useLayoutEffect(() => {'));
  // A layout effect: the fade can only go on a message that is long, and a
  // passive effect would paint a long message unfaded first.
  assert.match(effect, /^useLayoutEffect\(\(\) => \{[\s\S]*?if \(expanded\) return undefined;\s*const el = textRef\.current;\s*if \(!el\) return undefined;\s*const measure = \(\) => setOverflowing\(overflowsClamp\(el\)\);\s*measure\(\);/);
  assert.match(effect, /new ResizeObserver\(measure\);\s*obs\.observe\(el\);\s*return \(\) => obs\.disconnect\(\);\s*\}, \[expanded, text\]\);/,
    'a width change re-measures, and so do different words');
});

test('the control is the long-comment fold\'s button, not a new one', () => {
  const html = body({ expanded: false, overflowing: true });
  // variant="neutral" ink="neutral" size="xsText", as comment-clamp.tsx and
  // Browse's Show more draw it — the neutral fill, never the action blue.
  for (const cls of ['rounded-lg', 'bg-zinc-100', 'hover:bg-zinc-200', 'dark:bg-zinc-800',
    'px-3', 'py-1', 'text-xs', 'font-medium', 'text-zinc-900', 'dark:text-zinc-100']) {
    assert.ok(html.includes(cls), `the control carries ${cls}`);
  }
  assert.doesNotMatch(source, /\b(?:gray|indigo)-\d/);
});

// ── 2. A short message is unchanged ───────────────────────────────────

test('a message that fits renders as the same bubble, with no control and no fade', () => {
  const html = body({ expanded: false, overflowing: false });
  assert.equal(html, `<div class="${BUBBLE}"><p class="whitespace-pre-wrap line-clamp-[8]">hello\nthere</p></div>`);
  assert.doesNotMatch(html, /<button|Show more|mask-image/);
});

test('the first render clamps, and draws no control until the box is measured', () => {
  // renderToStaticMarkup runs no effect, which is exactly the first paint's
  // markup: the clamp is already on (a long message never paints at full
  // height), the control and the fade wait for the measurement.
  const html = renderToHtml(createElement(mod().UserMessage, { text: 'a long message. '.repeat(200) }));
  assert.match(html, /^<div class="relative max-w-\[85%\][^"]*"><p class="whitespace-pre-wrap line-clamp-\[8\]">/);
  assert.doesNotMatch(html, /<button|mask-image/);
});

// ── 3. Folded, and open ───────────────────────────────────────────────

test('folded: the words fade and "Show more" sits in the faded line, taking no room', () => {
  const html = body({ expanded: false, overflowing: true });
  assert.ok(html.includes(`<p class="whitespace-pre-wrap line-clamp-[8] ${FADE}">`));
  const button = html.match(/<button[^>]*>Show more<\/button>/);
  assert.ok(button, 'a real button');
  assert.match(button[0], /type="button"/);
  assert.match(button[0], /aria-expanded="false"/);
  assert.match(button[0], /data-agent-session-user-more="true"/);
  // Positioned inside the relative bubble, in its bottom corner: the bubble's
  // height is the clamp's, so the control appearing after the first render
  // cannot push the transcript off its bottom.
  assert.match(button[0], /class="[^"]*\btouch-target-32 absolute bottom-2 right-1"/);
  assert.ok(html.startsWith(`<div class="${BUBBLE}">`), 'inside the bubble, not under it');
  assert.ok(html.indexOf('</p>') < html.indexOf('<button'), 'after the text, so it is tabbed to after it');
});

test('open: nothing is clamped or faded, and "Show less" has a line of its own', () => {
  const html = body({ expanded: true, overflowing: true });
  assert.ok(html.includes('<p class="whitespace-pre-wrap">hello\nthere</p>'));
  assert.doesNotMatch(html, /line-clamp|mask-image/);
  const button = html.match(/<button[^>]*>Show less<\/button>/);
  assert.ok(button);
  assert.match(button[0], /aria-expanded="true"/);
  assert.match(button[0], /data-agent-session-user-more="true"/);
  assert.match(button[0], /class="[^"]*\btouch-target-32 -mb-0\.5 -mr-3 ml-auto mt-1 block"/);
  assert.doesNotMatch(button[0], /\babsolute\b/);
});

test('folding a message the reader opened brings it back into view', () => {
  // Read to its end, a long message's "Show less" is far below its top;
  // folding it shrinks the bubble, and the transcript would otherwise be
  // left showing whatever came after it.
  assert.match(source, /const toggle = \(\) => \{\s*if \(expanded\) folded\.current = true;\s*setExpanded\(!expanded\);\s*\};/);
  assert.match(source, /if \(expanded \|\| !folded\.current\) return;\s*folded\.current = false;\s*bubbleRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);\s*\}, \[expanded\]\);/,
    'only on a fold the reader asked for, and only as far as it takes');
});

test('the outbox keeps its sending fade on the bubble', () => {
  const html = body({ expanded: false, overflowing: false, className: 'opacity-80' });
  assert.ok(html.startsWith(`<div class="${BUBBLE} opacity-80">`));
});

// ── 4. Only your messages ─────────────────────────────────────────────

test('the transcript\'s user rows and the outbox fold; the Mayor\'s replies do not', () => {
  assert.match(panel, /import \{ UserMessage \} from '\.\/user-message';/);
  const user = panel.slice(panel.indexOf("    case 'user':"), panel.indexOf("    case 'mayor':"));
  assert.match(user, /data-agent-session-user>/, 'the row keeps its hook');
  assert.match(user, /\{item\.text \? <UserMessage text=\{item\.text\} \/> : null\}/);
  const outbox = panel.slice(panel.indexOf('function OutboxRows('), panel.indexOf('function LiveTurn('));
  assert.match(outbox, /<UserMessage text=\{item\.shown\} className=\{item\.status === 'sending' \? 'opacity-80' : ''\} \/>/,
    'drawn as the message it will be, so the server\'s row replaces it at the same height');
  // No hand-drawn copy of the bubble is left to drift from the folding one.
  assert.doesNotMatch(panel, /max-w-\[85%\] whitespace-pre-wrap rounded-2xl/);
  const mayor = panel.slice(panel.indexOf("    case 'mayor':"), panel.indexOf("    case 'divider':"));
  assert.doesNotMatch(mayor, /UserMessage|line-clamp/);
  const mayorText = panel.slice(panel.indexOf('const MayorText = memo('), panel.indexOf('function appInitial('));
  assert.ok(mayorText.length > 0);
  assert.doesNotMatch(mayorText, /UserMessage|line-clamp|mask-image/, 'a reply is drawn whole');
});
