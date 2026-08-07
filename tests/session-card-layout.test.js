// In-progress session cards: the two-row card layout (title row + wrapping
// actions row) that fixes the crushed-title / crazy-tall card in the busy
// "working" state, the explicit "Open chat" action on visible own sessions,
// and the private/visible split around the "Show archived" toggle in both
// the kanban In progress column (_inProgressCardsHtml) and the list view's
// pinned block (_mySessionsBlockHtml).
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the returned
// HTML strings — same harness as dev-kanban-buckets.test.js.
//
// Run with: node --test tests/session-card-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  return makeCtx().__AppView;
}

const mySess = (over) => ({
  id: 51, session_title: 'My session', status: 'active',
  created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T02:00:00Z',
  ...over,
});
const sharedSess = (over) => ({
  id: 71, session_title: 'Their session', status: 'active', username: 'them',
  user_id: 9, shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T00:00:00Z',
  chat_count: 2,
  ...over,
});

// Assert every marker is present and they appear in the given order.
function assertOrder(html, markers) {
  let prev = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    assert.ok(i >= 0, `expected marker in html: ${m}`);
    assert.ok(i > prev, `expected marker in order: ${m}`);
    prev = i;
  }
}

// Structural markers for the two-row card: the chevron path closes the
// title row, so anything indexed AFTER it lives in the actions row.
const CHEVRON = 'M9 5l7 7-7 7';
const ACTIONS_ROW = 'flex flex-wrap items-center gap-2';
const SPINNER = 'dc-status-spinner-arc';

// ── Two-row layout ──────────────────────────────────────────────────────────

test('busy own card: controls sit in a wrapping actions row below the title', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ busy: true }));
  assert.match(html, /break-words/, 'title still word-wraps');
  assert.ok(html.includes(ACTIONS_ROW), 'actions row container flex-wraps');
  // Title row ends at the chevron; the busy tag, visibility button and
  // Archive all come after it (i.e. in the actions row, not beside the
  // title where they could crush it to zero width).
  assertOrder(html, ['break-words', CHEVRON, ACTIONS_ROW, SPINNER, 'Make visible', 'data-archive-chip="51"']);
});

test('shared card: badge + Preview sit in the actions row; noNav drops nav and chevron', () => {
  const AppView = makeAppView();
  const s = sharedSess({ busy: true, staging_url: 'https://example.invalid' });
  const nav = AppView._renderSharedSessionCard(s);
  assert.match(nav, /data-shared-session-row="71"/);
  assertOrder(nav, ['break-words', CHEVRON, ACTIONS_ROW, SPINNER, 'dev-chat-badge', 'Preview']);

  const noNav = AppView._renderSharedSessionCard(s, { noNav: true });
  assert.doesNotMatch(noNav, /data-shared-session-row/, 'noNav variant has no row hook');
  assert.ok(!noNav.includes(CHEVRON), 'noNav variant has no chevron');
  assert.ok(noNav.includes(ACTIONS_ROW), 'noNav variant keeps the actions row');
});

// ── Preview pill gating (#689) ──────────────────────────────────────────────

test('shared card: can_preview without a live staging_url still gets Preview (empty fallback)', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.match(html, /Preview<\/button>/);
  // Routed through ensure-staging with no last-known URL — the server
  // decides live-vs-rebuild.
  assert.match(html, /swapToStagingForSession\(71, ''\)/);
});

test('shared card: no pushed changes (can_preview false) → no Preview pill', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: false, staging_url: null }));
  assert.doesNotMatch(html, /Preview<\/button>/);
});

test('shared card, read-only viewer: pill requires a live staging_url', () => {
  const AppView = makeAppView();
  // readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { can_collaborate: false };
  const rebuildOnly = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.doesNotMatch(rebuildOnly, /Preview<\/button>/, 'read-only viewers cannot trigger a rebuild');
  const live = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: 'https://example.invalid' }));
  assert.match(live, /Preview<\/button>/, 'a live URL still opens directly');
  assert.match(live, /swapToStagingForSession\(71, 'https:\/\/example\.invalid'\)/);
});

test('own card: Preview pill gated on pr_number (a PR exists once changes are pushed)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const withPr = AppView._renderMySessionCard(mySess({ pr_number: 123 }));
  assert.match(withPr, /Preview<\/button>/);
  assert.match(withPr, /swapToStagingForSession\(51, ''\)/);
  const noPr = AppView._renderMySessionCard(mySess({ pr_number: null }));
  assert.doesNotMatch(noPr, /Preview<\/button>/);
});

// ── "Open chat" on visible own sessions ─────────────────────────────────────

test('visible own card renders the labeled Open chat button (count from _sharedById)', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 4 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.match(html, /Open chat/, 'labeled button text');
  assert.match(html, /data-session-discuss="51"/, 'delegated discuss hook');
  assert.match(html, /data-count="4"/, 'badge carries the shared row count');
  assert.match(html, /data-unshare-chip="51"/, 'Hide stays available');
});

test('freshly-visible card (no _sharedById row yet) still gets Open chat at count 0', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.match(html, /Open chat/);
  assert.match(html, /data-session-discuss="51"/);
  assert.match(html, /data-count="0"/);
});

test('private own card has no Open chat and keeps Make visible', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({}));
  assert.doesNotMatch(html, /Open chat/);
  assert.doesNotMatch(html, /data-session-discuss/);
  assert.match(html, /data-share-chip="51"/, 'Make visible renders');
});

// ── Transcript sharing: the second, narrower opt-in ─────────────────────────

test('private own card offers NO chat-sharing chip (nowhere to read it from yet)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({}));
  assert.doesNotMatch(html, /data-transcript-chip/);
  assert.doesNotMatch(html, /data-untranscript-chip/);
  assert.doesNotMatch(html, /chat readable/);
  assert.match(html, /Your dev session/, 'subtitle unchanged for a private session');
});

test('visible own card offers "Share chat"; the subtitle stays plain', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.match(html, /data-transcript-chip="51"/, 'the opt-in chip renders');
  assert.match(html, />Share chat</);
  assert.doesNotMatch(html, /data-untranscript-chip/);
  // Visible ≠ readable: the card must not claim the chat is shared.
  assert.match(html, /Visible to everyone</);
  assert.doesNotMatch(html, /chat readable/);
});

test('chat-shared own card flips to the revoke chip and says so in the subtitle', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({
    shared_at: '2026-06-01T03:00:00Z',
    transcript_shared_at: '2026-06-01T03:05:00Z',
  }));
  assert.match(html, /data-untranscript-chip="51"/);
  assert.match(html, />Chat shared</);
  assert.doesNotMatch(html, /data-transcript-chip/);
  assert.match(html, /Visible to everyone · chat readable/);
});

test('the chat-sharing chip sits between Open chat and Hide in the actions row', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assertOrder(html, [
    CHEVRON, ACTIONS_ROW, 'data-session-discuss="51"',
    'data-transcript-chip="51"', 'data-unshare-chip="51"', 'data-archive-chip="51"',
  ]);
});

test('shared card: "Read chat" only when the owner published the transcript', () => {
  const AppView = makeAppView();
  const off = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: false }));
  assert.doesNotMatch(off, /data-read-chat/);

  const on = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: true }));
  assert.match(on, /data-read-chat="71"/);
  assert.match(on, />Read chat</);
});

test('shared card: "Read chat" is dropped in the noNav (topic-head) variant', () => {
  // On the topic page you're already looking at the transcript section, so a
  // chip that navigates to the page you're on would be dead weight.
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(
    sharedSess({ transcript_shared: true }), { noNav: true });
  assert.doesNotMatch(html, /data-read-chat/);
});

test('read-only viewers still get "Read chat" (published group content)', () => {
  // #621: read-only viewers may READ a shared transcript — it's the fork
  // action that needs collab access, and that lives in the transcript
  // section (see _transcriptActionsHtml), not on this card.
  const AppView = makeAppView();
  // readOnly is a getter over appData.can_collaborate (#621) — assigning
  // AppView.readOnly directly is a silent no-op.
  AppView.appData = { can_collaborate: false };
  const html = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: true }));
  assert.match(html, /data-read-chat="71"/);
});

// ── The transcript section + fork button on the topic page ──────────────────

test('transcript section renders only when the item reports the chat shared', () => {
  const AppView = makeAppView();
  assert.strictEqual(AppView._transcriptSectionHtml({ id: 5 }), '');
  assert.strictEqual(AppView._transcriptSectionHtml({ id: 5, transcript_shared: false }), '');
  assert.strictEqual(AppView._transcriptSectionHtml(null), '');

  // Shared-session / proposal rows carry the boolean…
  const shared = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true, message_count: 9 });
  assert.match(shared, /data-transcript-section="5"/);
  assert.match(shared, /data-transcript-toggle="5"/);
  assert.match(shared, /data-transcript-body="5"/);
  assert.match(shared, /read-only/);
  // …the viewer's OWN rows carry the timestamp instead (the owner gets the
  // section too, as the "preview what everyone else sees" path).
  const mine = AppView._transcriptSectionHtml({ id: 5, transcript_shared_at: '2026-07-01T00:00:00Z' });
  assert.match(mine, /data-transcript-section="5"/);
});

test('transcript section starts collapsed unless the reader asked to read it', () => {
  const AppView = makeAppView();
  const collapsed = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /hidden/);

  AppView._transcriptOpen = 5;
  const open = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true });
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /data-transcript-body="5" hidden/);
});

test('an expanded transcript SURVIVES a topic-head repaint', () => {
  // _renderTopicHead re-innerHTML's the head on every WS/poll refresh, so
  // an open flag held only in the DOM gets wiped seconds after the reader
  // expands the chat (observed in the browser before this was state-backed).
  // Re-rendering the section must therefore paint it open again.
  const AppView = makeAppView();
  const item = { id: 5, transcript_shared: true, message_count: 3 };
  AppView._transcriptOpen = 5;
  for (let repaint = 0; repaint < 3; repaint++) {
    assert.match(AppView._transcriptSectionHtml(item), /aria-expanded="true"/,
      'stays expanded across repaints');
  }
  // …and an explicit collapse likewise sticks across repaints.
  AppView._transcriptOpen = null;
  assert.match(AppView._transcriptSectionHtml(item), /aria-expanded="false"/);
  // The flag is per-session: another session's open state never leaks.
  AppView._transcriptOpen = 5;
  assert.match(
    AppView._transcriptSectionHtml({ id: 6, transcript_shared: true }),
    /aria-expanded="false"/
  );
});

test('"Fork this chat" follows the server can_fork flag, and never for read-only viewers', () => {
  const AppView = makeAppView();
  assert.match(AppView._transcriptActionsHtml({ id: 5, can_fork: true }), /data-fork-chat="5"/);
  // The owner's own chat: nothing to fork (that's "Start a new change").
  assert.strictEqual(AppView._transcriptActionsHtml({ id: 5, can_fork: false, is_owner: true }), '');
  assert.strictEqual(AppView._transcriptActionsHtml(null), '');

  // A dev chat spends the viewer's own AI budget and its API is
  // collab-gated, so a read-only viewer is never offered the button.
  // (readOnly is a getter over appData.can_collaborate — see #621.)
  AppView.appData = { can_collaborate: false };
  assert.strictEqual(AppView._transcriptActionsHtml({ id: 5, can_fork: true }), '');
});

// ── Private/visible split around the archived toggle ────────────────────────

const issueEntry = () => ({
  kind: 'issue',
  item: {
    number: 5, title: 'Issue five', headless: { status: 'generating' },
    priority: null, assignee: null,
  },
});

test('kanban In progress: private → archived toggle → visible → issues → shared', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 1, session_title: 'Private one' }) },
    { kind: 'my-session', item: mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }) },
    issueEntry(),
    { kind: 'shared-session', item: sharedSess({ id: 71 }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assertOrder(html, [
    'Only you can see your active sessions.',
    'data-session-chip="1"',
    'Show archived (1)',
    'Visible to everyone —',
    'data-session-chip="2"',
    'Issue five',
    'data-shared-session-row="71"',
  ]);
});

test('kanban In progress: no private sessions → no private caption; block still renders', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Only you can see your active sessions/);
  assertOrder(html, ['Visible to everyone —', 'data-session-chip="2"']);
});

test('kanban In progress: no visible sessions → nothing below the archived toggle', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, status: 'archived' })];
  const entries = [{ kind: 'my-session', item: mySess({ id: 1 }) }];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Visible to everyone —/);
  assertOrder(html, ['Only you can see your active sessions.', 'data-session-chip="1"', 'Show archived (1)']);
});

test('list view pinned block mirrors the split', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [
    mySess({ id: 1, session_title: 'Private one' }),
    mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }),
  ];
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const html = AppView._mySessionsBlockHtml();
  assertOrder(html, [
    'Only you can see your active sessions.',
    'data-session-chip="1"',
    'Show archived (1)',
    'Visible to everyone —',
    'data-session-chip="2"',
  ]);
});

test('list view pinned block: only a visible session still renders (no private caption)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' })];
  AppView._archivedSessions = [];
  const html = AppView._mySessionsBlockHtml();
  assert.notEqual(html, '');
  assert.doesNotMatch(html, /Only you can see your active sessions/);
  assertOrder(html, ['Visible to everyone —', 'data-session-chip="2"']);
});

test('list view pinned block: nothing to show → empty string', () => {
  const AppView = makeAppView();
  AppView._mySessions = [];
  AppView._archivedSessions = [];
  assert.equal(AppView._mySessionsBlockHtml(), '');
});

// ── #1038: the "working…" tag is driven by live state, not by the row ────
//
// The board used to re-pull three payloads every 15s just to notice this
// tag had flipped. It now renders through window.SessionState, so a pushed
// transition repaints it — in both directions.

const SESSION_STATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'session-state.js'), 'utf8'
);

// app-view.js with the live store loaded alongside it, as index.html does.
function makeAppViewWithStore() {
  const sandbox = makeCtx();
  vm.runInContext(SESSION_STATE_SRC, sandbox);
  return { AppView: sandbox.__AppView, SessionState: sandbox.window.SessionState };
}

test('status tag: falls back to the fetched row when the store knows nothing', () => {
  const AppView = makeAppView();
  assert.match(AppView._sessionStatusTagHtml(mySess({ busy: true })), /working…/);
  assert.doesNotMatch(AppView._sessionStatusTagHtml(mySess({ busy: false })), /working…/);
});

test('status tag: a live busy event beats a fetched row that said idle', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  const s = mySess({ id: 51, busy: false });
  assert.doesNotMatch(AppView._sessionStatusTagHtml(s), /working…/);

  SessionState.applyEvent({ sessionId: 51, busy: true, status: 'active' });
  assert.match(AppView._sessionStatusTagHtml(s), /working…/,
    'the card spins on the pushed transition, not on the next fetch');
});

test('status tag: a live idle event clears a spinner the fetched row still asserts', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  // The stale-snapshot case — this is the phantom spinner users report.
  const s = mySess({ id: 51, busy: true });
  assert.match(AppView._sessionStatusTagHtml(s), /working…/);

  SessionState.applyEvent({ sessionId: 51, busy: false, status: 'paused' });
  const html = AppView._sessionStatusTagHtml(s);
  assert.doesNotMatch(html, /working…/);
});

test('status tag: a paused session with no live entry still shows "paused"', () => {
  const { AppView } = makeAppViewWithStore();
  const html = AppView._sessionStatusTagHtml(mySess({ busy: false, status: 'paused' }));
  assert.match(html, /paused/);
  assert.doesNotMatch(html, /working…/);
});

test('a shared session card picks up live busy state too', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  AppView._sharedById = {};
  const s = sharedSess({ id: 71, busy: false });
  assert.doesNotMatch(AppView._renderSharedSessionCard(s), /working…/);

  SessionState.applyEvent({ sessionId: 71, busy: true, status: 'active' });
  assert.match(AppView._renderSharedSessionCard(s), /working…/,
    "another user's shared card updates for every viewer");
});

test('the 15s _stripTimer and the 8s headless poller are gone', () => {
  const AppView = makeAppView();
  assert.equal(AppView._syncSessionPolling, undefined,
    'replaced by the SessionState subscription');
  assert.equal(AppView._syncHeadlessPolling, undefined,
    'replaced by _onSessionStateEvent patching the cached issue row');
  assert.equal(AppView._stripTimer, undefined);
  assert.equal(AppView._headlessPollTimer, undefined);
});

test('_onSessionStateEvent patches the cached issue row for an auto-run', () => {
  const { AppView } = makeAppViewWithStore();
  AppView.appData = { slug: 'demo-app' };
  AppView._ghIssues = [
    { number: 900003, headless: { sessionId: 5, status: 'generating' }, bounty: { local: 'edit' } },
    { number: 900004, headless: null },
  ];

  AppView._onSessionStateEvent({
    sessionId: 5, appSlug: 'demo-app',
    headless: { status: 'ready', outcome: 'spec', issueNumber: 900003 },
  });

  // Spread into this realm before comparing — app-view.js built the object
  // inside the vm context, so its prototype isn't ours and deepStrictEqual
  // would fail on two structurally identical objects.
  assert.deepEqual({ ...AppView._ghIssues[0].headless },
    { sessionId: 5, status: 'ready', outcome: 'spec' });
  // Field-scoped merge: optimistic local bounty edits must survive, exactly
  // as they did under the poller this replaced.
  assert.deepEqual({ ...AppView._ghIssues[0].bounty }, { local: 'edit' });
  assert.equal(AppView._ghIssues[1].headless, null);
});

test('_onSessionStateEvent ignores events for another app', () => {
  const { AppView } = makeAppViewWithStore();
  AppView.appData = { slug: 'demo-app' };
  AppView._ghIssues = [{ number: 900003, headless: { status: 'generating' } }];

  AppView._onSessionStateEvent({
    sessionId: 5, appSlug: 'other-app',
    headless: { status: 'ready', outcome: 'spec', issueNumber: 900003 },
  });
  assert.equal(AppView._ghIssues[0].headless.status, 'generating',
    'issue numbers are per-repo, so a cross-app event must not patch this row');
});

test('_onSessionStateChanged never repaints mid-drag', () => {
  const { AppView } = makeAppViewWithStore();
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  AppView.appData = { slug: 'demo-app' };
  AppView._dragState = { dragging: true };

  AppView._onSessionStateChanged();
  assert.equal(repaints, 0, 'an innerHTML swap mid-drag would strand the card');
});
