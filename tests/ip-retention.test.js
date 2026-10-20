'use strict';

// #5132: IP addresses are cleared after IP_RETENTION_DAYS (90 by default),
// row by row, and the rows themselves are kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const ipRetention = require('../src/services/ip-retention');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('IP_RETENTION_DAYS is 90 unless set to a whole number of days in range', () => {
  const days = ipRetention.retentionDays;
  assert.equal(ipRetention.DEFAULT_DAYS, 90);
  assert.equal(days({}), 90);
  assert.equal(days({ IP_RETENTION_DAYS: '' }), 90);
  assert.equal(days({ IP_RETENTION_DAYS: '30' }), 30);
  assert.equal(days({ IP_RETENTION_DAYS: ' 60 ' }), 60);
  assert.equal(days({ IP_RETENTION_DAYS: '1' }), 1);
  assert.equal(days({ IP_RETENTION_DAYS: '3650' }), 3650);
  for (const bad of ['0', '-5', '3651', '30.5', '1e3', 'ninety', 'Infinity']) {
    assert.equal(days({ IP_RETENTION_DAYS: bad }), 90, bad);
  }
});

test('every target clears one IP column and keeps its row', () => {
  for (const target of ipRetention.TARGETS) {
    assert.match(target.sql, /^UPDATE \w+ SET \w*ip = NULL/);
    assert.doesNotMatch(target.sql, /DELETE/i);
    assert.match(target.sql, /make_interval\(days => \$1::int\)/);
  }
});

test('a failing table does not keep the others from being cleared', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push(params);
      if (/user_terms_consents/.test(sql)) throw new Error('relation is locked');
      return { rowCount: 2 };
    },
  };
  await assert.rejects(ipRetention.purgeExpiredIps(pool, { days: 30 }), (err) => {
    assert.equal(err.message, 'relation is locked');
    assert.deepEqual(err.ipRetentionCounts, { waitlistSignups: 2, userWaitlistIps: 2, termsConsents: 0, dbExports: 2 });
    return true;
  });
  assert.equal(seen.length, ipRetention.TARGETS.length);
  assert.ok(seen.every((params) => params[0] === 30));
});

// The sweep is the ip-retention clock's run (src/workflow/clock/services.ts):
// one at a time across every process, daily.
test('the ip-retention clock runs the sweep daily', async () => {
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'ip-retention');
  assert.ok(job, 'the ip-retention clock exists');
  assert.equal(job.everyMs, 24 * 60 * 60 * 1000);
  assert.equal(job.item, undefined, 'clearing a column is safe to run twice: no targets');
  const seen = [];
  const pool = { query: async (sql, params) => { seen.push(params); return { rowCount: 0 }; } };
  await job.run({ input: {} }, { config: {}, pool });
  assert.equal(seen.length, ipRetention.TARGETS.length, 'the run is purgeExpiredIps on the pool');
});

test('the purge against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'ip_retention_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const OLD = "NOW() - INTERVAL '91 days'";
  const NEW = "NOW() - INTERVAL '89 days'";
  let seq = 0;
  async function user(waitlistIp, submittedAt, createdAt = 'NOW()') {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, email, waitlist_ip, waitlist_submitted_at, created_at)
       VALUES ($1, 'x', $2, $3, ${submittedAt}, ${createdAt}) RETURNING id`,
      [`ipret_${seq}`, `ipret_${seq}@example.invalid`, waitlistIp]
    );
    return rows[0].id;
  }

  const oldUser = await user('203.0.113.1', OLD);
  const newUser = await user('203.0.113.2', NEW);
  const legacyOldUser = await user('203.0.113.3', 'NULL', OLD);
  const legacyNewUser = await user('203.0.113.4', 'NULL', NEW);

  await pool.query(
    `INSERT INTO waitlist_signups (email, ip, submitted_at) VALUES
       ('old@example.invalid', '198.51.100.1', ${OLD}),
       ('new@example.invalid', '198.51.100.2', ${NEW})`
  );
  const { rows: [terms] } = await pool.query(
    `INSERT INTO terms_versions (version, title, body_markdown, published_at)
     VALUES ('v-ipret', 'Terms', 'Body', NOW()) RETURNING id`
  );
  await pool.query(
    `INSERT INTO user_terms_consents (user_id, terms_version_id, status, responded_at, ip) VALUES
       ($1, $3, 'accepted', ${OLD}, '192.0.2.1'),
       ($2, $3, 'accepted', ${NEW}, '192.0.2.2')`,
    [oldUser, newUser, terms.id]
  );
  await pool.query(
    `INSERT INTO db_exports (username, db_name, status, ip, requested_at) VALUES
       ('old-admin', 'app_x', 'done', '2001:db8::1', ${OLD}),
       ('new-admin', 'app_x', 'done', '2001:db8::2', ${NEW})`
  );

  const counts = await ipRetention.purgeExpiredIps(pool, { days: 90 });
  assert.deepEqual(counts, { waitlistSignups: 1, userWaitlistIps: 2, termsConsents: 1, dbExports: 1 });

  const ips = async (sql) => (await pool.query(sql)).rows.map((r) => [r.k, r.ip]);
  assert.deepEqual(
    await ips('SELECT email AS k, ip FROM waitlist_signups ORDER BY email'),
    [['new@example.invalid', '198.51.100.2'], ['old@example.invalid', null]]
  );
  assert.deepEqual(
    await ips(`SELECT id AS k, waitlist_ip AS ip FROM users WHERE username LIKE 'ipret_%' ORDER BY id`),
    [[oldUser, null], [newUser, '203.0.113.2'], [legacyOldUser, null], [legacyNewUser, '203.0.113.4']]
  );
  assert.deepEqual(
    await ips('SELECT user_id AS k, ip FROM user_terms_consents ORDER BY user_id'),
    [[String(oldUser), null], [String(newUser), '192.0.2.2']]
  );
  assert.deepEqual(
    await ips('SELECT username AS k, ip FROM db_exports ORDER BY username'),
    [['new-admin', '2001:db8::2'], ['old-admin', null]]
  );

  // A second pass has nothing left to clear, and a shorter period reaches
  // the newer rows too.
  assert.deepEqual(await ipRetention.purgeExpiredIps(pool, { days: 90 }),
    { waitlistSignups: 0, userWaitlistIps: 0, termsConsents: 0, dbExports: 0 });
  assert.deepEqual(await ipRetention.purgeExpiredIps(pool, { days: 30 }),
    { waitlistSignups: 1, userWaitlistIps: 2, termsConsents: 1, dbExports: 1 });
  const left = await pool.query(
    `SELECT (SELECT COUNT(*) FROM waitlist_signups WHERE ip IS NOT NULL)
          + (SELECT COUNT(*) FROM users WHERE waitlist_ip IS NOT NULL)
          + (SELECT COUNT(*) FROM user_terms_consents WHERE ip IS NOT NULL)
          + (SELECT COUNT(*) FROM db_exports WHERE ip IS NOT NULL) AS n`
  );
  assert.equal(Number(left.rows[0].n), 0);
  const rows = await pool.query(
    `SELECT (SELECT COUNT(*) FROM waitlist_signups) AS w,
            (SELECT COUNT(*) FROM user_terms_consents) AS c,
            (SELECT COUNT(*) FROM db_exports) AS d`
  );
  assert.deepEqual(rows.rows[0], { w: '2', c: '2', d: '2' }, 'rows are kept, only the address goes');
});
