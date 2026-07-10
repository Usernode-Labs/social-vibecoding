// App detail page (public/js/app-detail.js) markup contract: the
// identity block (chip, "N active", tagline), the action row's gating
// (Open disabled with the card status vocabulary, Improve hidden for
// gated viewers, heart states, More overflow items), and the Builders
// section ("N changes merged", omitted entirely at zero).
//
// app-detail.js is a plain browser script (`const AppDetail = {…}`);
// we load it into a vm context with stubbed globals (escapeHtml lives
// in app-view.js in the real page; Home supplies the icon/chip
// helpers) and call the pure renderers directly — same harness as
// home-card-menu.test.js.
//
// Run with: node --test tests/app-detail-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DETAIL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-detail.js'),
  'utf8'
);

function makeDetail({ shortcutSupport = null } = {}) {
  const sandbox = {
    console,
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c])),
    // The pieces of Home the detail page leans on. iconTileFor mirrors
    // the real precedence contract (image > emoji > letter) closely
    // enough for markup assertions.
    Home: {
      _shortcutSupport: shortcutSupport,
      isYours: (a) => !!(a && (a.is_collaborator || a.is_favorited)),
      _menuAddShortcut: () => {},
      iconTileFor: (a) => (a.icon_emoji
        ? { kind: 'emoji', html: a.icon_emoji }
        : { kind: 'letter', html: (a.name || '?').charAt(0).toUpperCase() }),
      categoryChipHtml: (c) => (c === 'game' ? '<span class="category-chip">Game</span>'
        : c === 'tool' ? '<span class="category-chip">Tool</span>' : ''),
    },
    AppView: { appData: null, promptFork: () => {} },
    App: { currentApp: null, currentTab: null, navigateToApp: () => {} },
    document: { getElementById: () => null },
    fetch: async () => ({ ok: false }),
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${DETAIL_SRC}\n;globalThis.__AppDetail = AppDetail;`, sandbox);
  return { AppDetail: sandbox.__AppDetail, sandbox };
}

const baseApp = (over) => ({
  id: 1,
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  self_hosted: false,
  is_collaborator: false,
  is_favorited: false,
  can_collaborate: true,
  active_users: 74,
  category: 'game',
  tagline: 'Guess the number before your friends do',
  icon_emoji: '🎯',
  ...over,
});

// ── Identity block ────────────────────────────────────────────────

test('identity: name, chip, "N active", tagline, and the count explanation', () => {
  const { AppDetail } = makeDetail();
  const html = AppDetail.renderHtml(baseApp());
  assert.match(html, /Demo App/);
  assert.match(html, /category-chip">Game</);
  assert.match(html, />74 active</);
  assert.match(html, /Guess the number before your friends do/);
  assert.match(html, /People who used this app in the last 10 days/);
  assert.match(html, /data-icon="emoji"/, 'icon precedence markup preserved');
});

test('identity: missing tagline renders nothing, no placeholder', () => {
  const { AppDetail } = makeDetail();
  const html = AppDetail.renderHtml(baseApp({ tagline: null, category: null }));
  assert.doesNotMatch(html, /No tagline|Add a tagline/);
  assert.doesNotMatch(html, /category-chip/);
});

test('identity: name and tagline are HTML-escaped', () => {
  const { AppDetail } = makeDetail();
  const html = AppDetail.renderHtml(baseApp({
    name: 'Evil <img> & Co',
    tagline: '<script>alert(1)</script>',
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes('Evil &lt;img&gt; &amp; Co'));
});

// ── Action row ────────────────────────────────────────────────────

test('actions: Open primary when running; disabled with the status label otherwise', () => {
  const { AppDetail } = makeDetail();
  const running = AppDetail.renderHtml(baseApp());
  assert.match(running, /id="detail-open"[^>]*>Open</);
  assert.doesNotMatch(running, /id="detail-open"[^>]*disabled/);
  for (const [status, label] of [
    ['creating', 'Spinning up...'],
    ['awaiting_secrets', 'Awaiting secrets'],
    ['error', 'Error'],
  ]) {
    const html = AppDetail.renderHtml(baseApp({ status }));
    assert.match(html, new RegExp(`id="detail-open" disabled[\\s\\S]*?>${label.replace('...', '\\.\\.\\.')}<`), `${status} disables Open with its label`);
  }
});

test('actions: Improve hidden when the viewer cannot reach the Dev board', () => {
  const { AppDetail } = makeDetail();
  assert.match(AppDetail.renderHtml(baseApp()), /id="detail-improve"[^>]*>Improve</);
  assert.doesNotMatch(AppDetail.renderHtml(baseApp({ can_collaborate: false })), /detail-improve/);
});

test('actions: heart aria-labels and states', () => {
  const { AppDetail } = makeDetail();
  const plain = AppDetail.heartHtml(baseApp());
  assert.match(plain, /aria-label="Add to favorites"/);
  assert.match(plain, /aria-pressed="false"/);
  const faved = AppDetail.heartHtml(baseApp({ is_favorited: true }));
  assert.match(faved, /aria-label="Remove from favorites"/);
  assert.match(faved, /aria-pressed="true"/);
  // Member apps: filled AND disabled with the always-yours tooltip.
  const member = AppDetail.heartHtml(baseApp({ is_collaborator: true }));
  assert.match(member, /disabled/);
  assert.match(member, /You build this app, so it is always in your favorites/);
  assert.match(member, /aria-pressed="true"/);
});

// ── More overflow ─────────────────────────────────────────────────

test('more: Fork rides the existing fork dialog; hidden for the self-app', () => {
  const { AppDetail } = makeDetail();
  const keys = (a) => AppDetail.moreItemsFor(a).map((i) => i.key);
  assert.deepEqual([...keys(baseApp())], ['fork']);
  assert.deepEqual([...keys(baseApp({ self_hosted: true }))], []);
});

test('more: shortcut item mirrors the home-card gates and platform labels', () => {
  // No bridge support probed → no item.
  let { AppDetail } = makeDetail();
  assert.equal(
    AppDetail.moreItemsFor(baseApp({ is_favorited: true }))
      .some((i) => i.key === 'add-to-homescreen'),
    false
  );
  // Android pinned shortcut, favorited + running → "Add to home screen".
  ({ AppDetail } = makeDetail({ shortcutSupport: { mechanism: 'pinned-shortcut' } }));
  const android = AppDetail.moreItemsFor(baseApp({ is_favorited: true }));
  assert.equal(android.find((i) => i.key === 'add-to-homescreen').label, 'Add to home screen');
  // iOS widget mechanism names the widget.
  ({ AppDetail } = makeDetail({ shortcutSupport: { mechanism: 'widget' } }));
  const ios = AppDetail.moreItemsFor(baseApp({ is_collaborator: true }));
  assert.equal(ios.find((i) => i.key === 'add-to-homescreen').label, 'Add to Usernode widget');
  // Gates: not-yours, not-running, or explicit unsupported → hidden.
  assert.equal(AppDetail.moreItemsFor(baseApp()).some((i) => i.key === 'add-to-homescreen'), false, 'directory apps excluded');
  assert.equal(
    AppDetail.moreItemsFor(baseApp({ is_favorited: true, status: 'error' }))
      .some((i) => i.key === 'add-to-homescreen'),
    false, 'not running'
  );
  ({ AppDetail } = makeDetail({ shortcutSupport: { mechanism: 'unsupported' } }));
  assert.equal(
    AppDetail.moreItemsFor(baseApp({ is_favorited: true }))
      .some((i) => i.key === 'add-to-homescreen'),
    false, 'unsupported hosts hide the action'
  );
});

// ── Builders ──────────────────────────────────────────────────────

test('builders: rows carry username + "N changes merged", singular at 1', () => {
  const { AppDetail } = makeDetail();
  const html = AppDetail.renderBuildersHtml([
    { user_id: 1, username: 'alice', merged_count: 22 },
    { user_id: 2, username: 'bob', merged_count: 1 },
  ]);
  assert.match(html, /Builders/);
  assert.match(html, /alice/);
  assert.match(html, /22 changes merged/);
  assert.match(html, /bob/);
  assert.match(html, /1 change merged/);
});

test('builders: section omitted entirely with zero merges', () => {
  const { AppDetail } = makeDetail();
  assert.equal(AppDetail.renderBuildersHtml([]), '');
  assert.equal(AppDetail.renderBuildersHtml(null), '');
});

test('builders: usernames are HTML-escaped', () => {
  const { AppDetail } = makeDetail();
  const html = AppDetail.renderBuildersHtml([
    { user_id: 1, username: '<b>evil</b>', merged_count: 2 },
  ]);
  assert.doesNotMatch(html, /<b>evil<\/b>/);
  assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'));
});
