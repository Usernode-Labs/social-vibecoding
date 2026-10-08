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
  fetchIssueComments: async (o, r, n, opts) => { calls.push(['read-comments', n, opts.since]); return gh.thread; },
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
  assert.equal(saved.length, 3);
  assert.deepEqual([saved[0], saved[2]], [{ closed: true }, { closed: true, commented: true }]);
  assert.ok(!Number.isNaN(Date.parse(saved[1].commenting)), 'records when it started posting');
});

test('a retry after a lost comment reply finds the comment instead of posting it again', async () => {
  const input = { owner: 'a', repo: 'b', number: 7, comment: 'Closed.', marker: MARKER };
  const lost = { closed: true, commenting: '2026-10-07T10:00:00.000Z' };
  const since = '2026-10-07T09:50:00.000Z'; // the attempt's start, less ten minutes
  // GitHub created the comment, but the reply never arrived.
  calls.length = 0;
  gh.thread = { comments: [{ body: `Closed.\n\n<!-- ${MARKER} -->` }], truncated: false };
  const found = ctx(input, lost);
  await services['github.closeIssue'].run(found.ctx);
  assert.deepEqual(calls, [['read-comments', 7, since]], 'reads only the recent comments, posts nothing');
  assert.deepEqual(found.saved, [{ closed: true, commented: true }]);
  // Found even in a thread too long to read whole.
  calls.length = 0;
  gh.thread = { comments: [{ body: `<!-- ${MARKER} -->` }], truncated: true };
  await services['github.closeIssue'].run(ctx(input, lost).ctx);
  assert.deepEqual(calls.map((c) => c[0]), ['read-comments']);
  // The attempt failed before GitHub saw it: the comment is posted.
  calls.length = 0;
  gh.thread = { comments: [{ body: 'someone else' }], truncated: false };
  await services['github.closeIssue'].run(ctx(input, lost).ctx);
  assert.deepEqual(calls.map((c) => c[0]), ['read-comments', 'comment']);
  // Not found, but the recent comments did not all fit: cannot say, try later.
  calls.length = 0;
  gh.thread = { comments: [{ body: 'someone else' }], truncated: true };
  await assert.rejects(services['github.closeIssue'].run(ctx(input, lost).ctx), /every recent comment/);
  assert.deepEqual(calls.map((c) => c[0]), ['read-comments']);
  // The thread cannot be read at all: try later rather than risk a duplicate.
  calls.length = 0;
  gh.thread = { comments: [], truncated: false, note: 'rate limited' };
  await assert.rejects(services['github.closeIssue'].run(ctx(input, lost).ctx), /rate limited/);
  assert.deepEqual(calls.map((c) => c[0]), ['read-comments']);
  gh.thread = { comments: [], truncated: false };
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
