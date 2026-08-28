// `#dc-session-header` — the dev chat's top strip, converted.
//
// It is the one row that survives every swap below it: the launchpad replaces
// the composer for the three hand-off venues (#1281), the banners come and go,
// the transcript is rebuilt, and the back control, the session's name, its
// pull request, its lifecycle pill and the venue dropdown stay put.
//
// What this file is weighted toward, in order:
//
//   1. THE VENUE BUTTON'S POSITION. `dapp.json` selects it as
//      `#dc-session-header > button#dc-venue-select…:last-child` — a DIRECT
//      child, and the LAST one. That is why `BuildVenues.selectorHtml` could
//      not survive the conversion as a string: interpolating it through a
//      `dangerouslySetInnerHTML` sink would have made the wrapper the direct
//      child and the button a grandchild. Its markup is asserted here in the
//      shape the check reads it.
//   2. THE HEADER ELEMENT IS NOT OURS. `PlatformUI.attachScreenFx` writes a
//      hairline class onto it once the chat scrolls, so `renderChatView`'s
//      template keeps writing the element and only the children are React's.
//   3. THE MID-TURN PATCH. `_patchHeaderStatusPill` exists so a live stream is
//      not disturbed by a full `renderChatView`. It wrote
//      `#dc-status-pill.innerHTML`; it publishes now, which re-renders the
//      header alone.
//
// Run with: node --test tests/dev-session-header.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const VENUES_SRC = read('public', 'js', 'build-venues.js');
const MERGE_STATUS_SRC = read('public', 'js', 'merge-status.js');
const HEADER_TSX = read('frontend', 'src', 'features', 'dev-chat', 'session-header.tsx');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-session-header-api.ts')));

/** Render the strip from a published state, as the portal does. */
function headerHtml(state, preview) {
  const m = mod();
  m.sessionHeaderStore.set(JSON.parse(JSON.stringify(state)));
  // The mode switch reads these three off the improve store. Reset every
  // time so one test's preview cannot leak into the next one's rest state.
  m.improveStore.set({
    previewSessionId: null, previewUrl: null, previewActive: false, ...(preview || {}),
  });
  return renderToHtml(createElement(m.SessionHeader, {}));
}

// The module under vm, with `BuildVenues` and `MergeStatus` real — both are
// plain browser scripts and both are what the header model reads.
function makeDevChat(over = {}) {
  const host = { id: 'dc-session-header' };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentApp: 'recipe-box', switchTab: () => {} },
    document: {
      getElementById: (id) => (id === 'dc-session-header' ? host : null),
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
      mountSessionHeader: (_h, state) => published.push({ mounted: true, state }),
      publishSessionHeader: (state) => published.push({ mounted: false, state }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${VENUES_SRC}\n${MERGE_STATUS_SRC}\n${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`,
    sandbox
  );
  const DevChat = sandbox.__DevChat;
  Object.assign(DevChat, over);
  // `_sessionHeaderView` reads `DevChat.currentSession` — deliberately, so
  // the venue has one resolver — so setting it is how a case picks a session.
  // Cross-realm: the model is read in this realm, so copy it out as data.
  const view = (session) => {
    DevChat.currentSession = session;
    return JSON.parse(JSON.stringify(DevChat._sessionHeaderView()));
  };
  return { DevChat, sandbox, published, view, host };
}

const SESSION = {
  id: 5, session_title: 'Widget language', branch_name: 'dev/evan-1', status: 'active',
};

// ── 1. The venue button ────────────────────────────────────────────────

test('the venue button is the LAST direct child, with the attributes the check reads', () => {
  const { view } = makeDevChat();
  const html = headerHtml(view({ ...SESSION, agent_backend: 'codex_openrouter' }));

  assert.match(html, /<button[^>]*id="dc-venue-select"/);
  assert.match(html, /data-venue-change="1"/);
  assert.match(html, /data-venue-current="usernode-openrouter"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /class="dc-venue-name">Usernode · OpenRouter</);
  // LAST: nothing is rendered after it. The portal puts these children
  // directly under `#dc-session-header`, so `>` and `:last-child` both hold.
  assert.match(html, /<\/button>$/, 'the strip ends with the venue button');
  assert.equal(html.indexOf('dc-venue-select') > html.indexOf('New change'), true);
});

test('the caption sentence is the TOOLTIP, never the label', () => {
  // The control sits beside a truncating session title, so the whole
  // explanation the old composer caption carried survives only on hover.
  const { view } = makeDevChat();
  const v = view({ ...SESSION, agent_backend: 'codex_openrouter' });
  assert.match(v.venue.title, /^Building in Usernode · OpenRouter\./);
  assert.equal(v.venue.label, 'Usernode · OpenRouter');
  assert.doesNotMatch(v.venue.label, /Building in/);
});

test('an imported proposal reports its own venue', () => {
  const { view } = makeDevChat();
  const v = view({ ...SESSION, source: 'imported', agent_backend: 'claude_code' });
  assert.equal(v.venue.id, 'own-tools-pr');
  assert.equal(v.venue.label, 'Your computer · your own tools');
});

test('an unknown venue renders no button rather than half of one', () => {
  const { DevChat, view } = makeDevChat();
  DevChat._currentVenueId = () => 'nope';
  const v = view(SESSION);
  assert.equal(v.venue, null);
  assert.doesNotMatch(headerHtml(v), /dc-venue-select/);
});

test('mid-turn the venue cannot be changed', () => {
  // A running turn holds the worker, and moving it under itself is the
  // failure the old `agentSelect.disabled` guarded against.
  const { view } = makeDevChat({ isStreaming: true });
  assert.equal(view(SESSION).venue.disabled, true);
  assert.match(headerHtml(view(SESSION)), /<button[^>]*disabled=""/);
});

// ── 2. The rest of the strip ───────────────────────────────────────────

test('the strip carries no back control — the platform header owns ← now', () => {
  // Streamlined Concept: the session bar leads with the header's own
  // #back-btn (App.setBackIcon('arrow', '#app/<slug>/board') on the way in),
  // and its plain click walks app.js's handleBack chain into
  // DevChat.handleBack → leaveSession. The in-strip #dc-back retired.
  const { view, DevChat, sandbox } = makeDevChat();
  assert.doesNotMatch(headerHtml(view(SESSION)), /dc-back/);
  // The decline contract: no session → false (the chain keeps walking);
  // a session → handled, and the session is left.
  DevChat.currentSession = null;
  assert.equal(DevChat.handleBack(), false);
  DevChat.currentSession = { ...SESSION };
  let switched = null;
  sandbox.App.switchTab = (tab) => { switched = tab; };
  assert.equal(DevChat.handleBack(), true);
  assert.equal(switched, 'dev', 'backing out of a session lands on the Board');
  // And app.js's header listener actually consults it, before the
  // navigate-home fallback.
  const appJs = read('public', 'js', 'app.js');
  const chainAt = appJs.indexOf("window.DevChat?.handleBack?.()");
  const homeAt = appJs.indexOf('App.navigateHome();', appJs.indexOf("getElementById('back-btn').addEventListener"));
  assert.ok(chainAt !== -1 && chainAt < homeAt, 'DevChat.handleBack precedes the home fallback');
});

test('a session with a pull request offers it; one without says so', () => {
  const { view } = makeDevChat();
  const withPr = headerHtml(view({ ...SESSION, pr_number: 42 }));
  assert.match(withPr, /id="dc-pr-header-link"[^>]*>PR #42</);
  assert.match(withPr, /title="[^"]*goes to PR #42/);

  const without = headerHtml(view(SESSION));
  assert.doesNotMatch(without, /dc-pr-header-link/);
  assert.match(without, /New change</);
});

test('the title falls back through its three sources, and the branch is the tooltip', () => {
  const { view } = makeDevChat();
  assert.equal(view({ ...SESSION }).title, 'Widget language');
  assert.equal(view({ branch_name: 'b', pr_title: 'From the PR' }).title, 'From the PR');
  assert.equal(view({ branch_name: 'only-a-branch' }).title, 'only-a-branch');
  assert.equal(view({}).title, 'Session');
  assert.match(headerHtml(view(SESSION)), /title="dev\/evan-1"/);
});

// ── 3. The lifecycle pill (in the TOP BAR now) ─────────────────────────
//
// Streamlined Concept: the Figma session bar leads with ← and the
// `Checks run…` pill, so MergeStatusPill renders in the platform header
// (#header-status-pill, frontend/src/features/header/platform-header.tsx)
// from this same store — the strip carries the Building/Preview MODE chip
// instead. The pill's own rendering is asserted on the component directly.

/** Render the pill alone, as the platform header does. */
function pillHtml(life) {
  const m = mod();
  return renderToHtml(createElement(m.MergeStatusPill, { life: JSON.parse(JSON.stringify(life)) }));
}

test('the pill draws MergeStatus\'s descriptor, tone and glyph included', () => {
  const { view } = makeDevChat();
  const html = pillHtml(view({ ...SESSION, check_state: 'passing' }).life);
  assert.match(html, /class="ms-pill ms-pill-green"/);
  assert.match(html, /✓ Checks passed/, 'glyph and label are ONE text run, as the string version emitted');
});

test('an in-vote session carries its tally, and its advisory surplus separately', () => {
  const { view } = makeDevChat();
  const html = pillHtml(view({
    ...SESSION, status: 'promoted', check_state: 'passing',
    yes_count: 1, no_count: 0, majority: 3,
    qualified_yes_count: 1, approval_policy: 'invited', approvals_required: 3,
  }).life);
  assert.match(html, /ms-pill/);
  assert.match(html, / · 1\/3/, 'the header has no vote pill of its own, so the tally rides in the label');
});

test('the strip hosts no lifecycle pill — the header chip does', () => {
  const { view } = makeDevChat();
  const html = headerHtml(view({ ...SESSION, check_state: 'passing' }));
  assert.doesNotMatch(html, /dc-status-pill/);
  assert.doesNotMatch(html, /ms-pill/);
  // The pill's seat moved from the bar's left slot INTO the chip, as its
  // subtitle. On a new change the old arrangement drew the lifecycle alone —
  // the chip was empty on this route — so the top of the screen said "Draft"
  // and never said which app was being changed. Same store, same component,
  // same id, one control.
  const chipTsx = read('frontend', 'src', 'features', 'header', 'app-switcher-chip.tsx');
  assert.match(chipTsx, /id="header-status-pill"/);
  assert.match(chipTsx, /sessionHeaderStore/);
  assert.match(chipTsx, /MergeStatusPill/);
  assert.match(chipTsx, /subTab === 'sessions'/, 'the lifecycle subtitle is the session route’s');
  // And it is gone from the bar, so there is exactly one seat for it.
  const headerTsx = read('frontend', 'src', 'features', 'header', 'platform-header.tsx');
  assert.doesNotMatch(
    headerTsx.replace(/\/\/.*$/gm, ''),
    /id="header-status-pill"/,
    'the bar no longer hosts a second lifecycle seat',
  );
});

test('with no preview built yet the strip is the bare Building chip', () => {
  const { view } = makeDevChat();
  const rest = headerHtml(view(SESSION));
  assert.doesNotMatch(rest, /dc-mode-chip/, 'absent at rest');
  assert.doesNotMatch(rest, /dc-mode-switch/, 'and no switch — there is nothing to see');
  const busy = headerHtml({ ...view(SESSION), busy: true });
  assert.match(busy, /id="dc-mode-chip"[^>]*>Building</);
  assert.doesNotMatch(busy, /dc-mode-switch/);
});

// The doing<->seeing loop. It was an eye/pencil pair in the PLATFORM HEADER's
// right slot, where it displaced Improve; Improve is the header's standing
// action now, so the loop moved down here, beside the name of the change it
// acts on. The retired `#dc-mode-chip` is the active segment's label.
test('once a preview exists the strip draws the doing<->seeing switch', () => {
  const { view } = makeDevChat();
  const doing = headerHtml({ ...view(SESSION), busy: true },
    { previewSessionId: 7, previewUrl: 'https://staging.example/x' });

  assert.match(doing, /id="dc-mode-switch"/);
  assert.match(doing, /id="app-eye-btn"[^>]*aria-pressed="false"/, 'not seeing');
  assert.match(doing, /id="session-build-btn"[^>]*aria-pressed="true"/, 'doing is current');
  // The current segment carries the word, and it is the chip's id.
  assert.match(doing, /id="session-build-btn"[\s\S]{0,900}?id="dc-mode-chip"[^>]*>Building</);
  // ONE control: the fill is a single THUMB that slides between the two
  // segments, not a pill on each. So the colour is on the thumb and the ink
  // is on the segment it is under.
  assert.match(doing, /aria-hidden="true"[^>]*bg-violet-600/, 'the thumb is the accent under doing');
  assert.match(doing, /id="session-build-btn"[^>]*text-white/, 'and the doing segment takes white ink');
  assert.equal((doing.match(/bg-violet-600|bg-amber-300/g) || []).length, 1,
    'exactly one fill in the control — two would be two buttons again');

  const seeing = headerHtml({ ...view(SESSION), busy: true },
    { previewSessionId: 7, previewUrl: 'https://staging.example/x', previewActive: true });
  assert.match(seeing, /id="app-eye-btn"[^>]*aria-pressed="true"/);
  assert.match(seeing, /id="session-build-btn"[^>]*aria-pressed="false"/);
  assert.match(seeing, /id="app-eye-btn"[\s\S]{0,900}?id="dc-mode-chip"[^>]*>Preview</);
  assert.match(seeing, /aria-hidden="true"[^>]*bg-amber-300/, 'the thumb slides under seeing, in yellow');
  assert.match(seeing, /id="app-eye-btn"[^>]*text-zinc-900/, 'and the eye segment takes dark ink');
  assert.equal((seeing.match(/bg-violet-600|bg-amber-300/g) || []).length, 1, 'still one fill');
  // Only ONE label at a time — the chip is the current mode, not both.
  assert.equal((seeing.match(/id="dc-mode-chip"/g) || []).length, 1);
});

test('the label belongs to the THUMB, so both sides carry one', () => {
  // It used to say `Building` only while a turn ran, which left the thumb
  // wordless half the time and made the two sides look like different
  // controls. A switch that reads `Preview` in one position reads `Building`
  // in the other.
  const { view } = makeDevChat();
  const rest = headerHtml(view(SESSION),
    { previewSessionId: 7, previewUrl: 'https://staging.example/x' });
  assert.match(rest, /id="dc-mode-switch"/);
  assert.match(rest, /id="session-build-btn"[^>]*aria-pressed="true"/);
  assert.match(rest, /id="dc-mode-chip"[^>]*>Building</,
    'idle or busy, the doing side is labelled');
  assert.equal((rest.match(/id="dc-mode-chip"/g) || []).length, 1, 'and only one side is');
});

test('the mid-turn repaint publishes instead of writing innerHTML', () => {
  const { DevChat, published } = makeDevChat();
  DevChat.currentSession = { ...SESSION, check_state: 'passing' };
  DevChat._repaintSessionHeader();

  assert.equal(published.length, 1);
  assert.equal(published[0].mounted, false, 'a repaint never re-mounts the portal');
  assert.equal(published[0].state.life.key, 'checks_passed');
  // The whole point of it is that it does NOT re-render the view.
  const at = DEV_CHAT_SRC.indexOf('_repaintSessionHeader() {');
  assert.ok(at !== -1);
  assert.doesNotMatch(DEV_CHAT_SRC.slice(at, at + 400), /renderChatView\(\)/);
  assert.doesNotMatch(DEV_CHAT_SRC, /dc-status-pill'\)[\s\S]{0,80}?innerHTML/,
    'and nothing writes that span by hand any more');
});

test('the streaming guard is a republish, not a second writer on the button', () => {
  // `_setStreamingUI` set `#dc-venue-select.disabled` in place. A rendered
  // `disabled` would clobber that on React's next paint, so the guard is
  // `_headerVenue`'s resolved field and the sync republishes the strip.
  const { DevChat, published } = makeDevChat();
  DevChat.currentSession = SESSION;
  DevChat.isStreaming = true;
  DevChat._repaintSessionHeader();
  assert.equal(published[0].state.venue.disabled, true);
  assert.doesNotMatch(DEV_CHAT_SRC, /venueChange\.disabled/);
});

// ── 4. The seams that stayed ───────────────────────────────────────────

test('the header ELEMENT carries a CONSTANT className', () => {
  // The whole screen is a component now, so the element is rendered rather
  // than written — but its class string is a literal, not a prop derived
  // from state, because `PlatformUI.attachScreenFx` writes a hairline class
  // onto that node once the chat scrolls and React never rewrites a
  // className whose prop has not changed.
  const VIEW_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'view.tsx'), 'utf8');
  const at = VIEW_TSX.indexOf('id="dc-session-header"');
  assert.ok(at > 0, 'the screen renders the element');
  const tag = VIEW_TSX.slice(at, VIEW_TSX.indexOf('>', at));
  assert.match(tag, /className="[^"{]*"/, 'a literal, never an expression');
  assert.doesNotMatch(HEADER_TSX, /id="dc-session-header"/,
    'the header component renders the CHILDREN, never the host');
  // attachScreenFx writes onto that element, which is why.
  assert.match(DEV_CHAT_SRC, /attachScreenFx\([\s\S]{0,700}?getElementById\('dc-session-header'\)/);
});

test('the header publishes its whole state in one call', () => {
  // It used to mount its own portal, with the state riding in so the one row
  // that is constant on this screen never painted empty. The screen mounts
  // once now (features/dev-chat/view.tsx), so this is a publish — and the
  // no-blink guarantee comes from `renderChatView` calling it on the line
  // after that mount, inside the same synchronous flush.
  const { DevChat, published, sandbox } = makeDevChat();
  DevChat.currentSession = SESSION;
  DevChat._renderSessionHeader();
  assert.equal(published.length, 1);
  assert.equal(published[0].state.venue.id, 'usernode-claude');
  assert.ok(sandbox); // the host was resolved by id
});

test('BuildVenues.selectorHtml is retired, and nothing still calls it', () => {
  assert.doesNotMatch(VENUES_SRC, /function selectorHtml/);
  assert.doesNotMatch(VENUES_SRC, /selectorHtml: selectorHtml/);
  assert.doesNotMatch(DEV_CHAT_SRC, /BuildVenues\.selectorHtml/);
  // The venue LOOKUP it did is what the model reads instead.
  assert.match(DEV_CHAT_SRC, /BuildVenues\.venue\(DevChat\._currentVenueId\(\)\)/);
  // noteHtml and chipHtml stay strings — their callers still are.
  assert.match(VENUES_SRC, /function noteHtml/);
  assert.match(VENUES_SRC, /function chipHtml/);
});
