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
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { buildRecents, RECENTS_LIMIT } = loadTsx('frontend/src/features/nav/recents.ts');

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
