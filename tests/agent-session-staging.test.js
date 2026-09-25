'use strict';

// A change's staging build in an agent session (#2779 follow-up).
//
//   1. A CARD, for every build: deployed (Open preview, View change, Propose
//      to group; then "In vote" with the proposal) or failed (why, and
//      Retry). It says where the change's checks stand, because they gate
//      merge. Only a change's newest card is live; an older one is
//      "Superseded by a newer preview" and offers nothing.
//   2. THE PREVIEW opens in the side pane beside the chat on a wide screen:
//      the platform's own preview (AppView.ensureStaging), docked over the
//      pane's slot and signed in to the change's app, so Full screen and the
//      dev console are the dev chat's. With a spec open too, Spec | Preview.
//      A narrow screen opens it in a tab, as before.
//   3. PROPOSE is the owner's own propose route after a confirm; RETRY is the
//      owner's ensure route, whose build writes the next card. The change's
//      staging events reach a preview waiting on a rebuild.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
const row = (id, role, content, metadata = {}, changeId = null) => ({ id, role, content, metadata, changeId, createdAt: null });

test('every build is a card, a failed one too; only a change\'s newest is live', () => {
  const items = transcript.buildTranscript([
    row(1, 'system', 'Staging deployed!', { stagingUrl: 'https://s1.example', prNumber: 14 }, 50),
    row(2, 'system', 'Staging build failed', { stagingFailed: true, error: 'npm ci failed', prNumber: 14 }, 50),
    row(3, 'system', 'Staging deployed!', { stagingUrl: 'https://s2.example', prNumber: 21 }, 60),
    row(4, 'system', 'Staging build failed', { stagingFailed: true, error: '  ' }, 50),
  ]).filter((item) => item.kind === 'preview');
  assert.deepEqual(items.map((i) => [i.changeId, i.failed, i.superseded, i.url, i.error]), [
    [50, false, true, 'https://s1.example', null],
    [50, true, true, null, 'npm ci failed'],
    [60, false, false, 'https://s2.example', null],
    [50, true, false, null, null],
  ], 'per change: the newest build is the live card, whatever the other changes did');

  // Inside a run, the failed build is a card of its own, not a step of the run.
  const inRun = transcript.buildTranscript([
    row(10, 'system', 'Starting OpenRouter (x)...', { agentBackend: 'codex_openrouter', agentModel: 'x' }, 50),
    row(11, 'system', 'Staging build failed', { stagingFailed: true, error: 'boom' }, 50),
  ]);
  assert.ok(inRun.some((i) => i.kind === 'preview' && i.failed));
  assert.ok(!inRun.some((i) => i.kind === 'run' && i.steps.includes('Staging build failed')));
});

test('the checks, as the card says them', () => {
  assert.deepEqual(transcript.checksSummary('passing', 0), { key: 'passing', text: 'Checks passing' });
  assert.deepEqual(transcript.checksSummary('skipped', 0), { key: 'passing', text: 'Checks passing' }, 'skipped passes the gate');
  assert.deepEqual(transcript.checksSummary('failing', 2), { key: 'failing', text: '2 checks failing' });
  assert.deepEqual(transcript.checksSummary('failing', 1), { key: 'failing', text: '1 check failing' });
  assert.deepEqual(transcript.checksSummary('failing', 0), { key: 'failing', text: 'Checks failing' });
  assert.deepEqual(transcript.checksSummary('pending', 0), { key: 'running', text: 'Checks running' });
  assert.equal(transcript.checksSummary('error', 0).key, 'error');
  assert.equal(transcript.checksSummary(null, 0), null, 'no run yet, nothing said');
});

test('the card: its actions for each state, and nothing on a superseded one', () => {
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const item = (over = {}) => ({
    kind: 'preview', key: 'k', text: 'Staging deployed!', url: 'https://s.example', prNumber: 14, changeId: 50,
    failed: false, error: null, superseded: false, ...over,
  });
  const change = (over = {}) => ({
    id: 50, appSlug: 'notes', appName: 'Notes', status: 'active', title: 'Dark mode', prNumber: 14,
    checkState: 'failing', checkFailing: 2, ...over,
  });
  const render = (props) => renderToHtml(createElement(api.PreviewCardView, {
    item: item(), change: change(), wide: true, action: null, busy: false, ...props,
  }));

  const live = render({});
  assert.match(live, /data-agent-session-preview="deployed"/);
  assert.match(live, />Staging deployed · PR #14</);
  assert.match(live, /data-agent-session-checks="failing"[^>]*>2 checks failing</);
  assert.match(live, /<button[^>]*data-agent-session-preview-open[^>]*>Open preview<\/button>/, 'wide: a button, for the side pane');
  assert.match(live, /href="#app\/notes\/dev\/proposals\/50"[^>]*>Open draft proposal</, 'the change\'s own page, while it is a draft');
  assert.match(live, /data-agent-session-preview-propose[^>]*>Propose to group</);

  // Narrow (a phone, the side panel): the same button, and never a bare new
  // tab, which was signed out of the app and away from the chat.
  const narrow = render({ wide: false });
  assert.match(narrow, /<button[^>]*data-agent-session-preview-open[^>]*>Open preview<\/button>/, 'narrow: over the chat, not a new tab');
  assert.doesNotMatch(narrow, /target="_blank"/);
  const voting = render({ change: change({ status: 'promoted', checkState: 'passing' }) });
  assert.match(voting, /data-agent-session-preview-status[^>]*>In vote</);
  assert.match(voting, />View proposal</);
  assert.doesNotMatch(voting, /Propose to group/, 'proposed once');
  assert.match(voting, /data-agent-session-checks="passing"/);
  const merged = render({ change: change({ status: 'merged' }) });
  assert.match(merged, />Merged</);
  assert.match(merged, />View proposal</, 'a merged change is no draft');
  assert.match(render({ action: 'propose', busy: true }), /disabled=""[^>]*data-agent-session-preview-propose[^>]*>Proposing…</);

  const failed = render({ item: item({ failed: true, url: null, error: 'npm ci failed', text: 'Staging build failed' }) });
  assert.match(failed, /data-agent-session-preview="failed"/);
  assert.match(failed, />Staging build failed · PR #14</);
  assert.match(failed, />npm ci failed</);
  assert.match(failed, /data-agent-session-preview-retry[^>]*>Retry</);
  assert.doesNotMatch(failed, /Open preview/, 'nothing to open');
  assert.match(failed, /Propose to group/, 'a failed preview still proposes: proposing rebuilds it');

  const old = render({ item: item({ superseded: true }) });
  assert.match(old, /data-agent-session-preview="superseded"[\s\S]*Superseded by a newer preview/);
  assert.doesNotMatch(old, /<button|<a /, 'an old build offers nothing');
});

test('Open preview docks the platform\'s preview in the pane, signed in to the change\'s app; closing it tells the pane', async () => {
  const calls = [];
  let host = null;
  const session = {
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange: { id: 50, appSlug: 'usernode-2d5619', appName: 'Homeroom', status: 'active', title: 'Dark mode', prNumber: 14, appSelfHosted: true },
    changes: [], lastActivityAt: null, createdAt: null,
  };
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {} },
    UsernodeReact: {},
    AppView: {
      setStagingDockHost: (h) => { host = h; calls.push(['host', h && h.slotId]); },
      ensureStaging: async (...args) => { calls.push(['ensure', ...args]); },
      closeStagingOverlay: () => { calls.push(['close']); if (host && host.closed) host.closed(); host = null; },
      onStagingRebuildResult: (...args) => calls.push(['rebuilt', ...args]),
    },
  };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (/\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] } : { session, turn: null }),
  });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    api.openPreview({ changeId: 50, url: 'https://s.example', prNumber: 14 });
    const state = api.getAgentSessionState();
    assert.deepEqual(state.preview, { changeId: 50, url: 'https://s.example', prNumber: 14, app: { slug: 'usernode-2d5619', self_hosted: true } });
    assert.equal(state.paneTab, 'preview');

    api.dockPreview(state.preview);
    assert.deepEqual(calls[0], ['host', api.PREVIEW_SLOT_ID]);
    assert.deepEqual(calls[1], ['ensure', 50, 'https://s.example', null,
      { dock: true, readOnly: false, app: { slug: 'usernode-2d5619', self_hosted: true } }],
      'the owner\'s ensure route, docked, signed in to the change\'s own app');
    assert.equal(host.live(), true);

    // A rebuild's result reaches the waiting preview through the conversation.
    api.handleEvent(7, { type: 'staging_ready', changeId: 50, url: 'https://s3.example' });
    assert.deepEqual(calls.find((c) => c[0] === 'rebuilt'), ['rebuilt', 50, { url: 'https://s3.example', failed: false, error: null }]);

    api.closePreview();
    assert.equal(api.getAgentSessionState().preview, null, 'the overlay\'s close is the pane\'s');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

// Where there is no room beside the chat (a phone, the side panel beside a
// running app) Open preview used to open the bare staging address in a new
// tab: signed out of the app, away from the chat. It is the platform's own
// preview now, over the chat. The panel's Expand carries it, and an open spec,
// into the full-width chat, beside the conversation.
test('narrow: the preview opens over the chat, signed in; Expand carries it and the spec to the full-width chat', async () => {
  const session = {
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange: { id: 50, appSlug: 'notes', appName: 'Notes', status: 'active', title: 'Dark mode', prNumber: 14, appSelfHosted: false },
    changes: [], lastActivityAt: null, createdAt: null,
  };
  const fetchFor = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (/\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /\/spec$/.test(url) ? { spec: '# Dark mode', versions: [{ version: 2 }] }
          : { session, turn: null }),
  });
  const calls = [];
  let host = null;
  const appView = {
    setStagingDockHost: (h) => { host = h; calls.push(['host', h && h.slotId]); },
    ensureStaging: async (...args) => { calls.push(['ensure', ...args]); },
    closeStagingOverlay: () => { if (host && host.closed) host.closed(); host = null; },
  };
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, AppView: appView };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = fetchFor;
  let carried;
  try {
    // The panel's document.
    const panel = loadTsx('frontend/src/features/agent-session/store.ts');
    await panel.openAgentSession({ id: 7, host: 'messages' });
    panel.setDrawerOpen(true);
    panel.openPreviewOver({ changeId: 50, url: 'https://s.example', prNumber: 14 });
    assert.deepEqual(calls.find((c) => c[0] === 'ensure'), ['ensure', 50, 'https://s.example', null,
      { readOnly: false, app: { slug: 'notes', self_hosted: false } }],
      'the platform\'s preview, not docked (over the chat), signed in to the change\'s app');
    assert.equal(host.live(), false, 'nothing to dock into');
    assert.equal(panel.getAgentSessionState().drawerOpen, false, 'the drawer steps aside');
    assert.equal(panel.getAgentSessionState().preview, null, 'no side pane where there is no room');
    assert.deepEqual(panel.paneToCarry(), {
      sessionId: 7, spec: null, preview: { changeId: 50, url: 'https://s.example', prNumber: 14 }, tab: 'preview',
    });

    await panel.openSpec(50);
    panel.setSpecTab('tech');
    carried = panel.paneToCarry();
    assert.deepEqual(carried.spec, { changeId: 50, version: 2, tab: 'tech' });
    assert.equal(carried.tab, 'spec', 'the one showing last');

    appView.closeStagingOverlay();
    assert.equal(panel.paneToCarry().preview, null, 'a closed preview is not carried');
    assert.equal(panel.agentSessionController.paneToCarry, panel.paneToCarry, 'published for the top window');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }

  // The top document, after Expand: the same conversation, full width.
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, AppView: appView };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = fetchFor;
  try {
    const top = loadTsx('frontend/src/features/agent-session/store.ts');
    top.adoptPane(carried);
    assert.equal(top.getAgentSessionState().specSheet, null, 'held until that conversation is open');
    await top.openAgentSession({ id: 7, host: 'messages' });
    await new Promise((resolve) => setImmediate(resolve));
    const state = top.getAgentSessionState();
    assert.deepEqual(state.preview, { changeId: 50, url: 'https://s.example', prNumber: 14, app: { slug: 'notes', self_hosted: false } });
    assert.equal(state.specSheet.changeId, 50);
    assert.equal(state.specSheet.tab, 'tech');
    assert.equal(state.paneTab, 'spec');

    // Another conversation does not take it.
    const other = loadTsx('frontend/src/features/agent-session/store.ts');
    other.adoptPane({ ...carried, sessionId: 8 });
    await other.openAgentSession({ id: 7, host: 'messages' });
    assert.equal(other.getAgentSessionState().preview, null);
    assert.equal(other.getAgentSessionState().specSheet, null);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the side panel\'s Expand hands the panel\'s open pane to the full-width chat', () => {
  const controller = read('frontend/src/features/side-panel/controller.ts');
  const expand = controller.slice(controller.indexOf('export function expand()'), controller.indexOf('export function appPresence('));
  assert.match(expand, /carryAgentPane\(\);\s*navigateTop\(expandRoute\(route\)\);/, 'read before the panel is dropped');
  assert.match(expand, /paneToCarry\?\.\(\)/);
  assert.match(expand, /adoptPane\?\.\(pane\)/);

  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /const cover = isEmbeddedPanel\(\);/, 'in the side panel the spec fills the panel');
  assert.doesNotMatch(panel, /href=\{active\.stagingUrl\}/, 'the Changes drawer\'s Open preview is no bare new tab either');
  assert.match(panel, /data-agent-session-drawer-preview[\s\S]{0,300}showPreview\(/);
});

test('Propose (once its panel is confirmed) uses the owner\'s propose route; Retry uses the ensure route', async () => {
  const requests = [];
  let answer = false;
  const session = {
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange: { id: 50, appSlug: 'notes', appName: 'Notes', status: 'active', title: 'Dark mode', prNumber: 14 },
    changes: [], lastActivityAt: null, createdAt: null,
  };
  const confirms = [];
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {} },
    UsernodeReact: {},
    PlatformUI: { confirm: async (opts) => { confirms.push(opts); return answer; }, toast() {} },
  };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /ensure-staging$/.test(url) ? { status: 'rebuilding' }
          : /promote$/.test(url) ? { ok: true } : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    // #3032: the card's panel asks (./propose-confirm.tsx); the store's
    // proposeChange is what its Propose calls, and asks nothing itself.
    await api.proposeChange(50);
    assert.equal(confirms.length, 0, 'no full-screen dialog');
    assert.ok(requests.some(([u, m]) => u === '/api/sessions/50/promote' && m === 'POST'));
    assert.equal(api.getAgentSessionState().changeAction, null, 'done, and the card reads the refreshed change');

    await api.retryStaging(50);
    assert.ok(requests.some(([u, m]) => u === '/api/sessions/50/ensure-staging' && m === 'POST'));
    assert.deepEqual(api.getAgentSessionState().changeAction, { changeId: 50, kind: 'retry' }, 'Retrying… until the build answers');
    api.handleEvent(7, { type: 'staging_failed', changeId: 50, error: 'again' });
    assert.equal(api.getAgentSessionState().changeAction, null, 'the build\'s own answer ends it');
    assert.match(read('frontend/src/features/agent-session/store.ts'), /RETRY_GIVE_UP_MS = 180_000/,
      'and a build whose answer never lands gives up after the dev chat preview\'s three minutes');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the pane holds Spec | Preview, keeps the preview\'s slot while the spec shows, and the dev chat takes its dock back', () => {
  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /\{sheet && preview \? <PaneTabs tab=\{showing\} \/> : null\}/);
  assert.match(panel, /id=\{PREVIEW_SLOT_ID\}\s+className=\{showing === 'preview' \? 'min-h-0 flex-1' : 'hidden'\}/,
    'hidden, not unmounted: the overlay shrinks to nothing and the preview keeps its state');
  assert.match(panel, /if \(preview\) dockPreview\(preview\);\s+\}, \[previewKey\]\);/, 'docked once the slot is on screen, again only for another preview');
  assert.match(panel, /frame\.style\.pointerEvents = 'none'/, 'the preview\'s iframe cannot swallow the drag');
  assert.match(read('frontend/src/features/dev-chat/dev-chat.js'), /openStagingPanel\(\) \{\s+if \(!DevChat\.currentSession\) return;[\s\S]{0,200}AppView\.setStagingDockHost\(null\)/);
  const layout = loadTsx('frontend/src/features/agent-session/spec-layout.ts');
  assert.equal(layout.clampSpecWidth(100, 1200, layout.PREVIEW_MIN_WIDTH), 320, 'a preview\'s floor is the staging panel\'s');
});

test('a change carries its failing count and its app\'s kind, from the rows it has', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(sql);
      if (/FROM agent_sessions s/.test(sql) && /LIMIT \$4/.test(sql)) {
        return { rows: [{ id: 7, user_id: 4, title: 't', title_source: 'auto', status: 'open', change_id: 50, change_status: 'active', change_app_slug: 'notes', change_check_failing: 3, change_app_self_hosted: true }] };
      }
      return { rows: [] };
    },
  };
  const { sessions } = await agentSessions.listAgentSessions(pool, { userId: 4 });
  assert.equal(sessions[0].activeChange.checkFailing, 3);
  assert.equal(sessions[0].activeChange.appSelfHosted, true);
  assert.match(calls[0], /jsonb_typeof\(c\.test_results\) = 'array'/, 'an odd legacy row cannot break the list');
});
