'use strict';

// The hub's Top contributors card (request 6837,
// frontend/src/features/dev-board/workshop/hub-cards.tsx ContributorsCard):
// the people who took part most in a project, by name and a count in words.
// The hub is not a dashboard, so there is no chart, rank number or medal:
// the order is the ranking, nobody is listed at zero, and there is no card
// until two people have taken part. The counting is pinned against a real
// database in tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hub = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');

const person = (id, username, n) => ({ id, username, display_name: null, n });
const card = (contributors) => renderToHtml(createElement(hub.ContributorsCard, {
  data: contributors === undefined ? null : { slug: 'geneva-hikes', contributors },
}));
const rows = (html) => [...html.matchAll(/data-ws-contributor="([^"]+)"/g)].map((m) => m[1]);
const pressed = (html, span) => new RegExp(`data-ws-contrib-span="${span}"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-ws-contrib-span="${span}"`).test(html);

test('no card until two people have taken part, or without the list', () => {
  assert.equal(card(undefined), '');
  assert.equal(card(null), '');
  assert.equal(card({ month: [], all_time: [] }), '');
  assert.equal(card({ month: [person(1, 'evan', 4)], all_time: [person(1, 'evan', 9)] }), '', 'a list of one is no list');
});

test('it opens on This month: a face, a name and a count in words for each person', () => {
  const html = card({
    month: [person(1, 'snait', 14), person(2, 'evan', 1)],
    all_time: [person(2, 'evan', 40), person(1, 'snait', 30), person(3, 'drea', 2)],
  });
  assert.match(html, /<section class="dev-ws-hub-section" data-ws-hub-contributors="month"/);
  assert.ok(html.includes(message('project:hub.contributors.title')));
  assert.equal(message('project:hub.contributors.title'), 'Top contributors');
  assert.ok(pressed(html, 'month') && !pressed(html, 'all'));
  assert.deepEqual(rows(html), ['snait', 'evan'], "the server's order, this month's people only");
  assert.ok(html.includes('>14 contributions<'));
  assert.ok(html.includes('>1 contribution<'), 'one is said in the singular');
  assert.match(html, /class="dev-ws-hero-face dev-ws-contrib-face"[^>]*aria-hidden="true"[^>]*>S</);
  // Rows are read, not pressed: no button, no link, no chevron.
  const body = html.slice(html.indexOf('dev-ws-strip'));
  assert.doesNotMatch(body, /<button|<a |ui-lrow-go/);
  // No rank numbers, medals or charts.
  assert.doesNotMatch(html, /<svg|<ol|#1|1st/);
});

test('with nobody yet this month it opens on All time', () => {
  const html = card({ month: [], all_time: [person(2, 'evan', 40), person(1, 'snait', 30)] });
  assert.match(html, /data-ws-hub-contributors="all"/);
  assert.ok(pressed(html, 'all') && !pressed(html, 'month'));
  assert.deepEqual(rows(html), ['evan', 'snait']);
  assert.ok(!html.includes(message('project:hub.contributors.emptyMonth')));
});

test('the switch is two labelled buttons, and an empty month has its own line', () => {
  const src = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const fn = src.slice(src.indexOf('export function ContributorsCard'), src.indexOf('/* ── The hub while it loads'));
  assert.match(fn, /role="group" aria-label=\{t\('project:hub\.contributors\.span'\)\}/);
  assert.match(fn, /data-ws-contrib-span="month" aria-pressed=\{span === 'month'\} onClick=\{\(\) => setPicked\('month'\)\}/);
  assert.match(fn, /data-ws-contrib-span="all" aria-pressed=\{span === 'all'\} onClick=\{\(\) => setPicked\('all'\)\}/);
  assert.match(fn, /data-ws-contrib-none="">\{t\('project:hub\.contributors\.emptyMonth'\)\}/);
  assert.equal(message('project:hub.contributors.month'), 'This month');
  assert.equal(message('project:hub.contributors.allTime'), 'All time');
  assert.equal(message('project:hub.contributors.emptyMonth'), 'Nobody has taken part yet this month.');
});

test('the hub mounts it last in its thin column, after Recently live, and the route sends the list best-effort', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const topics = lander.indexOf('<TopicsCard data={community}');
  const mine = lander.indexOf('<ContributorsCard data={community} />');
  const versions = lander.indexOf('<FromVersionsCard slug={slug}');
  const recent = lander.indexOf('<RecentlyLive slug={slug}');
  // 26 Nov 2026 (the owner's two-column hub): For you, Recently live, then Top contributors, one under another.
  assert.ok(topics > 0 && topics < versions && versions < recent && recent < mine, 'For you, then Recently live, then Top contributors');
  const route = read('src/routes/apps.js');
  const handler = route.slice(route.indexOf("router.get('/api/apps/:slug/community'"));
  const at = handler.indexOf('let contributors = null;');
  assert.ok(at > 0);
  const block = handler.slice(at, at + 400);
  assert.match(block, /try \{\s+contributors = await communities\.contributorsSummary\(pool, app\.id\);\s+\} catch \(err\) \{\s+log\.warn\('apps', 'Could not read contributors'/);
  assert.match(handler.slice(0, handler.indexOf('res.json(') + 4000), /\n\s+activity,\n\s+contributors,\n/);
});

test('the standard look puts it last, across the hub', () => {
  const css = read('public/css/app.css');
  // The older two-column placement (under For you, beside Topics) lost to the look's own grid and was removed
  // with the hub's 1080px width (24 Nov 2026), so nothing places it there any more.
  const base = 'html:root .dev-ws[data-ws-tab="status"] > .dev-ws-tabbody > [data-ws-hub-for-you] + [data-ws-hub-topics]';
  assert.ok(!css.includes(`${base} + [data-ws-hub-contributors] { grid-column: 1; }`));
  // The look's hub rules are scoped `html:root` since the standard look took the brand kit's hub (#6923).
  // 26 Nov 2026: the hub's parts sit in its thin column (.dev-ws-hub-side), so the look reaches them inside the page's body.
  assert.ok(css.includes('html:root #dev-workshop .dev-ws[data-ws-tab="status"] > .dev-ws-tabbody [data-ws-hub-contributors] { order: 5; }'));
  // The count is the hub's muted count, never a pill.
  assert.match(css, /\.dev-ws-foryou-count \{[^}]*color: var\(--text-muted\)/);
});
