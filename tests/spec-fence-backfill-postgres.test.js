'use strict';

// migrate.backfillFenceWrappedSpecs: every release unwraps the specs stored
// inside one whole-document fence. It reads only the specs whose first mark is
// a fence, so what is pinned here is that the read never leaves out one that
// stripSpecWrapperFence would change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { backfillFenceWrappedSpecs } = require('../src/db/migrate');
const { stripSpecWrapperFence } = require('../src/services/spec-format');

const FENCE = '```';
// What String.prototype.trim removes before the fence is looked for.
const BLANKS = [...'\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'];

test('wrapped specs are unwrapped whatever blank comes first, and no other spec is read (PostgreSQL)', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `spec_fence_backfill_${process.pid}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const user = (await pool.query("INSERT INTO users (username, password) VALUES ('ada', 'unused') RETURNING id")).rows[0].id;
    const app = (await pool.query("INSERT INTO apps (slug, name, created_by, repo_url) VALUES ('a', 'a', $1, 'https://git.example.test/a') RETURNING id", [user])).rows[0].id;

    const wrapped = [
      `${FENCE}markdown\n# One\n${FENCE}`, `${FENCE}\n# Two\n${FENCE}`, `~~~md\n# Three\n~~~`,
      `${FENCE}filepath:SPEC.md\n# Four\n${FENCE}\n\n`,
      ...BLANKS.map((blank) => `${blank}${blank}${FENCE}markdown\n# After a blank\n${FENCE}`),
      `${BLANKS.join('')}${FENCE}markdown\n# After every blank\n${FENCE}`,
    ];
    const left = ['# Plain', `Intro\n${FENCE}js\n1\n${FENCE}`, '- a list', '1. one', '日本語の仕様', '   ', '', `${FENCE}js\nconst a = 1;\n${FENCE}`];
    assert.deepEqual(wrapped.filter((spec) => stripSpecWrapperFence(spec) === spec), [], 'each is one the rule unwraps');
    assert.deepEqual(left.filter((spec) => stripSpecWrapperFence(spec) !== spec), []);
    for (const [i, spec] of [...wrapped, ...left].entries()) {
      const { rows: [session] } = await pool.query(
        "INSERT INTO chat_sessions (app_id, user_id, branch_name, status, spec_md) VALUES ($1, $2, $3, 'active', $4) RETURNING id", [app, user, `b${i}`, spec]);
      await pool.query('INSERT INTO chat_session_specs (session_id, version, content) VALUES ($1, 1, $2)', [session.id, spec]);
    }
    const read = [];
    const counting = { query: async (sql, params) => {
      const result = await pool.query(sql, params);
      if (/^\s*SELECT/.test(sql)) read.push(result.rows.length);
      return result;
    } };
    await backfillFenceWrappedSpecs(counting);
    const live = (await pool.query('SELECT spec_md FROM chat_sessions ORDER BY id')).rows.map((r) => r.spec_md);
    const versions = (await pool.query('SELECT content FROM chat_session_specs ORDER BY session_id')).rows.map((r) => r.content);
    const expected = [...wrapped.map(stripSpecWrapperFence), ...left];
    assert.deepEqual(live, expected);
    assert.deepEqual(versions, expected);
    // The one fenced spec that is a real code block is read, and left as it is.
    assert.deepEqual(read, [wrapped.length + 1, wrapped.length + 1], 'the other specs are not read');
    read.length = 0;
    await backfillFenceWrappedSpecs(counting);
    assert.deepEqual(read, [1, 1], 'a second run has nothing to unwrap');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await root.end();
  }
});
