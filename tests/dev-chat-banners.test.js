// The four strips between the dev chat's session header and its panes.
//
// They did not convert together because they are similar — the sync banner is
// about the branch and the credits pair is about money — but because they
// shared ONE slot and three copies of the same in-place dance. Each
// `_apply*Banner` read the live element, replaced its `outerHTML` when there
// was still something to say, `remove()`d it when there was not, and
// `insertAdjacentHTML`'d it back before `.dc-session-body` when it had to
// reappear; `_applySyncBanner` could not even do the last part and fell
// through to a whole `renderChatView` — rebuilding the transcript to make a
// strip appear.
//
// That dance existed for one reason: a banner must be able to appear, change
// and vanish mid-session WITHOUT re-rendering the message list under an
// in-flight stream. A store does that by construction, and this file's
// weightiest assertions are that the three paths collapsed into one publish
// and that the message list is not in the subtree.
//
// The rest is what the declared checks read: `[data-credits-reset]`,
// `[data-credits-low-lead]`, and the two-doors chain
// `#dc-credits-banner .dc-credits-banner-actions > button#dc-credits-add-key
// + button[data-credits-venue="1"]:last-child` — which is why
// `CreditOptions.bannerActionsHtml`'s markup arrives WHOLE.
//
// Run with: node --test tests/dev-chat-banners.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const CREDIT_OPTIONS_SRC = read('public', 'js', 'credit-options.js');
const BANNERS_TSX = read('frontend', 'src', 'features', 'dev-chat', 'banners.tsx');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-banners-api.ts')));

function bannersHtml(state) {
  const m = mod();
  m.bannersStore.set(JSON.parse(JSON.stringify(state)));
  return renderToHtml(createElement(m.DevChatBanners, {}));
}

function makeDevChat(over = {}) {
  const host = { id: 'dc-banners' };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentApp: 'recipe-box', switchTab: () => {} },
    document: {
      getElementById: (id) => (id === 'dc-banners' ? host : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
      body: { appendChild: () => {}, addEventListener: () => {} },
    },
    requestAnimationFrame: () => {},
    alert: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const published = [];
  sandbox.UsernodeReact = {
    devChat: {
      mountBanners: (_h, state) => published.push({ mounted: true, state }),
      publishBanners: (state) => published.push({ mounted: false, state }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${CREDIT_OPTIONS_SRC}\n${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  Object.assign(DevChat, over);
  const view = () => JSON.parse(JSON.stringify(DevChat._bannersView()));
  return { DevChat, sandbox, published, view };
}

const SESSION = { id: 5, session_title: 'x', branch_name: 'dev/evan-1', status: 'active' };

// ── 1. The dance that is gone ──────────────────────────────────────────

test('every _apply*Banner is one publish, and no path swaps an element', () => {
  for (const fn of ['_applySyncBanner', '_applyCreditsBanner', '_applyCreditsLowBanner']) {
    const at = DEV_CHAT_SRC.indexOf(`${fn}() {`);
    assert.ok(at !== -1, `${fn} is still the entry point every caller uses`);
    const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
    assert.match(body, /DevChat\._publishBanners\(\)/, `${fn} publishes`);
    assert.doesNotMatch(body, /outerHTML|insertAdjacentHTML|\.remove\(\)/, `${fn} touches no element`);
    assert.doesNotMatch(body, /renderChatView\(\)/,
      `${fn} must never rebuild the transcript to make a strip appear`);
  }
  // …and none of the four string builders survives.
  for (const gone of [
    '_renderSyncBannerHtml', '_renderNewChangeBannerHtml',
    '_renderCreditsBannerHtml', '_renderCreditsLowBannerHtml',
    '_wireSyncBanner', '_wireCreditsBanner', '_wireCreditsLowBanner',
  ]) {
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`${gone}\\b`), `${gone} is retired`);
  }
});

test('a banner appearing from nothing no longer costs a re-render', () => {
  const { DevChat, published, view } = makeDevChat();
  DevChat.currentSession = { ...SESSION, behind_main: 0 };
  assert.equal(view().sync, null, 'nothing to say');

  DevChat.currentSession.behind_main = 3;
  DevChat._applySyncBanner();
  const last = published[published.length - 1];
  assert.equal(last.mounted, false, 'a publish, not a re-mount');
  // Cross-realm: the model was built in the vm, so compare it as data.
  assert.deepEqual(JSON.parse(JSON.stringify(last.state.sync)),
    { kind: 'behind', behind: 3, busy: false });
});

test('the host generates no box, so each banner stays #dc-view\'s flex child', () => {
  // A plain wrapper would take the banners' place in that flex column and
  // they would become block children of it — a different layout for the same
  // markup, and nothing would have failed to say so.
  assert.match(DEV_CHAT_SRC, /<div id="dc-banners" class="contents"><\/div>/);
  assert.doesNotMatch(BANNERS_TSX, /id="dc-banners"/, 'the component renders the CHILDREN');
});

// ── 2. The sync banner's four states ───────────────────────────────────

test('the sync banner resolves its state from the branch and the sync', () => {
  const { DevChat, view } = makeDevChat();
  DevChat.currentSession = { ...SESSION, behind_main: 1 };
  assert.deepEqual(view().sync, { kind: 'behind', behind: 1, busy: false });

  DevChat._syncState = { sessionId: 5, phase: 'resolving' };
  assert.deepEqual(view().sync, { kind: 'inflight', message: 'Resolving merge conflicts with Claude…' });

  DevChat._syncState = { sessionId: 5, terminal: true, ok: true, message: 'Synced with main.' };
  assert.deepEqual(view().sync, { kind: 'ok', message: 'Synced with main.' });

  DevChat._syncState = { sessionId: 5, terminal: true, ok: false, message: 'Nope.' };
  assert.deepEqual(view().sync, { kind: 'failed', message: 'Nope.', busy: false });

  // A terminal notice from session A must not render on session B's banner.
  DevChat._syncState = { sessionId: 99, terminal: true, ok: false, message: 'Other.' };
  assert.deepEqual(view().sync, { kind: 'behind', behind: 1, busy: false });
});

test('mid-turn the sync button says so before the click, not after', () => {
  // The route refuses with a 409 while a chat turn holds the worker.
  const { DevChat, view } = makeDevChat({ isStreaming: true });
  DevChat.currentSession = { ...SESSION, behind_main: 2 };
  assert.equal(view().sync.busy, true);
  const html = bannersHtml(view());
  assert.match(html, /id="dc-sync-btn"[^>]*disabled=""/);
  assert.match(html, /title="Claude is busy with a turn/);
});

test('each sync state draws its own shell, and only two carry a button', () => {
  const s = (sync) => bannersHtml({ sync, newChange: null, credits: null, creditsLow: null });

  const behind = s({ kind: 'behind', behind: 4, busy: false });
  assert.match(behind, /id="dc-sync-banner"/);
  assert.match(behind, /main has moved <span class="font-semibold">4<\/span> commits ahead/);
  assert.match(behind, />Sync with main<\/button>/);

  assert.match(s({ kind: 'behind', behind: 1, busy: false }), /1<\/span> commit ahead/, 'singular');

  const flight = s({ kind: 'inflight', message: 'Pushing the merged branch…' });
  assert.match(flight, /animate-spin/);
  assert.match(flight, />Syncing…<\/button>/);
  assert.match(flight, /disabled=""/);

  const ok = s({ kind: 'ok', message: 'Synced with main.' });
  assert.match(ok, /bg-emerald-50/);
  assert.doesNotMatch(ok, /<button/, 'a settled success has nothing to press');

  const failed = s({ kind: 'failed', message: 'A chat turn holds the worker.', busy: false });
  assert.match(failed, />Try again<\/button>/);
  assert.doesNotMatch(failed, /disabled=""/, 'and it is pressable when the turn has landed');
});

// ── 3. The new-change banner ───────────────────────────────────────────

test('the new-change banner appears only past the active-editing stage', () => {
  const { DevChat, view } = makeDevChat();
  for (const [status, expected] of [
    ['active', null], ['paused', null],
    ['promoted', 'proposed to the group (PR #7)'],
    ['merging', 'proposed to the group (PR #7)'],
    ['merged', 'merged (PR #7)'],
  ]) {
    DevChat.currentSession = { ...SESSION, status, pr_number: 7 };
    const got = view().newChange;
    assert.equal(got ? got.stateLabel : null, expected, status);
  }
  // No PR yet — nothing to say about bundling work into one.
  DevChat.currentSession = { ...SESSION, status: 'promoted', pr_number: null };
  assert.equal(view().newChange, null);
});

test('its button\'s busy state is published, not written onto the element', () => {
  // It was `btn.disabled` + `btn.textContent` by id — a second author on a
  // node the component renders now, and React would clobber both on its next
  // paint.
  assert.doesNotMatch(DEV_CHAT_SRC, /btn\.textContent = 'Starting…'/);
  assert.match(DEV_CHAT_SRC, /DevChat\._newChangePending = true;\s*\n\s*DevChat\._publishBanners\(\)/);
  const html = bannersHtml({
    sync: null, newChange: { stateLabel: 'merged (PR #7)', pending: true },
    credits: null, creditsLow: null,
  });
  assert.match(html, /id="dc-new-change-btn"[^>]*disabled=""/);
  assert.match(html, />Starting…</);
});

test('the one primary-filled button routes through <Button>, byte for byte', () => {
  // The shell's primitive is the rule for a violet fill
  // (tests/shell-primitive-adoption.test.js), and the point of a
  // TRANSCRIBED cva table is that adopting it moves nothing: same classes,
  // same order, same attribute order. `disabledStyle: 'dim60'` was added for
  // this call site, which is the only thing the table could not already say.
  const html = bannersHtml({
    sync: null, newChange: { stateLabel: 'merged (PR #7)', pending: false },
    credits: null, creditsLow: null,
  });
  const tag = html.match(/<button[^>]*>/)[0];
  assert.equal(
    tag,
    '<button id="dc-new-change-btn" type="button" class="rounded-md bg-violet-600 '
    + 'hover:bg-violet-500 disabled:opacity-60 disabled:cursor-not-allowed px-3 py-1 '
    + 'text-xs font-medium text-white transition-colors shrink-0">'
  );
});

test('the sync button stays hand-written, and that is the rule, not an exception', () => {
  // `bg-amber-600` is not the primary action's fill — a warning strip's
  // button is a different thing — so the adoption rule does not reach it, and
  // an amber `variant` would be a value invented for one call site in a table
  // whose whole discipline is that every value is transcribed from a button
  // that already exists.
  const at = BANNERS_TSX.indexOf('const SYNC_BTN');
  assert.ok(at !== -1, 'the sync button keeps its own class string');
  assert.match(BANNERS_TSX.slice(at, at + 260), /bg-amber-600/);
  assert.doesNotMatch(BANNERS_TSX.slice(at, at + 260), /bg-violet-600/);
});

// ── 4. The credits pair, which is one banner in two tenses ─────────────

const CREDITS = {
  id: 'dc-credits-banner', tone: 'red', icon: 'warn',
  lead: 'You’ve used up today’s free AI credits.', leadTagged: false,
  reset: 'Free credits reset at midnight UTC.', tail: ' Or keep working right now with your own API key.',
  actionsHtml: '<div class="dc-credits-banner-actions"><button type="button" id="dc-credits-add-key" class="dc-credits-banner-btn dc-credits-banner-btn-primary" data-credits-hash="#settings/api-key">Add API key</button><button type="button" class="dc-credits-banner-btn" data-credits-venue="1" data-credits-hash="#settings/cli">Change session type</button></div>',
  blockedVenue: true,
};

test('the declared checks\' hooks all survive the conversion', () => {
  const html = bannersHtml({ sync: null, newChange: null, credits: CREDITS, creditsLow: null });
  assert.match(html, /id="dc-credits-banner"/);
  // The separating space rides INSIDE this span rather than between the two,
  // because a bare `{' '}` between text runs is what tests/shell-build.test.js
  // forbids: it is the thing that makes React emit a `<!-- -->` separator, and
  // a comment node between two words is a hydration mismatch waiting to be
  // read as content. Same rendered text either way.
  assert.match(html, /<span data-credits-reset="1"> Free credits reset at midnight UTC\.<\/span>/);
  // The two-doors chain: the actions block must be a direct child of the
  // banner, with its two buttons adjacent and the venue one last.
  const actionsAt = html.indexOf('<div class="dc-credits-banner-actions">');
  assert.ok(actionsAt !== -1, 'the actions block is in the banner');
  const actions = html.slice(actionsAt, html.indexOf('</div>', actionsAt) + 6);
  assert.match(actions, /^<div class="dc-credits-banner-actions"><button/, 'button is a DIRECT child');
  assert.match(actions, /id="dc-credits-add-key"[\s\S]*?<button[^>]*data-credits-venue="1"/,
    'and the venue button is its adjacent sibling');
  assert.match(actions, /data-credits-venue="1"[^>]*>[^<]*<\/button><\/div>$/, 'and the LAST child');
  // …which is why the module's markup arrives WHOLE, through a host that
  // generates no box.
  assert.match(BANNERS_TSX, /className="contents" dangerouslySetInnerHTML/);
});

test('the low banner is the same shape, tagged for its own check', () => {
  const low = {
    ...CREDITS, id: 'dc-credits-low-banner', tone: 'amber', icon: 'clock',
    lead: 'Running low on free AI credits — $5.00 of $25.00 left today.',
    leadTagged: true, blockedVenue: false,
  };
  const html = bannersHtml({ sync: null, newChange: null, credits: null, creditsLow: low });
  assert.match(html, /id="dc-credits-low-banner"/);
  assert.match(html, /<span class="font-semibold" data-credits-low-lead="1">Running low/);
  assert.match(html, /data-credits-reset="1"/);
  assert.match(html, /id="dc-credits-add-key"/);
});

test('the copy is RAW text — React escapes it, so entities would be literal', () => {
  const html = bannersHtml({ sync: null, newChange: null, credits: CREDITS, creditsLow: null });
  assert.match(html, /You’ve used up today’s free AI credits\./);
  assert.doesNotMatch(html, /&amp;rsquo;|&rsquo;/);
  assert.doesNotMatch(DEV_CHAT_SRC, /&rsquo;ve used up/, 'and the model carries no entities either');
});

test('the red banner blocks the venue it just refused; the amber one does not', () => {
  // Marking the in-chat venue unavailable while credits are merely LOW would
  // be a lie told early.
  const { DevChat, view } = makeDevChat();
  DevChat.currentSession = SESSION;
  DevChat.budget = { spentCents: 100, limitCents: 100, globalSpentCents: 0, globalLimitCents: 100 };
  const v = view();
  assert.equal(v.credits && v.credits.blockedVenue, true);
  assert.match(BANNERS_TSX, /b\.blockedVenue[\s\S]{0,140}?blocked: true/);
});

test('the three reasons the red banner can appear each state their own remedy', () => {
  const { DevChat, view } = makeDevChat();
  DevChat.currentSession = SESSION;
  DevChat.budget = { spentCents: 100, limitCents: 100, globalSpentCents: 0, globalLimitCents: 100 };

  DevChat._creditState = () => ({ level: 'locked' });
  let v = view().credits;
  assert.equal(v.icon, 'person');
  assert.match(v.lead, /Connect GitHub or X/);
  assert.equal(v.reset, null, 'there is no allowance to reset yet');

  DevChat._creditState = () => ({ level: 'unavailable' });
  v = view().credits;
  assert.equal(v.icon, null, 'a verification blip gets no alarm glyph');
  assert.match(v.lead, /could not be verified/);

  DevChat._creditState = () => ({ level: 'exhausted' });
  v = view().credits;
  assert.equal(v.tone, 'red');
  assert.ok(v.reset, 'and this one says when it comes back');
});

test('CreditOptions is wired from the component, and its guard makes that safe', () => {
  // `wire` binds ONE delegated click per element and marks it — so a ref that
  // runs on every mount is right, and adding a listener is not a DOM write,
  // which is why this seam needs no ownership-audit exception.
  assert.match(CREDIT_OPTIONS_SRC, /root\.__creditOptionsWired/);
  assert.match(BANNERS_TSX, /CO\?\.wire\?\.\(el, \{/);
  assert.doesNotMatch(DEV_CHAT_SRC, /CreditOptions\.wire\(banner/);
});
