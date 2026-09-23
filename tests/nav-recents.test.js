'use strict';

// #platform-recents — the desktop rail's Recents (#2802): the apps you left
// and the conversations you were in, on one clock, between Workshop and Me.
//
//   frontend/src/features/nav/recents.ts           the pure merge
//   frontend/src/features/nav/recent-apps-store.js the apps, per account
//   frontend/src/features/nav/recents-list.tsx     the rows
//
// Also the two sidebar polish requests that ride with it:
//   #2795  the hover-opened rail is the rail's frosted surface, and fades out
//   #2798  no resting disc behind the toggle and the bell; a blue hover on
//          them and on the rail's tabs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  buildRecents, groupRecents, recentDayLabel, RECENTS_LIMIT, RECENT_DAYS,
} = loadTsx('frontend/src/features/nav/recents.ts');

function conversation(id, kind, at, extra = {}) {
  return { id, kind, title: `Conversation ${id}`, lastActivityAt: at, unreadCount: 0, ...extra };
}

test('one list, newest first, across apps and every kind of conversation', () => {
  const items = buildRecents({
    apps: [{ slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', at: '2026-09-20T10:00:00Z' }],
    conversations: [
      conversation(1, 'direct', '2026-09-20T12:00:00Z', { peer: { id: 9, username: 'ana' } }),
      conversation(2, 'group', '2026-09-20T09:00:00Z', { title: 'Team' }),
      conversation(3, 'channel', '2026-09-20T11:00:00Z', { channelKey: 'general' }),
    ],
    discussions: [{
      slug: 'chess', name: 'Chess', channel: 'chess', iconUrl: null, iconEmoji: null,
      lastMessage: 'gg', lastAt: '2026-09-20T08:00:00Z', lastBy: 'bo',
    }],
    agents: [{ id: 'g1', title: 'Plan a feature', updatedAt: '2026-09-20T11:30:00Z' }],
  });
  assert.deepEqual(items.map((i) => [i.kind, i.label]), [
    ['direct', '@ana'],
    ['agent', 'Plan a feature'],
    // NOT the inbox's order: a channel is not held back behind the chats.
    ['channel', '#general'],
    ['app', 'Notes'],
    ['group', 'Team'],
    ['channel', '#chess'],
  ]);
  assert.deepEqual(items.map((i) => i.href), [
    '#messages/1', '#chat/g1', '#messages/3', '/app/notes', '#messages/2', '#messages/app/chess',
  ]);
});

test('#2878: more than a rail of rows, and the cut keeps the newest', () => {
  // The list runs down the rest of the rail and scrolls there, so the cap is
  // a ceiling on history rather than the eight rows it used to be.
  assert.ok(RECENTS_LIMIT >= 24, 'more rows than a tall rail shows at once');
  const conversations = Array.from({ length: RECENTS_LIMIT + 5 }, (_, i) => conversation(
    i + 1, 'group', new Date(Date.UTC(2026, 8, 1) + i * 3600e3).toISOString(),
  ));
  const items = buildRecents({ apps: [], conversations, discussions: [], agents: [] });
  assert.equal(items.length, RECENTS_LIMIT);
  assert.equal(items[0].key, `conversation:${RECENTS_LIMIT + 5}`);
  assert.equal(items[RECENTS_LIMIT - 1].key, 'conversation:6');
  assert.equal(buildRecents({ apps: [], conversations, discussions: [], agents: [], limit: 3 }).length, 3);

  const { RECENT_APPS_MAX } = loadTsx('frontend/src/features/nav/recent-apps-store.js');
  assert.ok(RECENT_APPS_MAX > RECENTS_LIMIT, 'storage keeps more apps than the list holds');
});

test('#2878: the list fills the rail and scrolls; the tabs never shrink for it', () => {
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('.platform-recents:not(.hidden) {'));
  assert.match(block, /^\.platform-recents:not\(\.hidden\) \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  const desktop = css.slice(css.indexOf('THE SAME FIVE TABS, STANDING UP'));
  assert.match(desktop, /\n  \.platform-tab \{\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*flex: none;/,
    'a tab keeps its 44px when the list overflows');
});

test('#2800/#2878: a thin rule above Me, drawn by the rail itself on the desktop only', () => {
  const css = read('public/css/app.css');
  const desktop = css.indexOf('THE SAME FIVE TABS, STANDING UP');
  const rule = css.indexOf('.platform-tabs::after {');
  assert.ok(rule > desktop, 'inside the desktop block, so the phone bar has no rule');
  assert.equal(css.indexOf('.platform-tabs::after {', rule + 1), -1, 'drawn once');
  const body = css.slice(rule, css.indexOf('}', rule));
  assert.match(body, /content: "";/);
  assert.match(body, /height: 1px;/);
  assert.match(body, /background: var\(--app-sheet-line\);/, 'the rail\'s own hairline colour');
  assert.match(body, /order: 1;/);
  assert.match(css.slice(desktop), /#platform-tab-me \{\s*order: 2;\s*\}/, 'Me comes after it');
  // Me is the rail's last child, so ordering the ::after before it is enough.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /key === 'me' \? <RecentsList key="recents" \/> : null,/);
});

test('#2878: an app row draws the app\'s own icon, the glyph only when it has none', () => {
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /import \{ AppIconContent, appIconKind \} from '\.\.\/apps\/app-card-view';/,
    'the launcher\'s own icon renderer');
  assert.match(list, /const app = item\.app && \(item\.app\.iconUrl \|\| item\.app\.iconEmoji\) \? item\.app : null;/);
  assert.match(list, /\{app \? <AppTile app=\{app\} \/> : <Glyph className="platform-recent-glyph" aria-hidden="true" \/>\}/);
  assert.match(list, /className="app-icon-tile platform-recent-tile"/);

  const { AppIconContent } = loadTsx('frontend/src/features/apps/app-card-view.tsx');
  assert.equal(typeof AppIconContent, 'function');
  const css = read('public/css/app.css');
  const desktop = css.slice(css.indexOf('THE SAME FIVE TABS, STANDING UP'));
  assert.match(desktop, /\.platform-recent-tile \{\s*width: 18px;\s*height: 18px;/,
    'the glyph\'s footprint, so every label starts on one line');
  assert.match(desktop, /\.platform-recent-glyph \{\s*width: 18px;\s*height: 18px;/);
});

test('#2801: the Resume row has no background of its own in the rail', () => {
  const css = read('public/css/app.css');
  const desktop = css.slice(css.indexOf('THE SAME FIVE TABS, STANDING UP'));
  const at = desktop.indexOf('  .platform-parked {\n    right: auto;');
  assert.ok(at > 0);
  const body = desktop.slice(at, desktop.indexOf('}', at));
  assert.match(body, /background: transparent;/);
  assert.match(body, /backdrop-filter: none;/);
});

// #2919: the list is cut into the viewer's own calendar days, and anything
// older than five days ago folds behind one "Show N older" button.
//
// Local wall-clock times, built with the local Date constructor, so the day
// boundaries are the ones the test's own zone draws, whatever it is.
const local = (d, h, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const NOW = new Date(2026, 8, 23, 0, 5).getTime(); // 12:05am, Sep 23

function byDayFixture() {
  return buildRecents({
    apps: [{ slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', at: local(21, 12) }],
    conversations: [
      conversation(1, 'direct', local(23, 0, 7), { peer: { id: 9, username: 'ahead' } }), // another clock, 2 min fast
      conversation(2, 'direct', local(23, 0, 1), { peer: { id: 9, username: 'ana' } }),
      conversation(3, 'group', local(22, 23, 50)), // 11:50pm last night
      conversation(4, 'group', local(22, 0, 10)),
      conversation(5, 'channel', local(18, 0, 0), { channelKey: 'five' }),
      conversation(6, 'channel', local(17, 23, 59), { channelKey: 'six' }),
      conversation(7, 'group', ''), // no clock at all
    ],
    discussions: [],
    agents: [],
  });
}

test('#2919: Today, Yesterday, then 2 to 5 days ago, by calendar day; empty days get no label', () => {
  assert.equal(RECENT_DAYS, 6, 'today and the five days before it');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(recentDayLabel),
    ['Today', 'Yesterday', '2 days ago', '3 days ago', '4 days ago', '5 days ago']);

  const items = byDayFixture();
  const { days, older } = groupRecents(items, NOW);
  assert.deepEqual(days.map((d) => [d.label, d.items.map((i) => i.key)]), [
    ['Today', ['conversation:1', 'conversation:2']],
    // 11:50pm is Yesterday at 12:05am: a calendar day, not the last 24 hours.
    ['Yesterday', ['conversation:3', 'conversation:4']],
    ['2 days ago', ['app:notes']],
    // Nothing three or four days ago, so neither label is drawn.
    ['5 days ago', ['conversation:5']],
  ]);
  assert.deepEqual(older.map((i) => i.key), ['conversation:6', 'conversation:7'],
    'six days back, and a row with no clock, are older');

  // Grouping only: read top to bottom it is buildRecents' own order and count.
  assert.deepEqual([...days.flatMap((d) => d.items), ...older], items);
  const full = Array.from({ length: RECENTS_LIMIT + 4 }, (_, i) => conversation(
    i + 1, 'group', new Date(NOW - i * 7 * 3600e3).toISOString(),
  ));
  const capped = buildRecents({ apps: [], conversations: full, discussions: [], agents: [] });
  const grouped = groupRecents(capped, NOW);
  assert.deepEqual([...grouped.days.flatMap((d) => d.items), ...grouped.older], capped);
  assert.equal(capped.length, RECENTS_LIMIT);
});

test('#2919: a daylight-saving day is still one day', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // 8 March 2026 is 23 hours long in New York: its midnight is 23 hours
    // before the next one, which a plain division would call the same day.
    const now = new Date(2026, 2, 9, 0, 30).getTime();
    const items = buildRecents({
      apps: [],
      conversations: [
        conversation(1, 'group', new Date(2026, 2, 8, 23, 0).toISOString()),
        conversation(2, 'group', new Date(2026, 2, 3, 1, 0).toISOString()),
      ],
      discussions: [],
      agents: [],
    });
    const { days, older } = groupRecents(items, now);
    assert.deepEqual(days.map((d) => [d.label, d.items.length]), [['Yesterday', 1]]);
    assert.equal(older.length, 1, 'six calendar days back across the change is older');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('#2919: small labels before each day, and "Show N older" folded until pressed', () => {
  const { RecentsByDay } = loadTsx('frontend/src/features/nav/recents-list.tsx');
  const items = byDayFixture();
  const render = (showOlder) => renderToHtml(createElement(RecentsByDay, {
    items, live: [], showOlder, onToggleOlder: () => {}, now: NOW,
  }));
  const labels = (html) => [...html.matchAll(/<div class="platform-recents-day">([^<]*)<\/div>/g)].map((m) => m[1]);
  const keys = (html) => [...html.matchAll(/data-recent-key="([^"]*)"/g)].map((m) => m[1]);

  const closed = render(false);
  assert.deepEqual(labels(closed), ['Today', 'Yesterday', '2 days ago', '5 days ago']);
  assert.doesNotMatch(closed, /<h\d/, 'the labels are not headings; Recents is the one heading');
  assert.deepEqual(keys(closed), [
    'conversation:1', 'conversation:2', 'conversation:3', 'conversation:4', 'app:notes', 'conversation:5',
  ], 'the older rows are not rendered while folded');
  assert.match(closed,
    /<button type="button" class="platform-recents-more" aria-expanded="false"><svg class="platform-recents-more-icon"[^>]*><path[^>]*d="M19 9l-7 7-7-7"><\/path><\/svg><span>Show 2 older<\/span><\/button>$/,
    'a real button at the foot of the list, with a chevron down, saying how many');
  assert.ok(closed.indexOf('Today') < closed.indexOf('data-recent-key="conversation:1"'), 'a label comes before its rows');

  const open = render(true);
  assert.deepEqual(labels(open), ['Today', 'Yesterday', '2 days ago', '5 days ago', 'Older']);
  assert.deepEqual(keys(open), items.map((i) => i.key), 'every row, in the list\'s own order');
  assert.match(open,
    /<div class="platform-recents-day">Older<\/div>[\s\S]*<button type="button" class="platform-recents-more" aria-expanded="true"><svg class="platform-recents-more-icon"[^>]*><path[^>]*d="M5 15l7-7 7 7"><\/path><\/svg><span>Show less<\/span><\/button>$/);

  // Nothing older than five days: no fold at all.
  const recent = renderToHtml(createElement(RecentsByDay, {
    items: items.slice(0, 6), live: [], showOlder: false, onToggleOlder: () => {}, now: NOW,
  }));
  assert.doesNotMatch(recent, /<button/);
  assert.equal(renderToHtml(createElement(RecentsByDay, {
    items: [], live: [], showOlder: false, onToggleOlder: () => {},
  })), '', 'an empty list renders nothing, so the prerender is unchanged');

  // Closed on every load: the fold is component state, never stored.
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /const \[showOlder, setShowOlder\] = useState\(false\);/);
  assert.match(list, /onToggleOlder=\{\(\) => setShowOlder\(\(open\) => !open\)\}/);
  assert.doesNotMatch(list, /showOlder[^\n]*(localStorage|sessionStorage)/);
});

test('#2919: the day labels and the fold are drawn in the desktop block only', () => {
  const css = read('public/css/app.css');
  const desktop = css.indexOf('THE SAME FIVE TABS, STANDING UP');
  const day = css.indexOf('  .platform-recents-day {');
  const more = css.indexOf('  .platform-recents-more {');
  assert.ok(day > desktop && more > desktop, 'inside the desktop block, so the phone never draws them');
  assert.equal(css.indexOf('.platform-recents-day {'), day + 2, 'drawn once');
  const dayBody = css.slice(day, css.indexOf('}', day));
  assert.match(dayBody, /flex: none;/, 'never squeezed by the scrolling list');
  assert.match(dayBody, /color: var\(--text-muted\);/);
  assert.match(dayBody, /font-size: 11px;/);
  assert.doesNotMatch(dayBody, /text-transform/, 'sentence case, unlike the RECENTS heading');
  assert.match(css, /\.platform-recents-head \+ \.platform-recents-day \{\s*padding-top: 2px;\s*\}/);
  const moreBody = css.slice(more, css.indexOf('}', more));
  assert.match(moreBody, /flex: none;/);
  assert.match(moreBody, /height: 30px;/);
  assert.match(moreBody, /background: none;/);
  assert.match(moreBody, /color: var\(--text-muted\);/);
});

test('unread shows on conversations; archived and silent channels stay out', () => {
  const items = buildRecents({
    apps: [],
    conversations: [
      conversation(1, 'direct', '2026-09-20T12:00:00Z', {
        unreadCount: 3, members: [{ id: 1, username: 'me' }, { id: 2, username: 'kai' }],
      }),
      conversation(2, 'group', '2026-09-20T13:00:00Z', { archived: true }),
    ],
    discussions: [{
      slug: 'quiet', name: 'Quiet', iconUrl: null, iconEmoji: null,
      lastMessage: '', lastAt: null, lastBy: null,
    }],
    agents: [],
    viewerId: 1,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '@kai', 'a DM is named after the other person');
  assert.equal(items[0].unread, true);
});

test('the rail renders Recents between Workshop and Me, empty until mounted', () => {
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /key === 'me' \? <RecentsList key="recents" \/> : null,/);
  const list = read('frontend/src/features/nav/recents-list.tsx');
  // Hydration: rows only after mount, the root's class a constant.
  assert.match(list, /const items = mounted && viewer\s*\n\s*\? buildRecents\(/);
  assert.match(list, /className="platform-recents hidden"/);
  assert.match(list, /useHiddenClass\(ref, items\.length === 0\);/);
  // A distinct glyph per kind.
  assert.match(list, /app: AppWindowIcon,\s*direct: UserIcon,\s*group: UserGroupIcon,\s*channel: HashIcon,\s*agent: SparklesIcon,/);
  // Resuming an app goes through the router, as the Resume strip did.
  assert.match(list, /window\.App\?\.openAppTab\?\.\(slug, 'app'\);/);

  const html = read('public/index.html');
  const at = html.indexOf('id="platform-recents"');
  assert.ok(at > 0, 'the root ships in the document');
  assert.ok(at < html.indexOf('id="platform-tab-me"'), 'before Me');
  assert.ok(at > html.indexOf('id="platform-tab-workshop"'), 'after Workshop');
  const root = html.slice(html.lastIndexOf('<', at), html.indexOf('</div>', at));
  assert.match(root, /class="platform-recents hidden"/);
  assert.doesNotMatch(root, /platform-recent"/, 'with no rows in the prerender');
});

test('Recents are desktop-only, and replace the Resume strip there', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\n\.platform-recents \{\s*display: none;\s*\}/, 'off the phone bar');
  const desktop = css.indexOf('THE SAME FIVE TABS, STANDING UP');
  const recents = css.indexOf('.platform-recents:not(.hidden) {');
  assert.ok(recents > desktop, 'drawn in the desktop block');
  assert.match(css, /THE RESUME STRIP GIVES WAY TO RECENTS[\s\S]{0,500}#platform-parked \{\s*display: none;\s*\}/);
});

test('recent apps are remembered per account, and park(null) forgets nothing', () => {
  const storage = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  try {
    const mod = loadTsx('frontend/src/features/nav/recent-apps-store.js');
    mod.rememberRecentApp({ slug: 'a', name: 'A' }, 'ana', '2026-09-20T01:00:00Z');
    mod.rememberRecentApp({ slug: 'b', name: 'B' }, 'ana', '2026-09-20T02:00:00Z');
    mod.rememberRecentApp({ slug: 'a', name: 'A' }, 'ana', '2026-09-20T03:00:00Z');
    assert.deepEqual(mod.recentAppsStore.get().apps.map((a) => a.slug), ['a', 'b'],
      'an app appears once, at the front');
    assert.deepEqual(mod.readRecentApps('ana').map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readRecentApps('bo'), [], 'another account sees none of it');
    assert.deepEqual(mod.readRecentApps(null), [], 'nor does nobody');
  } finally {
    delete global.window;
  }
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /if \(app && app\.slug\) rememberRecentApp\(app, navStore\.get\(\)\.viewer\);/);
  assert.match(mount, /recentAppsStore\.set\(\{ apps: readRecentApps\(viewer \|\| null\) \}\);/,
    'a change of account swaps the list');
});

test('#2795: the peeked rail is the frosted rail, and fades out', () => {
  const css = read('public/css/app.css');
  const peek = css.slice(css.indexOf('  .platform-tabs.platform-tabs-peek {'));
  const rule = peek.slice(0, peek.indexOf('}'));
  assert.match(rule, /background-color: var\(--dc-sheet-fill\);/);
  assert.match(rule, /backdrop-filter: var\(--dc-frost\);/);
  assert.doesNotMatch(rule, /background-color: var\(--dc-sheet\);/, 'not the solid white sheet');
  assert.match(rule, /transition: opacity 200ms ease-in;/);
  assert.match(css, /\.platform-tabs\.platform-tabs-peek\.platform-tabs-peek-out \{\s*opacity: 0;\s*\}/);
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-peek-out', collapsed && peek && peekOut\);/);
});

test('#2798: no resting disc on the toggle or the bell; a blue hover on them and the tabs', () => {
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  const cls = toggle.slice(toggle.indexOf('const TOGGLE_CLASS'), toggle.indexOf(';', toggle.indexOf('const TOGGLE_CLASS')));
  assert.doesNotMatch(cls, / bg-\[color:var\(--brand-tint\)\]/);
  assert.match(cls, /hover:bg-\[color:var\(--brand-tint\)\]/);

  const header = read('frontend/src/features/header/platform-header.tsx');
  const bell = header.match(/id="notifications-btn"\s*\n\s*href="#notifications"\s*\n\s*className="([^"]*)"/)[1];
  assert.doesNotMatch(bell, /(^| )bg-\[color:var\(--brand-tint\)\]/);
  assert.match(bell, /hover:bg-\[color:var\(--brand-tint\)\]/);
  // The other header controls keep theirs.
  assert.match(header, /const BACK_BTN_CLASS = [^;]*' border border-\[color:var\(--brand-line\)\] bg-\[color:var\(--brand-tint\)\]'/);

  const css = read('public/css/app.css');
  assert.match(css,
    /@media \(hover: hover\) \{\s*\.platform-tab:not\(\[aria-current="page"\]\):hover,\s*\.platform-recent:hover \{\s*background: color-mix\(in srgb, var\(--brand-tint\) 55%, transparent\);/,
    'the hovered tab is a lighter blue than the current one');
  assert.match(css, /\.platform-tab\[aria-current="page"\] \{\s*background: var\(--brand-tint\);/);
});
