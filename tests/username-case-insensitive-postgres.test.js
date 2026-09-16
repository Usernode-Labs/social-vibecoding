'use strict';

// Usernames are unique case-insensitively (#2296), enforced by the
// `reject_case_variant_username` trigger in src/db/schema.sql.
//
// Executed against real PostgreSQL rather than pinned by regex because the
// properties that matter are behaviours of the database: that the trigger
// raises the 23505 every registration route already maps to "Username
// already taken", that a user may re-case their own handle, that legacy
// case-variant pairs keep working, and that the advisory lock serialises two
// concurrent registrations of the same name in different cases.
//
// The trigger SQL is sliced out of schema.sql itself, so this tests the
// statement production boots with, not a copy of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

function triggerSql() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE OR REPLACE FUNCTION reject_case_variant_username()');
  const createTrigger = schema.indexOf('CREATE TRIGGER users_reject_case_variant_username', start);
  const end = schema.indexOf('END $$;', createTrigger) + 'END $$;'.length;
  assert.ok(start > 0 && createTrigger > start && end > createTrigger,
    'schema.sql defines the case-variant username trigger');
  return schema.slice(start, end);
}

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `username_case_test_${process.pid}`;
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
        display_name VARCHAR(255)
      );
    `);
    // A legacy case-variant pair that predates the trigger: the reason this
    // is a trigger and not a UNIQUE index on LOWER(username).
    await pool.query(`INSERT INTO users (username) VALUES ('drea'), ('Drea')`);
    await pool.query(triggerSql());
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.code;
  }
}

test('registering a different capitalisation of a taken username is refused with 23505', async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query(`INSERT INTO users (username) VALUES ('alice')`);

    assert.equal(await codeOf(pool.query(`INSERT INTO users (username) VALUES ('Alice')`)), '23505');
    assert.equal(await codeOf(pool.query(`INSERT INTO users (username) VALUES ('ALICE')`)), '23505');
    // The exact string still hits the raw UNIQUE constraint, as before.
    assert.equal(await codeOf(pool.query(`INSERT INTO users (username) VALUES ('alice')`)), '23505');
    // An unrelated name is unaffected.
    assert.equal(await codeOf(pool.query(`INSERT INTO users (username) VALUES ('alicia')`)), null);
  });
});

// The staging and platform seeds re-run `INSERT … ON CONFLICT (username) DO
// NOTHING` on every boot. A BEFORE trigger fires before ON CONFLICT is
// weighed, so an exact match must be left to the constraint — raising here
// aborted the whole staging seed on the first proposal that shipped this.
test('an idempotent ON CONFLICT (username) DO NOTHING seed still does nothing on re-run', async (t) => {
  await withDatabase(t, async (pool) => {
    const seed = `INSERT INTO users (username) VALUES ('seeded-service') ON CONFLICT (username) DO NOTHING`;
    await pool.query(seed);
    const again = await pool.query(seed);
    assert.equal(again.rowCount, 0);
    // A case-variant is still refused even through ON CONFLICT: it is not a
    // conflict on the raw constraint.
    assert.equal(
      await codeOf(pool.query(`INSERT INTO users (username) VALUES ('Seeded-Service') ON CONFLICT (username) DO NOTHING`)),
      '23505'
    );
  });
});

test('renaming into another user\'s handle in a different case is refused', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rows } = await pool.query(
      `INSERT INTO users (username) VALUES ('bob'), ('carol') RETURNING id, username`
    );
    const carol = rows.find((r) => r.username === 'carol');
    assert.equal(
      await codeOf(pool.query('UPDATE users SET username = $1 WHERE id = $2', ['BOB', carol.id])),
      '23505'
    );
  });
});

test('a user may change the capitalisation of their own username', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rows } = await pool.query(`INSERT INTO users (username) VALUES ('dave') RETURNING id`);
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', ['Dave', rows[0].id]);
    const { rows: after } = await pool.query('SELECT username FROM users WHERE id = $1', [rows[0].id]);
    assert.equal(after[0].username, 'Dave');
  });
});

test('legacy case-variant pairs keep working for writes that do not touch the username', async (t) => {
  await withDatabase(t, async (pool) => {
    const { rowCount } = await pool.query(
      `UPDATE users SET display_name = 'still fine' WHERE LOWER(username) = 'drea'`
    );
    assert.equal(rowCount, 2);
    // …and neither half of the pair can be joined by a third variant.
    assert.equal(await codeOf(pool.query(`INSERT INTO users (username) VALUES ('DREA')`)), '23505');
  });
});

test('two concurrent registrations of the same name in different cases cannot both commit', async (t) => {
  await withDatabase(t, async (pool) => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await first.query(`INSERT INTO users (username) VALUES ('erin')`);

      await second.query('BEGIN');
      // Blocks on the advisory lock until `first` finishes.
      const racing = second.query(`INSERT INTO users (username) VALUES ('Erin')`)
        .then(() => null, (err) => err.code);

      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query('COMMIT');

      assert.equal(await racing, '23505');
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    const { rows } = await pool.query(`SELECT username FROM users WHERE LOWER(username) = 'erin'`);
    assert.deepEqual(rows.map((r) => r.username), ['erin']);
  });
});
