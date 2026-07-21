// archiveSession / unarchiveSession must fire pushIssueUpdate when the
// session carries linked_issues — that broadcast is what clears (or
// restores) the issue list's derived "In progress" chip on every open Dev
// panel the moment a session is withdrawn / auto-rejected / stale-swept
// (all of which funnel through archiveSession) or brought back. With no
// linkage there is nothing to repaint, so no broadcast fires.
//
// The lifecycle service requires its collaborators at module load and
// looks ws up lazily per call, so everything is stubbed via the modules'
// exports before the functions run.
//
// Run with: node --test tests/session-lifecycle-issue-push.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const ws = require('../src/services/ws');
const pushedSession = [];
const pushedIssue = [];
ws.pushSessionUpdate = (d) => pushedSession.push(d);
ws.pushIssueUpdate = (d) => pushedIssue.push(d);
ws.sendSystemMessage = async () => {};

const staging = require('../src/services/staging');
staging.teardownStaging = async () => {};

const worker = require('../src/services/worker');
worker.destroyWorker = async () => {};
worker.workerContainerName = (id) => `worker-${id}`;
worker.destroyCcVolume = async () => {};

const workerProgress = require('../src/services/worker-progress');
workerProgress.clear = () => {};

const github = require('../src/services/github');
github.closePR = async () => {};
github.reopenPR = async () => {};

const { archiveSession, unarchiveSession } = require('../src/services/session-lifecycle');

// Minimal pool: the status-flip UPDATE returns a row (the transition
// happened), the follow-up SELECT returns the session row under test,
// everything else is a silent no-op.
function makePool(sessionRow) {
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/^UPDATE chat_sessions SET status/i.test(s.trim())) {
        return { rows: [{ id: sessionRow.id }] };
      }
      if (/SELECT cs\.\*/.test(s)) {
        return { rows: [sessionRow] };
      }
      return { rows: [] };
    },
  };
}

function baseSession(over) {
  return {
    id: 5, app_id: 1, app_slug: 'demo', repo_url: null,
    pr_number: null, pr_title: null, staging_container_id: null,
    user_id: 7, owner_username: 'tester', cc_purged: false,
    linked_issues: [],
    ...over,
  };
}

function reset() {
  pushedSession.length = 0;
  pushedIssue.length = 0;
}

test('archiveSession broadcasts an issue_update when linked_issues is non-empty', async () => {
  reset();
  const { archived } = await archiveSession({
    pool: makePool(baseSession({ linked_issues: [4, 9] })),
    sessionId: 5,
    reason: 'manual',
  });
  assert.strictEqual(archived, true);
  assert.strictEqual(pushedSession.length, 1);
  assert.strictEqual(pushedIssue.length, 1);
  assert.strictEqual(pushedIssue[0].action, 'updated');
  assert.strictEqual(pushedIssue[0].source, 'session_archived');
  assert.strictEqual(pushedIssue[0].appSlug, 'demo');
  assert.strictEqual(pushedIssue[0].appId, 1);
});

test('archiveSession stays silent on the issue channel with no linkage', async () => {
  reset();
  const { archived } = await archiveSession({
    pool: makePool(baseSession()),
    sessionId: 5,
    reason: 'manual',
  });
  assert.strictEqual(archived, true);
  assert.strictEqual(pushedSession.length, 1, 'session update still fires');
  assert.strictEqual(pushedIssue.length, 0, 'no issue update without linked issues');
});

test('unarchiveSession broadcasts an issue_update when linked_issues is non-empty', async () => {
  reset();
  const { unarchived } = await unarchiveSession({
    pool: makePool(baseSession({ linked_issues: [4] })),
    sessionId: 5,
  });
  assert.strictEqual(unarchived, true);
  assert.strictEqual(pushedIssue.length, 1);
  assert.strictEqual(pushedIssue[0].source, 'session_unarchived');
});

test('unarchiveSession stays silent on the issue channel with no linkage', async () => {
  reset();
  const { unarchived } = await unarchiveSession({
    pool: makePool(baseSession()),
    sessionId: 5,
  });
  assert.strictEqual(unarchived, true);
  assert.strictEqual(pushedIssue.length, 0);
});
