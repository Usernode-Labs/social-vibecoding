'use strict';

// The promote, end to end through the platform (src/workflow/platform.ts
// promoteProposal) with a running workflow runtime against the full
// PostgreSQL schema: the proposal machine's guard, its review.open work
// (src/workflow/proposal/services.ts) and the answer the promote route gives.
// GitHub and the legacy modules review.open reaches are stubbed through the
// require cache (src/workflow/legacy.ts shares it); `github` and
// `prMetadata` are mutable, so each test sets how they behave.
//
// startPromotePlatform(t) resolves null when PostgreSQL is unavailable and
// TEST_DATABASE_URL is unset (the caller skips), as the other *-postgres
// suites do.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function startPromotePlatform(t, { name = 'wf_promote' } = {}) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return null;
  }
  const dbName = `${name}_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  await pool.query(fs.readFileSync(require.resolve('../../src/db/schema.sql'), 'utf8'));

  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  // What review.open meets: a GitHub with no reads (isEnabled false: the
  // pull request, once opened, is not read back), lazy PR creation as the
  // test says, no model key, and no explicit-approval read.
  const calls = { applyPrMetadata: [] };
  const behaviour = { applyPrMetadata: null };
  stub('../../src/db/pool', { getPool: () => pool });
  const realWs = require('../../src/services/ws');
  stub('../../src/services/ws', {
    ...realWs, broadcast: () => {}, broadcastGlobalScoped: () => {}, pushVoteUpdate: () => {},
    pushIssueUpdate: () => {}, pushNotificationToUser: () => {},
  });
  const realGithub = require('../../src/services/github');
  stub('../../src/services/github', { ...realGithub, isEnabled: () => false });
  stub('../../src/services/limits', { ...require('../../src/services/limits'), resolveBillingPath: async () => ({ error: 'no key in tests' }) });
  stub('../../src/services/app-admins', { ...require('../../src/services/app-admins'), refreshExplicitApproval: async () => {} });
  stub('../../src/services/pr-metadata', {
    ...require('../../src/services/pr-metadata'),
    async applyPrMetadata(args) {
      calls.applyPrMetadata.push(args.session.id);
      return behaviour.applyPrMetadata ? behaviour.applyPrMetadata(args) : null;
    },
  });
  stub('../../src/services/homeroom-bot-dm', { ...require('../../src/services/homeroom-bot-dm'), noteProposalChanged: async () => null });

  const platform = require('../../src/workflow/platform.ts');
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: true });

  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id, username`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ('Whiteboard', 'whiteboard', $1, 'https://github.com/acme/whiteboard') RETURNING *`,
    [owner.id]);
  // A change with no pull request yet, so a promote that gets past the
  // guard has to open one (review.open's lazy creation).
  async function session({ status = 'active', pr = null } = {}) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, pr_number, pr_title)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [app.id, owner.id, status, `dev/evan-${++seq}`, pr, pr ? 'A change' : null]);
    return s;
  }
  // The promote route's call, as it makes it for a change with no pull
  // request (pr: null).
  const promote = (s, { cap = 5, from = s.status } = {}) => platform.promoteProposal({
    sessionId: s.id, appId: app.id, userId: owner.id, username: owner.username, from, cap, pr: null, waitMs: 10000,
  });
  const status = async (s) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [s.id])).rows[0].status;
  return { pool, platform, owner, app, session, promote, status, calls, behaviour };
}

module.exports = { startPromotePlatform };
