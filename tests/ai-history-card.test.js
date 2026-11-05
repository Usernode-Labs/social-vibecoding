'use strict';

// The Homeroom bot tab as the desk for your work (5 Nov 2026): its project
// filter in its address, and the History card below Live this week.
//
// What this pins:
//   1. The filter is the address's (frontend/src/features/ai/filter-address.ts):
//      #homeroom-bot?project=<slug> narrows the lists to a project, and
//      #homeroom-bot/history?kind=<kind> opens History on one kind; the
//      query rides along on any of the tab's places.
//   2. A project picked that no list names is still a chip, and Needs you
//      says there is nothing of yours in it rather than showing every project.
//   3. History groups by month, then by project, in quiet rows whose right
//      word says how each thing ended; a community you left says so; its
//      chips pick a kind; Earlier months reads the next page.
//   4. A change of your own that waits on your fix is Needs you's, Fix it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ADDRESS = 'frontend/src/features/ai/filter-address.ts';
const HISTORY = 'frontend/src/features/ai/history.ts';
const MODEL = 'frontend/src/features/ai/model.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';
const ROOT = path.join(__dirname, '..');

const garden = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const club = { slug: 'book-swap', name: 'Book swap', icon_url: null, icon_emoji: null };

function lists(extra = {}) {
  return renderComponent(LISTS, 'AiLists', {
    hero: null,
    main: { open() {}, lit: false, unread: 0 },
    ready: true,
    owed: 0,
    rows: [],
    progress: [],
    waiting: [],
    live: [],
    openRow() {},
    openThread() {},
    ...extra,
  });
}

function historyState(rows, extra = {}) {
  return { rows, next: null, ready: true, loading: false, failed: false, more() {}, retry() {}, ...extra };
}

test('the filter is the address\'s: projects and History\'s kind ride on any of the tab\'s places', () => {
  const a = loadTsx(ADDRESS);
  assert.deepEqual(a.projectsOf('#homeroom-bot?project=garden'), ['garden']);
  assert.deepEqual(a.projectsOf('#homeroom-bot/main?project=garden,book-swap&project=garden'), ['garden', 'book-swap'], 'once each, in order');
  assert.deepEqual(a.projectsOf('#homeroom-bot?project=<script>'), [], 'never anything but a slug');
  assert.deepEqual(a.projectsOf('#app/garden?project=garden'), [], 'only the tab\'s own addresses');
  assert.equal(a.kindOf('#homeroom-bot/history?kind=vote'), 'vote');
  assert.equal(a.kindOf('#homeroom-bot/history?kind=everything'), null);
  assert.equal(a.historyAsked('#homeroom-bot/history'), true);
  assert.equal(a.historyAsked('#homeroom-bot/history?kind=change'), true);
  assert.equal(a.historyAsked('#homeroom-bot/main'), false);
  assert.equal(a.withFilter('#homeroom-bot/main', { projects: ['garden'] }), '#homeroom-bot/main?project=garden');
  assert.equal(a.withFilter('#homeroom-bot/thread/7?project=old', { projects: [] }), '#homeroom-bot/thread/7', 'All is the bare address');
  assert.equal(a.withFilter('#homeroom-bot', { projects: ['a', 'b'], kind: 'solo' }), '#homeroom-bot?project=a,b&kind=solo');
  assert.equal(a.projectTabAddress('garden'), '#homeroom-bot?project=garden');
  assert.equal(a.historyAddress('request'), '#homeroom-bot/history?kind=request');
  assert.equal(a.historyAddress(), '#homeroom-bot/history');
  // The router reads the path before the query (public/js/app.js), and the
  // tab's place parsers split it off too, so every place still parses.
  const door = loadTsx('frontend/src/features/ai/door.ts');
  assert.deepEqual(door.botTabAt('#homeroom-bot/thread/12?project=garden'), { threadRootId: 12, focusMessageId: null });
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /const fragQuery = qIdx === -1 \? '' : rawHash\.slice\(qIdx \+ 1\);/);
});

test('a project a link picked is a chip even when no list names it, and Needs you says nothing of yours is there', () => {
  const html = lists({ picked: ['garden'], appFor: (slug) => (slug === 'garden' ? garden : null), history: historyState([]) });
  assert.match(html, /data-ai-chip="garden"/, 'its chip');
  assert.match(html, new RegExp(message('messages:ai.filter.emptyProject', { project: 'Garden club' })));
  assert.match(html, /data-ai-empty="project"/);
  const all = lists({ history: historyState([]) });
  assert.doesNotMatch(all, /data-ai-empty="project"/, 'with nothing picked, the plain empty line');
  assert.match(all, new RegExp(message('messages:ai.work.empty')));
});

test('History: by month, then by project, quiet rows that say how each thing ended', () => {
  const h = loadTsx(HISTORY);
  const rows = [
    { key: 'thread:1', threadId: 1, number: 392, title: 'Watering reminders', app: garden, href: '#app/garden/dev/issues/392', at: '2026-10-24T12:00:00Z', kind: 'change', outcome: 'live', by: 'bot' },
    { key: 'thread:2', threadId: 2, number: 380, title: 'Sign in with a code', app: garden, href: '#app/garden/dev/issues/380', at: '2026-10-20T12:00:00Z', kind: 'change', outcome: 'closed', by: 'you' },
    { key: 'thread:3', threadId: 3, number: null, title: 'A new card picture', app: garden, href: '#app/garden/dev/governance/3', at: '2026-10-18T12:00:00Z', kind: 'vote', outcome: 'passed', decision: true, myVote: 'yes' },
    { key: 'thread:4', threadId: 4, number: 31, title: 'Swap requests', app: club, href: '#app/book-swap/dev/issues/31', at: '2026-10-03T12:00:00Z', kind: 'change', outcome: 'live', left: true },
    { key: 'private:5', rootId: 5, number: null, title: 'Ideas for a seed swap', app: null, href: null, at: '2026-09-10T12:00:00Z', kind: 'solo', outcome: 'done' },
  ];
  assert.deepEqual(h.byMonth(rows).map((m) => [m.key, m.rows.length]), [['2026-10', 4], ['2026-09', 1]]);
  assert.deepEqual(h.historyWords(rows[2]), { id: 'messages:ai.history.yesPassed' });
  assert.equal(h.historyWords(rows[0], 'en-US').id, 'messages:ai.history.live');
  assert.match(String(h.historyWords(rows[0], 'en-US').values.date), /Oct/);
  assert.deepEqual(h.historyWords({ ...rows[4], outcome: 'filed_shipped', resultRef: 74 }), { id: 'messages:ai.history.filedShipped', values: { number: 74 } });
  assert.deepEqual(h.historyTooltip(rows[1]), { id: 'messages:ai.row.where', values: { project: 'Garden club', number: 380 } });
  assert.deepEqual(h.historyTooltip({ ...rows[1], change: true, app: { ...garden, changesOnGithub: true } }),
    { id: 'messages:ai.history.wherePr', values: { project: 'Garden club', number: 380 } }, 'a change on GitHub is PR N');
  assert.equal(h.historyPath({ projects: ['garden'], kind: 'vote', before: '2026-10-01T00:00:00.000Z' }),
    '/api/ai/history?project=garden&kind=vote&before=2026-10-01T00%3A00%3A00.000Z');
  assert.equal(h.historyPath({ projects: ['a', 'b'], kind: null }), '/api/ai/history', 'several projects: the card narrows them');

  const html = lists({ history: historyState(rows, { next: '2026-09-10T12:00:00.000Z' }), historyKind: null });
  assert.match(html, /data-ai-sheet="history"/);
  assert.match(html, new RegExp(message('messages:ai.history.title')));
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('data-ai-sheet="live"') === -1 || at('data-ai-sheet="live"') < at('data-ai-sheet="history"'), 'below Live this week');
  assert.ok(at('data-ai-history-month="2026-10"') < at('data-ai-history-month="2026-09"'), 'newest month first');
  assert.match(html, /data-ai-line="history-change"/);
  assert.match(html, new RegExp(message('messages:ai.history.yesPassed')));
  assert.match(html, new RegExp(message('messages:ai.history.closed')));
  assert.match(html, new RegExp(`· ${message('messages:ai.history.left')}`), 'a community you left says so');
  assert.match(html, /data-ai-history-more=""/, 'Earlier months while there is more');
  for (const kind of ['all', 'change', 'request', 'vote', 'solo']) assert.match(html, new RegExp(`data-ai-history-kind="${kind}"`));
  // Narrowed by the chips above, as every list is.
  const narrowed = lists({ history: historyState(rows), picked: ['book-swap'], appFor: () => club });
  assert.match(narrowed, /Swap requests/);
  assert.doesNotMatch(narrowed, /Watering reminders/);
  // Nothing finished: it says so; a read that failed says that, with Try again.
  assert.match(lists({ history: historyState([]) }), /data-ai-history-empty=""/);
  assert.match(lists({ history: historyState([], { failed: true }) }), /data-ai-history-failed=""/);
  // Until it is read, two bars and no words.
  assert.match(lists({ history: historyState([], { ready: false }) }), /data-ai-history-loading=""/);
});

test('History\'s projects join the filter, after the ones with work under way', () => {
  const { withProjects, rankProjects } = loadTsx(MODEL);
  const ranked = withProjects(rankProjects([], [{ app: garden }], [], []), [club, garden, null]);
  assert.deepEqual(ranked.map((p) => p.app.slug), ['garden', 'book-swap']);
  assert.deepEqual([ranked[1].needs, ranked[1].progress, ranked[1].waiting, ranked[1].live], [0, 0, 0, 0]);
});

test('a change of your own that waits on your fix is Needs you\'s, with Fix it', () => {
  const { needsYou, whyOf } = loadTsx(MODEL);
  const rows = needsYou([], {
    private: [],
    needs: [{ threadId: 9, number: 51, kind: 'work', title: 'Frost alerts', app: garden, change: { id: 3, number: 52 }, href: '#app/garden/dev/issues/51', group: 'needs', what: 'fix_yours', at: null }],
    next: [], waiting: [], live: [],
  });
  assert.equal(rows[0].key, 'fix_yours:9');
  assert.deepEqual(rows[0].pill, { id: 'messages:ai.pill.fixIt' });
  assert.equal(rows[0].sub.id, 'messages:ai.row.fixYours');
  assert.deepEqual(whyOf(rows[0]), { id: 'messages:ai.why.fixYours' });
  const html = lists({ rows, owed: 1 });
  assert.match(html, new RegExp(message('messages:ai.pill.fixIt')));
  // And a finished filed thread is History's, not a Needs you row.
  const filed = needsYou([], { private: [{ rootId: 4, title: 'Sourdough timer', kind: 'draft_request', app: garden, at: null, state: 'filed', resultRef: 74, resultDone: true }], needs: [], next: [], waiting: [], live: [] });
  assert.deepEqual(filed, []);
});
