// Putting a change up for a vote (POST /api/sessions/:id/promote):
// #2500 / #2537, the originating-issue backfill.
//
// Starting a dev chat from an issue card recorded the number in
// chat_sessions.created_from_issue_number only. The issue board linked back
// to the session from there (services/issue-proposal-ref.js unions the
// column in), but the proposal's own "Addresses" chips and the deterministic
// `Closes #N` block both read chat_sessions.linked_issues, which nothing
// wrote unless the Mayor declared the link with `addresses_issues` — and an
// OpenRouter or direct-agent turn emits no Mayor tool at all. So the
// proposal read "No issues linked yet" and merging it closed nothing.
//
// Sessions created since carry the link from the INSERT (see
// tests/create-session-issue-link.test.js). Promote time is where the rows
// that predate that get repaired, and what is pinned here:
//   1. An unseeded row with an originating issue and no linkage gets the
//      issue linked, through proposal-update.updateLinkedIssues so a
//      session that already has a pull request gets `Closes #N` appended to
//      its live body too, and is then marked seeded.
//   2. A SEEDED row with empty linkage is left alone: that emptiness is an
//      author who removed the issue, and resurrecting it would make the
//      linked-issues editor look broken.
//   3. A row that already links something is left alone.
//   4. The backfill is best-effort — a failure inside it never stops the
//      proposal going up for a vote.
//
// Since the proposal machine, the backfill is the first thing its
// review.open work does (src/workflow/proposal/services.ts) once a promote
// is claimed for review; it reports `issueLinkSeeded`, and the move into
// review marks the row seeded in its transaction (machine.ts `promoted`
// write). Pinned here against review.open with the legacy modules it
// reaches (through src/workflow/legacy.ts, the shared require cache)
// stubbed. Nothing real spins up.
//
// Run with: node --test tests/promote-issue-backfill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { proposalServices } = require('../src/workflow/proposal/services.ts');
const { WORK } = require('../src/workflow/proposal/machine.ts');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function sessionRow(overrides = {}) {
  return {
    id: 7,
    app_id: 5,
    user_id: 3,
    status: 'active',
    is_headless: false,
    branch_name: 'dev/evan-1',
    pr_number: null,
    pr_title: null,
    created_from_issue_number: 2496,
    linked_issues: [],
    issue_link_seeded: false,
    app_slug: 'whiteboard',
    app_name: 'Whiteboard',
    repo_url: 'https://github.com/acme/whiteboard',
    ...overrides,
  };
}

// `row` is the session review.open reads. `onUpdateLinkedIssues` lets a
// test make the backfill blow up.
async function reviewOpen({ row, onUpdateLinkedIssues }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    limits: require.resolve('../src/services/limits'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    proposalUpdate: require.resolve('../src/services/proposal-update'),
    appAdmins: require.resolve('../src/services/app-admins'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const seen = { linkCalls: [], prCreated: false, linkedAtCreation: null };
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (/FROM chat_sessions cs JOIN apps a/.test(s)) return { rows: [row], rowCount: 1 };
      if (/FROM chat_session_messages/.test(s)) return { rows: [{ content: 'add a thing' }], rowCount: 1 };
      if (/FROM users/.test(s)) return { rows: [{ username: 'evan' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  stub(ids.github, { isEnabled: () => false });
  stub(ids.limits, { resolveBillingPath: async () => ({ error: 'no key' }) });
  stub(ids.appAdmins, { refreshExplicitApproval: async () => {} });
  stub(ids.proposalUpdate, {
    async updateLinkedIssues(args) {
      seen.linkCalls.push(args);
      if (onUpdateLinkedIssues) return onUpdateLinkedIssues(args);
      args.session.linked_issues = args.addIssues.slice();
      return { changed: true, linkedIssues: args.addIssues.slice() };
    },
  });
  stub(ids.prMetadata, {
    applyPrMetadata: async ({ session }) => {
      seen.prCreated = true;
      seen.linkedAtCreation = session.linked_issues;
      // Stop the promote at the next gate: we only care that the backfill
      // ran first, not that a whole promote succeeds under stubs.
      const err = new Error('stubbed: no GitHub in this test');
      err.code = 'no_commits';
      throw err;
    },
  });

  try {
    let result = null;
    let error = null;
    try {
      result = await proposalServices({ config: {}, pool })[WORK.open].run({ input: { sessionId: row.id, n: 1, userId: 3 } });
    } catch (err) {
      error = err;
    }
    return { result, error, seen };
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
}

test('an unseeded issue-started proposal gets its originating issue linked at promote', async () => {
  const row = sessionRow();
  const { seen, error } = await reviewOpen({ row });
  assert.equal(seen.linkCalls.length, 1, 'the backfill ran');
  assert.deepEqual(seen.linkCalls[0].addIssues, [2496]);
  assert.deepEqual(seen.linkCalls[0].removeIssues, []);
  assert.equal(seen.linkCalls[0].owner, 'acme');
  assert.equal(seen.linkCalls[0].repo, 'whiteboard');
  assert.ok(seen.prCreated, 'the backfill runs BEFORE the pull request is opened');
  assert.deepEqual(seen.linkedAtCreation, [2496], 'the row carries the link into PR creation');
  assert.equal(error.code, 'no_commits', 'the stubbed creation stopped it at the next gate');
});

test('a linked backfill is reported, so the move into review marks the row seeded', async () => {
  // A row that already has its pull request: review.open goes all the way.
  const row = sessionRow({ pr_number: 41, pr_title: 'Add a thing' });
  const { result, error, seen } = await reviewOpen({ row });
  assert.equal(error, null);
  assert.equal(seen.prCreated, false);
  assert.equal(result.issueLinkSeeded, true);
});

test('a seeded proposal with no linked issues is left alone (a deliberate removal stays removed)', async () => {
  const row = sessionRow({ issue_link_seeded: true });
  const { seen } = await reviewOpen({ row });
  assert.equal(seen.linkCalls.length, 0);
  assert.deepEqual(seen.linkedAtCreation, []);
});

test('a proposal that already links issues is left alone', async () => {
  const row = sessionRow({ linked_issues: [900] });
  const { seen } = await reviewOpen({ row });
  assert.equal(seen.linkCalls.length, 0);
  assert.deepEqual(seen.linkedAtCreation, [900]);
});

test('a proposal with no originating issue has nothing to backfill', async () => {
  const row = sessionRow({ created_from_issue_number: null });
  const { seen } = await reviewOpen({ row });
  assert.equal(seen.linkCalls.length, 0);
});

test('a failing backfill never stops the proposal going up for a vote', async () => {
  const failing = () => { throw new Error('GitHub is down'); };
  const { seen } = await reviewOpen({ row: sessionRow(), onUpdateLinkedIssues: failing });
  assert.equal(seen.linkCalls.length, 1, 'it was attempted');
  assert.ok(seen.prCreated, 'the promote carried on regardless');
  const { result, error } = await reviewOpen({ row: sessionRow({ pr_number: 41, pr_title: 'Add a thing' }), onUpdateLinkedIssues: failing });
  assert.equal(error, null);
  assert.equal(result.issueLinkSeeded, false, 'and is not marked seeded, so it retries next time');
});
