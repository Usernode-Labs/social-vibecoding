'use strict';

// How many queries a governance vote costs on the workflow machine path.
// Every query is a round trip the voter waits for (the production database
// is tens of milliseconds away), so this counts every query any connection
// sends while the vote route runs, with a counter on pg.Client.prototype.query,
// and fails above a budget. The critical path today is 11: the route's own
// checks (3), the append, the pipeline's opening batch with its pick, the
// governance facts (2), the vote write, the finishing statement, COMMIT and
// the outcome read. The budget leaves room for what runs beside it (the
// post-commit notifiers, the slot looking for its next event).
//
// Over budget? The test prints every query it counted; docs/workflows.md
// ("Round trips") says where they usually come from.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const pg = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BUDGET = { nonDeciding: 15, deciding: 20 };

function handlerFor(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`no route ${method} ${path}`);
}

async function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ get: () => undefined, params: {}, body: {}, query: {}, ...req }, res)).catch(reject);
  });
}

// Run fn, counting the queries every pg client sends meanwhile.
async function counted(fn) {
  const original = pg.Client.prototype.query;
  const seen = [];
  pg.Client.prototype.query = function query(q, ...rest) {
    seen.push(String(typeof q === 'string' ? q : q?.text).replace(/\s+/g, ' ').trim().slice(0, 100));
    return original.call(this, q, ...rest);
  };
  try {
    return { result: await fn(), seen };
  } finally {
    pg.Client.prototype.query = original;
  }
}

test('a governance vote stays within its query budget', { timeout: 120000 }, async (t) => {
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_budget_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', {
    ...realWs, pushIssueUpdate() {}, pushAppUpdate() {}, broadcast() {}, sendSystemMessage: async () => {},
  });
  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfGovernanceEnabled: true,
    wfPoolMax: 4, wfSlots: 2, wfOwnershipMode: 'raise',
  };
  const platform = require('../src/workflow/platform.ts');
  const vote = handlerFor(require('../src/routes/issues').issueRoutes(config), 'post', '/api/issues/:id/vote');
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  let seq = 0;
  const user = async () => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [`budget_${++seq}`])).rows[0];
  const author = await user();
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, approvals_required) VALUES ('Budget', 'budget', $1, 2) RETURNING *`, [author.id]);
  const { rows: [issue] } = await pool.query(
    `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'rename', 'rename', $2, $3) RETURNING *`,
    [app.id, JSON.stringify({ newName: 'Budgeted' }), author.id]);
  await platform.startWorkflow(config, { loops: true });
  const enrolled = Date.now() + 5000;
  while (!(await pool.query(`SELECT 1 FROM wf_instances WHERE key = $1 AND state = 'open'`, [`issue:${issue.id}`])).rowCount) {
    assert.ok(Date.now() < enrolled, 'the boot backfill enrolled the proposal');
    await new Promise((r) => setTimeout(r, 50));
  }
  const settle = () => new Promise((r) => setTimeout(r, 300));  // let the loops go quiet

  const cast = async (label, budget, check) => {
    const voter = await user();
    await settle();
    const { result, seen } = await counted(() => call(vote, { params: { id: String(issue.id) }, body: { vote: 'up' }, user: voter }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    check(result.body);
    assert.ok(seen.length <= budget,
      `${label}: ${seen.length} queries, budget ${budget}:\n${seen.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`);
  };
  await cast('a vote that does not decide', BUDGET.nonDeciding, (body) => assert.equal(body.renamed.applied, false));
  await cast('the vote that applies the proposal', BUDGET.deciding, (body) => assert.equal(body.renamed.applied, true));
});
