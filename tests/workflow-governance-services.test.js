'use strict';

// The governance machine's work handlers (src/workflow/governance-proposal/
// services.ts) with GitHub stubbed: close-then-comment is checkpointed so a
// retry never comments twice, a gone issue counts as closed, and the target
// check reads an issue's state. No database.

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
const gh = {
  enabled: true,
  closeFails: null,
  isEnabled: () => gh.enabled,
  closeIssue: async (o, r, n) => { calls.push(['close', n]); if (gh.closeFails) throw gh.closeFails; },
  createIssueComment: async (o, r, n, body) => { calls.push(['comment', n, body]); },
  thread: { comments: [] },
  fetchIssueComments: async (o, r, n) => { calls.push(['read-comments', n]); return gh.thread; },
  getIssue: async (o, r, n) => { calls.push(['get', n]); if (n === 404) throw Object.assign(new Error('nf'), { status: 404 }); return { state: n === 1 ? 'open' : 'closed' }; },
  noteIssuesClosed: () => calls.push(['note']),
  invalidateIssuesCache: () => calls.push(['bust']),
};
const id = require.resolve('../src/services/github');
require.cache[id] = { id, filename: id, loaded: true, exports: gh, paths: [] };
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { pushIssueUpdate: (d) => calls.push(['push', d.action]) }, paths: [] };

const { governanceServices } = require('../src/workflow/governance-proposal/services.ts');
const services = governanceServices({ config: {}, pool: { query: async () => ({ rows: [] }) } });

function ctx(input, resumeFrom = null) {
  const saved = [];
  return { saved, ctx: { input, resumeFrom, checkpoint: async (v) => { saved.push(v); }, signal: new AbortController().signal } };
}

const MARKER = 'homeroom-governance:issue:5:close';

test('github.closeIssue closes, checkpoints, comments with its marker, and busts the cache', async () => {
  calls.length = 0;
  const { saved, ctx: c } = ctx({ owner: 'a', repo: 'b', number: 7, comment: 'Closed.', marker: MARKER, bustCache: true, appId: 1, appSlug: 's' });
  assert.deepEqual(await services['github.closeIssue'].run(c), { closed: true });
  assert.deepEqual(calls, [['close', 7], ['comment', 7, `Closed.\n\n<!-- ${MARKER} -->`], ['note'], ['bust'], ['push', 'github_synced']]);
  assert.deepEqual(saved, [{ closed: true }, { closed: true, commenting: true }, { closed: true, commented: true }]);
});

test('a retry after a lost comment reply finds the comment instead of posting it again', async () => {
  const input = { owner: 'a', repo: 'b', number: 7, comment: 'Closed.', marker: MARKER };
  // GitHub created the comment, but the reply never arrived.
  calls.length = 0;
  gh.thread = { comments: [{ body: `Closed.\n\n<!-- ${MARKER} -->` }] };
  const found = ctx(input, { closed: true, commenting: true });
  await services['github.closeIssue'].run(found.ctx);
  assert.deepEqual(calls, [['read-comments', 7]], 'no second comment');
  assert.deepEqual(found.saved, [{ closed: true, commented: true }]);
  // The attempt failed before GitHub saw it: the comment is posted.
  calls.length = 0;
  gh.thread = { comments: [{ body: 'someone else' }] };
  await services['github.closeIssue'].run(ctx(input, { closed: true, commenting: true }).ctx);
  assert.deepEqual(calls.map((c) => c[0]), ['read-comments', 'comment']);
  // The thread cannot be read: retry later rather than risk a duplicate.
  calls.length = 0;
  gh.thread = { comments: [], note: 'rate limited' };
  await assert.rejects(services['github.closeIssue'].run(ctx(input, { closed: true, commenting: true }).ctx), /rate limited/);
  assert.deepEqual(calls, [['read-comments', 7]]);
  gh.thread = { comments: [] };
});

test('a retry resumes after the checkpoint: no second close, no second comment', async () => {
  calls.length = 0;
  await services['github.closeIssue'].run(ctx({ owner: 'a', repo: 'b', number: 7, comment: 'Closed.' }, { closed: true }).ctx);
  assert.deepEqual(calls, [['comment', 7, 'Closed.']]);
  calls.length = 0;
  await services['github.closeIssue'].run(ctx({ owner: 'a', repo: 'b', number: 7, comment: 'Closed.' }, { closed: true, commented: true }).ctx);
  assert.deepEqual(calls, []);
});

test('a gone issue is done; GitHub off is a permanent failure', async () => {
  gh.closeFails = Object.assign(new Error('gone'), { status: 410 });
  assert.deepEqual(await services['github.closeIssue'].run(ctx({ owner: 'a', repo: 'b', number: 8, comment: 'x' }).ctx), { gone: true });
  gh.closeFails = null;
  gh.enabled = false;
  await assert.rejects(services['github.closeIssue'].run(ctx({ owner: 'a', repo: 'b', number: 8 }).ctx), (err) => err.permanent === true);
  gh.enabled = true;
});

test('governance.checkTarget reports whether the target is still open', async () => {
  const run = (n) => services['governance.checkTarget'].run(ctx({ owner: 'a', repo: 'b', number: n }).ctx);
  assert.deepEqual(await run(1), { open: true });
  assert.deepEqual(await run(2), { open: false });
  assert.deepEqual(await run(404), { open: false });
});
