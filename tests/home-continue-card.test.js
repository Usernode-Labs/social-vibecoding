// Home's "Continue where you left off" card (#4025, the plan's Continue card):
// one row, the change the viewer worked on last, or nothing at all.
//
// Run with: node --test tests/home-continue-card.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');
const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CARD = 'frontend/src/features/home/continue-card.tsx';
const SOURCE = read(CARD);

const { ContinueCard, ContinueCardView, pickContinueRow, CONTINUE_WINDOW_MS } = loadTsx(CARD);

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const row = (id, ago, extra = {}) => ({
  key: `s${id}`,
  kind: 'session',
  id,
  appSlug: 'recipes',
  appName: 'Recipe Box',
  icon: { kind: 'letter', letter: 'R' },
  title: `Change ${id}`,
  href: `#app/recipes/dev/proposals/${id}`,
  status: null,
  busy: false,
  awaitingInput: false,
  sessionStatus: 'active',
  sortAt: NOW - ago,
  lastActivityAt: new Date(NOW - ago).toISOString(),
  ...extra,
});

test('the row is the most recently touched change, wherever the list holds it', () => {
  const picked = pickContinueRow([row(1, 5 * HOUR), row(2, HOUR), row(3, 3 * HOUR)], NOW);
  assert.equal(picked.id, 2);
});

test('a busy change does not outrank one touched later', () => {
  const picked = pickContinueRow([row(1, 5 * HOUR, { busy: true }), row(2, HOUR)], NOW);
  assert.equal(picked.id, 2);
});

test('only changes in the last 7 days count', () => {
  assert.equal(pickContinueRow([row(1, CONTINUE_WINDOW_MS - HOUR)], NOW).id, 1);
  assert.equal(pickContinueRow([row(1, CONTINUE_WINDOW_MS + HOUR)], NOW), null);
  assert.equal(pickContinueRow([row(1, 0, { sortAt: 0 })], NOW), null);
});

test('a work order is skipped: there is no conversation here to go back into', () => {
  const task = row(9, 60 * 1000, { kind: 'task', sessionStatus: undefined });
  assert.equal(pickContinueRow([task, row(1, HOUR)], NOW).id, 1);
  assert.equal(pickContinueRow([task], NOW), null);
});

test('a merging or merged change is skipped, though the list carries it for Messages', () => {
  const merged = row(7, 60 * 1000, { sessionStatus: 'merged' });
  const merging = row(8, 60 * 1000, { sessionStatus: 'merging' });
  assert.equal(pickContinueRow([merged, merging, row(1, HOUR)], NOW).id, 1);
  assert.equal(pickContinueRow([merged, merging], NOW), null);
});

test('a change up for a vote or paused is still one to continue', () => {
  assert.equal(pickContinueRow([row(1, HOUR, { sessionStatus: 'promoted' })], NOW).id, 1);
  assert.equal(pickContinueRow([row(1, HOUR, { sessionStatus: 'paused' })], NOW).id, 1);
});

test('nothing to continue is no row', () => {
  assert.equal(pickContinueRow([], NOW), null);
});

test('the first render is nothing at all, so hydration has nothing to disagree with', () => {
  assert.equal(renderToHtml(createElement(ContinueCard)), '');
});

test('the card is the heading and the bell\'s own row, opening the change', () => {
  const html = renderToHtml(createElement(ContinueCardView, { row: row(42, HOUR) }));
  const heading = message('home:continue.heading');
  assert.equal(heading, 'Continue where you left off');
  assert.ok(html.includes(`aria-label="${heading}"`), html);
  assert.match(html, /<h2 class="home-area-label/);
  assert.ok(html.includes(`>${heading}</span>`), html);
  assert.ok(html.includes('href="#app/recipes/dev/proposals/42"'), html);
  assert.ok(html.includes('data-improve-row="session"'), html);
  assert.ok(html.includes('Change 42'), html);
  assert.ok(html.includes('Recipe Box'), html, 'the row names the app');
  assert.match(html, /rounded-\[20px\]/);
  assert.doesNotMatch(html, /\bmx-4\b/, 'the card lines up with the section around it');
});

test('the list is asked for in an effect, when signed in on a verified session', () => {
  const effect = SOURCE.slice(SOURCE.indexOf('useEffect(() => {'), SOURCE.indexOf('}, [onHome]);'));
  assert.ok(effect.includes('if (!onHome) return undefined;'));
  assert.match(effect, /if \(!app\?\.user \|\| app\._sessionFromSnapshot\) return;/);
  assert.match(effect, /Improve\?\.loadSessions\?\.\(\)/);
  assert.match(effect, /addEventListener\('sv:session', ask\)/);
  assert.match(effect, /removeEventListener\('sv:session', ask\)/);
  assert.match(SOURCE, /if \(!sessionsLoaded \|\| !viewer \|\| view === 'search'\) return null;/);
});

test('it sits above My apps, under the widget strip', () => {
  const index = read('frontend/src/features/home/index.tsx');
  const strip = index.indexOf('<WidgetStrip />');
  const card = index.indexOf('<ContinueCard />');
  const apps = index.indexOf('<section id="home-apps-section"');
  assert.ok(strip > 0 && strip < card && card < apps);
});

test('the staging demo has a change to show, so /?demo=1#home draws the card', () => {
  const { stagingMockOwnSessions } = require('../src/routes/sessions');
  const now = Date.now();
  const rows = stagingMockOwnSessions(1, 'homeroom').map((s) => ({
    kind: 'session',
    id: s.id,
    sessionStatus: s.status,
    sortAt: Date.parse(s.last_activity_at || s.created_at),
  }));
  const picked = pickContinueRow(rows, now);
  assert.ok(picked, 'a demo row qualifies');
  assert.notEqual(picked.sessionStatus, 'merged');
});
