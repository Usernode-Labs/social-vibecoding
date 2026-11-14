'use strict';

// #6199: the vote-type filter above Needs you, and the reopen that keeps a
// vote that decides in view.
//
// The server already marks each item that does not decide the outcome
// (withViewerDecides: `advisory`, `uncounted`) and puts the deciding ones
// first (decidingFirst). These helpers read those marks, narrow the feed and
// count each chip; the chips draw from the same primitive as the All
// communities filter. The executions below cover the helpers and the
// rendered chips; the feed hosts and the experimental run are pinned from
// source where they are held under effects that renderToStaticMarkup does
// not run.
//
// Run with: node --test tests/needs-vote-filter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const filter = loadTsx('frontend/src/features/workshop/vote-filter.tsx');
const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');

/** A feed item as GET /api/workshop/needs-feed serves it. */
const item = (over = {}) => ({
  kind: 'proposal', id: 1, title: 'Dark mode', summary: 'Adds a dark theme.',
  author: 'ada', number: 7, epoch: 3, at: null, yes: 1, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
  ...over,
});

// ── The kind ───────────────────────────────────────────────────────────

test('a vote is advisory when the feed marks it so, and decides otherwise', () => {
  assert.equal(filter.itemVoteType(item()), 'deciding', 'a plain change decides');
  assert.equal(filter.itemVoteType(item({ advisory: true })), 'advisory');
  assert.equal(filter.itemVoteType(item({ uncounted: true })), 'advisory', 'a test account\'s vote is grouped with advisory');
  assert.equal(filter.itemVoteType(item({ kind: 'governance' })), 'deciding', 'a group decision decides');
  assert.equal(filter.itemVoteType(item({ kind: 'ballot' })), 'deciding', 'a ballot decides');
  assert.equal(filter.itemVoteType(item({ kind: 'question' })), 'deciding', 'the bot\'s question decides');

  // A Needs you row gives the same answer from the flags on its Yes.
  assert.equal(filter.rowVoteType({ yes: { advisory: true } }), 'advisory');
  assert.equal(filter.rowVoteType({ yes: { uncounted: true } }), 'advisory');
  assert.equal(filter.rowVoteType({ yes: {} }), 'deciding');
  assert.equal(filter.rowVoteType({ yes: null }), 'deciding', 'a group decision has no Yes and no advisory mark');
  assert.equal(filter.rowVoteType({}), 'deciding');
});

test('filterByVoteType keeps the feed\'s order and returns the same list on All', () => {
  const list = [
    item({ id: 1 }),
    item({ id: 2, advisory: true }),
    item({ id: 3, kind: 'governance' }),
    item({ id: 4, uncounted: true }),
  ];
  assert.equal(filter.filterByVoteType(list, 'all', filter.itemVoteType), list, 'All copies nothing');
  assert.deepEqual(filter.filterByVoteType(list, 'deciding', filter.itemVoteType).map((it) => it.id), [1, 3]);
  assert.deepEqual(filter.filterByVoteType(list, 'advisory', filter.itemVoteType).map((it) => it.id), [2, 4]);
  assert.deepEqual(filter.voteTallies(list, filter.itemVoteType), { all: 4, deciding: 2, advisory: 2 });
});

// ── The chips ──────────────────────────────────────────────────────────

const noop = () => {};

test('the chips are All, Votes that decide and Advisory, their counts beside them', () => {
  const html = renderToHtml(createElement(filter.VoteTypeChips, {
    tallies: { all: 7, deciding: 1, advisory: 6 }, pressed: 'all', onPress: noop,
  }));
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Show votes"/);
  for (const key of ['all', 'deciding', 'advisory']) {
    assert.match(html, new RegExp(`data-needs-vote-chip="${key}"`));
  }
  // The words are the catalog's, and the count is in its own dimmed span.
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.all')}</span><span class="tabular-nums opacity-60" aria-hidden="true">7</span>`));
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.deciding')}</span><span class="tabular-nums opacity-60" aria-hidden="true">1</span>`));
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.advisory')}</span><span class="tabular-nums opacity-60" aria-hidden="true">6</span>`));
  // All is picked when the feed opens, and the accessible names carry the counts.
  assert.match(html, /aria-pressed="true"[^>]*data-needs-vote-chip="all"/);
  assert.match(html, /aria-label="All, 7 votes"/);
  assert.match(html, /aria-label="Votes that decide, 1 vote"/);
  assert.match(html, /aria-label="Advisory, 6 votes"/);
});

test('the chips are not drawn when the feed holds only one kind of vote', () => {
  const draw = (tallies) => renderToHtml(createElement(filter.VoteTypeChips, { tallies, pressed: 'all', onPress: noop }));
  assert.equal(draw({ all: 3, deciding: 3, advisory: 0 }), '', 'no advisory votes: nothing to choose between');
  assert.equal(draw({ all: 3, deciding: 0, advisory: 3 }), '', 'no deciding votes either');
  assert.equal(draw({ all: 0, deciding: 0, advisory: 0 }), '', 'an empty feed');
});


// ── The take-part rule on every owed-vote query (#6664) ────────────────

test('each owed-vote query asks the project\'s take-part rule, and leaves questions out', () => {
  const SRC = read('src/routes/workshop-overview.js');
  const region = (startMarker) => {
    const start = SRC.indexOf(startMarker);
    assert.ok(start >= 0, `${startMarker} is in the source`);
    const end = SRC.indexOf('`;', start);
    assert.ok(end > start, `${startMarker} is a template literal`);
    return SRC.slice(start, end + 2);
  };
  // The rule is checkAppAccess's 'collab' level, the one that refuses a vote:
  // an admin, a project that lets everyone take part, or a collaborator. The
  // `me` join is the viewer's accepted app_collaborators row.
  const rule = region('const CAN_TAKE_PART_SQL = ');
  assert.match(rule, /\$3::boolean OR a\.collab_visibility = 'public' OR me\.user_id IS NOT NULL/);

  const counts = region('const COUNTS_SQL = ');
  const items = region('const ITEMS_SQL = ');
  const feed = region('const needsFeedSql = ');
  const owed = region('const OWED_BY_COMMUNITY_SQL = ');
  for (const [name, sql] of [
    ['COUNTS_SQL', counts], ['ITEMS_SQL', items],
    ['needsFeedSql', feed], ['OWED_BY_COMMUNITY_SQL', owed],
  ]) {
    assert.match(sql, /\$\{CAN_TAKE_PART_SQL\}/, `${name} reads the take-part rule`);
  }

  // The bot's questions are the viewer's wherever they are: only the votes
  // are gated, so the chips' counts never include a vote they cannot cast.
  const needsExpr = counts.slice(counts.indexOf('SELECT a.slug,'), counts.indexOf('FROM apps a'));
  assert.equal((needsExpr.match(/CASE WHEN \$\{CAN_TAKE_PART_SQL\}/g) || []).length, 4,
    'the two vote counts and their two key arrays are gated');
  assert.ok(needsExpr.includes('COALESCE(oq.n, 0)) AS needs'), 'the question count is not gated');
  assert.ok(needsExpr.includes("COALESCE(oq.keys, '{}'::text[])) AS owed"), 'nor its keys');
  assert.match(feed, /o\.kind = 'question' OR \$\{CAN_TAKE_PART_SQL\}/);
  assert.match(owed, /o\.kind = 'question' OR \$\{CAN_TAKE_PART_SQL\}/);
  assert.match(items, /it\.kind = 'question'/);
});


// ── The project's own Needs you, and the experimental run ──────────────


test('the experimental run filters its run and draws the chips under its bar', () => {
  const SRC = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(SRC, /const \[filter, setFilter\] = useState<VoteFilter>\('all'\);/);
  assert.match(SRC, /const run = list \? filterByVoteType\(list, filter, reviewVoteType\) : \[\];/);
  assert.match(SRC, /const tallies = useMemo\(\(\) => voteTallies\(list \|\| \[\], reviewVoteType\), \[list\]\);/);
  // The press restarts the run at the first change of that kind with no vote
  // or skip yet, so it lands where there is still something to decide.
  assert.match(SRC, /const first = nextRun\.findIndex\(\(it\) => it\.kind !== 'governance' && !passed\[it\.key\]\);/);
  // Inside the bar, so the folded bar's measurement includes the chips; and
  // on the end card, so the other kind is one press away.
  const bar = SRC.slice(SRC.indexOf('className="rf-bar"'), SRC.indexOf('className="rf-desc-wrap"'));
  assert.match(bar, /<VoteTypeChips tallies=\{tallies\} pressed=\{filter\} onPress=\{pickFilter\} \/>/);
  assert.match(SRC, /filter !== 'all' \? <VoteTypeChips tallies=\{tallies\} pressed=\{filter\} onPress=\{pickFilter\} \/> : null/);
  assert.match(read('public/css/app.css'), /\.rf-bar \{ position: relative; z-index: 9; flex: none; display: flex; flex-wrap: wrap;/,
    'the chips wrap to a row under the title');
  assert.match(read('public/css/app.css'), /\.rf-bar \.needs-vote-chips \{ flex-basis: 100%; \}/);
});
