'use strict';

// #4266 against the full PostgreSQL schema: list_my_work_orders lists exactly
// the work orders connector-limits counts toward prepare_work's cap,
// close_work_order frees one slot so prepare_work goes through again, and a
// close refuses whatever is not the caller's own open, unshared work order.
// tests/connector-work-orders.test.js pins the same rules on stubs.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { z } = require('zod');

const tasks = require('../src/services/external-agent-tasks');
const connectorLimits = require('../src/services/connector-limits');
const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DAY = 24 * 60 * 60 * 1000;
const BASE_SHA = `ba5e${'0'.repeat(34)}fe`;

test('work orders: the list is the count, and a close frees a slot', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `work_orders_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // inspectFork's one public GitHub read: answered "no fork yet", offline.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  t.after(async () => {
    globalThis.fetch = realFetch;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    "INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id", [username])).rows[0].id;
  const ada = await user('ada_orders');
  const bob = await user('bob_orders');
  const app = async (slug) => (await pool.query(
    'INSERT INTO apps (name, slug, repo_url) VALUES ($1, $2, $3) RETURNING id, slug, name, repo_url',
    [`App ${slug}`, slug, `https://github.com/acme/${slug}`])).rows[0];
  const recipe = await app('recipe-box');
  const tiny = await app('tiny');
  const session = async (appId, status, prNumber) => (await pool.query(
    'INSERT INTO chat_sessions (app_id, user_id, status, pr_number) VALUES ($1, $2, $3, $4) RETURNING id',
    [appId, ada, status, prNumber])).rows[0].id;
  const proposal = await session(tiny.id, 'promoted', 2151);
  const sharedCard = await session(recipe.id, 'active', null);
  const submittedTo = await session(recipe.id, 'promoted', 2200);

  const now = Date.now();
  const task = async ({
    userId = ada, appId = recipe.id, issue = null, key, status = 'open', sessionId = null,
    createdDaysAgo = 1, expiresInDays = 13, target = null, brief = '',
  }) => (await pool.query(
    `INSERT INTO external_agent_tasks
       (user_id, app_id, issue_number, fork_owner, fork_repo, branch_name, base_sha, brief,
        client_id, status, session_id, created_at, expires_at, request_key, linked_issues,
        target_session_id)
     VALUES ($1, $2, $3, 'ada-gh', 'repo', $4, $5, $6, 'Claude', $7, $8, $9, $10, $4, $11, $12)
     RETURNING id`,
    [userId, appId, issue, key, BASE_SHA, brief || (issue ? `Request #${issue}` : 'Make it faster'),
      status, sessionId, new Date(now - createdDaysAgo * DAY), new Date(now + expiresInDays * DAY),
      issue ? [issue] : [], target],
  )).rows[0].id;

  // Ten that count: nine requests on Recipe Box and one update work order on
  // Tiny, revising PR #2151.
  const counted = [];
  for (let n = 1; n <= 9; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    counted.push(await task({ issue: n, key: `issue:${n}`, createdDaysAgo: 12 - n }));
  }
  const revising = await task({ appId: tiny.id, key: `proposal:${proposal}`, target: proposal, createdDaysAgo: 1 });
  counted.push(revising);
  // Five that do not: past expiry, shared as an in-progress card, submitted,
  // closed, and somebody else's.
  const expired = await task({ issue: 20, key: 'issue:20', createdDaysAgo: 15, expiresInDays: -1 });
  const shared = await task({ issue: 21, key: 'issue:21', sessionId: sharedCard });
  const submitted = await task({ issue: 22, key: 'issue:22', status: 'submitted', sessionId: submittedTo });
  const closed = await task({ issue: 23, key: 'issue:23', status: 'abandoned' });
  const bobs = await task({ userId: bob, issue: 1, key: 'issue:1' });

  // Activity: Ada renewed her claim on #3 just now, and claimed #1 before she
  // prepared its work order. Bob's claim on #4 is not Ada's activity.
  const claim = (userId, issue, at) => pool.query(
    'INSERT INTO issue_claims (app_id, github_issue_number, user_id, claimed_at) VALUES ($1, $2, $3, $4)',
    [recipe.id, issue, userId, at]);
  await claim(ada, 3, new Date(now));
  await claim(ada, 1, new Date(now - 30 * DAY));
  await claim(bob, 4, new Date(now));

  // ── The list is the count ─────────────────────────────────────────────
  const held = await tasks.listHeldWorkOrders(pool, ada);
  assert.deepEqual(held.map((w) => w.taskId).sort((a, b) => a - b), counted.map(Number).sort((a, b) => a - b),
    'exactly the ten the cap counts, and none of the five it does not');
  assert.equal(held.length, connectorLimits.LIMITS.openTasks);
  const refused = await connectorLimits.checkOpenWorkOrders(pool, ada);
  assert.equal(refused && refused.code, 'at_capacity', 'and the cap agrees it is full');

  assert.equal(held[0].taskId, Number(counted[2]), 'the one with the newest activity leads');
  assert.ok(Math.abs(new Date(held[0].lastActivityAt).getTime() - now) < 5000);
  const byId = new Map(held.map((w) => [w.taskId, w]));
  const one = byId.get(Number(counted[0]));
  assert.equal(new Date(one.lastActivityAt).getTime(), new Date(one.createdAt).getTime(),
    'a claim older than the work order is not activity on it');
  const four = byId.get(Number(counted[3]));
  assert.equal(new Date(four.lastActivityAt).getTime(), new Date(four.createdAt).getTime(),
    'somebody else\'s claim is not the caller\'s activity');
  const update = byId.get(Number(revising));
  assert.equal(update.revisesProposalId, Number(proposal));
  assert.equal(update.revisesPrNumber, 2151);
  assert.deepEqual(update.requestNumbers, []);
  assert.deepEqual(one.requestNumbers, [1]);
  assert.equal(one.appSlug, 'recipe-box');

  assert.deepEqual((await tasks.listHeldWorkOrders(pool, bob)).map((w) => w.taskId), [Number(bobs)]);
  assert.equal(await connectorLimits.checkOpenWorkOrders(pool, bob), null);

  // ── prepare_work at the cap, through the real limiter ─────────────────
  const deps = {
    pool,
    config: {},
    gh: {
      isEnabled: () => true,
      parseGithubUrl: (u) => {
        const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(u || ''));
        return m ? { owner: m[1], repo: m[2] } : null;
      },
      getBranchSha: async () => BASE_SHA,
    },
    githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'ada-gh' }) },
    limits: connectorLimits,
    prompts: null,
  };
  const prepare = () => tasks.prepareWork(deps, {
    user: { id: ada, username: 'ada_orders' }, app: recipe, issueNumber: 10, brief: 'Request #10',
    clientId: 'Claude', clientName: 'Claude', origin: 'https://homeroom.example',
  });
  const atCap = await prepare();
  assert.equal(atCap.ok, false);
  assert.equal(atCap.code, 'at_capacity');

  // ── The close refuses what is not the caller's to close ───────────────
  const statusOf = async (id) => (await pool.query(
    'SELECT status FROM external_agent_tasks WHERE id = $1', [id])).rows[0].status;

  const notYours = await tasks.closeWorkOrder(pool, ada, bobs);
  assert.equal(notYours.code, 'unknown_task');
  assert.equal(await statusOf(bobs), 'open', 'another user\'s work order is never touched');
  assert.equal((await tasks.closeWorkOrder(pool, ada, 999999)).code, 'unknown_task',
    'and reads exactly like one that does not exist');

  const alreadySubmitted = await tasks.closeWorkOrder(pool, ada, submitted);
  assert.equal(alreadySubmitted.code, 'already_submitted');
  assert.equal(alreadySubmitted.proposalId, Number(submittedTo));
  assert.equal(await statusOf(submitted), 'submitted');
  assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [submittedTo])).rows[0].status,
    'promoted', 'the proposal it became is untouched');

  assert.equal((await tasks.closeWorkOrder(pool, ada, closed)).code, 'already_closed');

  const sharedRefusal = await tasks.closeWorkOrder(pool, ada, shared);
  assert.equal(sharedRefusal.code, 'already_shared');
  assert.equal(await statusOf(shared), 'open', 'a shared card keeps its reservation');

  // Past its expiry: it closes, and says it held no slot, so the cap stays full.
  const stale = await tasks.closeWorkOrder(pool, ada, expired);
  assert.equal(stale.ok, true);
  assert.equal(stale.freedSlot, false);
  assert.equal(await statusOf(expired), 'abandoned');
  assert.equal((await connectorLimits.checkOpenWorkOrders(pool, ada)).code, 'at_capacity');

  // ── A close through the registered tool frees a slot ──────────────────
  const specs = new Map();
  const handlers = new Map();
  tools.registerTools({
    registerTool(n, spec, handler) { specs.set(n, spec); handlers.set(n, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user: { id: ada, username: 'ada_orders' },
    clientName: 'Claude', clientId: 'c1', origin: 'https://homeroom.example',
    baseUrl: 'http://platform.internal', pool, config: {}, tokenId: null, grantId: null,
  });
  const listed = await handlers.get('list_my_work_orders')({});
  const listedOut = z.object(specs.get('list_my_work_orders').outputSchema).parse(listed.structuredContent);
  assert.equal(listedOut.count, 10);
  assert.equal(listedOut.atCapacity, true);

  const closing = await handlers.get('close_work_order')({ taskId: Number(counted[0]) });
  assert.ok(!closing.isError, JSON.stringify(closing.structuredContent));
  const closedOut = z.object(specs.get('close_work_order').outputSchema).parse(closing.structuredContent);
  assert.equal(closedOut.taskId, Number(counted[0]));
  assert.equal(closedOut.freedSlot, true);
  assert.equal(closedOut.openWorkOrders, 9);
  assert.deepEqual(closedOut.requestNumbers, [1]);
  assert.equal(await statusOf(counted[0]), 'abandoned', 'the same ending restart writes');
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS n FROM issue_claims WHERE app_id = $1 AND github_issue_number = 1 AND user_id = $2',
    [recipe.id, ada])).rows[0].n, 1, 'the request claim is left alone, as restart leaves it');

  const twice = await handlers.get('close_work_order')({ taskId: Number(counted[0]) });
  assert.equal(twice.structuredContent.code, 'already_closed');

  // The slot is free, so prepare_work goes through, and takes it.
  assert.equal(await connectorLimits.checkOpenWorkOrders(pool, ada), null);
  const prepared = await prepare();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.reused, false);
  const after = await tasks.listHeldWorkOrders(pool, ada);
  assert.equal(after.length, 10);
  assert.ok(after.some((w) => w.taskId === Number(prepared.taskId)));

  // A coding agent still holding the closed work order is told so.
  const late = await tasks.submitWork(deps, {
    user: { id: ada, username: 'ada_orders' }, taskId: counted[0], patch: 'diff', clientName: 'Claude',
  });
  assert.equal(late.code, 'unknown_task');
  assert.match(late.message, /put away/);
});
