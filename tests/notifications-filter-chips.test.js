'use strict';

// The bell's filter chips: Votes, Merges, Mentions, Kudos.
//
// The notification sheet holds one flat list, and on a busy account the row
// you came for sits buried under every other kind — which is what the
// reporter ("everything is in one list … hard to find my own stuff") asked
// to have fixed. The answer is four kind-group chips on the Unread and All
// tabs, a narrowing on top of the tabs rather than new tabs, and — because a
// client-side filter over the shared feed cannot page (the Messages tab
// learned that before) — a named kind group the server's `?kind=<group>`
// answers, so the All tab's pager under a chip brings back rows you can see.
//
// Pinned here, in the style of tests/notifications-messages-tab.test.js:
//
//   1. the server's named groups (services/notifications.js
//      NOTIFICATION_KIND_GROUPS) hold the kinds the rows and the routing
//      already cluster, and the client's mirror cannot drift from them;
//   2. `rowView` stamps each row with the group it answers (the same
//      flag-not-re-derivation pattern the Messages tab's `conversation`
//      flag uses), and stamps nothing for a row outside the four;
//   3. the sheet's chips are single-select, clear when the sheet closes,
//      render on the Unread and All tabs only, and their filtered empty
//      state names the chip;
//   4. the route maps a named group through the service map and rejects an
//      unknown one, and `loadOlderGroup` pages one group on its own cursor.
//
// Run with: node --test tests/notifications-filter-chips.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules } = require('./helpers/bundle-module');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');
const ROUTE_SRC = read('src/routes/notifications.js');
const SVC = require('../src/services/notifications');
const GROUPS = SVC.NOTIFICATION_KIND_GROUPS;

const CHIP_NAMES = ['votes', 'merges', 'mentions', 'kudos'];

// ── 1. the server's named groups ────────────────────────────────────────

test('the server serves the four groups the chips name, plus conversation', () => {
  assert.deepEqual(Object.keys(GROUPS).sort(), ['conversation', 'kudos', 'mentions', 'merges', 'votes']);
  // Votes is the six kinds about deciding a change: the `vote_cast` cluster
  // (ACTION_COMPLETIONS) plus the vote and the digest. The testing-couldn't-
  // run row (check_failed) stays out of every group, per the spec.
  assert.deepEqual([...GROUPS.votes].sort(),
    ['change_ready', 'pr_proposed', 'proposal_vote', 'revision_recheck', 'stale_pr', 'vote_digest']);
  assert.deepEqual([...GROUPS.merges], ['pr_merged']);
  // The `message_sent` cluster plus the thread kind (#2387) that joins it.
  assert.deepEqual([...GROUPS.mentions].sort(), ['mention', 'reaction', 'reply', 'thread_reply']);
  assert.deepEqual([...GROUPS.kudos], ['kudos']);
  // The group that predates the chips: the Messages tab's kinds, unchanged.
  assert.deepEqual(GROUPS.conversation, SVC.CONVERSATION_NOTIFICATION_KINDS);
});

// ── 2. the client mirror ────────────────────────────────────────────────

// The mirrored map, read out of the shipped source the way the sheet's tests
// read theirs, so the assertions cannot drift from what runs.
function clientGroups() {
  const start = FE_SRC.indexOf('const NOTIF_FILTER_GROUPS');
  const end = FE_SRC.indexOf('// Which chip a row answers');
  assert.ok(start > -1 && end > start, 'NOTIF_FILTER_GROUPS found in notifications.js');
  return new Function(FE_SRC.slice(start, end) + '\nreturn NOTIF_FILTER_GROUPS;')();
}

test('the client map mirrors the server map kind for kind', () => {
  const client = clientGroups();
  assert.deepEqual(Object.keys(client), CHIP_NAMES,
    'the chips are exactly the four groups; conversation stays the Messages tab\'s server kind');
  for (const name of CHIP_NAMES) {
    assert.deepEqual([...client[name]].sort(), [...GROUPS[name]].sort(),
      `the ${name} chip names the same kinds the server pages for ?kind=${name}`);
  }
});

// ── 3. the row flag ─────────────────────────────────────────────────────

// The whole module, evaluated as the classic script it still is, with the
// one import stubbed — so the `rowView` under test is the one that ships.
// The module's own window publications are skipped (no window in this
// sandbox); the tail re-publishes the private binding the way the page's
// bundle does.
const sandbox = vm.createContext({ window: undefined });
runModules(sandbox, [['notifications.js', FE_SRC]], {
  imports: {
    '../../lib/timestamp': {
      agoStamp: (ts) => ({ text: 'now', title: String(ts) }),
    },
  },
  tail: 'this.__Notifications__ = Notifications;',
});
const rowView = sandbox.__Notifications__._rowView;

test('rowView stamps notifGroup on each group\'s kinds, and null elsewhere', () => {
  const stamps = {
    votes: ['pr_proposed', 'change_ready', 'stale_pr', 'revision_recheck', 'proposal_vote', 'vote_digest'],
    merges: ['pr_merged'],
    mentions: ['mention', 'reply', 'thread_reply', 'reaction'],
    kudos: ['kudos'],
  };
  for (const [group, kinds] of Object.entries(stamps)) {
    for (const kind of kinds) {
      const view = rowView({ id: 1, kind, createdAt: '2026-10-01T00:00:00Z' });
      assert.equal(view.notifGroup, group, `${kind} answers the ${group} chip`);
    }
  }
  // Rows outside the four groups hide under every chip and show only with
  // no chip lit — check_failed (testing couldn't run) is the spec's named
  // one; the rest stand for the whole unread feed a chip must not hide.
  for (const kind of [
    'session_done', 'session_stalled', 'auto_solve_done', 'check_failed',
    'conversation_message', 'friend_request', 'collab_invite', 'issue_opened',
    'weekly_digest', 'test_alert', 'kudos_badge',
  ]) {
    const view = rowView({ id: 2, kind, createdAt: '2026-10-01T00:00:00Z' });
    assert.equal(view.notifGroup, null, `${kind} answers no chip`);
  }
});

// ── 4. the sheet's chips ────────────────────────────────────────────────

test('the chips are single-select, and clear when the sheet closes', () => {
  // One chip at a time: tapping a chip replaces the previous one, and
  // tapping the lit chip clears it.
  assert.match(SHEET_SRC, /const \[chip, setChip\] = useState<NotifChip \| null>\(null\)/);
  assert.match(SHEET_SRC, /onClick=\{\(\) => setChip\(chip === c\.key \? null : c\.key\)\}/);
  // Never persisted: an effect clears the chip when the sheet stops being
  // open, so the next open starts unfiltered.
  assert.match(SHEET_SRC, /useEffect\(\(\) => \{\s*\n\s*if \(!open\) setChip\(null\);\s*\n\s*\}, \[open\]\)/);
});

test('the chip rail renders on the Unread and All tabs only', () => {
  assert.match(SHEET_SRC, /\{railOn \? \(\s*\n\s*<div\s*\n\s*id="notifications-filter-chips"/);
  assert.match(SHEET_SRC, /data-notif-filter=\{c\.key\}/);
  assert.match(SHEET_SRC, /const railOn = tab === 'unread' \|\| tab === 'all';/);
  // Messages takes no chip — its tab IS its filter.
  assert.doesNotMatch(SHEET_SRC, /const railOn = tab === 'unread' \|\| tab === 'all' \|\| tab === 'messages'/);
  // The id ships in the prerender (the sheet opens on Unread), so it is a
  // declared id in the shell's inventory, with a reason.
  const inventory = read('tests/shell-id-inventory.test.js');
  assert.match(inventory, /'notifications-filter-chips':/,
    'recorded in ADDED_IDS — the rail is in the prerendered markup, not conditional');
});

test('the chip narrows the tab, and the Unread count and Mark all read do not follow it', () => {
  // The filter joins the tab computation after it, so the whole-unread list
  // the count and mark-all read stays intact.
  assert.match(SHEET_SRC, /const rows = tab === 'unread' \? unread\s*\n\s*: tab === 'messages' \? messages : all;/);
  assert.match(SHEET_SRC, /railOn && chip\s*\n\s*\? rows\.filter\(\(view\) => view\.notifGroup === chip\)\s*\n\s*: rows;/);
  assert.match(SHEET_SRC, /const unreadCount = unread\.reduce\(\(sum, view\) => sum \+ \(view\.count \|\| 1\), 0\)/);
  assert.match(SHEET_SRC, /disabled=\{!unread\.length\}/);
});

test('the filtered empty state names the chip', () => {
  assert.match(SHEET_SRC, /railOn && chip \? `No \$\{chip\} notifications yet\.`/);
  // And the untouched states keep their own copy.
  assert.match(SHEET_SRC, /'You’re all caught up\.'/);
  assert.match(SHEET_SRC, /'Nothing here yet\. You’ll get pinged here\.'/);
});

test('the All tab pager pages the lit group on its own cursor', () => {
  // Under a chip the pager fetches ?kind=<group> (loadOlderGroup), so
  // pressing it brings back rows the chip can show; without a chip the
  // unfiltered pager is untouched, and so are the regexes that pin it.
  const chipBranch = SHEET_SRC.slice(
    SHEET_SRC.indexOf("tab === 'all' && chip && snap.groupCanLoadMore"),
    SHEET_SRC.indexOf(") : tab === 'all' && !chip && snap.screenCanLoadMore ? ("),
  );
  assert.ok(chipBranch, 'the chip pager branch found');
  assert.match(chipBranch, /id="notifications-load-older"/,
    'the same pager button, narrowed — the spec\'s id');
  assert.match(chipBranch, /disabled=\{snap\.loadingOlderGroup\}/);
  assert.match(chipBranch, /controller\(\)\?\.loadOlderGroup\(chip\)/);
  // The unfiltered pager keeps its own wiring, and keeps out of the chip's
  // way: once the group's cursor is exhausted the pager retires (the
  // Messages tab's does the same), rather than paging rows the chip hides.
  assert.match(SHEET_SRC, /controller\(\)\?\.loadOlder\(\)/);
  assert.match(SHEET_SRC, /disabled=\{snap\.loadingMore\}/);
  assert.match(SHEET_SRC, /tab === 'all' && !chip && snap\.screenCanLoadMore/);
});

// ── 5. the route ────────────────────────────────────────────────────────

test('the route maps every named group, and rejects an unknown one, through the service map', () => {
  const start = ROUTE_SRC.indexOf('const kindParam');
  const end = ROUTE_SRC.indexOf('const rows = await notifications.listForUser');
  assert.ok(start > -1 && end > start, 'the group lookup found in routes/notifications.js');
  const run = new Function('notifications', 'req',
    ROUTE_SRC.slice(start, end) + '\nreturn kinds;');
  const service = { NOTIFICATION_KIND_GROUPS: GROUPS };

  const known = (kind) => run(service, { query: kind === undefined ? {} : { kind } });
  assert.deepEqual(known('conversation'), [...GROUPS.conversation],
    'the Messages tab\'s ?kind=conversation is unchanged');
  for (const name of CHIP_NAMES) {
    assert.deepEqual(known(name), [...GROUPS[name]], `?kind=${name} pages that group`);
  }
  // An unknown name, a repeated parameter (an array), and no parameter all
  // pass null: the whole feed, exactly as before.
  assert.equal(known('everything'), null);
  assert.equal(known(['conversation', 'votes']), null);
  assert.equal(known(), null);
});

// ── 6. the group pager ──────────────────────────────────────────────────

// Rebuild loadOlderGroup as a standalone callable over injected stubs, in the
// style of tests/notifications-show-more.test.js.
function buildLoadOlderGroup() {
  const m = FE_SRC.match(/async loadOlderGroup\(group\) \{([\s\S]*?)\n  \},/);
  assert.ok(m, 'loadOlderGroup() definition found in notifications.js');
  return new Function('Notifications', 'fetch', 'URLSearchParams',
    `return async (group) => {\n${m[1]}\n}`);
}

function stubController() {
  return {
    items: [],
    groupFor: null,
    groupNextBefore: null,
    groupHasMore: true,
    groupLoading: false,
    renders: 0,
    _renderList() { this.renders += 1; },
  };
}

function page(notifications, { hasMore = false, nextBefore = null } = {}) {
  return { ok: true, json: async () => ({ notifications, hasMore, nextBefore }) };
}

test('loadOlderGroup pages one named kind group on its own cursor', async () => {
  const N = stubController();
  N.items = [{ id: 7, kind: 'session_done', createdAt: '2026-10-02T00:00:00Z' }];
  let requested = null;
  const fetchImpl = async (url) => {
    requested = url;
    return page([{ id: 4, kind: 'pr_proposed', createdAt: '2026-10-01T00:00:00Z' }]);
  };
  await buildLoadOlderGroup()(N, fetchImpl, URLSearchParams)('votes');

  assert.match(requested, /kind=votes/, 'the group is asked for by NAME');
  assert.ok(!/before=/.test(requested), 'the first press starts from the newest');
  assert.deepEqual(N.items.map((n) => n.id), [7, 4],
    'the page lands in the shared items, deduped, beside the rows already there');
  assert.equal(N.groupFor, 'votes');
  assert.equal(N.groupHasMore, false, 'the server said there is nothing older');
});

test('loadOlderGroup pages back from its own cursor, and a chip change restarts it', async () => {
  const N = stubController();
  N.items = [{ id: 4, kind: 'pr_proposed', createdAt: '2026-10-01T00:00:00Z' }];
  N.groupFor = 'votes';
  N.groupHasMore = true;
  N.groupNextBefore = { createdAt: '2026-10-01T00:00:00Z', id: 4 };
  const urls = [];
  await buildLoadOlderGroup()(N, async (url) => {
    urls.push(url);
    return page([{ id: 1, kind: 'vote_digest', createdAt: '2026-09-30T00:00:00Z' }],
      { hasMore: false, nextBefore: { createdAt: '2026-09-30T00:00:00Z', id: 1 } });
  }, URLSearchParams)('votes');
  assert.match(urls[0], /kind=votes&before=/, 'the walk continues the group\'s own cursor');

  // Switching the chip resets the cursor: the first press on the new group
  // starts from its newest row, not from where the last walk stopped.
  let second = null;
  await buildLoadOlderGroup()(N, async (url) => {
    second = url;
    return page([], { hasMore: false });
  }, URLSearchParams)('merges');
  assert.match(second, /kind=merges/);
  assert.ok(!/before=/.test(second), 'a chip change starts the walk over');
  assert.equal(N.groupFor, 'merges');
});

test('loadOlderGroup does not stack requests once the cursor is exhausted', async () => {
  const N = stubController();
  N.groupFor = 'kudos';
  N.groupHasMore = false;
  let calls = 0;
  await buildLoadOlderGroup()(N, async () => { calls += 1; return page([]); }, URLSearchParams)('kudos');
  assert.equal(calls, 0, 'the cursor is exhausted; the second press is a no-op');
});

// ── 7. what the chips must not break ────────────────────────────────────

test('a collapsed conversation run never appears under a chip', () => {
  // A conversation row carries the `conversation` flag and notifGroup null,
  // so its count pill can only be reached with no chip lit.
  const view = rowView({ id: 3, kind: 'conversation_message', createdAt: '2026-10-01T00:00:00Z', conversationId: 9 });
  assert.equal(view.conversation, true);
  assert.equal(view.notifGroup, null);
});
