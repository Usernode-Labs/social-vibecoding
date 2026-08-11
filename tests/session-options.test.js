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
//   3. the venue question is asked ONCE, through one row. This menu used to
//      enumerate the routes itself — a CLI row plus one per web agent — so
//      it asked "where is this built?" in its own words inches from where
//      the composer footer asked it in different ones. There is now a single
//      "Change how this is built" row that opens the shared venue list in
//      public/js/build-venues.js, and that list does the gating.
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

test('a plain deployment offers the key and the venue row, in that order', () => {
  assert.deepEqual(ids({}), ['api-key', 'venue']);
});

test('the venue row is ONE row, whatever the deployment can offer', () => {
  // This menu used to enumerate the "somewhere else" routes itself — a CLI
  // row plus one per web agent — so it grew and shrank with the deployment
  // and asked the venue question in its own words, inches from where the
  // composer footer asked it in different ones. It now carries one row that
  // opens public/js/build-venues.js, and THAT list does the gating (see
  // tests/build-venues.test.js). So none of these states changes the shape
  // of this menu.
  for (const state of [
    { externalFlowsAvailable: true },
    { externalFlowsAvailable: false },
    { cliAuthEnabled: false },
    { cliAuthEnabled: undefined },
    { cliAuthEnabled: true },
    { externalFlowsAvailable: true, cliAuthEnabled: false },
  ]) {
    assert.deepEqual(
      ids(state), ['api-key', 'venue'],
      `the menu shape must not move with ${JSON.stringify(state)}`
    );
  }
});

test('the venue row names where this session is building now', () => {
  // The row is a door, not a statement — but its tooltip has to say what
  // you would be changing FROM, or "change how this is built" is a question
  // about something the user cannot see.
  const venueRow = SessionOptions.items({ agentBackend: 'codex_openrouter' })
    .find((i) => i.id === 'venue');
  assert.equal(venueRow.kind, 'venue');
  assert.match(venueRow.title, /Usernode · OpenRouter/);

  const claude = SessionOptions.items({}).find((i) => i.id === 'venue');
  assert.match(claude.title, /Usernode · Claude/);

  // An imported proposal has an agent_backend column like any other row,
  // but no turn ever ran through it. Reading the backend here would name a
  // venue that is structurally unreachable.
  const imported = SessionOptions.items({ source: 'imported', agentBackend: 'claude_code' })
    .find((i) => i.id === 'venue');
  assert.match(imported.title, /your own tools/);
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
//
// This section used to live here, driving SessionOptions.items() directly.
// The rows moved into public/js/build-venues.js when the three "somewhere
// else" entries became one door, and the assertions moved with them:
// tests/build-venues.test.js drives the same three-way derivation (#1071)
// against the venue list. What stays here is the seam — this menu must not
// grow a second copy of that copy.

test('the venue copy is not re-implemented in this module', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '../public/js/session-options.js'), 'utf8'
  );
  for (const label of [
    'Claude Code on the web', 'Codex on the web',
    'Your computer · Usernode session', 'Your computer · your own tools',
  ]) {
    assert.ok(
      !SRC.includes(`'${label}'`) && !SRC.includes(`"${label}"`),
      `session-options.js must read ${label} from build-venues.js, not own a copy`
    );
  }
});

test('webTargetKind is re-exported, and still answers for every session state', () => {
  // Callers and fixtures already read this from SessionOptions. The
  // implementation moved to build-venues.js; the answer must not move.
  const cases = [
    [{ sessionStatus: 'active', hasBranch: true }, 'session'],
    [{ sessionStatus: 'paused', hasBranch: true }, 'session'],
    [{ sessionStatus: 'promoted', hasBranch: true }, 'proposal'],
    [{ sessionStatus: 'promoted', hasBranch: false }, 'proposal'],
    [{ sessionStatus: 'archived', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merging', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merged', hasBranch: true }, 'new'],
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

test('a session already leased to a machine offers the way back instead', () => {
  const items = SessionOptions.items({
    cliAuthEnabled: true,
    localAgent: { label: 'Work laptop', leaseId: 'lease-1' },
  });
  assert.deepEqual(items.map((i) => i.id), ['api-key', 'hand-back', 'venue']);
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
  assert.deepEqual(items.map((i) => i.id), ['api-key', 'hand-back', 'venue']);
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
  // The venue question is asked once, so this menu no longer enumerates the
  // hand-off routes — it opens the shared sheet instead.
  assert.match(DEV_CHAT_SRC, /onVenue: \(\) => DevChat\.openVenueSheet\(anchorEl\)/);
  // …and the target id still travels with the agent (#1071): without it the
  // prepare call would open new work for a row that said "continue this
  // session". That now happens where the sheet dispatches a `flow` pick.
  assert.match(
    DEV_CHAT_SRC,
    /DevChat\._devFlowFromCredits\(pick\.flow, row\.targetId\)/
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
