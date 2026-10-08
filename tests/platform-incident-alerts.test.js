'use strict';

// The two bells for the errors that should not happen
// (services/platform-incident-alerts.js).
//
// The SQL the two notification creators run — the full-admin audience and
// the unread de-dupe that collapses a burst to one row per admin — is
// executed against a REAL postgres, in a throwaway schema, the same contract
// as tests/mobile-push-trigger-postgres.test.js: skipped, never failed, when
// no server is reachable. The digest sweep's decision logic (hour, quiet
// span, the 20-hour gap, the advisory lock) runs against the same real
// tables with an injected clock, and the parts that need no database (the
// threshold map) stay pure.
//
// Run with: node --test tests/platform-incident-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const alerts = require('../src/services/platform-incident-alerts');
const incidents = require('../src/services/platform-incidents');
const notifications = require('../src/services/notifications');

// ── The threshold map ────────────────────────────────────────────────────

test('one number per kind, held in one place, with a default for the rest', () => {
  assert.equal(alerts.THRESHOLDS.build_interrupted, 3);
  assert.equal(alerts.THRESHOLD_DEFAULT, 3);
  assert.equal(alerts.WINDOW_HOURS, 1);
  assert.equal(alerts.thresholdFor('build_interrupted'), 3);
  assert.equal(alerts.thresholdFor('not_registered_yet'), 3, 'a later kind inherits the default');
  assert.equal(alerts.DIGEST_HOUR_UTC, 6);
  assert.equal(alerts.DIGEST_MIN_GAP_HOURS, 20);
});

// ── Real postgres ────────────────────────────────────────────────────────

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

// Connect for a test, or skip it: a test that cannot reach its dependency
// is not evidence of a defect.
async function realDb(t) {
  const c = await connect();
  if (!c || c.error) { t.skip(c?.error ? `no postgres: ${c.error}` : 'no pg module'); return null; }
  t.after(() => c.client.end().catch(() => {}));
  return c.client;
}

// The stubs carry exactly the columns the creators and the sweep touch —
// users' admin flags, notifications' detail token, and the events rows the
// incidents are.
const STUB_DDL = `
  CREATE TABLE users (
    id             SERIAL PRIMARY KEY,
    is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
    admin_readonly BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE notifications (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    source_user_id INTEGER,
    kind           VARCHAR(32) NOT NULL,
    detail         VARCHAR(32),
    read_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE events (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER,
    app_id     INTEGER,
    session_id INTEGER,
    event_type VARCHAR(32) NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function withSchema(clients, fn) {
  const list = Array.isArray(clients) ? clients : [clients];
  const name = `platform_incident_alerts_test_${process.pid}`;
  await list[0].query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await list[0].query(`CREATE SCHEMA ${name}`);
  try {
    for (const c of list) await c.query(`SET search_path TO ${name}`);
    await list[0].query(STUB_DDL);
    return await fn();
  } finally {
    for (const c of list) await c.query('SET search_path TO public').catch(() => {});
    await list[0].query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

// A pg Client is not a Pool, but every call site here only uses .query —
// except the sweep, which pools a client out. `pool.connect()` hands back a
// dedicated client over the same connection, so the advisory lock is real.
function asPool(client) {
  return {
    query: (sql, params) => client.query(sql, params),
    connect: async () => ({
      query: (sql, params) => client.query(sql, params),
      release: () => {},
    }),
  };
}

async function insertEvent(pool, { kind, at = null } = {}) {
  if (at) {
    await pool.query(
      "INSERT INTO events (event_type, metadata, created_at) VALUES ('platform_incident', $1, $2)",
      [JSON.stringify({ kind }), at],
    );
  } else {
    await pool.query(
      "INSERT INTO events (event_type, metadata) VALUES ('platform_incident', $1)",
      [JSON.stringify({ kind })],
    );
  }
}

test('threshold: two in the hour send nothing, the third sends one row per full admin and none to a view-only admin', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const pool = asPool(client);
    await client.query(
      `INSERT INTO users (is_admin, admin_readonly) VALUES
        (TRUE, FALSE), (TRUE, FALSE), (TRUE, TRUE), (FALSE, FALSE)`,
    );
    await insertEvent(pool, { kind: 'build_interrupted' });
    await insertEvent(pool, { kind: 'build_interrupted' });
    const quiet = await alerts.checkThreshold(pool, 'build_interrupted');
    assert.equal(quiet.triggered, false, 'two in the hour stays under the line');
    assert.equal(quiet.count, 2);

    await insertEvent(pool, { kind: 'build_interrupted' });
    const crossed = await alerts.checkThreshold(pool, 'build_interrupted');
    assert.equal(crossed.triggered, true);
    assert.equal(crossed.recipients, 2, 'the two full admins, nobody else');
    const { rows } = await client.query("SELECT detail FROM notifications WHERE kind = 'platform_incident' ORDER BY id");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.detail === 'build_interrupted:3'));

    // A second crossing while the first row is unread sends nothing.
    await insertEvent(pool, { kind: 'build_interrupted' });
    const again = await alerts.checkThreshold(pool, 'build_interrupted');
    assert.equal(again.triggered, false, 'no second alert while the first is unread');

    // Marking it read lets the next crossing send again — to that admin only.
    await client.query(
      'UPDATE notifications SET read_at = NOW() WHERE kind = $1 AND user_id = (SELECT MIN(id) FROM users)',
      ['platform_incident'],
    );
    const third = await alerts.checkThreshold(pool, 'build_interrupted');
    assert.equal(third.triggered, true);
    assert.equal(third.recipients, 1, 'only the admin whose row was read');
  });
});

test('record() still resolves when the chained threshold query fails, and writes the incident', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    // A pool that answers the events insert but fails the threshold COUNT
    // — the shape an existing fake pool in the restart-recovery test has.
    let first = true;
    const fake = {
      query: async (sql) => {
        if (/INSERT INTO events/.test(sql) && first) {
          first = false;
          return { rows: [] };
        }
        throw new Error('down');
      },
    };
    await assert.doesNotReject(incidents.record(fake, { kind: 'build_interrupted' }));
    // And against a real pool the whole chain runs: write, then check.
    const pool = asPool(client);
    await incidents.record(pool, { kind: 'build_interrupted' });
    await incidents.record(pool, { kind: null });
    const { rows } = await client.query(
      "SELECT metadata->>'kind' AS kind FROM events WHERE event_type = 'platform_incident'",
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows.map((r) => r.kind), ['build_interrupted']);
  });
});

test('digest: rows since the last digest send one per full admin; quiet, early and recent spans send none', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const pool = asPool(client);
    await client.query(
      `INSERT INTO users (is_admin, admin_readonly) VALUES
        (TRUE, FALSE), (TRUE, FALSE), (TRUE, TRUE)`,
    );
    // The clock the sweep is driven by. The digest rows' real created_at is
    // rewritten to this same clock after each send, so the whole run is
    // deterministic against a real NOW() the test cannot choose.
    const C = new Date('2026-10-07T07:10:00Z');
    const stamp = async (iso) => {
      await client.query("UPDATE notifications SET created_at = $1 WHERE kind = 'platform_incident_digest'", [iso]);
    };

    // Nothing since the (nonexistent) previous digest: quiet, no rows.
    let out = await alerts.sweepDigest(pool, C);
    assert.deepEqual(out, { due: false, sent: 0, count: 0, skipped: 'quiet' });

    // Two incidents inside the last day, one two days back. No digest row
    // yet, so the window opens at the same hour the previous day: the first
    // run covers its own day, not the table's whole history.
    await insertEvent(pool, { kind: 'build_interrupted', at: '2026-10-07T05:00:00Z' });
    await insertEvent(pool, { kind: 'build_interrupted', at: '2026-10-07T06:30:00Z' });
    await insertEvent(pool, { kind: 'build_interrupted', at: '2026-10-05T12:00:00Z' });
    out = await alerts.sweepDigest(pool, C);
    assert.equal(out.due, true);
    assert.equal(out.count, 2, 'the incident from two days ago is outside the window');
    assert.equal(out.sent, 2);
    await stamp('2026-10-07T07:10:00Z');
    let { rows } = await client.query("SELECT detail FROM notifications WHERE kind = 'platform_incident_digest'");
    assert.deepEqual(rows.map((r) => r.detail).sort(), ['2', '2']);

    // A digest in the last 20 hours suppresses.
    out = await alerts.sweepDigest(pool, new Date('2026-10-07T17:10:00Z'));
    assert.equal(out.skipped, 'recent');

    // Before the hour: nothing, whatever is in the table.
    out = await alerts.sweepDigest(pool, new Date('2026-10-08T03:00:00Z'));
    assert.equal(out.skipped, 'hour');

    // After the gap and the hour, with incidents since the last digest: it
    // fires again. The previous rows are read first, so the unread de-dupe
    // does not hold this run back.
    await client.query("UPDATE notifications SET read_at = NOW() WHERE kind = 'platform_incident_digest'");
    await insertEvent(pool, { kind: 'build_interrupted', at: '2026-10-08T03:00:00Z' });
    await insertEvent(pool, { kind: 'build_interrupted', at: '2026-10-08T06:00:00Z' });
    out = await alerts.sweepDigest(pool, new Date('2026-10-08T07:10:00Z'));
    assert.equal(out.due, true);
    assert.equal(out.count, 2, 'the two incidents since the first digest');
    assert.equal(out.sent, 2);
    rows = (await client.query("SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'platform_incident_digest'")).rows;
    assert.equal(rows[0].n, 4);
  });
});

test('a taken advisory lock skips the sweep', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  // A second real connection: session-scoped advisory locks are re-entrant
  // within one session, so the lock must be held by a different session for
  // the sweep's try to fail.
  const other = await connect();
  if (!other || other.error) { t.skip('could not open a second connection'); return; }
  t.after(() => other.client.end().catch(() => {}));
  await withSchema([client, other.client], async () => {
    await client.query('SELECT pg_advisory_lock($1, $2)', [991015, 0]);
    try {
      const pool = asPool(other.client);
      const busy = await alerts.sweep(pool, new Date('2026-10-07T07:10:00Z'));
      assert.equal(busy.busy, true);
      assert.equal(busy.digest, null);
      assert.deepEqual(busy.thresholdChecks, []);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [991015, 0]);
    }
  });
});

test('a staging sweep notifies nobody', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const pool = asPool(client);
    await client.query('INSERT INTO users (is_admin, admin_readonly) VALUES (TRUE, FALSE)');
    await insertEvent(pool, { kind: 'build_interrupted' });
    await insertEvent(pool, { kind: 'build_interrupted' });
    await insertEvent(pool, { kind: 'build_interrupted' });
    // deps.staging overrides the env check, the way platform-limit-alerts's
    // test does.
    const out = await alerts.sweepDigest(pool, new Date('2026-10-07T07:10:00Z'), { staging: true });
    assert.equal(out.skipped, 'staging');
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM notifications');
    assert.equal(rows[0].n, 0);
  });
});

// ── Notification creators' audiences, straight from the service ─────────

test('both creators answer the same audience platform_limit uses', async (t) => {
  const client = await realDb(t);
  if (!client) return;
  await withSchema(client, async () => {
    const pool = asPool(client);
    await client.query(
      `INSERT INTO users (is_admin, admin_readonly) VALUES
        (TRUE, FALSE), (TRUE, TRUE), (FALSE, FALSE)`,
    );
    const alertRows = await notifications.createPlatformIncidentAlertNotifications(pool, { kind: 'build_interrupted', count: 3 });
    assert.equal(alertRows.length, 1, 'the full admin only');
    assert.equal(alertRows[0].detail, 'build_interrupted:3');
    assert.equal(alertRows[0].source_user_id, null);
    const digestRows = await notifications.createPlatformIncidentDigestNotifications(pool, { count: 2 });
    assert.equal(digestRows.length, 1);
    assert.equal(digestRows[0].detail, '2');
    // The unread de-dupe: no second digest row while the first is unread.
    const repeat = await notifications.createPlatformIncidentDigestNotifications(pool, { count: 2 });
    assert.equal(repeat.length, 0);
  });
});