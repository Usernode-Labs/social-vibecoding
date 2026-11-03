'use strict';

// #6101, the server half: a vote refused because the change is no longer up
// for a vote says so with a code and where the change is now, so the client
// can close the card instead of putting its Yes and No back.
//
//   - the 404 (the row is no longer promoted or merging) reads the change's
//     own status and merge time, and reports `merged` when it has one;
//   - the 409 (it left review between the read and the write lock) reports
//     the status it now holds;
//   - both keep the HTTP code and the error string they had.
//
// The route is mounted over a mock pool, like tests/vote-retract.test.js, so
// this is the real route answering, not a copy of its SQL.
//
// Run with: node --test tests/vote-settled-refusal-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makePool({ session = null, now = null, recordRows = null } = {}) {
  return {
    async query(sql, params) {
      const text = String(sql);
      if (/FROM chat_sessions cs JOIN apps a ON cs\.app_id = a\.id[\s\S]*status IN \('promoted', 'merging'\)/.test(text)) {
        return { rows: session ? [session] : [] };
      }
      if (/SELECT status, merged_at FROM chat_sessions WHERE id = \$1/.test(text)) {
        return { rows: now ? [now] : [] };
      }
      if (/WITH current_session AS/.test(text)) {
        return recordRows || { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotes(pool) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    communities: require.resolve('../src/services/communities'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const realCommunities = require('../src/services/communities');
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.communities, {
    ...realCommunities,
    requireSessionMembership: () => (_req, _res, next) => next(),
    privateVoteRefusal: async () => null,
    identityVoteRefusal: async () => null,
  });
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, restore };
}

async function withServer(pool, fn) {
  const ctx = loadVotes(pool);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 3, username: 'evan' }; next(); });
  app.use(ctx.subject.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const vote = () => fetch(`${base}/api/sessions/7/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'yes' }),
  });
  try {
    await fn({ ...ctx, vote });
  } finally {
    server.close();
    ctx.restore();
  }
}

test('a change no longer up for a vote: 404 carries the code and its merged status', async () => {
  const pool = makePool({ now: { status: 'promoted', merged_at: '2026-11-02T10:00:00Z' } });
  await withServer(pool, async (ctx) => {
    const r = await ctx.vote();
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), {
      error: 'Promoted session not found',
      code: 'not_up_for_vote',
      status: 'merged',
    }, 'the error string and HTTP code are unchanged; the merge time decides the status');
  });
});

test('a change that left review reports where it went, without inventing a merge', async () => {
  const session = {
    id: 7, app_id: 5, user_id: 9, status: 'promoted', approval_epoch: 2,
    source: 'imported', pr_number: 26, imported_pr_head_sha: 'a'.repeat(40),
    reviewed_head_sha: null, branch_name: null, app_slug: 'widget',
  };
  const pool = makePool({ session, now: { status: 'active', merged_at: null } });
  await withServer(pool, async (ctx) => {
    const r = await ctx.vote();
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), {
      error: 'This proposal is no longer up for a vote.',
      code: 'not_up_for_vote',
      status: 'active',
    });
  });
});

test('an unknown session has no status to report', async () => {
  const pool = makePool({ now: null });
  await withServer(pool, async (ctx) => {
    const r = await ctx.vote();
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), {
      error: 'Promoted session not found',
      code: 'not_up_for_vote',
    }, 'nothing exists to name, so no status is invented');
  });
});
