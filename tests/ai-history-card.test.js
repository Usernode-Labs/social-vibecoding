'use strict';

// The Homeroom bot tab as the desk for your work (5 Nov 2026): its project
// filter in its address, and History. 24 Nov 2026 (the three bands): History
// is no card of its own; Done is the whole past, this week's rows and then
// History's.
//
// What this pins:
//   1. The filter is the address's (frontend/src/features/ai/filter-address.ts):
//      #homeroom-bot?project=<slug> narrows the lists to a project, and
//      #homeroom-bot/history?kind=<kind> opens Done into History on one
//      kind; the query rides along on any of the tab's places.
//   2. A project picked that no list names is still named by the project
//      filter, and Needs you says there is nothing of yours in it rather
//      than showing every project.
//   3. Done runs on into History with no month headings: a tick for what
//      went live, History's word for anything else; a community you left
//      says so; its kind chips show once it is opened; Show more reads on.
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

test('a project a link picked is named by the filter even when no list names it, and Needs you says nothing of yours is there', () => {
  const html = lists({ picked: ['garden'], appFor: (slug) => (slug === 'garden' ? garden : null), history: historyState([]) });
  assert.match(html, /<button[^>]*data-ai-project-more=""[^>]*data-ai-picked="garden"[^>]*>[\s\S]*?Garden club[\s\S]*?<\/button>/, 'the filter says the project');
  assert.match(html, new RegExp(message('messages:ai.filter.emptyProject', { project: 'Garden club' })));
  assert.match(html, /data-ai-empty="project"/);
  const all = lists({ history: historyState([]) });
  assert.doesNotMatch(all, /data-ai-empty="project"/, 'with nothing picked, the band\'s own line');
  assert.match(all, /data-ai-empty=""[^>]*>[\s\S]*?<strong[^>]*>Nothing needs you\.<\/strong>/, 'nothing needs you, and nothing is in progress either');
  assert.match(all, new RegExp(message('messages:ai.filter.allProjects')), 'with nothing picked, All projects');
});

test('History: Done runs on into it, quiet rows that say how each thing ended (24 Nov 2026: no months)', () => {
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
  // 13 Nov 2026: a private thread about a change ends as its change did,
  // still drawn as a private thread.
  const aboutLive = { ...rows[4], app: garden, outcome: 'live' };
  assert.equal(h.historyWords(aboutLive, 'en-US').id, 'messages:ai.history.live');
  assert.deepEqual(h.historyWords({ ...aboutLive, outcome: 'closed' }), { id: 'messages:ai.history.closed' });
  assert.equal(h.historyGlyph(aboutLive), 'private');
  const { privatePastOf } = require('../src/services/ai-history');
  const past = (extra) => privatePastOf({ root_id: 5, state: 'open', kind: 'ask', about_kind: 'change', about_number: 52, about_title: 'Frost alerts', at: '2026-10-24T12:00:00Z', ...extra });
  assert.deepEqual([past({ about_outcome: 'live' }).outcome, past({ about_outcome: 'closed' }).outcome], ['live', 'closed']);
  assert.deepEqual({ kind: past({ about_outcome: 'live' }).kind, title: past({ about_outcome: 'live' }).title, rootId: past({ about_outcome: 'live' }).rootId },
    { kind: 'solo', title: 'Frost alerts', rootId: 5 }, 'named by its change, opening the thread');
  assert.equal(past({ state: 'done', about_outcome: null }).outcome, 'done', 'one marked done says so');
  assert.deepEqual(h.historyTooltip(rows[1]), { id: 'messages:ai.row.where', values: { project: 'Garden club', number: 380 } });
  assert.deepEqual(h.historyTooltip({ ...rows[1], change: true, app: { ...garden, changesOnGithub: true } }),
    { id: 'messages:ai.history.wherePr', values: { project: 'Garden club', number: 380 } }, 'a change on GitHub is PR N');
  assert.equal(h.historyPath({ projects: ['garden'], kind: 'vote', before: '2026-10-01T00:00:00.000Z' }),
    '/api/ai/history?project=garden&kind=vote&before=2026-10-01T00%3A00%3A00.000Z');
  assert.equal(h.historyPath({ projects: ['a', 'b'], kind: null }), '/api/ai/history', 'several projects: the card narrows them');

  // 24 Nov 2026: Done is the whole past. History's rows run on under this
  // week's in the one band, with no card and no month headings of their own.
  const html = lists({ history: historyState(rows, { next: '2026-09-10T12:00:00.000Z' }), historyKind: null, doneOpen: 1 });
  assert.doesNotMatch(html, /data-ai-sheet="history"|data-ai-history-month/, 'no History card, no months');
  assert.doesNotMatch(html, new RegExp(`>${message('messages:ai.history.title')}<`), 'History is no heading');
  assert.match(html, /data-ai-sheet="live"[\s\S]*data-ai-line="history-change"/, 'in Done');
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('Watering reminders') < at('Sign in with a code') && at('Sign in with a code') < at('Swap requests'), 'newest first');
  // What went live ends in a tick and says when; anything else in History's word.
  const row = (title) => html.slice(html.lastIndexOf('<button', at(title)), html.indexOf('</button>', at(title)));
  assert.match(row('Watering reminders'), /data-ai-row-end="tick"/);
  assert.match(row('Watering reminders'), new RegExp(message('messages:ai.done.wentLive', { day: 'Oct 24' })));
  assert.match(row('Sign in with a code'), new RegExp(`data-ai-row-end="word">${message('messages:ai.history.closed')}<`));
  assert.doesNotMatch(row('Sign in with a code'), /data-ai-row-end="tick"/, 'a closed thing has no tick');
  assert.match(row('A new card picture'), new RegExp(message('messages:ai.history.yesPassed')));
  assert.match(row('Swap requests'), new RegExp(`· ${message('messages:ai.history.left')}`), 'a community you left says so');
  assert.match(html, /data-ai-history-more=""/, 'Show more while there is more');
  assert.match(html, new RegExp(`data-ai-history-more="">${message('messages:ai.band.showMore')}`), 'with no count');
  for (const kind of ['all', 'change', 'request', 'vote', 'solo']) assert.match(html, new RegExp(`data-ai-history-kind="${kind}"`));
  // At rest, five rows and no kind chips; they come once Show more is pressed
  // (or an address picks a kind).
  const rest = lists({ history: historyState(rows, { next: '2026-09-10T12:00:00.000Z' }) });
  assert.doesNotMatch(rest, /data-ai-history-kinds/, 'no kind chips at rest');
  assert.match(lists({ history: historyState(rows), historyKind: 'change' }), /data-ai-history-kind="change" aria-pressed="true"|aria-pressed="true"[^>]*data-ai-history-kind="change"/, 'a kind picked shows them');
  // #7059: the kind chips ride the shared fading rail (chip.tsx's FadeRail,
  // under an alias), and each stays on one line.
  const src = fs.readFileSync(path.join(ROOT, LISTS), 'utf8');
  assert.match(src, /import \{[^}]*FadeRail as KindRail[^}]*\} from '@\/components\/ui\/chip';/, 'the shared fading rail, under an alias');
  assert.match(src, /<KindRail role="group" aria-label=\{t\('messages:ai\.history\.kind\.label'\)\} className="gap-1\.5 px-1\.5 pt-2 pb-1" data-ai-history-kinds="">/);
  assert.match(html, /role="group"[^>]*data-ai-history-kinds=""/, 'the rail still reads as the filters\' group');
  for (const kind of ['all', 'change', 'request', 'vote', 'solo']) {
    assert.match(html, new RegExp(`class="[^"]*whitespace-nowrap[^"]*"[^>]*data-ai-history-kind="${kind}"`), `${kind}'s chip never wraps`);
  }
  // A kind narrows the whole of Done: this week's rows too.
  const week = [{ threadId: 70, number: 70, kind: 'request', title: 'Frost alerts', app: garden, change: null, href: '#app/garden/dev/issues/70', group: 'live', work: { stage: 'live', why: null, reason: null, line: null, since: null }, at: new Date().toISOString() }];
  assert.match(lists({ live: week, history: historyState(rows), historyKind: 'change' }), /Frost alerts/, 'what went live this week is a change');
  assert.doesNotMatch(lists({ live: week, history: historyState(rows), historyKind: 'vote' }), /Frost alerts/, 'and is no vote');
  // A thread both lists carry is shown once.
  const twice = lists({ live: [{ ...week[0], threadId: 1 }], history: historyState(rows) });
  assert.equal((twice.match(/data-ai-line="history-change"[^>]*>[\s\S]{0,1200}?Watering reminders/g) || []).length, 0, 'History\'s copy of a thread this week shows gives way');
  // Narrowed by the project filter, as every band is.
  const narrowed = lists({ history: historyState(rows), picked: ['book-swap'], appFor: () => club });
  assert.match(narrowed, /Swap requests/);
  assert.doesNotMatch(narrowed, /Watering reminders/);
  // Nothing finished: it says so; a read that failed says that, with Try again.
  assert.match(lists({ history: historyState([]) }), /data-ai-history-empty=""/);
  assert.match(lists({ history: historyState([], { failed: true }) }), /data-ai-history-failed=""/);
  // Until it is read, two bars where its rows will be.
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
    needs: [{ threadId: 9, number: 51, kind: 'work', title: 'Frost alerts', app: garden, change: { id: 3, number: 52 }, href: '#app/garden/dev/issues/51', group: 'needs', work: { stage: 'checking', why: null, reason: null, line: { code: 'checks_failing' }, since: null }, fixYours: true, at: null }],
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
