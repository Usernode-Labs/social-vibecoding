'use strict';

// The agent session's session and change controls (#2779 follow-up): what
// the dev chat's session had around the conversation.
//
//   1. THE ⋯ MENU renames, archives and unarchives through the routes that
//      already existed; an archived conversation says so above the box.
//   2. CHECKS: a change's checks line opens the platform's own checks dialog,
//      and a failing one offers Re-run checks (AppView.castRecheck).
//   3. THE CREDITS METER is the header's own figure, beside the model.
//   4. OUT OF CREDITS, a refused message is a card with ways to keep
//      building, credit-options.js's copy and rows, the web hand-offs first.
//   5. "BUILD: HOMEROOM" is always in the bar; its web rows open the dev
//      chat's hand-off walkthrough (dev-flow-select.js's steps over the
//      server's status) for the conversation's change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const change = (over = {}) => ({
  id: 50, appSlug: 'notes', appName: 'Notes', status: 'active', title: 'Dark mode', prNumber: 14,
  checkState: null, checkFailing: 0, ...over,
});

test('a hand-off works on the conversation\'s change while it can be revised, else new work on its app', () => {
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  assert.deepEqual(api.handoffTarget({ activeChange: change(), focusApp: null }),
    { slug: 'notes', appName: 'Notes', change: { id: 50, kind: 'session', prNumber: 14 } });
  assert.equal(api.handoffTarget({ activeChange: change({ status: 'paused' }) }).change.kind, 'session');
  assert.equal(api.handoffTarget({ activeChange: change({ status: 'promoted' }) }).change.kind, 'proposal',
    'up for a vote: the hand-off updates the proposal');
  assert.equal(api.handoffTarget({ activeChange: change({ status: 'merged' }) }).change, null, 'merged: new work on the same app');
  assert.deepEqual(api.handoffTarget({ activeChange: null, focusApp: { id: 3, slug: 'recipes', name: 'Recipes' } }),
    { slug: 'recipes', appName: 'Recipes', change: null });
  assert.equal(api.handoffTarget({ activeChange: null, focusApp: null }), null, 'no app: nothing to hand over yet');
  assert.deepEqual(api.VENUE_ROWS.map((r) => r.id), ['homeroom', 'claude-code', 'codex']);
});

test('the walkthrough is the dev chat\'s: its steps over the server\'s status', () => {
  const DevFlowSelect = require('../public/js/dev-flow-select.js');
  globalThis.window = { DevFlowSelect };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    const fresh = api.handoffSteps({ available: true, github: { linked: false }, connectors: { count: 0 }, fork: null }, 'claude-code');
    assert.deepEqual(fresh.map((s) => [s.key, s.state]), [['github', 'current'], ['fork', 'todo'], ['handoff', 'todo']]);
    assert.equal(fresh[0].actions[0].action, 'link-github');
    const ready = api.handoffSteps({
      available: true, github: { linked: true, login: 'ada' }, connectors: { count: 1 },
      fork: { state: 'ready', owner: 'ada', repo: 'notes' }, targetKind: 'session', instructions: 'Paste me',
    }, 'codex');
    assert.equal(ready[2].state, 'current');
    assert.deepEqual(ready[2].actions.map((a) => a.action), ['copy', 'open-agent']);
    assert.match(ready[2].detail, /lands as an update to it/);
    assert.deepEqual(api.handoffSteps({ available: false, reason: 'no_repository' }, 'codex'), [], 'unavailable: its note, not steps');
  } finally {
    delete globalThis.window;
  }
  const dialog = read('frontend/src/features/agent-session/handoff.tsx');
  assert.match(dialog, /api\.handoffStatus\(target\.slug, target\.change \? \{ id: target\.change\.id, kind: target\.change\.kind \} : null\)/);
  assert.match(read('frontend/src/features/agent-session/api.ts'), /\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/dev-flow\/status/);
  assert.match(dialog, /<ClaudeSetupSteps \/>/, 'Connect Homeroom shows the connector steps in place');
});

test('out of credits: a card with credit-options.js\'s copy, the web hand-offs first, no developer routes', () => {
  const BuildVenues = require('../public/js/build-venues.js');
  globalThis.window = { BuildVenues };
  delete require.cache[require.resolve('../public/js/credit-options.js')];
  const CreditOptions = require('../public/js/credit-options.js');
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    assert.equal(api.creditsRefusal({ status: 409, body: { code: 'budget_exceeded' } }), null);
    const refusal = api.creditsRefusal({ status: 429, body: { code: 'budget_exceeded', error: 'Weekly limit reached ($50.00). Resets Monday 00:00 UTC.' } });
    assert.deepEqual(refusal, { error: 'Weekly limit reached ($50.00). Resets Monday 00:00 UTC.', reason: null, verificationRequired: false });

    const budget = { limitCents: 5000, spentCents: 5000, remainingCents: 0, capWindow: 'weekly' };
    const view = api.creditsView(refusal, { co: CreditOptions, budget, externalFlowsAvailable: true, hasApiKey: false });
    assert.equal(view.lead, 'You\'re out of this week\'s free AI credits.');
    assert.deepEqual(view.rows.slice(0, 2).map((r) => r.flow), ['claude-code', 'codex'], 'the plans they already pay for lead');
    assert.ok(view.rows.some((r) => r.id === 'api-key'));
    assert.ok(!view.rows.some((r) => r.developer), 'a CLI lease or an imported PR builds a dev session, not this conversation');
    assert.match(view.intro, /ways? to keep building right now:$/);

    const html = renderToHtml(createElement(api.CreditsCardView, { refusal, view }));
    assert.match(html, /data-agent-session-credits="true"/);
    assert.match(html, />Use Claude Code</);
    assert.match(html, /href="#settings\/api-key"/);
    assert.match(html, />Dismiss</);
    assert.deepEqual(api.creditsView(refusal, { co: null }).rows, [], 'without the module: the error alone');
  } finally {
    delete globalThis.window;
  }
});

test('the ⋯ renames, archives and unarchives; Build opens the hand-off; checks re-run through the platform', async () => {
  const requests = [];
  let session = {
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange: change({ checkState: 'failing', checkFailing: 2 }), changes: [], lastActivityAt: null, createdAt: null,
  };
  const rechecks = [];
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {} },
    UsernodeReact: {},
    PlatformUI: {
      toast() {},
      confirm: async () => true,
      prompt: async () => '  Night mode  ',
    },
    AppView: { castRecheck: async (id) => { rechecks.push(id); return true; } },
  };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    requests.push([method, url, init.body ? JSON.parse(init.body) : null]);
    if (/\/title$/.test(url)) session = { ...session, title: 'Night mode' };
    if (/\/archive$/.test(url)) session = { ...session, status: 'archived' };
    if (/\/unarchive$/.test(url)) session = { ...session, status: 'open' };
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /\/drafts$/.test(url) ? { drafts: [] }
          : /\/api\/agent-sessions$/.test(url) ? { sessions: [session] }
            : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });

    await api.renameCurrentSession();
    assert.deepEqual(requests.find(([m, u]) => m === 'PATCH' && u === '/api/agent-sessions/7/title')[2], { title: 'Night mode' });
    assert.equal(api.getAgentSessionState().session.title, 'Night mode');

    await api.archiveCurrentSession();
    assert.ok(requests.some(([m, u]) => m === 'POST' && u === '/api/agent-sessions/7/archive'));
    assert.equal(api.getAgentSessionState().session.status, 'archived');
    await api.unarchiveCurrentSession();
    assert.ok(requests.some(([m, u]) => m === 'POST' && u === '/api/agent-sessions/7/unarchive'));

    api.openHandoff('codex');
    assert.equal(api.getAgentSessionState().handoff, 'codex');
    api.closeHandoff();
    assert.equal(api.getAgentSessionState().handoff, null);

    await api.recheckChange(50);
    assert.deepEqual(rechecks, [50], 'the platform\'s own recheck, with its own toasts');
    assert.equal(api.getAgentSessionState().changeAction, null);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('a refused message becomes the credits card and goes back to the box', async () => {
  const session = { id: 7, title: 'x', status: 'open', focusApp: null, focusContext: {}, busy: false, activeChange: null, changes: [] };
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, PlatformUI: { toast() {} } };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url, init = {}) => {
    if (/\/turns$/.test(url) && init.method === 'POST') {
      return { ok: false, status: 429, json: async () => ({ error: 'Weekly limit reached.', code: 'budget_exceeded' }) };
    }
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] } : /\/drafts$/.test(url) ? { drafts: [] } : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    await api.sendAgentMessage('Make it blue');
    const state = api.getAgentSessionState();
    assert.deepEqual(state.credits, { error: 'Weekly limit reached.', reason: null, verificationRequired: false });
    assert.equal(state.error, '', 'the card, not a red line');
    assert.equal(state.returnedText, 'Make it blue');
    assert.equal(state.turn.running, false);
    api.dismissCredits();
    assert.equal(api.getAgentSessionState().credits, null);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the card\'s checks open the dialog and a failing run offers Re-run; the bar carries Build and ⋯', () => {
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const item = { kind: 'preview', key: 'k', text: 'Staging deployed!', url: 'https://s.example', prNumber: 14, changeId: 50, failed: false, error: null, superseded: false };
  const failing = renderToHtml(createElement(api.PreviewCardView, {
    item, change: change({ checkState: 'failing', checkFailing: 2 }), wide: true, action: null, busy: false,
  }));
  assert.match(failing, /<button[^>]*data-agent-session-checks="failing"[^>]*>[\s\S]*?2 checks failing<\/button>/, 'the line is the way to the list');
  assert.match(failing, /data-agent-session-preview-recheck="true">Re-run checks</);
  assert.match(failing, /data-agent-session-preview-open="true">Open preview<\/button><a[^>]*data-agent-session-preview-change/,
    'Open preview and View change stay side by side (the declared check)');
  const passing = renderToHtml(createElement(api.PreviewCardView, {
    item, change: change({ checkState: 'passing' }), wide: true, action: null, busy: false,
  }));
  assert.doesNotMatch(passing, /Re-run checks/, 'nothing to re-run on a green change');
  const running = renderToHtml(createElement(api.PreviewCardView, {
    item, change: change({ checkState: 'failing', checkFailing: 1 }), wide: true, action: 'recheck', busy: true,
  }));
  assert.match(running, />Re-running…</);

  const picker = renderToHtml(createElement(api.VenuePicker, { disabled: false }));
  assert.match(picker, /data-agent-session-venue="true"/);
  assert.match(picker, /Build:<\/span>Homeroom/);

  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /<VenuePicker disabled=\{snapshot\.phase === 'loading'\} \/>/);
  assert.match(panel, /\{ label: 'Rename…'/);
  assert.match(panel, /label: 'Archive',[\s\S]*?destructive: true/);
  assert.match(panel, /\{ label: 'Unarchive'/);
  assert.match(panel, /\{snapshot\.handoff \? <HandoffDialog \/> : null\}/);
  assert.match(panel, /\{snapshot\.credits \? <CreditsCard refusal=\{snapshot\.credits\} \/> : null\}/);
  assert.match(panel, /useStoreState<AiBudgetState>\(aiBudgetStore\)/, 'the header\'s own meter, kept live by budget_updated');
  assert.match(panel, /This session is archived\. Unarchive it to keep going\./);
  assert.match(panel, /window\.AppView\?\.openSessionChecks\?\.\(item\.changeId\)/);
});
