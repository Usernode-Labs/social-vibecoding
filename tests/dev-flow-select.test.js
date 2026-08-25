// The build-flow picker and its guided walkthrough (#1049).
//
// public/js/dev-flow-select.js is pure render + wire: it never fetches, so
// every branch is reachable from node with no DOM and no server. That is the
// point of the split, and these tests are what it buys.
//
// The properties worth pinning:
//
//   1. exactly one step is 'current' — the first one that is not done. That
//      single rule is what makes the walkthrough RESUMABLE: nothing is
//      remembered on the client, so a person who closes the tab half-way
//      through and comes back must land on the same step, derived only from
//      what the server can see;
//   2. only the current step offers buttons (three live "Check again"s down
//      one card is noise, and acting on a later step out of order just
//      produces an error nobody needed);
//   3. the external pair disappears — rather than failing on click — when the
//      deployment or the app cannot support it; and
//   4. GitHub-supplied strings (a fork owner, a branch name, the platform's
//      own error text) are escaped, never injected.
//
// Run with: node --test tests/dev-flow-select.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DevFlowSelect = require('../public/js/dev-flow-select.js');

const AUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/auth.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);

// A status payload with every stage satisfied; individual tests knock pieces
// out to walk the person backwards through the flow.
function fullStatus(over) {
  return Object.assign({
    available: true,
    repo: { owner: 'usernode-apps', repo: 'demo' },
    github: { linked: true, login: 'octo-contributor', available: true },
    connectors: { count: 0 },
    fork: {
      state: 'ready',
      owner: 'octo-contributor',
      repo: 'demo',
      url: 'https://api.github.com/repos/octo-contributor/demo',
      pageUrl: 'https://github.com/octo-contributor/demo',
    },
    task: {
      id: 4242,
      agent: 'claude-code',
      branch: 'usernode/add-a-button',
      baseSha: '0123456789abcdef0123456789abcdef01234567',
      workOrder: '# Work order\n\nAdd a button.',
    },
    branch: { state: 'pushed', pushed: true, unpushed: false, missing: false },
  }, over || {});
}

function stateOf(list) {
  return list.reduce((acc, step) => {
    acc[step.key] = step.state;
    return acc;
  }, {});
}

test('FLOWS is the allowlist plus the venue name, and nothing else', () => {
  assert.deepEqual(
    DevFlowSelect.FLOWS.map((f) => f.id),
    ['platform', 'claude-code', 'codex'],
    'building here stays first — it is what most people want and needs no setup'
  );
  for (const flow of DevFlowSelect.FLOWS) {
    assert.ok(flow.title.length > 0, `${flow.id} has a title`);
    // The blurbs and CTAs belonged to the picker card, and the picker is
    // gone: public/js/build-venues.js is the one place a venue is described
    // to the user, and it covers three venues this list cannot name. A
    // second description here is exactly the drift that made "Claude Code"
    // mean two products.
    assert.equal(flow.blurb, undefined, `${flow.id} must not re-describe its venue`);
    assert.equal(flow.cta, undefined, `${flow.id} must not carry its own CTA`);
  }
  assert.equal(typeof DevFlowSelect.pickerHtml, 'undefined',
    'the picker card is retired — the venue line above the composer replaced it');
  assert.equal(typeof DevFlowSelect.flowsFor, 'undefined',
    'and the gating that fed it went with it');
});

test('the flow ids match the server allowlist exactly', () => {
  // Three places have to agree: this list, DEV_FLOWS in src/routes/auth.js
  // (which validates POST /api/me/dev-flow) and the CHECK constraint on
  // users.dev_flow_preference. A fourth flow that lands in one only would
  // either be unsaveable or be rejected by Postgres.
  const declared = AUTH_SRC.match(/const DEV_FLOWS = \[([^\]]+)\]/);
  assert.ok(declared, 'src/routes/auth.js declares DEV_FLOWS');
  const serverFlows = declared[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(
    serverFlows,
    DevFlowSelect.FLOWS.map((f) => f.id),
    'DEV_FLOWS and DevFlowSelect.FLOWS must list the same flows'
  );

  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const check = schema.match(/dev_flow_preference IN \(([^)]+)\)/);
  assert.ok(check, 'schema.sql constrains users.dev_flow_preference');
  const dbFlows = check[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(dbFlows.sort(), serverFlows.slice().sort(),
    'the CHECK constraint must accept exactly the flows the route accepts');
});

test('picking a venue persists it, with no second question about it', () => {
  // The picker asked twice: once for the flow, once for "remember my
  // choice — don't ask again", unticked by default. So the common path
  // answered the same question in every new session. Opening the venue
  // sheet is already the deliberate act, so the save rides along with it.
  const devChat = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
  );
  assert.match(devChat, /_saveDevFlowPreference\(pick\.flow\)/,
    'a flow picked in the sheet becomes the saved default');
  assert.match(devChat, /'\/api\/me\/dev-flow'/, 'through the route that owns the column');
  assert.ok(!devChat.includes('data-flow-remember'),
    'and there is no "remember my choice" tick left to forget');
});

test('the external pair is withheld, not offered-then-failed', () => {
  // The gating moved to build-venues.js with the list itself; what stays
  // here is the copy that explains a withheld hand-off, which the
  // walkthrough still renders when the server says the flow cannot run.
  const html = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: { available: false, reason: 'no_repository' },
  });
  assert.match(html, /no GitHub repository yet/);
  assert.ok(!html.includes('data-flow-pick='), 'nothing here is pickable any more');
});

test('every reason code the status route can send becomes real copy', () => {
  // Two producers: the status route, and the dev chat's own fallback when
  // the read fails outright. A code with no copy would render an empty
  // explanation under a card offering one option.
  const codes = new Set();
  for (const rel of ['../src/routes/dev-flow.js', '../frontend/src/features/dev-chat/dev-chat.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    // Per LINE, because the route's reason is a ternary over three codes on
    // one line rather than three separate literals.
    for (const line of src.split('\n')) {
      if (!/\breason:/.test(line)) continue;
      for (const m of line.matchAll(/'([a-z_]+)'/g)) codes.add(m[1]);
    }
  }
  assert.ok(codes.size >= 3, `the route sends reason codes (got ${codes.size})`);
  for (const code of codes) {
    assert.ok(
      DevFlowSelect.unavailableNote(code).length > 0,
      `reason '${code}' has no user-facing copy in unavailableNote()`
    );
  }
});

test('exactly one step is current, and it is the first unfinished one', () => {
  const cases = [
    // Nothing done at all — the very first visit.
    [{ github: { linked: false }, fork: null, task: null, branch: null }, 'github'],
    // Linked, but no fork yet.
    [{ fork: null, task: null, branch: null }, 'fork'],
    // Fork found, no work order yet.
    [{ task: null, branch: null }, 'prepare'],
    // Work order written, branch not pushed.
    [{ branch: { state: 'missing', pushed: false, missing: true } }, 'handoff'],
    // Branch pushed — all that is left is submitting.
    [{}, 'submit'],
  ];
  for (const [over, expected] of cases) {
    const list = DevFlowSelect.steps(fullStatus(over), 'claude-code');
    assert.equal(list.length, 5, 'always the same five steps');
    const current = list.filter((s) => s.state === 'current');
    assert.equal(current.length, 1,
      `exactly one current step for ${JSON.stringify(over)}, got ${current.length}`);
    assert.equal(current[0].key, expected,
      `expected '${expected}' to be current for ${JSON.stringify(over)}`);
    // Everything before the current step is done; everything after is todo.
    const at = list.indexOf(current[0]);
    list.forEach((step, index) => {
      if (index < at) assert.equal(step.state, 'done', `${step.key} precedes the current step`);
      if (index > at) assert.equal(step.state, 'todo', `${step.key} follows the current step`);
    });
  }
});

test('only the current step offers buttons', () => {
  const list = DevFlowSelect.steps(
    fullStatus({ fork: null, task: null, branch: null }), 'codex'
  );
  for (const step of list) {
    if (step.state === 'current') continue;
    assert.deepEqual(step.actions, [], `${step.key} (${step.state}) offers no buttons`);
  }
});

test('the walkthrough resumes from the server alone', () => {
  // The same payload must always produce the same card: there is no client
  // memory to diverge from, which is what makes closing the tab safe.
  const status = fullStatus({ task: null, branch: null });
  assert.equal(
    DevFlowSelect.wizardHtml({ agent: 'claude-code', status }),
    DevFlowSelect.wizardHtml({ agent: 'claude-code', status }),
  );
  // And the agent survives a reload with no client state, because the task
  // row carries it (external-agent-tasks records the picked agent in
  // client_id, and the status route reads it back).
  const html = DevFlowSelect.wizardHtml({ status: fullStatus() });
  assert.match(html, /Building with Claude Code/,
    'with no agent passed, the open task names it');
});

test('a status still in flight says so instead of showing a wrong step', () => {
  const html = DevFlowSelect.wizardHtml({ agent: 'codex', status: null });
  assert.match(html, /Building with Codex/);
  assert.match(html, /Checking where you are/);
  assert.ok(!html.includes('data-flow-step='), 'no steps are guessed at');
});

test('an unavailable flow offers the way back to the platform', () => {
  const html = DevFlowSelect.wizardHtml({
    agent: 'claude-code',
    status: { available: false, reason: 'no_repository' },
  });
  assert.match(html, /no GitHub repository yet/);
  assert.match(html, /data-flow-action="cancel"/,
    'a dead end must offer "build here instead", not trap the user');
});

test('the walkthrough card renders each step and the work order', () => {
  const html = DevFlowSelect.wizardHtml({ status: fullStatus() });
  for (const key of ['github', 'fork', 'prepare', 'handoff', 'submit']) {
    assert.ok(html.includes(`data-flow-step="${key}"`), `renders the '${key}' step`);
  }
  assert.match(html, /data-flow-step-state="done"/);
  assert.match(html, /data-flow-step-state="current"/);
  assert.match(html, /data-flow-order="1"/, 'the work order is available to copy');
  assert.match(html, /data-flow-action="submit"/, 'a pushed branch can be submitted');
  // The footer escape hatch is always there.
  assert.match(html, /dc-flow-actions-footer/);
});

// ── Continuing something that already exists (#1054 + #1071) ────────

// The same full status, with a target on the prepared task. `targetKind`
// 'proposal' is the #1054 shape (a promoted proposal, votes to clear);
// 'session' is the #1071 one (work in progress, nobody has voted).
function continuingStatus(targetKind, over) {
  const base = fullStatus(over);
  base.task = Object.assign({}, base.task, {
    targetProposal: {
      id: targetKind === 'session' ? 990405 : 990406,
      title: targetKind === 'session' ? 'Session and billing options' : 'Add a dark-mode toggle',
      targetKind,
      branchHome: targetKind === 'session' ? 'app_repo' : 'user_fork',
      webPath: '/#app/demo/dev/sessions/990406',
    },
  });
  return base;
}

const stepsOf = (status) => Object.fromEntries(
  DevFlowSelect.steps(status, 'claude-code').map((s) => [s.key, s])
);

test('a continuation ends in submitting an update, not a new proposal', () => {
  for (const kind of ['session', 'proposal']) {
    const submit = stepsOf(continuingStatus(kind)).submit;
    assert.equal(submit.title, 'Submit the update', `${kind}: the step is renamed`);
    assert.deepEqual(submit.actions, [
      { action: 'submit-update', label: 'Submit the update', primary: true },
    ], `${kind}: a distinct action id, so the client cannot post the new-proposal body`);
  }
  // Without a target it is still the ordinary new-proposal submission.
  const plain = stepsOf(fullStatus()).submit;
  assert.equal(plain.title, 'Submit for review');
  assert.deepEqual(plain.actions, [
    { action: 'submit', label: 'Submit for review', primary: true },
  ]);
});

test('the update step says what submitting costs, and only where it costs it', () => {
  const session = stepsOf(continuingStatus('session')).submit;
  const proposal = stepsOf(continuingStatus('proposal')).submit;
  // The vote clearing is the warning people most need — and it is false for
  // a session nobody has voted on, so it must not appear there.
  assert.match(proposal.detail, /votes are cleared/i);
  assert.doesNotMatch(session.detail, /vote/i);
  assert.match(session.detail, /same session, further along/i);
  assert.match(session.detail, /No new proposal/i);
});

test('step 3 names what is being continued, and step 4 where the agent talks', () => {
  const session = stepsOf(continuingStatus('session', {
    branch: { state: 'missing', pushed: false, missing: true },
  }));
  assert.match(session.prepare.detail, /^Continuing "Session and billing options"\. /);
  assert.match(session.prepare.detail, /Branch usernode\/add-a-button/);
  assert.match(session.handoff.detail, /This transcript stays where it is/);

  const proposal = stepsOf(continuingStatus('proposal', {
    branch: { state: 'missing', pushed: false, missing: true },
  }));
  assert.match(proposal.prepare.detail, /^Updating "Add a dark-mode toggle"\. /);
  assert.match(proposal.handoff.detail, /This transcript stays where it is/);

  // New work has no "over there" to explain, so it says nothing about it.
  const plain = stepsOf(fullStatus({
    branch: { state: 'missing', pushed: false, missing: true },
  }));
  assert.doesNotMatch(plain.prepare.detail, /Continuing|Updating/);
  assert.doesNotMatch(plain.handoff.detail, /transcript/);
});

test('a target with no targetKind is treated as a proposal', () => {
  // Older payloads (#1054 shipped before the field existed) carried a
  // promoted proposal and nothing else. Defaulting the other way would tell
  // somebody their votes are safe when submitting clears them.
  const status = continuingStatus('proposal');
  delete status.task.targetProposal.targetKind;
  const submit = stepsOf(status).submit;
  assert.equal(submit.title, 'Submit the update');
  assert.match(submit.detail, /votes are cleared/i);
});

test('the update button is rendered with its own action id', () => {
  const html = DevFlowSelect.wizardHtml({ status: continuingStatus('session') });
  assert.match(html, /data-flow-action="submit-update"/);
  assert.ok(!/data-flow-action="submit"/.test(html),
    'the new-proposal submit must not also be offered');
});

test('busy disables the buttons rather than reordering the card', () => {
  const status = fullStatus({ task: null, branch: null });
  const idle = DevFlowSelect.wizardHtml({ status });
  const busy = DevFlowSelect.wizardHtml({ status, busy: true });
  // #1281: scoped to the STEP actions. The vendor toggle above them always
  // renders the CURRENT vendor disabled — that button is a statement of
  // where you are rather than an offer — so a bare "no 'disabled' anywhere"
  // check now fails on correct markup. What this test is about is that an
  // in-flight request disables the action that started it, and that is
  // still exactly what is asserted.
  const stepButtons = (html) => html.match(/<button[^>]*data-flow-action="(?!vendor-)[^"]*"[^>]*>/g) || [];
  assert.ok(stepButtons(idle).length > 0, 'the idle card offers at least one step action');
  assert.ok(
    !stepButtons(idle).some((b) => /disabled/.test(b)),
    'no step action is disabled while idle',
  );
  assert.match(busy, /data-flow-action="prepare"[^>]*disabled/,
    'the in-flight action is disabled, so it cannot be fired twice');
  // Same steps, same order — only the buttons change.
  assert.equal(
    (busy.match(/data-flow-step=/g) || []).length,
    (idle.match(/data-flow-step=/g) || []).length,
  );
});

test('errors and notices are shown in the card, not thrown away in a toast', () => {
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus(),
    error: 'GitHub rejected the request.',
    notice: 'Copied.',
  });
  assert.match(html, /dc-flow-error/);
  assert.match(html, /GitHub rejected the request\./);
  assert.match(html, /dc-flow-notice/);
  assert.match(html, /Copied\./);
});

test('the handoff step links the agent the user actually picked', () => {
  const pushedNot = { state: 'missing', pushed: false, missing: true };
  const claude = DevFlowSelect.wizardHtml({
    agent: 'claude-code', status: fullStatus({ branch: pushedNot }),
  });
  assert.match(claude, /https:\/\/claude\.ai\/code/);
  assert.match(claude, /Open Claude Code/);

  const codex = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: fullStatus({ branch: pushedNot, task: Object.assign(fullStatus().task, { agent: 'codex' }) }),
  });
  assert.match(codex, /https:\/\/chatgpt\.com\/codex/);
  assert.match(codex, /Open Codex/);

  assert.equal(DevFlowSelect.agentLabel('claude-code'), 'Claude Code');
  assert.equal(DevFlowSelect.agentLabel('codex'), 'Codex');
  assert.equal(DevFlowSelect.agentLabel('mystery'), 'your coding agent');
  assert.equal(DevFlowSelect.agentUrl('mystery'), '',
    'an unknown agent gets no link rather than a broken one');
});

test('a failed fork read is reported honestly, not as "no fork"', () => {
  // inspectFork answers 'unknown' when GitHub could not be read. Telling
  // someone to fork a repository they have already forked sends them to a
  // page that offers no fork button — so the copy has to hedge.
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus({ fork: { state: 'unknown' }, task: null, branch: null }),
  });
  assert.match(html, /could not read GitHub/);
  assert.match(html, /data-flow-action="refresh"/);
  assert.ok(!html.includes('No fork yet'));
});

test('a branch pushed with no commits is called out specifically', () => {
  // 'unpushed' means the branch exists on the fork but still points at the
  // base commit — almost always "the agent committed locally and never
  // pushed", which the generic copy would leave the user guessing at.
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus({ branch: { state: 'unpushed', pushed: false, unpushed: true } }),
  });
  assert.match(html, /still on the base commit/);
  assert.ok(!html.includes('data-flow-action="submit"'),
    'submitting an empty branch would only produce an error');
});

test('GitHub-supplied names are escaped, never injected', () => {
  // fork.owner/repo, task.branch and the work order all originate outside
  // the platform. The card must not be an HTML sink.
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus({
      github: { linked: true, login: '<img src=x onerror="alert(1)">' },
      fork: { state: 'ready', owner: '<script>', repo: '"onmouseover="' },
      task: {
        id: 1,
        agent: 'codex',
        branch: '<b>evil</b>',
        baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        workOrder: '<img src=x onerror="alert(1)">',
      },
    }),
  });
  assert.ok(!html.includes('<img'), 'no raw tag survives');
  assert.ok(!html.includes('onerror="'), 'no attribute injection');
  assert.ok(!html.includes('<b>evil</b>'));
  assert.ok(html.includes('&lt;img'), 'it renders as escaped text instead');
});

test('the base commit is shown short, because that is what people compare', () => {
  const html = DevFlowSelect.wizardHtml({ status: fullStatus({ branch: null }) });
  assert.match(html, /0123456/);
  assert.ok(!html.includes('0123456789abcdef0123456789abcdef01234567'));
});

test('an existing connector is mentioned but never required', () => {
  // The whole point of #1049 is that the MCP connector stopped being the
  // only door. Someone who has one should hear that it also works; someone
  // who has none must see no mention of it at all.
  const withOne = DevFlowSelect.wizardHtml({
    status: fullStatus({ connectors: { count: 1 } }),
  });
  assert.match(withOne, /1 Claude \/ ChatGPT connector /, 'singular, not "1 connectors"');
  const withTwo = DevFlowSelect.wizardHtml({
    status: fullStatus({ connectors: { count: 2 } }),
  });
  assert.match(withTwo, /2 Claude \/ ChatGPT connectors/);
  const withNone = DevFlowSelect.wizardHtml({ status: fullStatus() });
  assert.ok(!withNone.includes('connector'),
    'no connector, no mention — it is not a prerequisite');
});

// ── wire() ─────────────────────────────────────────────────────────────
//
// Minimal DOM stand-ins: enough to prove one handler is attached, that a
// real anchor's navigation is left to the browser (#1312) while still being
// reported to the caller, and that the non-anchor fallback still opens its
// data-flow-href.

function fakeRoot(box) {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { listeners.push(fn); },
    contains() { return true; },
    querySelector() { return box || null; },
  };
}

function clickOn(root, attrs) {
  root.listeners[0]({
    target: { closest: () => ({ getAttribute: (name) => (name in attrs ? attrs[name] : null) }) },
    preventDefault() {},
  });
}

test('wire() attaches one handler per node', () => {
  const root = fakeRoot();
  DevFlowSelect.wire(root, {});
  DevFlowSelect.wire(root, {});
  assert.equal(root.listeners.length, 1,
    're-rendering the card must not stack duplicate handlers');
});

test('a pick button is no longer something this module answers', () => {
  // The picker's rows are gone; wire() handles walkthrough actions only.
  // Left over markup (a stale render, a hand-written fixture) must not
  // quietly re-enter through the click handler.
  const seen = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });
  clickOn(root, { 'data-flow-pick': 'codex' });
  assert.deepEqual(seen, [], 'a data-flow-pick click reaches nothing');
});

test('a non-anchor node with a data-flow-href still opens it (fallback)', () => {
  // The rendered markup gives href actions a real <a> now, but wire() is
  // deliberately tolerant of straggler non-anchor markup (a stale render,
  // a fixture): a button carrying data-flow-href keeps the old scripted
  // trip out, and the action is reported either way.
  const seen = [];
  const opened = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });

  const originalWindow = global.window;
  global.window = { open: (url, target, features) => opened.push([url, target, features]) };
  try {
    clickOn(root, {
      'data-flow-action': 'open-agent',
      'data-flow-href': 'https://claude.ai/code',
    });
    clickOn(root, { 'data-flow-action': 'refresh' });
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }

  assert.deepEqual(opened, [['https://claude.ai/code', '_blank', 'noopener']],
    'the trip out is a new tab with noopener, so the chat survives it');
  assert.deepEqual(seen, ['open-agent', 'refresh'],
    'the caller still hears about the click, so it can re-poll on return');
});

test('an href action renders as a real anchor, never a scripted button (#1312)', () => {
  // A button that window.open()s never leaves the page on mobile: popup
  // heuristics eat the scripted open in mobile browsers, and the Usernode
  // app's webview is bound to the platform's own domains, so github.com and
  // claude.ai can only leave for the system browser the way a plain
  // target="_blank" anchor does. "Fork on GitHub" was the report (#1312);
  // "Open Claude Code" / "Open Codex" share the path.
  const forkHtml = DevFlowSelect.wizardHtml({
    status: fullStatus({
      fork: { state: 'missing', owner: 'octo-contributor', repo: 'demo', pageUrl: 'https://github.com/usernode-apps/demo/fork' },
      task: null,
      branch: null,
    }),
  });
  const fork = forkHtml.match(/<a [^>]*data-flow-action="open-fork"[^>]*>/);
  assert.ok(fork, '"Fork on GitHub" is an anchor');
  assert.match(fork[0], /href="https:\/\/github\.com\/usernode-apps\/demo\/fork"/);
  assert.match(fork[0], /target="_blank"/, 'the trip out stays a new tab');
  assert.match(fork[0], /rel="noopener"/, 'and the chat survives it');
  assert.ok(!forkHtml.includes('data-flow-href'),
    'no scripted-open attribute remains for the browser-owned navigation');

  const handoffHtml = DevFlowSelect.wizardHtml({ status: fullStatus({ branch: null }) });
  const agent = handoffHtml.match(/<a [^>]*data-flow-action="open-agent"[^>]*>/);
  assert.ok(agent, '"Open Claude Code" is an anchor too');
  assert.match(agent[0], /href="https:\/\/claude\.ai\/code"/);
  assert.match(handoffHtml, /<button [^>]*data-flow-action="copy"/,
    'actions with no destination stay buttons');
  assert.match(handoffHtml, /<button [^>]*data-flow-action="refresh"/);
});

test('busy keeps the disabled-button rendering for href actions', () => {
  // An anchor cannot be disabled, and while a request is running the trip
  // out is supposed to be unavailable like every other action — so busy
  // falls back to the button form, exactly as before.
  const html = DevFlowSelect.wizardHtml({ status: fullStatus({ branch: null }), busy: true });
  assert.ok(!/<a [^>]*data-flow-action="open-agent"/.test(html));
  const btn = html.match(/<button [^>]*data-flow-action="open-agent"[^>]*>/);
  assert.ok(btn, 'the busy form is a button again');
  assert.match(btn[0], /disabled/);
});

test('an anchor click is left to the browser and still reported (#1312)', () => {
  // preventDefault or a scripted window.open here would take the navigation
  // back from the browser — the exact path mobile drops. The caller still
  // hears about the click so it can re-poll after the trip out.
  const seen = [];
  const opened = [];
  let prevented = 0;
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });

  const originalWindow = global.window;
  global.window = { open: (...args) => opened.push(args) };
  try {
    const attrs = {
      'data-flow-action': 'open-fork',
      href: 'https://github.com/usernode-apps/demo/fork',
    };
    root.listeners[0]({
      target: {
        closest: () => ({
          tagName: 'A',
          getAttribute: (name) => (name in attrs ? attrs[name] : null),
        }),
      },
      preventDefault() { prevented += 1; },
    });
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }

  assert.deepEqual(seen, ['open-fork'], 'the caller can re-poll on return');
  assert.deepEqual(opened, [], 'no scripted open rides along with the navigation');
  assert.equal(prevented, 0, 'the browser keeps the activation');
});

test('a node with neither attribute is ignored', () => {
  const seen = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onPick: () => seen.push('pick'), onAction: () => seen.push('action') });
  root.listeners[0]({ target: { closest: () => null }, preventDefault() {} });
  assert.deepEqual(seen, []);
});

test('the dev chat wires the marker the wizard actually renders (#1304)', () => {
  // #1093 retired the picker card together with its data-flow-card="1"
  // marker, but the transcript wiring kept selecting [data-flow-card] — so
  // the walkthrough rendered with dead buttons: "Fork on GitHub" opened
  // nothing, "Copy work order" copied nothing, "Check again" checked
  // nothing. Pin the wiring selector to the attribute wizardHtml emits, in
  // every state it renders, so renaming either side breaks this test
  // instead of the card.
  for (const [name, state] of [
    ['loading', { agent: 'claude-code', status: null }],
    ['unavailable', { agent: 'claude-code', status: { available: false, reason: 'no_repository' } }],
    ['steps', { status: fullStatus() }],
  ]) {
    assert.match(DevFlowSelect.wizardHtml(state), /data-flow-wizard="1"/,
      `the ${name} card carries the marker the wiring selects`);
  }
  assert.match(DEV_CHAT_SRC, /querySelectorAll\('\[data-flow-wizard\]'\)/,
    'dev-chat.js must wire the marker the wizard renders');
  assert.ok(!DEV_CHAT_SRC.includes('[data-flow-card]'),
    'the picker marker is gone from the markup, so selecting it wires nothing');
});

test('the dev chat is the module\'s only consumer, and owns the fetching', () => {
  // The split this file relies on: DevFlowSelect renders, dev-chat.js talks
  // to the server. A fetch appearing in the module would make these tests
  // impossible to run.
  const MODULE_SRC = fs.readFileSync(
    path.join(__dirname, '../public/js/dev-flow-select.js'), 'utf8'
  );
  assert.ok(!/\bfetch\s*\(/.test(MODULE_SRC),
    'dev-flow-select.js must not fetch — the caller owns that');
  assert.match(DEV_CHAT_SRC, /DevFlowSelect\.wizardHtml\(/);
  assert.match(DEV_CHAT_SRC, /DevFlowSelect\.wire\(/);
  assert.match(DEV_CHAT_SRC, /dev-flow\/status/,
    'dev-chat.js reads the status the walkthrough is derived from');
});
