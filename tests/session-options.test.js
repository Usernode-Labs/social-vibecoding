// Session and billing options — the "⋯" beside the dev-chat credit meter
// (#1055).
//
// The menu answers two questions that had no entry point next to the meter:
// "how do I set a key?" and "how do I move this session somewhere else?".
// public/js/session-options.js owns all of it, and these tests pin the four
// properties that make the module worth having:
//
//   1. the GATING. Every row is present or absent by deployment capability,
//      never `disabled: true` — the kit's touch idiom is an action sheet,
//      which drops disabled rows entirely, so a disabled entry is invisible
//      on a phone and inert-but-present on desktop. Two different products.
//   2. the API-key row FLIPS rather than disappears: a user with a key on
//      file must be told which key, not told to add one they already added.
//   3. the two "somewhere else" routes stay DISTINCT in the copy. The local
//      CLI lease (#907) continues THIS session; the web walkthrough (#1049)
//      starts separate work that returns as its own proposal. Copy that
//      blurred them would be wrong, not just vague.
//   4. the instructions card interpolates this session and escapes what it
//      interpolates — the repo URL is app data.
//
// Run with: node --test tests/session-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SessionOptions = require('../public/js/session-options.js');

const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/settings.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/dev-chat.js'), 'utf8'
);
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '../public/index.html'), 'utf8'
);
const APP_CSS = fs.readFileSync(
  path.join(__dirname, '../public/css/app.css'), 'utf8'
);
const DAPP = require('../dapp.json');

const ids = (state) => SessionOptions.items(state).map((i) => i.id);

// ── Gating ──────────────────────────────────────────────────────────

test('a plain deployment offers the key and the local CLI, in that order', () => {
  assert.deepEqual(ids({}), ['api-key', 'local-cli']);
});

test('the web hand-offs appear only where the deployment can offer them', () => {
  assert.deepEqual(
    ids({ externalFlowsAvailable: true }),
    ['api-key', 'local-cli', 'claude-code', 'codex']
  );
  // externalFlowsAvailable comes from GET /api/auth/me: a deployment with no
  // GitHub-link support cannot attribute the user's fork, so there is
  // nothing to walk anyone through.
  assert.deepEqual(ids({ externalFlowsAvailable: false }), ['api-key', 'local-cli']);
});

test('the local-CLI row is dropped where /api/cli/* does not exist', () => {
  // A staging clone 404s the whole CLI family, and cliAuthEnabled reports
  // that. `undefined` is NOT that state — an older payload that omits the
  // field must keep the row (the !== false shape the rest of the platform
  // uses for this flag).
  assert.deepEqual(ids({ cliAuthEnabled: false }), ['api-key']);
  assert.deepEqual(ids({ cliAuthEnabled: undefined }), ['api-key', 'local-cli']);
  assert.deepEqual(ids({ cliAuthEnabled: true }), ['api-key', 'local-cli']);
});

test('nothing is ever gated by disabling a row', () => {
  // The reason gating is by omission: PlatformUI.menu is adaptive, and the
  // touch action sheet omits disabled rows outright. A `disabled: true`
  // entry would therefore be a desktop-only affordance nobody chose.
  const states = [
    {}, { externalFlowsAvailable: true }, { cliAuthEnabled: false },
    { hasApiKey: true }, { localAgent: { label: 'Laptop', leaseId: 'l1' } },
  ];
  for (const state of states) {
    for (const item of SessionOptions.items(state)) {
      assert.ok(!item.disabled, `${item.id} is offered or omitted, never disabled`);
      assert.ok(item.label && item.label.length > 0, `${item.id} has a label`);
      assert.ok(item.title && item.title.length > 0, `${item.id} has a tooltip`);
      // The kit sets labels with textContent, so a label is one line by
      // construction — anything longer belongs in the header or the title.
      assert.doesNotMatch(item.label, /\n/, `${item.id}'s label is a single line`);
    }
  }
});

// ── The API-key row ─────────────────────────────────────────────────

test('the key row flips instead of disappearing, and names the saved key', () => {
  const [unset] = SessionOptions.items({});
  assert.equal(unset.kind, 'navigate');
  assert.equal(unset.hash, '#settings/api-key');
  assert.match(unset.label, /^Set /);

  const [saved] = SessionOptions.items({ hasApiKey: true, keyLast4: '7f2c' });
  assert.match(saved.label, /^Change /);
  assert.match(saved.label, /7f2c/, 'the last-4 says WHICH key is on file');

  // A key on file with no last-4 recorded still flips the verb — claiming
  // there is no key would be the wrong advice either way.
  const [noLast4] = SessionOptions.items({ hasApiKey: true });
  assert.match(noLast4.label, /^Change /);
  assert.doesNotMatch(noLast4.label, /…\)/);
});

test('the key row explains that billing is limit-first', () => {
  // #30/#119/#212: the daily platform allowance is spent BEFORE anything
  // reaches the user's own key. A menu that implied a key replaces the
  // allowance would describe a different product.
  for (const state of [{}, { hasApiKey: true, keyLast4: '7f2c' }]) {
    const [key] = SessionOptions.items(state);
    assert.match(key.title, /allowance/i);
  }
});

test('the key destination is a section Settings actually declares', () => {
  // Same guard as tests/credit-options.test.js: renaming a Settings section
  // without updating this module would ship a dead menu row.
  for (const hash of Object.values(SessionOptions.SETTINGS_HASHES)) {
    const key = hash.replace('#settings/', '');
    assert.match(SETTINGS_SRC, new RegExp(`key: '${key}'`),
      `Settings.SECTIONS declares '${key}'`);
    assert.match(INDEX_SRC, new RegExp(`data-settings-section="${key}"`),
      `index.html has a [data-settings-section="${key}"] wrapper`);
  }
});

// ── Continue this session vs start new work ─────────────────────────

test('the local CLI continues THIS session; the web hand-offs start new work', () => {
  const items = SessionOptions.items({ externalFlowsAvailable: true });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  assert.equal(byId['local-cli'].kind, 'instructions');
  assert.match(byId['local-cli'].title, /this session/i);
  assert.doesNotMatch(byId['local-cli'].label, /new work/i);

  for (const id of ['claude-code', 'codex']) {
    assert.equal(byId[id].kind, 'flow');
    assert.match(byId[id].label, /^Start new work/,
      `${id} must not read as moving this session`);
    assert.match(byId[id].title, /own proposal|its own proposal/i);
  }
  assert.deepEqual(
    items.filter((i) => i.kind === 'flow').map((i) => i.agent),
    ['claude-code', 'codex']
  );
});

// ── The three-way web hand-off (#1071) ──────────────────────────────

const webRows = (state) => SessionOptions.items(Object.assign(
  { externalFlowsAvailable: true }, state
)).filter((i) => i.kind === 'flow');

test('the hand-off state is derived from the session, in every direction', () => {
  // The predicate is the one place that decides, so it is driven directly:
  // a wrong answer here is a row that says "continue" and then starts
  // something separate, or the reverse.
  const cases = [
    [{ sessionStatus: 'active', hasBranch: true }, 'session'],
    [{ sessionStatus: 'paused', hasBranch: true }, 'session'],
    [{ sessionStatus: 'promoted', hasBranch: true }, 'proposal'],
    // A promoted proposal is the proposal, branch or not — its head is
    // whatever the platform recorded, and the server refuses it if that is
    // unreadable rather than the menu guessing.
    [{ sessionStatus: 'promoted', hasBranch: false }, 'proposal'],
    // An explicit put-away. Pushing onto it would resurrect work somebody
    // deliberately closed, so this starts new work instead.
    [{ sessionStatus: 'archived', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merging', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merged', hasBranch: true }, 'new'],
    // No branch yet: there is no commit to start from and nowhere to land.
    [{ sessionStatus: 'active', hasBranch: false }, 'new'],
    [{ sessionStatus: 'paused', hasBranch: false }, 'new'],
    [{}, 'new'],
  ];
  for (const [state, expected] of cases) {
    assert.equal(
      SessionOptions.webTargetKind(state), expected,
      `${JSON.stringify(state)} → ${expected}`
    );
  }
});

test('each state gets its own verb, and only the continue states carry a target', () => {
  const active = webRows({ sessionId: 990405, sessionStatus: 'active', hasBranch: true });
  const promoted = webRows({ sessionId: 990406, sessionStatus: 'promoted', hasBranch: true });
  const archived = webRows({ sessionId: 990408, sessionStatus: 'archived', hasBranch: true });

  assert.deepEqual(active.map((i) => i.label), [
    'Continue this session with Claude Code on the web',
    'Continue this session with Codex',
  ]);
  assert.deepEqual(promoted.map((i) => i.label), [
    'Continue this proposal with Claude Code on the web',
    'Continue this proposal with Codex',
  ]);
  assert.deepEqual(archived.map((i) => i.label), [
    'Start new work with Claude Code on the web',
    'Start new work with Codex',
  ]);

  // targetId is what makes the difference real: the prepare call continues
  // that session, and `null` is what opens separate work.
  assert.deepEqual(active.map((i) => i.targetId), [990405, 990405]);
  assert.deepEqual(promoted.map((i) => i.targetId), [990406, 990406]);
  assert.deepEqual(archived.map((i) => i.targetId), [null, null]);
  assert.deepEqual(active.map((i) => i.targetKind), ['session', 'session']);
  assert.deepEqual(promoted.map((i) => i.targetKind), ['proposal', 'proposal']);
  assert.deepEqual(archived.map((i) => i.targetKind), ['new', 'new']);

  // A continuable session the page has no id for cannot be continued, and
  // saying so with a null target is better than sending `undefined`.
  assert.deepEqual(
    webRows({ sessionStatus: 'active', hasBranch: true }).map((i) => i.targetId),
    [null, null]
  );
});

test('active and paused read identically and differ only in the tooltip', () => {
  const active = webRows({ sessionId: 990405, sessionStatus: 'active', hasBranch: true });
  const paused = webRows({ sessionId: 990407, sessionStatus: 'paused', hasBranch: true });

  // Byte-identical labels on purpose: one selector assertion covers both
  // staging fixtures, and the two cases cannot drift apart in the menu.
  assert.deepEqual(active.map((i) => i.label), paused.map((i) => i.label));

  // The tooltip is where the difference belongs, because it IS different:
  // a paused session's preview and checks do not rebuild until it reopens.
  for (const row of paused) {
    assert.match(row.title, /reopen/i);
    assert.match(row.title, /stays paused|catch up when you reopen/i);
  }
  for (const row of active) {
    assert.doesNotMatch(row.title, /reopen/i);
    assert.match(row.title, /rebuild/i);
  }
  assert.notDeepEqual(active.map((i) => i.title), paused.map((i) => i.title));
});

test('the continue tooltips say where the agent talks and what a push costs', () => {
  for (const state of [
    { sessionId: 1, sessionStatus: 'active', hasBranch: true },
    { sessionId: 1, sessionStatus: 'paused', hasBranch: true },
    { sessionId: 1, sessionStatus: 'promoted', hasBranch: true },
  ]) {
    for (const row of webRows(state)) {
      // The one thing a continuation gets wrong if left implied: the agent's
      // conversation is not this transcript.
      assert.match(row.title, /not in this transcript/i);
    }
  }
  // Votes are cleared by updating a promoted proposal and by nothing else —
  // a session nobody has voted on has none to clear.
  for (const row of webRows({ sessionId: 1, sessionStatus: 'promoted', hasBranch: true })) {
    assert.match(row.title, /clears the votes/i);
  }
  for (const row of webRows({ sessionId: 1, sessionStatus: 'active', hasBranch: true })) {
    assert.doesNotMatch(row.title, /vote/i);
  }
});

test('a session already leased to a machine offers the way back instead', () => {
  const items = SessionOptions.items({
    cliAuthEnabled: true,
    localAgent: { label: 'Work laptop', leaseId: 'lease-1' },
  });
  assert.deepEqual(items.map((i) => i.id), ['api-key', 'hand-back']);
  const handBack = items[1];
  assert.equal(handBack.kind, 'hand-back');
  assert.ok(handBack.destructive, 'releasing the lease is the destructive row');
  assert.match(handBack.label, /Work laptop/);
  // Telling someone to set up the CLI on a session already running through
  // it is advice for a thing already done.
  assert.ok(!items.some((i) => i.id === 'local-cli'));
});

test('the hand-back row is offered even where the CLI surface is gone', () => {
  // The lease outlives the surface flag: a machine that attached earlier
  // must still be releasable from the browser, which is the whole point of
  // routing the detach through the account route rather than the agent.
  const items = SessionOptions.items({
    cliAuthEnabled: false,
    localAgent: { label: 'Laptop', leaseId: 'lease-1' },
  });
  assert.deepEqual(items.map((i) => i.id), ['api-key', 'hand-back']);
});

// ── The popover header ──────────────────────────────────────────────

test('the header states which pot the work is billed to', () => {
  const unset = SessionOptions.headerHtml({});
  assert.match(unset, /Session and billing options/);
  assert.match(unset, /daily platform allowance/i);
  assert.match(unset, /midnight UTC/);

  const saved = SessionOptions.headerHtml({ hasApiKey: true, keyLast4: '7f2c' });
  assert.match(saved, /spent first/i);
  assert.match(saved, /7f2c/);
});

test('the header names the machine when one holds the lease', () => {
  const html = SessionOptions.headerHtml({ localAgent: { label: 'Work laptop' } });
  assert.match(html, /Work laptop/);
  assert.doesNotMatch(SessionOptions.headerHtml({}), /running on/i);
});

test('the header escapes what it interpolates', () => {
  const html = SessionOptions.headerHtml({
    localAgent: { label: '<img src=x onerror=alert(1)>' },
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ── The "run it on your computer" card ──────────────────────────────

test('the commands name this session and this repository', () => {
  const cmds = SessionOptions.commands({
    sessionId: 990405,
    repoUrl: 'https://github.com/acme/widget.git',
  });
  assert.equal(cmds.length, 3);
  assert.match(cmds[0], /^git clone https:\/\/github\.com\/acme\/widget\.git$/);
  assert.match(cmds[1], /social-vibecoding login$/);
  assert.match(cmds[2], /agent run --session 990405$/);
});

test('an unknown repository produces a comment, never a broken command', () => {
  const [first] = SessionOptions.commands({ sessionId: 1 });
  assert.match(first, /^#/, 'a clone line with no URL would be a command that fails');
  assert.doesNotMatch(first, /git clone\s*$/);
});

test('an unknown session id is a placeholder, not "undefined"', () => {
  const cmds = SessionOptions.commands({});
  assert.match(cmds[2], /--session <session-id>$/);
  assert.doesNotMatch(cmds.join('\n'), /undefined|null/);
});

test('the card escapes the repository URL it renders', () => {
  // repo_url is app data — it reaches the browser from the apps table and
  // must never be able to close the <pre> it is rendered into.
  const html = SessionOptions.instructionsHtml({
    sessionId: 7,
    repoUrl: 'https://x/"><script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

test('the card says the session stays put and how to undo the move', () => {
  const html = SessionOptions.instructionsHtml({ sessionId: 990405 });
  assert.match(html, /id="dc-options-commands"/);
  assert.match(html, /same transcript/i);
  assert.match(html, /Hand the turns back/i);
  assert.match(html, /Copy commands/);
});

// ── Wiring ──────────────────────────────────────────────────────────

test('the module is exported both ways', () => {
  // Loaded as a classic script in the browser and required here — the dual
  // export is what lets one file be the single source of truth for both.
  const src = fs.readFileSync(
    path.join(__dirname, '../public/js/session-options.js'), 'utf8'
  );
  assert.match(src, /module\.exports = SessionOptions/);
  assert.match(src, /window\.SessionOptions = SessionOptions/);
});

test('the composer paints the button statically and wires it', () => {
  // Static markup in renderChatView, NOT something renderBudget appends:
  // renderBudget returns early when there is nothing to paint, and "no key,
  // no spend yet" is precisely the state this menu exists for.
  assert.match(DEV_CHAT_SRC, /id="dc-budget-options"/);
  assert.match(DEV_CHAT_SRC, /aria-label="Session and billing options"/);
  assert.match(DEV_CHAT_SRC, /openSessionOptions\(optionsBtn\)/);
  // The button lives after the meter in the composer's status row.
  const meter = DEV_CHAT_SRC.indexOf('id="dc-budget"');
  const button = DEV_CHAT_SRC.indexOf('id="dc-budget-options"');
  assert.ok(meter !== -1 && button > meter, 'the button follows #dc-budget');
  // Both halves of the state come from the places that already own them.
  assert.match(DEV_CHAT_SRC, /_sessionOptionsState\(\)/);
  assert.match(DEV_CHAT_SRC, /onHandBack: \(\) => DevChat\._handBackToUsernode\(\)/);
  // The target id travels with the agent (#1071): without it the prepare
  // call would open new work for a row that said "continue this session".
  assert.match(
    DEV_CHAT_SRC,
    /onFlow: \(agent, targetId\) => DevChat\._devFlowFromCredits\(agent, targetId\)/
  );
});

test('the shell loads the module and the button has styles', () => {
  assert.match(INDEX_SRC, /src="\/js\/session-options\.js"/);
  assert.match(APP_CSS, /\.dc-budget-options\s*\{/);
  assert.match(APP_CSS, /\.dc-options-header\s*\{/);
});

test('both screenshot states are declared checks', () => {
  const paths = DAPP.tests.map((t) => t.path || '');
  assert.ok(paths.some((p) => p.includes('shot=session-options#')),
    'the open menu has a declared check');
  assert.ok(paths.some((p) => p.includes('shot=session-options-instructions')),
    'the instructions card has a declared check');
  assert.ok(paths.some((p) => p.includes('shot=session-options&un-platform=ios')),
    'the touch action-sheet idiom has its own check (#929)');
});

test('all three hand-off states have a declared check (#1071)', () => {
  // One fixture per state, because the difference is entirely in the copy
  // and no single session can show three of them.
  const expected = [
    ['990405', 'Continue this session with Claude Code on the web'],
    ['990407', 'Continue this session with Claude Code on the web'],
    ['990406', 'Continue this proposal with Claude Code on the web'],
    ['990408', 'Start new work with Claude Code on the web'],
  ];
  for (const [sessionId, text] of expected) {
    assert.ok(
      DAPP.tests.some((t) => (t.path || '').includes(`/dev/sessions/${sessionId}`)
        && t.expectText === text),
      `session ${sessionId} has a check asserting "${text}"`
    );
  }
});
