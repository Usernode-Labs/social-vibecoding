// Community-voted priority + assigned-person feature.
//
// Three layers:
//   1. Pure helpers in services/topic-attributes.js — normalizeValue
//      (priority enum + assignee trim/length-cap) and pickTop (count desc,
//      earliest-first tie-break, then alphabetical).
//   2. The service's DB-backed flow (summarizeForTargets / listOptions /
//      castVote) and the two HTTP endpoints, driven against a stateful
//      in-memory mock pool that re-implements the table's aggregation
//      semantics — so upsert-moves-a-vote, case-insensitive assignee
//      dedupe, and the GET/POST shapes are all exercised end to end.
//   3. Source guards pinning the feed-route enrichment + server wiring so
//      a refactor can't silently drop the chips from the cards.
//
// Run with: node --test tests/topic-attributes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── 1. Pure helpers ────────────────────────────────────────────────────
const attrs = require('../src/services/topic-attributes');

test('normalizeValue: priority accepts only low/medium/high', () => {
  assert.equal(attrs.normalizeValue('priority', 'high'), 'high');
  assert.equal(attrs.normalizeValue('priority', 'HIGH'), 'high'); // case-folded
  assert.equal(attrs.normalizeValue('priority', '  low '), 'low'); // trimmed
  assert.equal(attrs.normalizeValue('priority', 'urgent'), null);
  assert.equal(attrs.normalizeValue('priority', ''), null);
  assert.equal(attrs.normalizeValue('priority', 42), null);
});

test('normalizeValue: assignee trims, rejects empty + over-long, keeps casing', () => {
  assert.equal(attrs.normalizeValue('assignee', '  Evan '), 'Evan');
  assert.equal(attrs.normalizeValue('assignee', ''), null);
  assert.equal(attrs.normalizeValue('assignee', '   '), null);
  assert.equal(attrs.normalizeValue('assignee', 'x'.repeat(64)), 'x'.repeat(64));
  assert.equal(attrs.normalizeValue('assignee', 'x'.repeat(65)), null);
  assert.equal(attrs.normalizeValue('bogus', 'x'), null);
});

test('pickTop: count desc, then earliest first-suggestion, then alpha', () => {
  // Clear winner by count.
  assert.equal(attrs.pickTop([
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
    { value: 'high', count: 3, firstAt: '2026-01-02T00:00:00Z' },
  ]).value, 'high');

  // Tie on count → the value suggested first wins.
  assert.equal(attrs.pickTop([
    { value: 'high', count: 1, firstAt: '2026-01-02T00:00:00Z' },
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
  ]).value, 'low');

  // Tie on count AND time → alphabetical.
  assert.equal(attrs.pickTop([
    { value: 'medium', count: 1, firstAt: '2026-01-01T00:00:00Z' },
    { value: 'low', count: 1, firstAt: '2026-01-01T00:00:00Z' },
  ]).value, 'low');

  assert.equal(attrs.pickTop([]), null);
});

// ── 2. Stateful mock pool + service/route flow ─────────────────────────
//
// Re-implements the handful of SQL statements the service issues against
// an in-memory `store` so the real JS aggregation / dedupe / ranking runs.
function makeMockPool() {
  const store = []; // { app_id, target_type, target_ref, field, value, user_id, created_at }
  let seq = 0;
  const norm = (field, value) => (field === 'assignee' ? String(value).toLowerCase() : String(value));

  function grouped(filter) {
    const groups = new Map(); // `${ref}|${field}|${norm}` -> rows
    for (const r of store.filter(filter)) {
      const key = `${r.target_ref}|${r.field}|${norm(r.field, r.value)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [];
    for (const [key, rows] of groups) {
      const [refStr, field] = key.split('|');
      const byNewest = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      out.push({
        ref: parseInt(refStr, 10),
        field,
        norm: norm(field, rows[0].value),
        count: rows.length,
        first_at: rows.map((x) => x.created_at).sort()[0],
        display_value: byNewest[0].value, // array_agg(value ORDER BY created_at DESC)[1]
      });
    }
    return out;
  }

  const pool = {
    store,
    async query(sql, params) {
      // summarizeForTargets — grouped tally over a set of refs.
      if (/GROUP BY target_ref, field, norm/.test(sql)) {
        const [appId, type, ids] = params;
        return { rows: grouped((r) => r.app_id === appId && r.target_type === type && ids.includes(r.target_ref)) };
      }
      // summarizeForTargets — viewer's own votes over a set of refs.
      if (/SELECT target_ref AS ref, field, value/.test(sql)) {
        const [appId, type, ids, userId] = params;
        return {
          rows: store
            .filter((r) => r.app_id === appId && r.target_type === type && ids.includes(r.target_ref) && r.user_id === userId)
            .map((r) => ({ ref: r.target_ref, field: r.field, value: r.value })),
        };
      }
      // listOptions — grouped tally for one target+field.
      if (/GROUP BY norm/.test(sql)) {
        const [appId, type, ref, field] = params;
        return { rows: grouped((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field) };
      }
      // listOptions — viewer's own single value.
      if (/SELECT value FROM topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, userId] = params;
        const m = store.find((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId);
        return { rows: m ? [{ value: m.value }] : [] };
      }
      // castVote upsert.
      if (/INSERT INTO topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, value, userId] = params;
        const ex = store.find((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId);
        const ts = new Date(Date.now() + (seq++)).toISOString();
        if (ex) { ex.value = value; ex.created_at = ts; }
        else store.push({ app_id: appId, target_type: type, target_ref: ref, field, value, user_id: userId, created_at: ts });
        return { rows: [] };
      }
      // clearVote — remove only the caller's row for this target+field.
      if (/DELETE FROM topic_attribute_votes/.test(sql)) {
        const [appId, type, ref, field, userId] = params;
        const i = store.findIndex((r) => r.app_id === appId && r.target_type === type && r.target_ref === ref && r.field === field && r.user_id === userId);
        if (i >= 0) store.splice(i, 1);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
    },
  };
  return pool;
}

test('castVote upserts (moves) a vote instead of duplicating', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 100);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'low', 100); // same user moves their pick
  assert.equal(pool.store.length, 1);
  assert.equal(pool.store[0].value, 'low');
  const opts = await attrs.listOptions(pool, 1, 'issue', 7, 'priority', 100);
  assert.equal(opts.myValue, 'low');
  assert.equal(opts.options.find((o) => o.value === 'low').count, 1);
  assert.ok(!opts.options.some((o) => o.value === 'high'));
});

test('assignee dedupes case-insensitively, keeps most-recent casing', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'evan', 1);
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'Evan', 2);
  await attrs.castVote(pool, 1, 'proposal', 9, 'assignee', 'EVAN', 3);
  const opts = await attrs.listOptions(pool, 1, 'proposal', 9, 'assignee', 2);
  assert.equal(opts.options.length, 1, 'three casings collapse to one option');
  assert.equal(opts.options[0].count, 3);
  assert.equal(opts.options[0].value, 'EVAN', 'display value is the most recent casing');
  assert.equal(opts.options[0].mine, true, 'viewer (user 2) backs this option');
});

test('summarizeForTargets returns top + count + myValue per target', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 2);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'low', 3);
  await attrs.castVote(pool, 1, 'issue', 8, 'assignee', 'alice', 1);

  const map = await attrs.summarizeForTargets(pool, 1, 'issue', [7, 8], 3);
  assert.equal(map.get(7).priority.top, 'high');
  assert.equal(map.get(7).priority.count, 2);
  assert.equal(map.get(7).priority.myValue, 'low'); // user 3 voted low
  assert.equal(map.get(7).assignee.top, null); // untouched field → placeholder
  assert.equal(map.get(8).assignee.top, 'alice');
  assert.equal(map.get(8).assignee.myValue, null); // user 3 didn't vote here
});

// #600: clearVote removes the caller's own vote (the "Assign to me" toggle
// off / unassign path).
test('clearVote removes only the caller\'s row + is idempotent', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'assignee', 'alice', 1);
  await attrs.castVote(pool, 1, 'issue', 7, 'assignee', 'bob', 2);
  assert.equal(pool.store.length, 2);

  // User 1 clears their own vote → only their row goes; user 2 untouched.
  const after = await attrs.clearVote(pool, 1, 'issue', 7, 'assignee', 1);
  assert.equal(pool.store.length, 1);
  assert.equal(pool.store[0].user_id, 2);
  assert.equal(after.myValue, null, 'caller no longer backs any option');
  assert.equal(after.options.length, 1);
  assert.equal(after.options[0].value, 'bob', 'refreshed tally re-ranks to the survivor');

  // Clearing again is a no-op that still returns the current tally.
  const again = await attrs.clearVote(pool, 1, 'issue', 7, 'assignee', 1);
  assert.equal(pool.store.length, 1);
  assert.equal(again.options[0].value, 'bob');
});

test('clearVote leaves the sibling field + other targets alone', async () => {
  const pool = makeMockPool();
  await attrs.castVote(pool, 1, 'issue', 7, 'assignee', 'alice', 1);
  await attrs.castVote(pool, 1, 'issue', 7, 'priority', 'high', 1);
  await attrs.castVote(pool, 1, 'issue', 8, 'assignee', 'alice', 1);

  await attrs.clearVote(pool, 1, 'issue', 7, 'assignee', 1);
  assert.equal(pool.store.length, 2, 'only the (7, assignee) row is removed');
  assert.ok(pool.store.some((r) => r.target_ref === 7 && r.field === 'priority'), 'priority on 7 survives');
  assert.ok(pool.store.some((r) => r.target_ref === 8 && r.field === 'assignee'), 'assignee on 8 survives');
});

// ── HTTP endpoints ──────────────────────────────────────────────────────
const express = require('express');
const poolMod = require('../src/db/pool');
const appAccess = require('../src/services/app-access');

let server;
let base;
let mockPool;

test.before(async () => {
  mockPool = makeMockPool();
  poolMod.getPool = () => mockPool;
  appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo' });

  const { topicAttributeRoutes } = require('../src/routes/topic-attributes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 100, username: 'tester' }; next(); });
  app.use(topicAttributeRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('POST rejects an out-of-range priority value', async () => {
  const r = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'urgent' }),
  });
  assert.equal(r.status, 400);
});

test('POST rejects an unknown field and a bad target type', async () => {
  const bad1 = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'colour', value: 'red' }),
  });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(`${base}/api/apps/demo/topics/widget/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'low' }),
  });
  assert.equal(bad2.status, 400);
});

test('POST then GET round-trips the option list + myValue', async () => {
  const post = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'priority', value: 'medium' }),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.field, 'priority');
  assert.equal(posted.myValue, 'medium');
  assert.equal(posted.options[0].value, 'medium');
  assert.equal(posted.options[0].mine, true);

  const get = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes?field=priority`).then((x) => x.json());
  assert.equal(get.myValue, 'medium');
  assert.equal(get.options.find((o) => o.value === 'medium').count, 1);
});

// #600: the DELETE endpoint backing the "Assigned to you" → unassign toggle.
test('DELETE clears the caller\'s vote and round-trips to "no vote"', async () => {
  // Assign myself, confirm the vote lands, then DELETE it back off.
  const post = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field: 'assignee', value: 'tester' }),
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).myValue, 'tester');

  const del = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes?field=assignee`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const cleared = await del.json();
  assert.equal(cleared.field, 'assignee');
  assert.equal(cleared.myValue, null, 'caller no longer holds the assignment');
  assert.ok(!cleared.options.some((o) => o.mine), 'no option is flagged mine');

  // Idempotent: a second DELETE still succeeds.
  const del2 = await fetch(`${base}/api/apps/demo/topics/issue/42/attributes?field=assignee`, { method: 'DELETE' });
  assert.equal(del2.status, 200);
});

test('DELETE rejects an unknown field and a bad target type', async () => {
  const bad1 = await fetch(`${base}/api/apps/demo/topics/issue/5/attributes?field=colour`, { method: 'DELETE' });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(`${base}/api/apps/demo/topics/widget/5/attributes?field=assignee`, { method: 'DELETE' });
  assert.equal(bad2.status, 400);
});

// ── 3. Source guards ───────────────────────────────────────────────────
test('feed routes attach the priority/assignee summary', () => {
  const issuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf-8');
  assert.match(issuesSrc, /summarizeForTargets\([^)]*'issue'/s, 'issues route enriches issue targets');
  assert.match(issuesSrc, /issue\.priority = s\.priority/);

  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf-8');
  assert.match(votesSrc, /summarizeForTargets\([^)]*'proposal'/s, 'votes route enriches proposal targets');
});

test('server wires the topic-attributes route', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.match(serverSrc, /topicAttributeRoutes\(config\)/);
});

test('card renderer emits the two chips', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  assert.match(fe, /_attrChipsHtml\('issue'/, 'issue rows render chips');
  assert.match(fe, /_attrChipsHtml\('proposal'/, 'proposal cards render chips');
  assert.match(fe, /data-attr-chip/, 'chip carries the delegated-click hook');
});

// #600: the DELETE (unassign) endpoint is wired with the same collab gate,
// validation, and rate limiter as POST.
test('route exposes a rate-limited DELETE that clears the caller vote', () => {
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'topic-attributes.js'), 'utf-8');
  assert.match(routeSrc, /router\.delete\(\s*'\/api\/apps\/:slug\/topics\/:targetType\/:targetRef\/attributes',\s*attributeVoteLimiter/,
    'DELETE route is registered with the attributeVoteLimiter');
  assert.match(routeSrc, /attrs\.clearVote\(/, 'DELETE handler calls the clearVote service');
  // The DELETE handler reuses the collab gate + auth guard like POST.
  const delIdx = routeSrc.indexOf('router.delete(');
  const delBody = routeSrc.slice(delIdx);
  assert.match(delBody, /getAppForUser\([^)]*'collab'/s, 'DELETE enforces collab access');
  assert.match(delBody, /Not authenticated/, 'DELETE requires an authenticated user');

  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'topic-attributes.js'), 'utf-8');
  assert.match(svc, /clearVote,/, 'service exports clearVote');
});

// #600: the "Assign to me" / "Assigned to you" toggle button.
test('card renderer emits the assign-to-me toggle button on active cards', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  assert.match(fe, /_assignToMeBtnHtml/, 'a helper renders the assign-to-me button');
  assert.match(fe, /data-assign-me/, 'the button carries the delegated-click hook');
  assert.match(fe, /Assign to me/, 'unassigned label present');
  assert.match(fe, /Assigned to you/, 'assigned label present');
  // The button is suppressed on readonly (merged/completed) cards.
  assert.match(fe, /readonly \? '' : AppView\._assignToMeBtnHtml/, 'readonly cards drop the button');
  // The click handler toggles POST/DELETE with a double-submit guard.
  assert.match(fe, /_toggleAssignToMe/, 'click handler present');
  assert.match(fe, /_assignInFlight/, 'double-submit guard present');
  assert.match(fe, /method: 'DELETE'/, 'toggle-off issues a DELETE');
});

// #600: "am I the assignee?" is case-insensitive, matching the service's
// groupKey dedupe.
test('assignToMe button state comparison is case-insensitive', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  const idx = fe.indexOf('_assigneeIsMe(');
  assert.ok(idx > 0, '_assigneeIsMe helper exists');
  const body = fe.slice(idx, idx + 400);
  assert.match(body, /toLowerCase\(\)/, 'compares lower-cased values');
});

// #600: staging seeds make BOTH button states reviewable via ?demo=1 — one
// card assigned to the viewer (Assigned to you / DELETE path) and one
// unassigned (Assign to me / POST path).
test('staging seeds cover both assign-to-me button states', () => {
  const issuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'issues.js'), 'utf-8');
  assert.match(issuesSrc, /myValue: viewer/, 'an issue mock is assigned to the viewer');
  assert.match(issuesSrc, /req\.user && req\.user\.username/, 'the viewer name is sourced from req.user');

  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf-8');
  assert.match(votesSrc, /function stagingMockProposals\(viewer\)/, 'proposal mock accepts the viewer');
  assert.match(votesSrc, /stagingMockProposals\(req\.user\?\.username\)/, 'feed passes the viewer through');
});

// Style guard: the chips must reuse the shared card-badge pill recipe and
// must NOT drift into a bespoke look (e.g. the old brightness-filter hover).
test('chips reuse the sibling-badge pill recipe + tint-deepening hover', () => {
  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  // Same recipe as _devChatBadge / bounty pill / #N chip.
  assert.match(fe, /attr-chip inline-flex items-center text-\[0\.65rem\] font-medium px-1\.5 py-0\.5 rounded/,
    'chip base uses the shared pill utility recipe');
  assert.match(fe, /bg-zinc-500\/10 text-zinc-500/, 'muted placeholder uses the badge muted tint');
  // Hover deepens the same tint (like the linked-issue pills), not a filter.
  assert.match(fe, /hover:bg-(red|amber|sky|violet|zinc)-500\/20/, 'interactive chip uses tint-deepening hover');
  assert.doesNotMatch(fe, /hover:brightness-110/, 'no leftover brightness-filter hover');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf-8');
  const block = css.slice(css.indexOf('.attr-chip {'), css.indexOf('button.attr-chip'));
  assert.match(block, /font:\s*inherit/, '.attr-chip inherits the surrounding font');
  assert.match(block, /appearance:\s*none/, '.attr-chip strips native button appearance');
  assert.doesNotMatch(block, /line-height/, 'no line-height override (heights drift otherwise)');
});
