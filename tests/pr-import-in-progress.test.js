// #1162 — an imported PR lands **In progress**, not In review.
//
// Importing a PR says "this is the group's work now"; it does not say "this
// is finished, vote on it". Those were the same act before this issue, so an
// import went straight into the In review column with a vote open on code
// nobody had been asked to look at yet. Now the import creates an `active`
// row that sits in In progress until someone deliberately puts it up for
// vote, exactly like a native dev session.
//
// Flipping that one column value touches more than the INSERT, because every
// other part of the platform that treats `active` as "a live dev session with
// a worker behind it" now also sees imported rows. This file pins the whole
// set, since any one of them silently breaks the feature:
//
//   1. the default itself, and the explicit opt-in that preserves the old
//      behaviour for callers that really are submitting finished work;
//   2. the duplicate-import guard and its boot audit, which must count the
//      new live states or the same PR can be imported twice;
//   3. auto-pause / LRU eviction, which would flip an import to `paused` —
//      and /promote only accepts `active`, so the card's one action would
//      start failing on its own after a few hours;
//   4. per-user active-session caps, which an imported row must not consume
//      (it holds no container and runs no turns);
//   5. the head-change sweeper and the preview-open set, which decide whether
//      an In-progress import keeps tracking its PR and keeps its build;
//   6. the promote path itself, which for an imported row must go through the
//      PR's head SHA rather than a branch in the app's own repo;
//   7. the card: what it says, and the one action it offers.
//
// Run with: node --test tests/pr-import-in-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const VOTES = read('src', 'routes', 'votes.js');
const SESSIONS = read('src', 'routes', 'sessions.js');
const LIFECYCLE = read('src', 'services', 'session-lifecycle.js');
const IMPORT_SYNC = read('src', 'services', 'pr-import-sync.js');
const SERVER = read('server.js');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');

// ── 1. the default, and the explicit opt-in ──────────────────────────

const { wantsImportPromoted } = require('../src/routes/votes');

test('an import is In progress unless the caller explicitly asks for a vote', () => {
  // The browser's import button sends `{ pr }` and nothing else.
  assert.equal(wantsImportPromoted({ pr: 5 }), false, 'the browser import defaults to In progress');
  assert.equal(wantsImportPromoted({}), false);
  assert.equal(wantsImportPromoted(null), false, 'a missing body is not an opt-in');
  assert.equal(wantsImportPromoted('promote'), false, 'a non-object body is not an opt-in');
  assert.equal(wantsImportPromoted({ promote: false }), false);
  assert.equal(wantsImportPromoted({ status: 'active' }), false);
  assert.equal(wantsImportPromoted({ promoted: true }), false, 'only the two documented spellings count');

  // Two spellings, because two kinds of caller exist: the connector submit
  // path reads naturally as `promote: true`, and anything driving the API by
  // hand can name the column value.
  assert.equal(wantsImportPromoted({ promote: true }), true);
  assert.equal(wantsImportPromoted({ promote: 'true' }), true, 'a form-encoded caller still opts in');
  assert.equal(wantsImportPromoted({ promote: 1 }), true);
  assert.equal(wantsImportPromoted({ status: 'promoted' }), true);
  assert.equal(wantsImportPromoted({ status: 'PROMOTED' }), true, 'case is not the caller’s problem');
});

test('the INSERT writes that decision, and only promotes what it promoted', () => {
  const from = VOTES.indexOf('const promoteNow = wantsImportPromoted(req.body)');
  assert.ok(from > 0, 'the import route asks the helper');
  const insert = VOTES.slice(from, VOTES.indexOf('const sessionId = inserted[0].id', from));

  assert.match(insert, /promoteNow \? 'promoted' : 'active'/, 'the status parameter is the decision');
  // promoted_at is what the In review column and the vote window key off, so
  // it must be NULL on an In-progress import rather than "now".
  assert.match(insert, /CASE WHEN \$12 = 'promoted' THEN NOW\(\) END/, 'promoted_at only when promoted');
  // …and shared_at is its mirror image: a promoted proposal is public by way
  // of being a proposal, while an In-progress import needs the flag that puts
  // it in everyone's In progress area. An imported PR is group business the
  // moment it lands — it has no private transcript to leak.
  assert.match(insert, /CASE WHEN \$12 = 'promoted' THEN NULL ELSE NOW\(\) END/,
    'an In-progress import is shared on creation');
});

test('the announcement matches what actually happened', () => {
  const from = VOTES.indexOf('const label = pr.title ? `PR #${prNumber} — ${pr.title}`');
  const announce = VOTES.slice(from, VOTES.indexOf('log.info(\'votes\', \'PR imported as proposal\'', from));

  // 'vote' is the message type that renders live vote buttons inline on the
  // activity row. Rendering those for a proposal nobody can vote on yet would
  // be a broken control, not just wrong copy.
  assert.match(announce, /promoteNow\s*\n?\s*\? `\$\{req\.user\.username\} imported \$\{label\} for voting`/,
    'only a promoted import is announced "for voting"');
  assert.match(announce, /const msgType = promoteNow \? 'vote' : 'system'/, 'and only it carries vote buttons');
  assert.match(announce, /action: promoteNow \? 'promoted' : 'created'/, 'the live board update says which happened');
  assert.match(announce, /events\.EVENT_TYPES\.PR_PROMOTED/, 'a promoted import still records the promote');
  assert.match(announce, /events\.EVENT_TYPES\.DEV_SESSION_STARTED/,
    'and an In-progress one records the same event a native session start does');
});

test('the response tells the caller which state it got', () => {
  // The dialog routes on this: an In-progress import has no /proposal to open.
  assert.match(VOTES, /res\.json\(\{ ok: true, sessionId, prNumber, status: session\.status \}\)/);
});

// ── 2. the duplicate guard ───────────────────────────────────────────

test('the duplicate-import guard counts the In-progress states', () => {
  const from = VOTES.indexOf('importedPrNumbers');
  assert.ok(from > 0);
  const guard = VOTES.slice(from, from + 900);
  assert.match(guard, /status IN \('active', 'paused', 'promoted', 'merging', 'merged'\)/,
    'an In-progress import already claims its PR — importing it again must still be refused');
  // The archived exclusion is untouched: withdraw → reopen → re-import is a
  // documented flow (see tests/pr-import-audit.test.js for the boot audit
  // that has to stay in lockstep with this list).
  assert.doesNotMatch(guard, /'archived'/);
});

// ── 3. an imported row is never auto-paused ──────────────────────────

test('pauseSession refuses imported rows, so the promote button keeps working', () => {
  // /promote requires status = 'active'. Auto-pause after idle, LRU eviction
  // and pressure eviction all funnel through pauseSession, so ONE guard there
  // covers all three: an import left on the board overnight is still
  // promotable in the morning. (Pausing it would also be meaningless — there
  // is no container to reclaim.)
  const from = LIFECYCLE.indexOf('async function pauseSession');
  assert.ok(from > 0, 'found pauseSession');
  const fn = LIFECYCLE.slice(from, from + 2500);
  assert.match(fn, /source IS DISTINCT FROM 'imported'/, 'the UPDATE cannot pause an import');

  const victim = LIFECYCLE.indexOf('freeGlobalSlot');
  assert.ok(victim > 0);
  assert.match(LIFECYCLE.slice(victim, victim + 2500), /source IS DISTINCT FROM 'imported'/,
    'and an import is never chosen as the eviction victim');

  // IS DISTINCT FROM, not `<>` — `source` is NULL on every pre-#687 native
  // row, and `NULL <> 'imported'` is NULL, which would exclude them all.
  assert.doesNotMatch(LIFECYCLE, /source <> 'imported'/);
});

test('the idle sweep skips imported rows too', () => {
  const from = SERVER.indexOf('source IS DISTINCT FROM \'imported\'');
  assert.ok(from > 0, 'the auto-pause sweep excludes imports');
});

// ── 4. caps ──────────────────────────────────────────────────────────

test('imported rows do not consume a user’s active-session slots', () => {
  // The cap exists to bound concurrent dev workers. An imported row has no
  // worker, refuses AI turns, and cannot be paused to free anything — so
  // counting it would let three imports lock a user out of starting any work
  // at all, with no way to get the slots back short of closing the PRs.
  const counts = SESSIONS.match(/COUNT\(\*\)[\s\S]{0,400}?status = 'active'[\s\S]{0,200}?source IS DISTINCT FROM 'imported'/g) || [];
  assert.ok(counts.length >= 3, `every active-session cap query excludes imports (found ${counts.length})`);
  assert.match(SESSIONS, /ORDER BY[\s\S]{0,200}LIMIT 1/, 'the LRU victim pick is still there');
});

// ── 5. the sweeper and the preview-open set ──────────────────────────

test('the head sweeper keeps tracking an In-progress import', () => {
  const from = SERVER.indexOf("WHERE cs.source = 'imported'");
  assert.ok(from > 0, 'found the imported head-sync pass');
  assert.match(SERVER.slice(from, from + 400),
    /cs\.status IN \('active', 'paused', 'promoted', 'merging'\)/,
    'a PR updated on GitHub while In progress must still resync its head + preview');
});

test('an In-progress import keeps the preview the import built for it', () => {
  // stillOpenForPreview decides whether a finished (minutes-long) build is
  // persisted or torn down. Before #1162 it accepted only the promoted-side
  // states, which would have discarded the build for EVERY import — the
  // proposal would sit at "Preview building…" forever.
  assert.match(IMPORT_SYNC,
    /PREVIEW_OPEN_STATUSES = new Set\(\['active', 'paused', 'promoted', 'merging'\]\)/);
  assert.match(IMPORT_SYNC, /!PREVIEW_OPEN_STATUSES\.has\(status\)/);
});

test('the head-change note does not claim votes were cleared when there were none', () => {
  const from = IMPORT_SYNC.indexOf('const upForVote =');
  assert.ok(from > 0, 'the note is status-aware');
  const note = IMPORT_SYNC.slice(from, from + 900);
  assert.match(note, /session\.status === 'promoted' \|\| session\.status === 'merging'/);
  assert.match(note, /earlier votes were cleared, please re-review/, 'the up-for-vote wording survives');
  // Both branches promise the rebuild, because both rebuild.
  assert.match(note, /rebuildClause/);
});

// ── 6. promoting an imported row ─────────────────────────────────────

test('/promote routes an imported session to its own branch, before the native path', () => {
  const from = VOTES.indexOf("if (session.source === 'imported') {");
  assert.ok(from > 0, 'the promote handler branches on source');
  assert.match(VOTES.slice(from, from + 200), /await promoteImportedSession\(\{ req, res, session \}\);\s*\n\s*return;/);

  const fn = VOTES.slice(VOTES.indexOf('const promoteImportedSession ='));
  const body = fn.slice(0, fn.indexOf('\n};\n'));

  // The native promote builds staging from heads/<branch_name>. For a
  // fork-headed PR that ref does not exist in the app's own repo, so the
  // imported path re-reads the PR and pins everything to its head SHA —
  // the same thing the import-time kick does.
  assert.match(body, /importGithubClient\(\)/, 'the same client the import used (mock in staging)');
  assert.match(body, /getPR\(/, 'the PR is re-read at promote time');
  assert.match(body, /kickImportedChecks\(/, 'and the rebuild goes through the imported kick');

  // Promoting is asking people to vote on a PR — it must still be open, and
  // we deliberately do not reopen someone else's closed PR on their behalf.
  assert.match(body, /pr\.merged/, 'an already-merged PR cannot be put up for vote');
  assert.match(body, /pr\.state !== 'open'/, 'nor a closed one');

  // The UPDATE is the concurrency guard: two taps, or a tap racing an
  // archive, must not double-promote.
  assert.match(body, /WHERE id = \$1 AND status = 'active' AND source = 'imported'/);
  assert.match(body, /session_state_changed/);

  // Votes are bound to the head SHA (reviewedHeadForSession); anything cast
  // against an older head must not carry into the vote we are opening.
  assert.match(body, /DELETE FROM pr_votes WHERE session_id = \$1/);
  assert.match(body, /events\.EVENT_TYPES\.PR_PROMOTED/, 'it is a real promote, recorded as one');
});

test('promoting does not rebuild a preview that is already pinned to the head', () => {
  const fn = VOTES.slice(VOTES.indexOf('const promoteImportedSession ='));
  const body = fn.slice(0, fn.indexOf('\n};\n'));
  // The import already built one against this SHA. Rebuilding it would blow
  // the preview away and put the proposal back to "building…" the moment it
  // went up for vote — for no change in what is being previewed.
  assert.match(body, /const needsBuild = !session\.staging_url/);
  assert.match(body, /normalizedSha\(session\.checks_commit_sha\) !== normalizedSha\(headSha\)/);
  assert.match(body, /if \(needsBuild\)/);
});

// ── 7. the card ──────────────────────────────────────────────────────

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._sharedById = {};
  return AppView;
}

const importedRow = (over) => ({
  id: 61, status: 'active', source: 'imported', pr_number: 77,
  pr_title: 'Add a button', imported_pr_author: 'outsider',
  shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T01:00:00Z',
  last_activity_at: '2026-06-01T02:00:00Z',
  ...over,
});

test('the imported card says what it is and offers the one action it has', () => {
  const AppView = makeAppView();
  const html = AppView._renderMySessionCard(importedRow());

  assert.match(html, /Imported PR<\/span>/, 'the provenance badge is on the card');
  assert.match(html, /Imported pull request by outsider · not up for vote yet/,
    'the subtitle names the author and the state — the importer did not write this code');
  assert.match(html, /Put up for vote/, 'the promote action is on the card face');
  assert.match(html, /AppView\.promoteImportedSession\(61, this\)/, 'wired to the promote call');

  // Visibility is NOT offered: an imported PR is public on GitHub and shared
  // on the board from the moment it lands, so "Hide" would only take a card
  // away from people who can already read the PR.
  assert.doesNotMatch(html, /Make visible|>Hide</);
});

test('the imported card taps through to its discussion, not to a dev chat', () => {
  const AppView = makeAppView();
  const html = AppView._renderMySessionCard(importedRow());
  // There is no dev session behind an import: data-session-chip would open
  // the chat view, which refuses turns on an imported row.
  assert.match(html, /data-imported-session-row="61"/);
  assert.doesNotMatch(html, /data-session-chip=/);
  // …and the board handler knows that attribute.
  assert.match(APP_VIEW_SRC, /\[data-imported-session-row\]/);
  assert.match(APP_VIEW_SRC, /el\.dataset\.sharedSessionRow \|\| el\.dataset\.importedSessionRow/,
    'keyboard activation resolves it too');
});

test('the imported card offers no chat sharing, and its archive is honest', () => {
  const AppView = makeAppView();
  const html = AppView._renderMySessionCard(importedRow());
  const key = (html.match(/data-card-menu="([^"]+)"/) || [])[1];
  const labels = (AppView._cardMenus[key] || []).map((i) => i.label);

  assert.ok(!labels.some((l) => /Share chat|Chat shared/.test(l)),
    'there is no transcript behind an import to publish');
  assert.ok(labels.some((l) => /Open public discussion/.test(l)), 'the discussion is still reachable');
  assert.ok(labels.some((l) => /Remove from the board/.test(l)), 'and "Archive" is named for what it does here');

  const archive = (AppView._cardMenus[key] || []).find((i) => /Remove from the board/.test(i.label));
  assert.match(archive.title, /closes it on GitHub/,
    'archiving an import closes the PR — the tooltip must not imply otherwise');
});

test('a native session card is untouched by all of this', () => {
  const AppView = makeAppView();
  const html = AppView._renderMySessionCard({
    id: 51, session_title: 'My session', status: 'active',
    created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T02:00:00Z',
  });
  assert.doesNotMatch(html, /Imported PR|Put up for vote|data-imported-session-row/);
  assert.match(html, /data-session-chip="51"/);
  assert.match(html, /Make visible/, 'the visibility control is still the native card’s action');
});

// The declared proposal checks in dapp.json are the only place this state is
// asserted against a running browser, and they can only see it because the
// demo path seeds it (an import needs a real GitHub PR). Pin the pairing so
// removing one silently doesn't leave the other passing on nothing.
test('the demo board seeds both In-progress imports the dapp.json checks look for', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const checks = dapp.tests.filter((t) => /#1162/.test(t.name));
  assert.equal(checks.length, 2, 'both #1162 checks are declared');
  for (const t of checks) {
    assert.match(t.path, /demo=1/, 'they run against the demo board');
    assert.match(t.path, /#app\/[^/]+\/dev$/, 'on the dev board screen itself');
  }
  assert.ok(checks.some((t) => /promoteImportedSession/.test(t.expectSelector || '')),
    'one asserts the promote action exists on the card');
  assert.ok(checks.some((t) => /not up for vote yet/.test(t.expectText || '')),
    'and that the card says it is not up for vote');

  // The rows those selectors resolve against.
  assert.match(SESSIONS, /id: 990108[\s\S]{0,400}source: 'imported'/, 'the viewer’s own imported row');
  assert.match(SESSIONS, /id: 990004[\s\S]{0,400}source: 'imported'/, 'and someone else’s');
  for (const id of ['990108', '990004']) {
    assert.ok(checks.some((t) => (t.expectSelector || '').includes(id)), `a check selects row ${id}`);
  }
});

test('someone else’s imported card is not described as their work', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(
    { ...importedRow(), id: 71, user_id: 9, username: 'importer' },
    {}
  );
  assert.match(html, /Imported pull request by outsider · imported by importer/);
  assert.doesNotMatch(html, /is working on this/, 'nobody is mid-turn on an imported PR');
  assert.match(html, /Imported PR<\/span>/);
});

test('the promote button is on the imported row’s detail page too', () => {
  const AppView = makeAppView();
  const html = AppView._detailActionsHtml('session', importedRow());
  assert.match(html, /Put up for vote/, 'the card and its detail page offer the same action');

  const notMine = AppView._detailActionsHtml('session', importedRow({ user_id: 9 }));
  assert.doesNotMatch(notMine, /Put up for vote/, 'someone else’s import is not yours to promote');

  const already = AppView._detailActionsHtml('session', importedRow({ status: 'promoted' }));
  assert.doesNotMatch(already, /Put up for vote/, 'and it is offered once');

  const native = AppView._detailActionsHtml('session', { ...importedRow(), source: null });
  assert.doesNotMatch(native, /Put up for vote/, 'a native session promotes from its chat, not from here');
});

// Both surfaces gate on exactly the state POST /promote accepts, so the
// button never renders as a guaranteed 404.
test('the promote action is offered only where the endpoint would accept it', () => {
  const AppView = makeAppView();
  for (const status of ['promoted', 'merging', 'merged', 'archived', 'paused']) {
    assert.doesNotMatch(
      AppView._renderMySessionCard(importedRow({ status })), /Put up for vote/,
      `no promote button on a ${status} import`
    );
    assert.doesNotMatch(
      AppView._detailActionsHtml('session', importedRow({ status })), /Put up for vote/,
      `nor on its ${status} detail page`
    );
  }
  assert.match(VOTES, /WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.status = 'active'/,
    'and that state is the endpoint’s own precondition');
});
