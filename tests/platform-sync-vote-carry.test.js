// #955: what the platform's own "sync with main" turn does to a proposal's
// reviewed revision.
//
// A sync commit changes the branch WITHOUT changing the patch under review, so
// the approvals it already earned still describe the code — that is why a sync
// has never reset votes. Once the reviewed revision became an exact SHA pin
// (#872) the platform had to start saying so out loud: advance the pin to the
// commit we just pushed and carry the vote stamps with it, or the next
// reconciliation reads OUR merge commit as an author push and deletes the tally.
//
// The safety gate is the pushed commit's FIRST parent: a merge made on top of
// an author commit nobody reviewed must NOT inherit the approval.

const test = require('node:test');
const assert = require('node:assert/strict');

const REVIEWED = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);
const AUTHOR = 'c'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// sync-main lazy-requires github / ws / visuals / pr-import-sync inside the
// advance, so the stubs only have to be in place by CALL time.
function loadSyncMain({ githubEnabled = true, parents = {}, parentsThrow = false } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    subject: require.resolve('../src/services/sync-main'),
  };
  const original = {};
  for (const [key, id] of Object.entries(ids)) original[key] = require.cache[id];

  const messages = [];
  const voteUpdates = [];
  const pendingCalls = [];
  const rerunCalls = [];
  const parentReads = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, {
    isEnabled: () => githubEnabled,
    getCommitParents: async (_owner, _repo, sha) => {
      parentReads.push(sha);
      if (parentsThrow) throw new Error('GitHub unavailable');
      return parents[String(sha).toLowerCase()] || [];
    },
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content, _kind, meta, thread) => {
      messages.push({ content, meta, thread });
    },
    pushVoteUpdate: (data) => { voteUpdates.push(data); },
    pushSessionUpdate() {},
  });
  stub(ids.visuals, {
    setChecksPending: async (_pool, sessionId, sha) => { pendingCalls.push({ sessionId, sha }); },
    notifyChecksPending() {},
  });
  stub(ids.prImportSync, {
    rerunChecksForNewHead: async (args) => { rerunCalls.push(args); },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) {
      if (original[key]) require.cache[id] = original[key];
      else delete require.cache[id];
    }
  };
  return { subject, messages, voteUpdates, pendingCalls, rerunCalls, parentReads, restore };
}

function recordingPool(advanceRow = { reviewed_head_sha: PUSHED, votes_moved: 1 }) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/WITH advanced AS/.test(text)) {
        return advanceRow ? { rows: [advanceRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// An ordinary web-native proposal: source is NULL, which is exactly the class
// the old cli_handoff-only guard skipped (prod sessions 3015 / 3016 / 3018).
function nativeSession(extra = {}) {
  return {
    id: 41,
    app_id: 7,
    app_slug: 'demo',
    app_name: 'Demo',
    repo_url: 'https://github.com/acme/demo',
    pr_number: 952,
    branch_name: 'usernode/change',
    source: null,
    status: 'promoted',
    reviewed_head_sha: REVIEWED,
    checks_commit_sha: REVIEWED,
    ...extra,
  };
}

test('an ordinary web-native proposal advances its pin and carries its votes', async () => {
  const ctx = loadSyncMain({ parents: { [PUSHED]: [REVIEWED, 'd'.repeat(40)] } });
  const pool = recordingPool();
  const session = nativeSession();
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, session, {
      syncResult: 'resolved', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, true);
    assert.equal(session.reviewed_head_sha, PUSHED);

    const update = pool.queries.find((q) => /WITH advanced AS/.test(q.sql));
    assert.match(update.sql, /UPDATE pr_votes SET head_sha = \$1/);
    assert.match(update.sql, /COALESCE\(source, ''\) <> 'imported'/,
      'every native row is covered, not just CLI handoffs');
    assert.match(update.sql, /status IN \('active', 'promoted', 'merging'\)/,
      'a sync finishing after withdrawal cannot move an archived review');
    assert.deepEqual(update.params.slice(0, 4), [PUSHED, 41, REVIEWED, REVIEWED]);
    assert.ok(ctx.voteUpdates.some((u) => u.votesKept === true && u.headMoved === true));
    assert.ok(ctx.messages.some((m) => /votes were kept/i.test(m.content)));
    assert.equal(ctx.messages[0].thread.ref, 41,
      'the note goes to the proposal thread, not the app group chat');
  } finally {
    ctx.restore();
  }
});

test('provenance is recorded before the advance, so a later pass can still recognise us', async () => {
  const ctx = loadSyncMain({ parents: { [PUSHED]: [REVIEWED] } });
  const pool = recordingPool();
  try {
    await ctx.subject.advanceReviewAfterPlatformSync(pool, nativeSession(), {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.match(pool.queries[0].sql, /INSERT INTO session_platform_pushes/);
    assert.deepEqual(pool.queries[0].params.slice(0, 4),
      [41, PUSHED, REVIEWED, REVIEWED]);
    assert.match(pool.queries[0].sql, /ON CONFLICT \(session_id, sha\) DO UPDATE/,
      'a retried sync re-records idempotently');
    assert.ok(pool.queries.findIndex((q) => /WITH advanced AS/.test(q.sql)) > 0);
  } finally {
    ctx.restore();
  }
});

test('the record survives an advance that never happens', async () => {
  // Process restarts, races and gate failures all land here; the row is what
  // lets the next reconciliation classify the commit correctly.
  const ctx = loadSyncMain({ parents: { [PUSHED]: [AUTHOR] } });
  const pool = recordingPool();
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, nativeSession(), {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, false);
    assert.match(pool.queries[0].sql, /INSERT INTO session_platform_pushes/);
  } finally {
    ctx.restore();
  }
});

test('a merge sitting on unreviewed author work does not inherit the approval', async () => {
  const ctx = loadSyncMain({ parents: { [PUSHED]: [AUTHOR, 'd'.repeat(40)] } });
  const pool = recordingPool();
  const session = nativeSession();
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, session, {
      syncResult: 'resolved', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, false);
    assert.equal(session.reviewed_head_sha, REVIEWED, 'the pin stays on the reviewed code');
    assert.ok(!pool.queries.some((q) => /WITH advanced AS/.test(q.sql)),
      'the ordinary author-push reset owns this case');
    assert.equal(ctx.messages.length, 0);
  } finally {
    ctx.restore();
  }
});

test('an unreadable parent list fails closed rather than guessing provenance', async () => {
  const ctx = loadSyncMain({ parentsThrow: true });
  const pool = recordingPool();
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, nativeSession(), {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, false);
    assert.ok(!pool.queries.some((q) => /WITH advanced AS/.test(q.sql)));
  } finally {
    ctx.restore();
  }
});

test('a clean git merge carries its check verdict; a Claude-resolved tree re-runs checks', async () => {
  const clean = loadSyncMain({ parents: { [PUSHED]: [REVIEWED] } });
  const cleanPool = recordingPool();
  const cleanSession = nativeSession();
  try {
    await clean.subject.advanceReviewAfterPlatformSync(cleanPool, cleanSession, {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    const update = cleanPool.queries.find((q) => /WITH advanced AS/.test(q.sql));
    assert.equal(update.params[4], true, 'the checks stamp moves with the pin');
    assert.equal(cleanSession.checks_commit_sha, PUSHED);
    assert.equal(clean.pendingCalls.length, 0);
    assert.equal(clean.rerunCalls.length, 0);
  } finally {
    clean.restore();
  }

  const resolved = loadSyncMain({ parents: { [PUSHED]: [REVIEWED] } });
  const resolvedPool = recordingPool();
  const resolvedSession = nativeSession();
  try {
    await resolved.subject.advanceReviewAfterPlatformSync(resolvedPool, resolvedSession, {
      syncResult: 'resolved', pushOk: true, sha: PUSHED,
    });
    const update = resolvedPool.queries.find((q) => /WITH advanced AS/.test(q.sql));
    assert.equal(update.params[4], false,
      'a tree Claude edited is unverified — its old green verdict cannot carry');
    assert.deepEqual(resolved.pendingCalls, [{ sessionId: 41, sha: PUSHED }]);
    assert.equal(resolved.rerunCalls[0].newHead, PUSHED,
      'staging rebuilds against exactly the pushed commit');
  } finally {
    resolved.restore();
  }
});

test('a legacy proposal with no pin is bound by the sync, keeping its unbound votes', async () => {
  const ctx = loadSyncMain({ parents: { [PUSHED]: [REVIEWED] } });
  const pool = recordingPool();
  const session = nativeSession({ reviewed_head_sha: null, checks_commit_sha: null });
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, session, {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, true);
    const update = pool.queries.find((q) => /WITH advanced AS/.test(q.sql));
    assert.equal(update.params[2], null);
    assert.match(update.sql, /head_sha IS NOT DISTINCT FROM \$3::varchar/,
      'IS NOT DISTINCT FROM NULL is what carries the unbound stamps');
  } finally {
    ctx.restore();
  }
});

test('a PR-less local session needs no provenance read at all', async () => {
  const ctx = loadSyncMain({ githubEnabled: false });
  const pool = recordingPool();
  const session = nativeSession({ repo_url: null });
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, session, {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, true);
    assert.equal(ctx.parentReads.length, 0,
      'there is no external mutable branch to defend against');
  } finally {
    ctx.restore();
  }
});

test('a concurrently advanced row is left alone', async () => {
  const ctx = loadSyncMain({ parents: { [PUSHED]: [REVIEWED] } });
  const pool = recordingPool(null); // the guarded UPDATE matched nothing
  const session = nativeSession();
  try {
    const advanced = await ctx.subject.advanceReviewAfterPlatformSync(pool, session, {
      syncResult: 'clean', pushOk: true, sha: PUSHED,
    });
    assert.equal(advanced, false);
    assert.equal(session.reviewed_head_sha, REVIEWED);
    assert.equal(ctx.messages.length, 0);
  } finally {
    ctx.restore();
  }
});

test('the historical export name still points at the generalized implementation', () => {
  const ctx = loadSyncMain();
  try {
    assert.equal(
      ctx.subject.advanceSharedReviewAfterSync,
      ctx.subject.advanceReviewAfterPlatformSync
    );
  } finally {
    ctx.restore();
  }
});
