'use strict';

// The hub's first card: what landed since your last visit, in a sentence or
// two (dev-board/workshop/since-summary-card.tsx). The server side, the
// windows and the cache, is pinned in tests/since-summary.test.js.
//
//   - it says nothing until its read answers, so the first render is empty
//     (the island rule: data loads in effects);
//   - the heading names the window's start in the viewer's own calendar;
//   - "AI summary" only when a model wrote the line;
//   - it is not a link, and the × hides it until something newer lands.
//
// Run with: node --test tests/since-summary-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/dev-board/workshop/since-summary-card.tsx';
const SRC = fs.readFileSync(path.join(__dirname, '..', CARD), 'utf8');
const LANDER = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

test('nothing is drawn before the read answers', () => {
  const { SinceSummaryCard } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(SinceSummaryCard, { slug: 'garden', since: Date.now() - 86400000 })), '');
  assert.match(SRC, /useEffect\(\(\) => \{\s*setData\(null\);/, 'the fetch runs in an effect');
  // A first visit has no last visit to be since: no request at all, unless a
  // staging demo link asked for the fixed line.
  assert.match(SRC, /if \(!since && !demo\) return undefined;/);
  assert.match(SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/since-summary\?\$\{q\}`/);
});

test('the heading names the window’s start the way a person would', () => {
  const { sinceLabel } = loadTsx(CARD);
  const now = new Date(2026, 8, 30, 15, 0).getTime(); // a Wednesday afternoon, local
  assert.equal(sinceLabel(new Date(2026, 8, 30, 6, 0).getTime(), now), 'Since earlier today');
  assert.equal(sinceLabel(new Date(2026, 8, 29, 18, 0).getTime(), now), 'Since yesterday');
  const monday = new Date(2026, 8, 28, 0, 0).getTime();
  assert.equal(sinceLabel(monday, now), `Since ${new Date(monday).toLocaleDateString(undefined, { weekday: 'long' })}`);
  const older = new Date(2026, 8, 12, 0, 0).getTime();
  assert.equal(sinceLabel(older, now), `Since ${new Date(older).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
});

test('the card says who wrote it, is not a link, and the × hides it until something newer lands', () => {
  // "AI summary" on a model's line only; three or fewer changes are their
  // own titles, which nobody needs told are titles.
  assert.match(SRC, /\{data\.state === 'ai' \? <span className="dev-ws-since-card-tag">\{t\('project:sinceSummary\.aiTag'\)\}<\/span> : null\}/);
  assert.equal(message('project:sinceSummary.aiTag'), 'AI summary');
  assert.match(SRC, /data-ws-since-summary-text="">\{data\.text\}/);
  assert.match(SRC, /data-ws-since-summary-list=""/);
  assert.doesNotMatch(SRC, /<a\b|href=/, 'not a link to the Workshop');
  // The ×: named for a screen reader, and remembered per device as the
  // newest change the dismissed line covered.
  assert.match(SRC, /aria-label=\{t\('project:sinceSummary\.dismiss'\)\}/);
  assert.equal(message('project:sinceSummary.dismiss'), 'Dismiss this summary');
  assert.match(SRC, /export const DISMISS_KEY = 'sinceSummaryDismissed';/);
  assert.match(SRC, /window\.localStorage\.setItem\(`\$\{DISMISS_KEY\}:\$\{slug\}`, String\(headAt\)\)/);
  assert.match(SRC, /if \(dismissed && data\.headAt <= dismissed\) return null;/, 'a newer head brings it back');
  // Storage can throw (private mode): the card still works for the page.
  assert.match(SRC, /catch \{ \/\* private mode: dismissed for this page only \*\/ \}/);
  // On the hub, first under the hero, measured from the viewer's last visit.
  // Its one way on is a button, not a link: Week by week, the Workshop page
  // (#852).
  assert.match(LANDER, /\{slug \? \(\s*<SinceSummaryCard slug=\{slug\} since=\{v\.since \? v\.since\.baseline : 0\} onMore=\{\(\) => openTab\('workshop'\)\} \/>\s*\) : null\}/);
  assert.match(SRC, /data-ws-since-summary-more="" onClick=\{onMore\}>\s*\{t\('project:sinceSummary\.weekByWeek'\)\}\s*<ChevronRightIcon className="w-3\.5 h-3\.5" aria-hidden="true" \/>/);
  assert.equal(message('project:sinceSummary.weekByWeek'), 'Week by week');
  // #3510: in the head's far corner with its arrow, like the Discussion
  // card's Open, and the × after it at the very end; the count and "AI
  // summary" moved under the line to make the room.
  const head = SRC.slice(SRC.indexOf('<div className="dev-ws-head">'), SRC.indexOf('data-ws-since-summary-text'));
  assert.ok(head.indexOf('<span className="dev-ws-hub-head-end">') >= 0
    && head.indexOf('<span className="dev-ws-hub-head-end">') < head.indexOf('data-ws-since-summary-more')
    && head.indexOf('data-ws-since-summary-more') < head.indexOf('data-ws-since-summary-dismiss'),
    'Week by week then the ×, together at the head\'s end');
  assert.ok(SRC.indexOf('className="dev-ws-since-card-tag"') > SRC.indexOf('data-ws-since-summary-list'), 'the AI tag under the text');
  assert.ok(SRC.indexOf('className="dev-ws-since-card-n"') > SRC.indexOf('data-ws-since-summary-list'), 'and the count with it');
  for (const cls of ['dev-ws-since-card', 'dev-ws-since-card-n', 'dev-ws-since-card-tag', 'dev-ws-since-card-foot', 'dev-ws-since-card-x', 'dev-ws-since-card-text', 'dev-ws-since-card-list']) {
    assert.match(CSS, new RegExp(`\\.${cls} \\{`), `.${cls} has a rule`);
  }
});
