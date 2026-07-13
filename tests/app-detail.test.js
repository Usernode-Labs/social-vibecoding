const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AppDetail = require('../public/js/app-detail');
const detailCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

function app(overrides = {}) {
  return {
    slug: 'demo',
    name: 'Demo app',
    status: 'running',
    url: 'https://demo.test',
    repo_url: 'https://github.com/example/demo',
    category: 'game',
    tagline: 'Play with your friends',
    active_users: 7,
    icon_emoji: null,
    icon_url: null,
    is_collaborator: false,
    is_favorited: false,
    can_collaborate: true,
    ...overrides,
  };
}

function installGlobals({ support = null, canCreateApps = false } = {}) {
  global.App = { user: { canCreateApps } };
  global.Home = {
    _shortcutSupport: support,
    isYours: (candidate) => !!(candidate.is_collaborator || candidate.is_favorited),
    iconTileFor: (candidate) => ({
      kind: 'letter',
      html: candidate.name[0],
      style: '--app-icon-bg:hsl(20 45% 22%);--app-icon-fg:hsl(20 70% 70%)',
    }),
  };
}

test.afterEach(() => {
  AppDetail.app = null;
  delete global.App;
  delete global.Home;
  delete global.AppView;
  delete global.document;
});

test('detail renders identity, actions, and builder merge counts', () => {
  installGlobals({ canCreateApps: true });
  const html = AppDetail._pageHtml(app(), [
    { user_id: 1, username: 'alex', merged_count: 1 },
    { user_id: 2, username: 'bea', merged_count: 4 },
  ]);
  assert.match(html, /Demo app/);
  assert.match(html, /app-category-chip is-game[^>]*>Game</);
  assert.match(html, /Play with your friends/);
  assert.match(html, /app-detail-icon[^>]*data-icon="letter"[^>]*--app-icon-bg:hsl/);
  assert.match(html, />7 active</);
  assert.match(html, /People who used this app in the last 10 days/);
  assert.match(html, /id="app-detail-open"[^>]*>Open</);
  assert.match(html, /id="app-detail-improve"/);
  assert.match(html, />Builders</);
  assert.match(html, />1 change merged</);
  assert.match(html, />4 changes merged</);
  assert.match(html, /data-detail-action="fork"[^>]*>Fork</);
  assert.match(html, /id="app-detail-more"[^>]*aria-label="More"[^>]*title="More"/);
});

test('detail actions stay in one responsive row', () => {
  const actions = detailCss.match(/\.app-detail-actions \{[^}]+\}/)?.[0] || '';
  assert.match(actions, /flex-wrap:\s*nowrap/);
  assert.match(actions, /width:\s*100%/);
  assert.match(detailCss, /\.app-detail-action-primary,\s*\n\s*\.app-detail-action-secondary \{[^}]*flex:\s*1 1 0/);
  assert.match(detailCss, /\.app-detail-more-wrap \{[^}]*flex:\s*0 0 2\.75rem/);
});

test('detail omits empty optional content and disables unavailable Open', () => {
  installGlobals();
  const html = AppDetail._pageHtml(app({
    status: 'creating',
    url: null,
    tagline: null,
    category: null,
    can_collaborate: false,
  }), []);
  assert.doesNotMatch(html, /app-detail-tagline/);
  assert.doesNotMatch(html, /app-category-chip/);
  assert.doesNotMatch(html, />Builders</);
  assert.doesNotMatch(html, /app-detail-improve/);
  assert.match(html, /id="app-detail-open"[^>]*disabled[^>]*>Spinning up\.\.\.</);
});

test('favorite heart is filled and disabled for apps the viewer builds', () => {
  installGlobals();
  const html = AppDetail._pageHtml(app({ is_collaborator: true }), []);
  assert.match(html, /app-detail-heart is-active/);
  assert.match(html, /aria-label="Remove from favorites"/);
  assert.match(html, /title="You build this app, so it is always in your favorites" disabled/);
});

test('native shortcut action uses the host mechanism and existing membership gate', () => {
  installGlobals({ support: { mechanism: 'pinned-shortcut' } });
  let html = AppDetail._pageHtml(app({ is_favorited: true }), []);
  assert.match(html, /data-detail-action="shortcut"[^>]*>Add to home screen</);

  global.Home._shortcutSupport = { mechanism: 'widget' };
  html = AppDetail._pageHtml(app({ is_collaborator: true }), []);
  assert.match(html, /data-detail-action="shortcut"[^>]*>Add to Usernode widget</);

  html = AppDetail._pageHtml(app(), []);
  assert.doesNotMatch(html, /data-detail-action="shortcut"/, 'unfamiliar apps are not pinnable yet');
});

test('Fork opens the native independent-copy flow with this app as its source', () => {
  installGlobals({ canCreateApps: true });
  const calls = [];
  global.AppView = { promptFork: (source) => calls.push(source) };
  AppDetail.app = app();

  AppDetail._openForkFlow();

  assert.deepEqual(calls, [{ slug: 'demo', name: 'Demo app' }]);
  assert.doesNotMatch(AppDetail._pageHtml(app({ self_hosted: true }), []), /data-detail-action="fork"/);
  assert.doesNotMatch(AppDetail._pageHtml(app({ repo_url: null }), []), /data-detail-action="fork"/);
});

test('missing detail data renders the same non-disclosing not-found state', async () => {
  installGlobals();
  const content = { innerHTML: '' };
  global.document = { getElementById: (id) => id === 'app-content' ? content : null };
  global.AppView = { appData: null };
  await AppDetail.render(null);
  assert.equal(content.innerHTML, '<div class="app-detail-state">App not found</div>');
});

test('hash router preserves and round-trips the detail segment', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(source.includes("if (tab === 'detail') return { tab: 'detail', subTab: null, ref: null };"));
  assert.ok(source.includes('newHash = `#app/${App.currentApp}/detail`;'));
  assert.ok(source.includes("await AppDetail.render(AppView.appData)"));
});
