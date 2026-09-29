'use strict';

// The two SQL halves of #2563, against real PostgreSQL.
//
// Both are behaviours of the database rather than of any JavaScript, so a
// regex over the source would not tell you whether they work:
//
//   • the column (`users.needs_username_choice`) and the one-time backfill
//     that flags existing accounts whose handle IS their email address —
//     the statement has to match those and ONLY those, and it has to be
//     safe on every boot, not only the first;
//   • `chooseFirstUsername`'s UPDATE, which is gated on the flag it clears
//     and runs through the same `reject_case_variant_username` trigger
//     every registration route hits. The flag gate is the endpoint's
//     authorization — a rename asks for the current password and this
//     cannot, because an email-code account has none — so "fires exactly
//     once" is a claim worth proving against the real statement.
//
// The ALTER, the trigger and the backfill are all SLICED OUT of the files
// production boots with, so this tests those statements rather than a copy.
//
// Run with: node --test tests/username-first-choice-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const usernames = require('../src/services/usernames');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function columnSql() {
  const schema = read('src', 'db', 'schema.sql');
  const line = schema.split('\n').find((l) =>
    l.startsWith('ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_username_choice'));
  assert.ok(line, 'schema.sql adds users.needs_username_choice');
  return line;
}

function caseVariantTriggerSql() {
  const schema = read('src', 'db', 'schema.sql');
  const start = schema.indexOf('CREATE OR REPLACE FUNCTION reject_case_variant_username()');
  const end = schema.indexOf('END $$;', schema.indexOf(
    'CREATE TRIGGER users_reject_case_variant_username', start)) + 'END $$;'.length;
  assert.ok(start > 0 && end > start, 'schema.sql defines the case-variant trigger');
  return schema.slice(start, end);
}

// The backfill statement exactly as src/db/migrate.js runs it.
function backfillSql() {
  const migrate = read('src', 'db', 'migrate.js');
  const fn = migrate.slice(
    migrate.indexOf('async function backfillUsernameChoiceForEmailHandles'));
  const start = fn.indexOf('`UPDATE users');
  const end = fn.indexOf('`', start + 1);
  assert.ok(start > 0 && end > start, 'migrate.js runs one UPDATE for the backfill');
  return fn.slice(start + 1, end);
}

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `username_choice_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        updated_at TIMESTAMPTZ
      );
    `);
    await pool.query(columnSql());
    await pool.query(caseVariantTriggerSql());
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

const flagOf = async (pool, username) => (await pool.query(
  'SELECT needs_username_choice FROM users WHERE username = $1', [username],
)).rows[0]?.needs_username_choice;

test('the backfill flags email-as-username accounts and nothing else', async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query(
      `INSERT INTO users (username, email) VALUES
         ('ada@example.com', 'ada@example.com'),
         ('Grace@Example.COM', 'grace@example.com'),
         ('ada_lovelace', 'ada.lovelace@example.com'),
         ('mentions_ada', 'ada@example.org'),
         ('no_email_at_all', NULL),
         ('usernode-capture', NULL)`
    );

    await pool.query(backfillSql());

    // Flagged: the handle IS the address, case notwithstanding.
    assert.equal(await flagOf(pool, 'ada@example.com'), true);
    assert.equal(await flagOf(pool, 'Grace@Example.COM'), true);
    // Not flagged: a real handle, whatever it resembles, and an account
    // with no address to compare against.
    assert.equal(await flagOf(pool, 'ada_lovelace'), false);
    assert.equal(await flagOf(pool, 'mentions_ada'), false);
    assert.equal(await flagOf(pool, 'no_email_at_all'), false);
    assert.equal(await flagOf(pool, 'usernode-capture'), false);
  });
});

test('the backfill is safe on every boot, not only the first', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email) VALUES ('ada@example.com', 'ada@example.com')
       RETURNING id`
    );
    const id = rows[0].id;
    assert.equal((await pool.query(backfillSql())).rowCount, 1);
    // Re-running while the account still owes a choice changes nothing.
    assert.equal((await pool.query(backfillSql())).rowCount, 0);

    // And once it HAS chosen, the handle stops matching the address, so no
    // later boot can drag it back in front of the step.
    await usernames.chooseFirstUsername(pool, id, 'ada_lovelace');
    assert.equal((await pool.query(backfillSql())).rowCount, 0);
    assert.equal(await flagOf(pool, 'ada_lovelace'), false);
  });
});

test('the first choice installs the handle and clears the flag', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, needs_username_choice)
       VALUES ('ada@example.com', 'ada@example.com', TRUE) RETURNING id`
    );
    const result = await usernames.chooseFirstUsername(pool, rows[0].id, 'ada_lovelace');
    assert.deepEqual(result, { username: 'ada_lovelace' });
    assert.equal(await flagOf(pool, 'ada_lovelace'), false);
    // The address is gone from the username column entirely.
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE username LIKE $1', ['%@%'],
    )).rows[0].n, 0);
  });
});

test('the flag is the authorization: a second call writes nothing', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, needs_username_choice)
       VALUES ('ada@example.com', 'ada@example.com', TRUE) RETURNING id`
    );
    const id = rows[0].id;
    assert.ok(await usernames.chooseFirstUsername(pool, id, 'ada_lovelace'));
    // Without the gate this would be a free, password-less rename — which
    // is exactly the capability POST /api/me/username charges for.
    assert.equal(await usernames.chooseFirstUsername(pool, id, 'someone_else'), null);
    assert.equal((await pool.query(
      'SELECT username FROM users WHERE id = $1', [id],
    )).rows[0].username, 'ada_lovelace');
  });
});

test('a case variant of somebody else handle is refused by the trigger, as a 23505', async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query(`INSERT INTO users (username) VALUES ('Ada_Lovelace')`);
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, needs_username_choice)
       VALUES ('ada@example.com', 'ada@example.com', TRUE) RETURNING id`
    );
    let code = null;
    try {
      await usernames.chooseFirstUsername(pool, rows[0].id, 'ada_lovelace');
    } catch (err) {
      code = err.code;
    }
    // The route maps 23505 to "That username is taken." — the same answer
    // checkAvailability gives before the write is attempted.
    assert.equal(code, '23505');
    assert.equal(await flagOf(pool, 'ada@example.com'), true,
      'a refused choice leaves the gate closed');
  });
});
