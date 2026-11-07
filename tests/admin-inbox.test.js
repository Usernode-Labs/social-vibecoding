// The admin console as an inbox (#6455): every duty is a queue.
//
// Pinned here:
//  - the queue helpers (admin-queues.ts): the address names the queue, items
//    come from the one /api/admin/overview payload, "Mark done for now" lives
//    in sessionStorage behind try/catch, and a zero count is still counted;
//  - the desktop sidebar is Queues first, then Browse (the #1152 grouped menu,
//    untouched), with a hidden-not-removed zero count, and public mode keeps
//    the bare section menu;
//  - the queue view (admin-overview.tsx) draws two panes with severity marks,
//    keeps the ids the declared checks select on, offers only navigation,
//    refreshes every 30 s only while the tab is visible, and has an Inbox
//    zero state;
//  - the search dialog (admin-search.tsx) matches labels and synonyms, offers
//    only what _visibleSections() allows, and listens only while the console
//    is open;
//  - the band's environment label reads /api/version's `env` and hides when
//    it is unknown.
//
// Run with: node --test tests/admin-inbox.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const overviewTsx = read('frontend/src/features/admin/admin-overview.tsx');
const searchTsx = read('frontend/src/features/admin/admin-search.tsx');
const islandTsx = read('frontend/src/features/admin/index.tsx');
const dapp = JSON.parse(read('dapp.json'));

const PORTAL_STUB = { mountLegacyPortal() {}, unmountLegacyPortal() {} };

function method(src, head) {
  const at = src.indexOf(head);
  assert.ok(at > -1, `${head.trim()} exists`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n  },\n'));
}

const PAYLOAD = {
  stuckApps: [{ slug: 'wedged-app', dbStatus: 'creating', createdBy: 'alice', createdAt: '2026-11-01T10:00:00Z' }],
  orphanWorkers: [{ name: 'worker-7', appSlug: 'recipebot', uptimeSeconds: 7200, sessionArchived: true }],
  llmToday: { totalSpendCents: 1234, users: [{ username: 'small', costCents: 34 }, { username: 'big', costCents: 1200 }, { username: 'zero', costCents: 0 }] },
};

test('the queue helpers read the address, the payload and the session', () => {
  const q = loadTsx('frontend/src/features/admin/admin-queues.ts');
  assert.deepEqual([...q.QUEUE_KEYS], ['all', 'stuck', 'orphans', 'spenders']);
  assert.equal(q.queueFromHash('#admin/overview/stuck'), 'stuck');
  assert.equal(q.queueFromHash('#admin/overview/orphans?x=1'), 'orphans');
  assert.equal(q.queueFromHash('#admin/overview/nonsense'), 'all');
  assert.equal(q.queueFromHash('#admin'), 'all');

  const none = new Set();
  const all = q.queueItems(PAYLOAD, 'all', none);
  assert.deepEqual(all.map((i) => i.id), ['app:wedged-app', 'worker:worker-7', 'spend:big', 'spend:small'],
    'broken first, spenders by cost, a zero spender is not an item');
  assert.deepEqual(all.map((i) => i.severity), ['broken', 'broken', 'info', 'info']);
  assert.deepEqual(q.queueCounts(PAYLOAD, none), { all: 4, stuck: 1, orphans: 1, spenders: 2 });
  assert.equal(q.queueCounts(null, none), null, 'nothing loaded is not zero');

  const done = new Set(['worker:worker-7']);
  assert.deepEqual(q.queueItems(PAYLOAD, 'orphans', done), [], 'a marked item leaves its queue');
  assert.equal(q.queueCounts(PAYLOAD, done).all, 3);

  assert.equal(q.nextIndex(1, 3), 1, 'the next item takes the finished one\'s place');
  assert.equal(q.nextIndex(3, 3), 2, 'the last one hands back to the one before');
  assert.equal(q.nextIndex(0, 0), -1, 'an empty queue selects nothing');
  assert.equal(q.dollars(1234), '$12.34');

  const src = read('frontend/src/features/admin/admin-queues.ts');
  assert.match(src, /DONE_KEY = 'admin_queue_done_v1'/);
  assert.match(src, /window\.sessionStorage/, 'mark done lasts for this browser session only');
  for (const fn of ['loadDone', 'saveDone', 'storage']) {
    assert.match(method(src, `function ${fn}(`), /try \{[\s\S]*\} catch/, `${fn} cannot throw mid-render`);
  }
  assert.equal(q.loadDone().size, 0, 'no storage in Node: nothing marked done, no throw');
});

test('the sidebar is Queues first, then Browse, with counts from the one read', () => {
  const sidebar = method(consoleJs, '  _sidebarHtml() {');
  assert.match(sidebar, /if \(AdminConsole\._publicMode\(\)\) return AdminConsole\._navItemsHtml\(\);/,
    'a non-admin on a public section gets the two sections and no queues');
  assert.ok(sidebar.indexOf('_queuesHtml()') < sidebar.indexOf('Browse')
    && sidebar.indexOf('Browse') < sidebar.lastIndexOf('_navItemsHtml()'), 'Queues, then Browse');

  const shell = method(consoleJs, '  _renderShell() {');
  assert.match(shell, /sideHost\.innerHTML = AdminConsole\._sidebarHtml\(\);/);
  assert.match(shell, /_wireQueueButtons\(sideHost\)/);

  const queues = method(consoleJs, '  _queuesHtml() {');
  assert.match(queues, /queueCounts\(AdminConsole\._queueData, loadDone\(\)\)/);
  assert.match(queues, /data-admin-queue="\$\{q\.key\}"/);
  assert.match(queues, /data-admin-queue-count="\$\{q\.key\}" class="\$\{n \? '' : 'hidden '\}/,
    'a zero count is hidden and kept in the DOM');
  assert.match(queues, /AdminUI\.badge\.destructive/, 'broken queues count in red');

  const fetchFn = method(consoleJs, '  _fetchQueueData() {');
  assert.match(fetchFn, /fetchJson\('\/api\/admin\/overview'\)/, 'the one existing read, no new endpoint');
  assert.match(fetchFn, /if \(AdminConsole\._queueFetch\) return AdminConsole\._queueFetch;/,
    'the console and the section share one request');

  const openQueue = method(consoleJs, '  _openQueue(queue) {');
  assert.match(openQueue, /`#admin\/overview\/\$\{queue\}`/);
  assert.match(openQueue, /location\.hash = target/, 'a phone drill-in is a real navigation, so back works');
  assert.match(openQueue, /history\.replaceState/, 'a desktop switch replaces the address');

  // #1152 rides along untouched: the grouped Browse menu is the same builder.
  assert.match(method(consoleJs, '  _navItemsHtml() {'), /_groupToggleHtml\(g\.name, domId, collapsed,/);
});

test('the queue view keeps the declared ids and draws two panes', () => {
  global.window = {};
  global.location = { hash: '#admin/overview/all' };
  try {
    const mod = loadTsx('frontend/src/features/admin/admin-overview.tsx', {
      stubs: { '../../lib/legacy-portals': PORTAL_STUB },
    });
    // The bundle carries the chassis, which publishes window.AdminConsole as
    // it evaluates; the payload is set on that one.
    const chassis = global.window.AdminConsole;
    assert.ok(chassis, 'the chassis published itself');
    chassis._queueData = PAYLOAD;
    const html = renderToHtml(createElement(mod.QueueView));
    for (const id of ['admin-queue-view', 'admin-overview-stuck', 'admin-overview-orphan', 'admin-overview-llm',
      'admin-refresh-overview', 'admin-queue-list', 'admin-queue-detail']) {
      assert.ok(html.includes(`id="${id}"`), `the view renders #${id}`);
    }
    assert.match(html, /data-admin-queue-view="all"/);
    assert.match(html, /data-queue-item="app:wedged-app" data-severity="broken"/);
    assert.match(html, /data-queue-item="spend:big" data-severity="info"/);
    assert.match(html, />Broken</);
    assert.match(html, /data-queue-action="apps"/, 'a stuck app opens Apps &amp; usage');
    assert.match(html, /Mark done for now/);
    assert.ok(!/<a\b/.test(html), 'no anchors: actions are navigation buttons, never an API URL');

    global.location = { hash: '#admin/overview/orphans' };
    const worker = renderToHtml(createElement(mod.QueueView));
    assert.match(worker, /data-queue-action="status"/, 'an orphan worker opens Health &amp; status');
    assert.match(worker, /session archived/);

    global.location = { hash: '#admin/overview/spenders' };
    const spend = renderToHtml(createElement(mod.QueueView));
    assert.match(spend, /data-queue-action="model-costs"[\s\S]*data-queue-action="limits"/);

    chassis._queueData = { stuckApps: [], orphanWorkers: [], llmToday: { totalSpendCents: 0, users: [] } };
    global.location = { hash: '#admin/overview/all' };
    const empty = renderToHtml(createElement(mod.QueueView));
    assert.match(empty, /id="admin-queue-empty"/);
    assert.match(empty, /Inbox zero/);
    assert.match(empty, /id="admin-overview-stuck"[^>]*>0</, 'the header count still says 0');

    chassis._queueData = PAYLOAD;
    const card = renderToHtml(createElement(mod.QueuesCard));
    assert.match(card, /id="admin-mobile-queues"/);
    assert.match(card, /data-admin-queue="all"[\s\S]*?>4</, 'the phone card counts Needs you');
    assert.match(card, /min-h-\[44px\]/, 'phone rows meet the tap floor');
  } finally {
    delete global.window;
    delete global.location;
  }
});

test('the queue view refreshes only while mounted and visible, and keys only outside fields', () => {
  assert.match(overviewTsx, /const REFRESH_MS = 30_000;/);
  assert.match(overviewTsx, /setInterval\(\(\) => \{ if \(!document\.hidden\) load\(\); \}, REFRESH_MS\)/);
  assert.match(overviewTsx, /return \(\) => \{ clearInterval\(timer\); document\.removeEventListener\('visibilitychange', onVisible\); \};/,
    'unmounting (destroy) clears the timer');
  assert.match(overviewTsx, /const UNDO_MS = 5_000;/);
  assert.match(overviewTsx, /isTypingTarget\(e\.target\) \|\| dialogShowing\(document\)/);
  assert.match(overviewTsx, /c\._isMobile\(\)\) return;/, 'keyboard on desktop only');
  for (const key of ["e.key === 'j'", "e.key === 'k'", "e.key === 'Enter'", "e.key === 'x'"]) {
    assert.ok(overviewTsx.includes(key), `${key} is handled`);
  }
  assert.match(overviewTsx, /destroy\(\) \{\s*unmountLegacyPortal\(host\);/);
  assert.ok(!/canWrite|fetch\(|method: 'POST'/.test(overviewTsx), 'the view writes nothing to the server');
  assert.doesNotMatch(overviewTsx, /@\/components\/ui/);
});

test('search matches labels and synonyms, and listens only while the console is open', () => {
  const mod = loadTsx('frontend/src/features/admin/admin-search.tsx', {
    stubs: { '../../lib/legacy-portals': PORTAL_STUB },
  });
  const entries = [
    { kind: 'queue', key: 'stuck', label: 'Stuck apps' },
    { kind: 'section', key: 'model-costs', label: 'Model costs', group: 'Platform' },
    { kind: 'section', key: 'mail', label: 'Email delivery', group: 'Platform' },
    { kind: 'section', key: 'incidents', label: 'Unexpected events', group: 'Operations' },
    { kind: 'section', key: 'reports', label: 'Moderation', group: 'People' },
    { kind: 'section', key: 'db-export', label: 'Database export', group: 'Platform' },
    { kind: 'section', key: 'limits', label: 'Limits', group: 'People' },
  ];
  const first = (q) => mod.searchMatches(entries, q)[0]?.key;
  for (const word of ['spend', 'llm', 'budget']) assert.equal(first(word), 'model-costs', word);
  assert.equal(first('bounce'), 'mail');
  assert.equal(first('mail'), 'mail');
  assert.equal(first('errors'), 'incidents');
  assert.equal(first('abuse'), 'reports');
  assert.equal(first('reports'), 'reports');
  assert.equal(first('backup'), 'db-export');
  assert.equal(first('stuck'), 'stuck', 'queues are searchable');
  assert.equal(first('lim'), 'limits', 'a label match beats a synonym');
  assert.equal(mod.searchMatches(entries, '').length, entries.length);
  assert.deepEqual(mod.searchMatches(entries, 'zzz'), []);

  assert.equal(mod.isSearchKey({ key: 'k', ctrlKey: true }), true);
  assert.equal(mod.isSearchKey({ key: 'K', metaKey: true }), true);
  assert.equal(mod.isSearchKey({ key: 'k', ctrlKey: true, shiftKey: true }), false);
  assert.equal(mod.isSearchKey({ key: 'k' }), false);

  // What it lists is the console's to decide, and the console decides by
  // what this viewer may open.
  const entriesFn = method(consoleJs, '  searchEntries() {');
  assert.match(entriesFn, /_visibleSections\(\)/);
  assert.match(entriesFn, /_publicMode\(\) \? \[\]/, 'no queues for a non-admin');
  // Navigation through the chassis: setSection on desktop, the drill-in on a phone.
  assert.match(method(consoleJs, '  go(key) {'),
    /if \(AdminConsole\._isMobile\(\)\) AdminConsole\._openSection\(key\);\s*else AdminConsole\.setSection\(key\);/);
  // Listening is bounded by the console being open.
  assert.match(method(consoleJs, '  _openInbox() {'), /_searchHooks\?\.attach\?\.\(\)/);
  assert.match(method(consoleJs, '  _closeInbox() {'), /_searchHooks\?\.detach\?\.\(\)/);
  assert.match(method(consoleJs, '  close() {'), /_closeInbox\(\)/);
  assert.match(method(consoleJs, '  open(section, opts) {'), /_openInbox\(\)/);
  assert.match(searchTsx, /document\.removeEventListener\('keydown', onKey\)/);
  assert.match(searchTsx, /if \(!c \|\| !c\._open \|\| e\.defaultPrevented \|\| !isSearchKey\(e\)\) return;/);
  assert.match(searchTsx, /e\.key === 'Escape'/);
  assert.match(searchTsx, /back\?\.focus\?\.\(\)/, 'focus returns to where it was');
  assert.match(searchTsx, /aria-modal="true"/);

  assert.match(islandTsx, /<div id="admin-search-host"><\/div>/, 'the dialog host ships empty');
  assert.match(islandTsx, /id="admin-search-open"[\s\S]*?onClick=\{\(\) => openSearch\(\)\}/, 'a visible Search button');
});

test('the band names the environment from /api/version, hidden when unknown', () => {
  assert.match(islandTsx, /<span id="admin-env-label" className="hidden /);
  const paint = method(consoleJs, '  async _paintEnv() {');
  assert.match(paint, /App\._lastVersionInfo/, 'reuses the shell\'s last /api/version answer');
  assert.match(paint, /fetchJson\('\/api\/version'\)/);
  assert.match(paint, /'production' \? 'Production'/);
  assert.match(paint, /'staging' \? 'Staging' : ''/);
  assert.match(paint, /el\.classList\.toggle\('hidden', !label\)/);
});

test('dapp.json checks the queues sidebar and the queue view', () => {
  const declared = dapp.tests || [];
  const view = declared.find((t) => t.path === '/#admin/overview/all');
  assert.ok(view, 'the queue view has a declared check at its address');
  assert.match(view.expectSelector, /#admin-queue-view\[data-admin-queue-view="all"\] #admin-overview-stuck/);
  const page = declared.find((t) => t.path === '/#admin');
  assert.match(page.expectSelector, /\[data-admin-queues\] \[data-admin-queue="all"\]/,
    'the console check also asserts the Queues block, folded in rather than declared again');
});
