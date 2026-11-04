// Tests for GET /api/me/history (src/routes/kudos.js) — the "My
// history" feed of everything the caller has given: PR kudos, issue
// bounty pledges, PR votes, and proposal (issue) votes.
//
// Same harness style as tests/kudos.test.js: kudosRoutes(config) is
// mounted on a throwaway Express app with getPool() swapped for an
// in-memory mock that pattern-matches the SQL. The history endpoint
// issues a single UNION ALL whose arms are detected by their literal
// `'<type>' AS type` tags and their first FROM (#6102: each vote tag
// has a cast arm over `events` and a standing arm over its vote table),
// so the mock can tell which arms the route included for a given ?type=
// filter.
//
// Run with: node --test tests/history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// ─── module-cache pool/ws stubbing (same trick as kudos.test.js) ──

function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  const stub = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  require.cache[poolModulePath] = stub;
  delete require.cache[require.resolve('../src/routes/kudos')];
  const wsPath = require.resolve('../src/services/ws');
  const origWs = require.cache[wsPath];
  require.cache[wsPath] = {
    exports: {
      pushNotificationToUser: () => 0,
      pushKudosUpdate: () => {},
    },
    loaded: true,
    id: wsPath,
    filename: wsPath,
    paths: origWs ? origWs.paths : [],
  };
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    if (origWs) require.cache[wsPath] = origWs;
    else delete require.cache[wsPath];
    delete require.cache[require.resolve('../src/routes/kudos')];
  }
}

// ─── in-memory mock pool for the history UNION ALL ────────────────
//
// State mirrors the ledgers + their join targets, and the `events` log
// the vote arms read every cast from (#6102). The history query is
// recognized by its trailing `ORDER BY created_at DESC LIMIT $n`; it is
// split at UNION ALL and each arm is evaluated from its own SQL: its
// `'<type>' AS type` tag says what it is, its first FROM says what it
// reads (two arms share each vote tag: a cast one over `events`, a
// standing one over `pr_votes`/`issue_votes`), and NOT EXISTS on a
// standing arm is the one-minute same-side dedupe against the log. The
// keyset cursor (`created_at < $2`) is read off each arm too.
function makeHistoryPool(seed = {}) {
  const state = {
    apps: new Map(seed.apps || []),         // id => { slug, name }
    users: new Map(seed.users || []),       // id => { username }
    sessions: new Map(seed.sessions || []), // id => { id, user_id, status, app_id, pr_number, pr_title }
    issues: new Map(seed.issues || []),     // id => { id, app_id, github_issue_number, title, kind, status }
    kudos: seed.kudos || [],                // { session_id, giver_user_id, created_at }
    bounties: seed.bounties || [],          // { app_id, github_issue_number, giver_user_id, status, awarded_user_id, awarded_at, created_at }
    prVotes: seed.prVotes || [],            // { id, session_id, user_id, vote, created_at }
    issueVotes: seed.issueVotes || [],      // { id, issue_id, user_id, vote, created_at }
    events: seed.events || [],              // { id, user_id, session_id, event_type, metadata, created_at }
    lastSql: null,
    lastArms: [],
  };

  const MINUTE = 60 * 1000;
  const within = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= MINUTE;

  async function query(sql, params = []) {
    const s = String(sql);
    if (/ORDER BY created_at DESC/i.test(s) && /LIMIT \$\d+/i.test(s)) {
      state.lastSql = s;
      const userId = params[0];
      const hasBefore = /created_at < \$2/.test(s);
      const before = hasBefore ? Date.parse(params[1]) : null;
      const limit = params[params.length - 1];
      const app = (id) => state.apps.get(id) || { slug: 'app', name: 'App' };
      const uname = (id) =>
        id != null && state.users.has(id) ? state.users.get(id).username : null;
      const blank = {
        vote: null, status: null, merged_at: null, session_id: null, pr_number: null,
        pr_title: null, author_username: null, issue_number: null,
        issue_title: null, issue_kind: null, issue_id: null, awarded_username: null,
        awarded_at: null, row_key: null,
      };
      // #6101: merged_at decides, whatever status has caught up to.
      const changeRow = (cs) => ({
        session_id: cs.id,
        status: cs.merged_at
          ? (cs.live_at ? 'merged' : 'going_live')
          : (cs.status === 'merged' && !cs.live_at ? 'going_live' : cs.status),
        merged_at: cs.merged_at ?? null,
        pr_number: cs.pr_number ?? null, pr_title: cs.pr_title ?? null,
        author_username: uname(cs.user_id),
      });
      const decisionRow = (issue) => ({
        status: issue.status,
        issue_number: issue.github_issue_number ?? null,
        issue_title: issue.title, issue_kind: issue.kind, issue_id: issue.id,
      });
      const rows = [];

      // Everything between the outer SELECT * FROM ( ... ) h.
      const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(') h'));
      const arms = inner.split(/\bUNION ALL\b/).map((arm) => {
        const tag = (arm.match(/'(\w+)' AS type/) || [])[1];
        const from = (arm.match(/\bFROM (\w+)/) || [])[1];
        return { tag, from, sql: arm };
      });
      state.lastArms = arms;

      for (const arm of arms) {
        if (!arm.tag || !arm.from) throw new Error(`arm without a tag or a source: ${arm.sql.slice(0, 80)}`);
        if (arm.tag === 'kudos' && arm.from === 'pr_kudos') {
          state.kudos.forEach((k, i) => {
            if (k.giver_user_id !== userId) return;
            const cs = state.sessions.get(k.session_id);
            if (!cs) return; // inner JOIN chat_sessions
            const a = app(cs.app_id);
            rows.push({
              ...blank, type: 'kudos', created_at: k.created_at,
              status: cs.status, session_id: cs.id,
              pr_number: cs.pr_number ?? null, pr_title: cs.pr_title ?? null,
              author_username: uname(cs.user_id),
              app_slug: a.slug, app_name: a.name, row_key: `pk:${k.id ?? i + 1}`,
            });
          });
        } else if (arm.tag === 'bounty' && arm.from === 'issue_bounties') {
          state.bounties.forEach((b, i) => {
            if (b.giver_user_id !== userId) return;
            const a = app(b.app_id);
            rows.push({
              ...blank, type: 'bounty', created_at: b.created_at,
              status: b.status, issue_number: b.github_issue_number,
              awarded_username: uname(b.awarded_user_id),
              awarded_at: b.awarded_at ?? null,
              app_slug: a.slug, app_name: a.name, row_key: `ib:${b.id ?? i + 1}`,
            });
          });
        } else if (arm.tag === 'pr_vote' && arm.from === 'events') {
          // A cast: the side is in metadata.vote; a backfilled row has none.
          if (!/e\.event_type = 'pr_vote_cast'/.test(arm.sql)) throw new Error('pr_vote cast arm must read pr_vote_cast');
          for (const e of state.events) {
            if (e.user_id !== userId || e.event_type !== 'pr_vote_cast') continue;
            const vote = e.metadata && e.metadata.vote;
            if (vote !== 'yes' && vote !== 'no') continue;
            const cs = state.sessions.get(e.session_id);
            if (!cs) continue;
            const a = app(cs.app_id);
            rows.push({
              ...blank, type: 'pr_vote', created_at: e.created_at, vote,
              ...changeRow(cs), app_slug: a.slug, app_name: a.name, row_key: `e:${e.id}`,
            });
          }
        } else if (arm.tag === 'proposal_vote' && arm.from === 'events') {
          if (!/e\.event_type = 'issue_vote_cast'/.test(arm.sql)) throw new Error('proposal_vote cast arm must read issue_vote_cast');
          for (const e of state.events) {
            if (e.user_id !== userId || e.event_type !== 'issue_vote_cast') continue;
            const vote = e.metadata && e.metadata.vote;
            if (vote !== 'up' && vote !== 'down') continue;
            const issueId = String(e.metadata.issueId ?? '');
            if (!/^[0-9]{1,9}$/.test(issueId)) continue;
            const issue = state.issues.get(Number(issueId));
            if (!issue) continue;
            const a = app(issue.app_id);
            rows.push({
              ...blank, type: 'proposal_vote', created_at: e.created_at, vote,
              ...decisionRow(issue), app_slug: a.slug, app_name: a.name, row_key: `e:${e.id}`,
            });
          }
        } else if (arm.tag === 'pr_vote' && arm.from === 'pr_votes') {
          // The standing vote, only where no same-side cast event is within
          // a minute of it.
          if (!/NOT EXISTS/.test(arm.sql)) throw new Error('standing pr_vote arm must carry NOT EXISTS');
          state.prVotes.forEach((v, i) => {
            if (v.user_id !== userId) return;
            const cs = state.sessions.get(v.session_id);
            if (!cs) return;
            const logged = state.events.some((e) => e.user_id === userId
              && e.session_id === v.session_id && e.event_type === 'pr_vote_cast'
              && e.metadata && e.metadata.vote === v.vote && within(e.created_at, v.created_at));
            if (logged) return;
            const a = app(cs.app_id);
            rows.push({
              ...blank, type: 'pr_vote', created_at: v.created_at, vote: v.vote,
              ...changeRow(cs), app_slug: a.slug, app_name: a.name, row_key: `pv:${v.id ?? i + 1}`,
            });
          });
        } else if (arm.tag === 'proposal_vote' && arm.from === 'issue_votes') {
          if (!/NOT EXISTS/.test(arm.sql)) throw new Error('standing proposal_vote arm must carry NOT EXISTS');
          state.issueVotes.forEach((v, i) => {
            if (v.user_id !== userId) return;
            const issue = state.issues.get(v.issue_id);
            if (!issue) return;
            const logged = state.events.some((e) => e.user_id === userId
              && e.event_type === 'issue_vote_cast' && e.metadata
              && String(e.metadata.issueId) === String(v.issue_id)
              && e.metadata.vote === v.vote && within(e.created_at, v.created_at));
            if (logged) return;
            const a = app(issue.app_id);
            rows.push({
              ...blank, type: 'proposal_vote', created_at: v.created_at, vote: v.vote,
              ...decisionRow(issue), app_slug: a.slug, app_name: a.name, row_key: `iv:${v.id ?? i + 1}`,
            });
          });
        } else {
          throw new Error(`unexpected arm ${arm.tag} over ${arm.from}`);
        }
      }

      let out = rows;
      if (before != null) out = out.filter((r) => Date.parse(r.created_at) < before);
      out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return { rows: out.slice(0, limit) };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }

  return { query, state };
}

// `user` may be null to exercise the 401 guard.
async function startTestServer(pool, user = { id: 1, username: 'alice' }) {
  return withMockPool(pool, async () => {
    const { kudosRoutes } = require('../src/routes/kudos');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(kudosRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

// Standard seed: user 1 (alice, the caller) gave one of each thing at
// distinct, strictly increasing timestamps; user 2 (bob) authored the
// PRs. t() spaces entries a minute apart, newest = highest index.
function t(i) { return new Date(Date.UTC(2026, 4, 20, 10, i, 0)).toISOString(); }
// The same minute, a few seconds on: a vote's row and its event are written
// one after the other, never in the same instant.
function tPlus(i, seconds) { return new Date(Date.UTC(2026, 4, 20, 10, i, seconds)).toISOString(); }

function seedPool() {
  return makeHistoryPool({
    apps: [[1, { slug: 'cool-app', name: 'Cool App' }]],
    users: [[1, { username: 'alice' }], [2, { username: 'bob' }]],
    sessions: [
      [10, { id: 10, user_id: 2, status: 'merged', app_id: 1, pr_number: 7, pr_title: 'Add widgets' }],
      [11, { id: 11, user_id: 2, status: 'promoted', app_id: 1, pr_number: 8, pr_title: 'Fix gadgets' }],
    ],
    issues: [
      [5, { id: 5, app_id: 1, github_issue_number: 42, title: 'Rename to Cooler App', kind: 'rename', status: 'open' }],
    ],
    kudos: [{ session_id: 10, giver_user_id: 1, created_at: t(4) }],
    bounties: [{
      app_id: 1, github_issue_number: 99, giver_user_id: 1, status: 'open',
      awarded_user_id: null, awarded_at: null, created_at: t(3),
    }],
    prVotes: [{ session_id: 11, user_id: 1, vote: 'yes', created_at: t(2) }],
    issueVotes: [{ issue_id: 5, user_id: 1, vote: 'up', created_at: t(1) }],
  });
}

// ─── tests ─────────────────────────────────────────────────────────

test('GET /api/me/history: 401 without auth', async () => {
  const { baseUrl, close } = await startTestServer(seedPool(), null);
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});

test('merged feed: all four types, strict reverse-chronological order', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(
      data.items.map((i) => i.type),
      ['kudos', 'bounty', 'pr_vote', 'proposal_vote']
    );
    for (let i = 1; i < data.items.length; i++) {
      assert.ok(
        Date.parse(data.items[i - 1].created_at) > Date.parse(data.items[i].created_at),
        'items strictly newest-first'
      );
    }
    // Spot-check normalization per type.
    const [kudos, bounty, prVote, propVote] = data.items;
    assert.equal(kudos.pr.title, 'Add widgets');
    assert.equal(kudos.pr.number, 7);
    assert.equal(kudos.pr.author, 'bob');
    assert.deepEqual(kudos.app, { slug: 'cool-app', name: 'Cool App' });
    assert.equal(bounty.issue.number, 99);
    assert.equal(bounty.status, 'open');
    assert.equal(bounty.awarded, undefined, 'open bounty has no awarded block');
    assert.equal(prVote.vote, 'yes');
    assert.equal(prVote.pr.title, 'Fix gadgets');
    assert.equal(propVote.vote, 'up');
    assert.equal(propVote.issue.title, 'Rename to Cooler App');
    assert.equal(propVote.issue.kind, 'rename');
    // Page came back short of the default 50 — no further pages.
    assert.equal(data.nextBefore, null);
  } finally {
    await close();
  }
});

test('type=kudos returns only the kudos + bounty arms', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    assert.deepEqual(data.items.map((i) => i.type), ['kudos', 'bounty']);
  } finally {
    await close();
  }
});

test('type=votes returns only the vote arms: a cast and a standing one per kind', async () => {
  const pool = seedPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    assert.deepEqual(data.items.map((i) => i.type), ['pr_vote', 'proposal_vote']);
    assert.deepEqual(pool.state.lastArms.map((a) => [a.tag, a.from]), [
      ['pr_vote', 'events'], ['proposal_vote', 'events'],
      ['pr_vote', 'pr_votes'], ['proposal_vote', 'issue_votes'],
    ]);
    const [prCast, issueCast, prStanding, issueStanding] = pool.state.lastArms;
    // The cast arms read the log, a real cast only: the backfill's rows
    // (migrate.js) carry no metadata.vote and are not casts.
    assert.match(prCast.sql, /e\.event_type = 'pr_vote_cast'/);
    assert.match(prCast.sql, /e\.metadata->>'vote' IN \('yes', 'no'\)/);
    assert.match(issueCast.sql, /e\.event_type = 'issue_vote_cast'/);
    // up/down is the request vocabulary (routes/issues.js), not yes/no.
    assert.match(issueCast.sql, /e\.metadata->>'vote' IN \('up', 'down'\)/);
    // An issueId the log cannot join is dropped, never cast: the shape test
    // guards the cast inside a CASE so no evaluation order reaches it first.
    assert.match(issueCast.sql, /CASE WHEN e\.metadata->>'issueId' ~ '\^\[0-9\]\{1,9\}\$'\s+THEN \(e\.metadata->>'issueId'\)::int END/);
    // The standing arms fill in only a vote with no cast event of its own:
    // same person, same target, same side, within a minute.
    for (const arm of [prStanding, issueStanding]) {
      assert.match(arm.sql, /NOT EXISTS \(/);
      assert.match(arm.sql, /INTERVAL '1 minute'/);
    }
    assert.match(prStanding.sql, /e\.session_id = pv\.session_id/);
    assert.match(prStanding.sql, /e\.metadata->>'vote' = pv\.vote/);
    assert.match(issueStanding.sql, /e\.metadata->>'issueId' = iv\.issue_id::text/);
    assert.match(issueStanding.sql, /e\.metadata->>'vote' = iv\.vote/);
    // Me-scoped: every arm filters on $1, the dedupe subqueries too.
    for (const arm of pool.state.lastArms) {
      assert.match(arm.sql, /WHERE (e|pv|iv)\.user_id = \$1/);
    }
    for (const arm of [prStanding, issueStanding]) {
      assert.match(arm.sql, /NOT EXISTS \(\s*SELECT 1 FROM events e\s+WHERE e\.user_id = \$1/);
    }
    // Taking a vote back is no row of its own.
    assert.doesNotMatch(pool.state.lastSql, /pr_vote_retracted/);
    // Each item carries the server's key.
    for (const item of data.items) assert.match(item.key, /^(e|pv|iv):\d+$/);
  } finally {
    await close();
  }
});

test('type=kudos includes no events arm, and every arm carries a key', async () => {
  const pool = seedPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    assert.deepEqual(pool.state.lastArms.map((a) => [a.tag, a.from]), [
      ['kudos', 'pr_kudos'], ['bounty', 'issue_bounties'],
    ]);
    assert.doesNotMatch(pool.state.lastSql, /FROM events/);
    assert.deepEqual(data.items.map((i) => i.key), ['pk:1', 'ib:1']);
    for (const arm of pool.state.lastArms) assert.match(arm.sql, /\|\| (pk|ib)\.id AS row_key/);
  } finally {
    await close();
  }
});

test('every arm applies the before cursor to its own time column', async () => {
  const pool = seedPool();
  const { baseUrl, close } = await startTestServer(pool);
  try {
    await fetch(`${baseUrl}/api/me/history?before=${encodeURIComponent(t(3))}`);
    assert.equal(pool.state.lastArms.length, 6);
    assert.deepEqual(
      pool.state.lastArms.map((a) => (a.sql.match(/AND (\w+)\.created_at < \$2/) || [])[1]),
      ['pk', 'ib', 'e', 'e', 'pv', 'iv']
    );
  } finally {
    await close();
  }
});

test('pagination: limit + before cursor pages with no overlap', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const page1 = await (await fetch(`${baseUrl}/api/me/history?limit=2`)).json();
    assert.equal(page1.items.length, 2);
    assert.deepEqual(page1.items.map((i) => i.type), ['kudos', 'bounty']);
    assert.ok(page1.nextBefore, 'full page exposes a cursor');
    assert.equal(page1.nextBefore, page1.items[1].created_at);

    const page2 = await (await fetch(
      `${baseUrl}/api/me/history?limit=2&before=${encodeURIComponent(page1.nextBefore)}`
    )).json();
    assert.deepEqual(page2.items.map((i) => i.type), ['pr_vote', 'proposal_vote']);
    const seen = new Set(page1.items.map((i) => `${i.type}|${i.created_at}`));
    for (const it of page2.items) {
      assert.ok(!seen.has(`${it.type}|${it.created_at}`), 'no overlap across pages');
    }
    // page2 was also full, so it carries a cursor — the next page is empty.
    assert.ok(page2.nextBefore);
    const page3 = await (await fetch(
      `${baseUrl}/api/me/history?limit=2&before=${encodeURIComponent(page2.nextBefore)}`
    )).json();
    assert.equal(page3.items.length, 0);
    assert.equal(page3.nextBefore, null);
  } finally {
    await close();
  }
});

test('400 on a garbage before timestamp', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const r = await fetch(`${baseUrl}/api/me/history?before=not-a-date`);
    assert.equal(r.status, 400);
  } finally {
    await close();
  }
});

test('scoping: another user’s gives never appear', async () => {
  const pool = seedPool();
  // bob (id 2) also gave a kudos, a bounty, and both vote kinds — none
  // of it may leak into alice's feed.
  pool.state.kudos.push({ session_id: 11, giver_user_id: 2, created_at: t(9) });
  pool.state.bounties.push({
    app_id: 1, github_issue_number: 50, giver_user_id: 2, status: 'open',
    awarded_user_id: null, awarded_at: null, created_at: t(8),
  });
  pool.state.prVotes.push({ session_id: 10, user_id: 2, vote: 'no', created_at: t(7) });
  pool.state.issueVotes.push({ issue_id: 5, user_id: 2, vote: 'down', created_at: t(6) });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history`)).json();
    assert.equal(data.items.length, 4, 'only alice’s own four entries');
    assert.ok(!data.items.some((i) => i.vote === 'no' || i.vote === 'down'));
    assert.ok(!data.items.some((i) => i.issue?.number === 50));
  } finally {
    await close();
  }
});

// #6102: a vote changed is two casts, and both are listed.
test('vote-flip: two rows, one per side, newest first, with distinct keys', async () => {
  const pool = seedPool();
  // The yes was cast at t(2), its event written a few seconds after the
  // row; the flip to no at t(5) upserts the standing row in place
  // (ON CONFLICT ... SET vote, created_at = NOW()) and logs a second cast.
  const v = pool.state.prVotes[0];
  pool.state.events.push(
    { id: 1, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'yes' }, created_at: tPlus(2, 3) },
    { id: 2, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'no' }, created_at: tPlus(5, 3) },
  );
  v.vote = 'no';
  v.created_at = t(5);
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    const prVotes = data.items.filter((i) => i.type === 'pr_vote');
    assert.deepEqual(prVotes.map((i) => [i.key, i.vote, i.created_at, i.pr.sessionId]), [
      ['e:2', 'no', tPlus(5, 3), 11],
      ['e:1', 'yes', tPlus(2, 3), 11],
    ], 'both casts, the standing row folded into its own cast');
    assert.notEqual(prVotes[0].key, prVotes[1].key);
  } finally {
    await close();
  }
});

test('a standing vote with no cast event of its own still shows, once', async () => {
  const pool = seedPool();
  // Recorded before the log began (or its fire-and-forget event write
  // failed): the vote tables are the only record. A backfilled pr_vote_cast
  // row (no metadata.vote) is not a cast and does not hide it either.
  pool.state.events.push(
    { id: 3, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: {}, created_at: t(2) },
  );
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    assert.deepEqual(data.items.map((i) => [i.key, i.type, i.vote]), [
      ['pv:1', 'pr_vote', 'yes'],
      ['iv:1', 'proposal_vote', 'up'],
    ]);
  } finally {
    await close();
  }
});

test('a same-side cast more than a minute from the standing row is its own cast', async () => {
  const pool = seedPool();
  // Yes at t(2), no at t(5), back to yes at t(8): three casts. The standing
  // row is the last yes; only the t(8) event is within a minute of it.
  pool.state.events.push(
    { id: 1, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'yes' }, created_at: t(2) },
    { id: 2, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'no' }, created_at: t(5) },
    { id: 3, user_id: 1, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'yes' }, created_at: t(8) },
    // A request vote and its event in the same statement (the governance
    // machine): one row.
    { id: 4, user_id: 1, event_type: 'issue_vote_cast', metadata: { vote: 'up', issueId: 5 }, created_at: t(1) },
    // Another person's cast on the same change never shows.
    { id: 5, user_id: 2, session_id: 11, event_type: 'pr_vote_cast', metadata: { vote: 'no' }, created_at: t(9) },
  );
  pool.state.prVotes[0].created_at = t(8);
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    assert.deepEqual(data.items.map((i) => [i.key, i.type, i.vote]), [
      ['e:3', 'pr_vote', 'yes'],
      ['e:2', 'pr_vote', 'no'],
      ['e:1', 'pr_vote', 'yes'],
      ['e:4', 'proposal_vote', 'up'],
    ]);
    assert.equal(new Set(data.items.map((i) => i.key)).size, 4, 'keys are distinct');
    assert.equal(data.items[3].issue.id, 5, 'a cast on a request links to it');
  } finally {
    await close();
  }
});

test('#6101: a merged change whose status has not caught up still reads as decided', async () => {
  const pool = seedPool();
  // The vote was read while the change was still up for a vote; the merge
  // landed since. `merged_at` is the authority for the client.
  const cs = pool.state.sessions.get(11);
  cs.status = 'promoted';
  cs.merged_at = t(6);
  cs.live_at = null;
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    const prVote = data.items.find((i) => i.type === 'pr_vote');
    assert.equal(prVote.status, 'going_live', 'merged, its deploy still to come');
    assert.equal(prVote.merged_at, t(6), 'the merge time reaches the screen');
  } finally {
    await close();
  }
});

test('deleted PR author surfaces as null, not an error', async () => {
  const pool = seedPool();
  // chat_sessions.user_id is ON DELETE SET NULL — both the kudos and
  // the PR-vote arms LEFT JOIN users, so the row survives authorless.
  pool.state.sessions.get(10).user_id = null;
  pool.state.sessions.get(11).user_id = null;
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 200);
    const data = await r.json();
    const kudos = data.items.find((i) => i.type === 'kudos');
    const prVote = data.items.find((i) => i.type === 'pr_vote');
    assert.equal(kudos.pr.author, null);
    assert.equal(prVote.pr.author, null);
  } finally {
    await close();
  }
});

test('awarded bounty carries the awarded block (and null for deleted awardee)', async () => {
  const pool = seedPool();
  pool.state.bounties[0].status = 'awarded';
  pool.state.bounties[0].awarded_user_id = 2;
  pool.state.bounties[0].awarded_at = t(10);
  const { baseUrl, close } = await startTestServer(pool);
  try {
    let data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    let bounty = data.items.find((i) => i.type === 'bounty');
    assert.equal(bounty.status, 'awarded');
    assert.deepEqual(bounty.awarded, { username: 'bob', at: t(10) });

    // Deleted awardee (ON DELETE SET NULL) → username null, no error.
    pool.state.bounties[0].awarded_user_id = null;
    data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    bounty = data.items.find((i) => i.type === 'bounty');
    assert.equal(bounty.awarded.username, null);
  } finally {
    await close();
  }
});

test('/api/me/history is NOT in the auth middleware’s PUBLIC_PATHS', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(entries.length > 0, 'parsed at least one public path');
  for (const p of entries) {
    assert.ok(
      !'/api/me/history'.startsWith(p),
      `public prefix "${p}" must not expose /api/me/history`
    );
  }
});

// The challenge artwork directory is public for the same reason /icons/ is.
// The middleware matches by prefix, so the entry has to keep its trailing
// slash, and nothing that is a prefix of it (a bare "/" or "/i") may have come
// along with it.
test('/illustrations/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/illustrations') || '/illustrations/'.startsWith(p));
  assert.deepEqual(related, ['/illustrations/']);
});

// The signed-out landing's own artwork. Its whole audience is the tier that
// has no platform access, so the gate must not see the request at all: a 302
// to '/' in an <img> is a broken picture, which is what staging drew before
// this entry existed. Same shape as the two above.
test('/brand/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/brand') || '/brand/'.startsWith(p));
  assert.deepEqual(related, ['/brand/']);
});

// Uploaded challenge artwork decorates the same public cards, so its image
// route is public too, at its own prefix. Same shape as the entry above: the
// trailing slash stays, and nothing wider comes along with it.
test('/challenge-illustrations/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/challenge') || '/challenge-illustrations/'.startsWith(p));
  assert.deepEqual(related, ['/challenge-illustrations/']);
});
