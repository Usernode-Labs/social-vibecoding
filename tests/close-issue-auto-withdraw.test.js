// Tests for the auto-resolve of close_issue governance proposals whose
// target issue a merge closed:
//   1. The look names them (src/services/issue-close-watcher.js
//      closeAfterMerge, closeIncluded): `targets` are the app's open close
//      proposals for the numbers it saw closed (or gone), and only once it
//      saw them so. A close proposal for a linked request GitHub has not
//      closed yet is not named at the first look, and is at the second,
//      once the platform closed it.
//   2. The merge-followups machine's issues.closeAfterMerge work hands them
//      on in its result; it no longer supersedes anything itself. The
//      transition that applies the result tells each one (Filed, then
//      TargetClosed), pinned in tests/workflow-merge-followups-postgres
//      .test.js; end to end in tests/workflow-merge-followups-platform-
//      postgres.test.js.
//   3. The governance machine takes Filed and TargetClosed from that
//      machine's message, and from no other machine's.
//
// Run with: node --test tests/close-issue-auto-withdraw.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function stub(id, exports, orig) {
  require.cache[id] = {
    id, filename: id, loaded: true, exports, paths: orig ? orig.paths : [],
  };
}

// A pool that answers the targets read from `proposals` (request number to
// the id of its open close proposal).
function makePool(proposals = new Map()) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/kind = 'close_issue'/.test(sql)) {
        return { rows: [...proposals].filter(([n]) => params[1].includes(n)).map(([number, id]) => ({ id, number })) };
      }
      return { rows: [] };
    },
  };
}

// ── Part 1: the look names the close proposals ───────────────────────────

function loadWatcher({ gh = {} }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    closed: require.resolve('../src/services/homeroom-bot-closed-requests'),
    prMeta: require.resolve('../src/services/pr-metadata'),
    subject: require.resolve('../src/services/issue-close-watcher'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const closes = [];
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (...a) => (gh.getPR ? gh.getPR(...a) : { body: '' }),
    getIssue: async (...a) => (gh.getIssue ? gh.getIssue(...a) : { number: a[2], state: 'closed' }),
    closeIssue: async (o, r, n) => { closes.push(n); return { number: n, state: 'closed' }; },
    noteIssuesClosed: () => {},
    unsuppressIssues: () => {},
    invalidateIssuesCache: () => {},
  }, orig.github);
  stub(ids.ws, { pushIssueUpdate: () => {} }, orig.ws);
  stub(ids.closed, { noteRequestsClosed: async () => ({ withdrawn: [] }) }, orig.closed);

  delete require.cache[ids.prMeta];
  delete require.cache[ids.subject];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.prMeta];
    delete require.cache[ids.subject];
  };
  return { subject, closes, restore };
}

const WATCH_ARGS = { owner: 'usernode-bot', repo: 'some-app', prNumber: 42, appId: 7 };
const MERGED_PR = {
  body: 'Closes #3', merged: true,
  base: { ref: 'main', repo: { full_name: 'usernode-bot/some-app', default_branch: 'main' } },
};

test('watcher: the close proposals for numbers seen closed are named, from that app\'s open ones', async () => {
  const pool = makePool(new Map([[3, 61], [9, 62]]));
  const { subject, restore } = loadWatcher({ gh: { getPR: async () => ({ body: 'Closes #3, fixes #9' }) } });
  try {
    const res = await subject.closeAfterMerge({ ...WATCH_ARGS, pool });
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(res.targets, [{ issueId: 61, number: 3 }, { issueId: 62, number: 9 }]);
    const read = pool.calls.find((c) => /kind = 'close_issue'/.test(c.sql));
    assert.match(read.sql, /app_id = \$1 AND kind = 'close_issue' AND status = 'open'/);
    assert.deepEqual(read.params, [7, [3, 9]]);
  } finally { restore(); }
});

test('watcher: gone (404-skipped) numbers name their close proposals too', async () => {
  const pool = makePool(new Map([[6, 63]]));
  const { subject, restore } = loadWatcher({
    gh: {
      getPR: async () => ({ body: 'Closes #6' }),
      getIssue: async () => { const e = new Error('Not Found'); e.status = 404; throw e; },
    },
  });
  try {
    const res = await subject.closeAfterMerge({ ...WATCH_ARGS, pool });
    assert.deepEqual(res.skipped, [6]);
    assert.deepEqual(res.targets, [{ issueId: 63, number: 6 }]);
  } finally { restore(); }
});

// Before this, the merge work resolved the close proposals of every linked
// request BEFORE it watched GitHub close them: a request that never closed
// (GitHub dropped the keyword, the PR was not on the default branch) left
// its close proposal superseded with the request still open.
test('watcher: a close proposal for a request still open is named only once a look sees it closed', async () => {
  const pool = makePool(new Map([[3, 64]]));
  let state = 'open';
  const { subject, closes, restore } = loadWatcher({
    gh: { getPR: async () => MERGED_PR, getIssue: async (o, r, n) => ({ number: n, state }) },
  });
  try {
    const first = await subject.closeAfterMerge({ ...WATCH_ARGS, linkedIssues: [3], pool, look: 1 });
    assert.deepEqual([first.waiting, first.targets], [true, []], 'not while GitHub may still close it');
    const second = await subject.closeAfterMerge({ ...WATCH_ARGS, linkedIssues: [3], pool, look: 2 });
    assert.deepEqual(closes, [3], 'the second look closed it');
    assert.deepEqual(second.targets, [{ issueId: 64, number: 3 }], 'and only then names its close proposal');
    // GitHub closing it in between is the same: named at the look that sees it.
    state = 'closed';
    const late = await subject.closeAfterMerge({ ...WATCH_ARGS, linkedIssues: [3], pool, look: 1 });
    assert.deepEqual(late.targets, [{ issueId: 64, number: 3 }]);
  } finally { restore(); }
});

test('watcher: a request the platform could not close names nothing', async () => {
  const pool = makePool(new Map([[3, 65]]));
  const { subject, restore } = loadWatcher({
    gh: { getPR: async () => ({ ...MERGED_PR, merged: false }), getIssue: async (o, r, n) => ({ number: n, state: 'open' }) },
  });
  try {
    const res = await subject.closeAfterMerge({ ...WATCH_ARGS, linkedIssues: [3], pool, look: 2 });
    assert.deepEqual([res.stillOpen, res.targets], [[3], []]);
  } finally { restore(); }
});

// ── Part 2: the merge work hands them on ─────────────────────────────────

function loadMergeWork({ look = null, included = null }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    watcher: require.resolve('../src/services/issue-close-watcher'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const asked = [];
  stub(ids.github, { isEnabled: () => true }, orig.github);
  stub(ids.watcher, {
    async closeAfterMerge(args) { asked.push(['closeAfterMerge', args]); return look(args); },
    async closeIncluded(args) { asked.push(['closeIncluded', args]); return included(args); },
  }, orig.watcher);
  const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
  const { WORK } = require('../src/workflow/merge-followups/machine.ts');
  const pool = makePool();
  const handler = mergeFollowupsServices({ config: {}, pool })[WORK.issues];
  const run = (input) => handler.run({ input, key: 'issues', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { run, pool, asked, restore };
}

const MERGE_INPUT = {
  sessionId: 7, appId: 5, appSlug: 'widget', prNumber: 12, owner: 'acme', repo: 'widget',
  linkedIssues: [42, 43], closeOnly: false, look: 1,
};

test('merge work: the look\'s targets are its result, for the transition to tell', async () => {
  const targets = [{ issueId: 91, number: 42 }];
  const { run, pool, asked, restore } = loadMergeWork({
    look: () => ({ closed: [42, 43], skipped: [], stillOpen: [], waiting: false, targets }),
  });
  try {
    const out = await run({ ...MERGE_INPUT });
    assert.deepEqual(out.targets, targets);
    assert.equal(asked.length, 1);
    const [, args] = asked[0];
    assert.equal(args.pool, pool, 'the machine\'s pool forwarded');
    assert.deepEqual([args.appId, args.prNumber, args.linkedIssues, args.look], [5, 12, [42, 43], 1]);
    assert.equal(pool.calls.length, 0, 'it supersedes nothing itself');
  } finally { restore(); }
});

test('merge work: an included change\'s closes name their targets too, under its carrier\'s pull request', async () => {
  const targets = [{ issueId: 92, number: 42 }];
  const { run, asked, restore } = loadMergeWork({
    included: () => ({ closed: [42, 43], failed: [], targets }),
  });
  try {
    const out = await run({ ...MERGE_INPUT, closeOnly: true, carrierPrNumber: 30 });
    assert.deepEqual(out, { closed: [42, 43], targets });
    assert.equal(asked[0][0], 'closeIncluded');
    assert.equal(asked[0][1].prNumber, 30);
  } finally { restore(); }
});

test('merge work: a failing look fails the work item, so it is retried', async () => {
  const { run, restore } = loadMergeWork({ look: () => { throw new Error('db down'); } });
  try {
    await assert.rejects(run({ ...MERGE_INPUT }), /db down/);
  } finally { restore(); }
});

test('nothing supersedes a close proposal outside the governance machine\'s own messages', () => {
  assert.equal(require('../src/routes/issues').resolveSupersededCloseProposals, undefined);
  const platform = fs.readFileSync(require.resolve('../src/workflow/platform.ts'), 'utf8');
  assert.doesNotMatch(platform, /targetsClosed/);
  const services = fs.readFileSync(require.resolve('../src/workflow/merge-followups/services.ts'), 'utf8');
  assert.doesNotMatch(services, /resolveSupersededCloseProposals|TargetClosed/);
});

// ── Part 3: the governance machine hears the merge ───────────────────────

test('governance: Filed and TargetClosed are taken from merge-followups\' message, and from no other machine\'s', () => {
  const { governanceProposal } = require('../src/workflow/governance-proposal/machine.ts');
  const { reject } = require('../src/workflow/kernel/index.ts');
  const machine = governanceProposal({ dataKey: 'synthetic' });
  const from = (m) => ({ kind: 'message', from: { machine: m, key: 'session:1', eventId: 1 } });
  const filed = (source) => machine.authorize.get('Filed')({ type: 'Filed', payload: { issueId: 1 }, source, actor: null }, {});
  const closed = (source) => machine.authorize.get('TargetClosed')(
    { type: 'TargetClosed', payload: { issueNumber: 3, cause: { kind: 'pr-merge', prNumber: 12 } }, source, actor: null }, {});
  assert.equal(filed(from('merge-followups')), true);
  assert.equal(closed(from('merge-followups')), true);
  assert.deepEqual(filed(from('app-delivery')), reject('not_allowed'));
  assert.deepEqual(closed(from('app-delivery')), reject('internal_only'));
  // The sources it took before are unchanged.
  assert.equal(filed({ kind: 'route' }), true);
  assert.equal(closed({ kind: 'system' }), true);
  assert.deepEqual(closed({ kind: 'admin' }), reject('internal_only'));
});
