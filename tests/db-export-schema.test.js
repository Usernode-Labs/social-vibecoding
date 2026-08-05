// Platform database export — the audit table and its lifecycle.
//
// `db_exports` is the only durable record that a full copy of the platform
// database left the building. Everything asserted here is about that record
// being trustworthy:
//
//   - it survives the exporting admin being deleted (username snapshot +
//     ON DELETE SET NULL, never ON DELETE CASCADE);
//   - it is append-only — no route, and no migration, deletes from it;
//   - it is `staging:private`, so a staging clone doesn't carry production
//     admin IPs and user agents around;
//   - a row can never be left stuck in-flight: a mid-export restart is
//     swept to 'interrupted' at boot;
//   - the staging seed follows the platform's mock-data conventions.
//
// Static assertions on the SQL/JS source — no database required.
//
// Run with: node --test tests/db-export-schema.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
const migrate = fs.readFileSync(path.join(root, 'src/db/migrate.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
const eventsJs = fs.readFileSync(path.join(root, 'src/services/events.js'), 'utf8');

const table = schema.slice(
  schema.indexOf('CREATE TABLE IF NOT EXISTS db_exports'),
  schema.indexOf(');', schema.indexOf('CREATE TABLE IF NOT EXISTS db_exports'))
);

// ─── The table ────────────────────────────────────────────────────

test('db_exports exists and is created idempotently', () => {
  assert.ok(table.length > 0, 'schema.sql declares db_exports');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS db_exports/);
});

test('every column the audit trail needs is present', () => {
  for (const col of [
    'user_id', 'username', 'db_name', 'status', 'denied_reason',
    'ip', 'user_agent', 'bytes_sent', 'artifact_sha256', 'requested_at', 'started_at',
    'finished_at', 'error',
  ]) {
    assert.match(table, new RegExp(`\\b${col}\\b`), `column ${col}`);
  }
});

test('completed artifacts can store a strict SHA-256 while legacy rows remain nullable', () => {
  assert.match(table, /artifact_sha256\s+VARCHAR\(64\)/);
  assert.match(table,
    /artifact_sha256 IS NULL OR \(status = 'completed' AND artifact_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    'only a completed row can carry a lowercase 64-hex digest');
  assert.match(schema, /ALTER TABLE db_exports ADD COLUMN IF NOT EXISTS artifact_sha256/,
    'existing deployments receive the nullable column idempotently');
});

test('deleting the admin does not delete the evidence', () => {
  assert.match(table, /user_id\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/,
    'the FK nulls out; it must never cascade the row away');
  assert.ok(!/ON DELETE CASCADE/.test(table));
  assert.match(table, /username\s+VARCHAR\(255\) NOT NULL/,
    'the username is snapshotted so a deleted account is still attributable');
});

test('requested_at defaults server-side, so a row is stamped even if the write is partial', () => {
  assert.match(table, /requested_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
  assert.match(table, /bytes_sent\s+BIGINT\s+NOT NULL DEFAULT 0/,
    'a row that never streamed still reads as zero bytes, not null');
});

test('the history query is indexed', () => {
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_db_exports_requested ON db_exports \(requested_at DESC\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_db_exports_user ON db_exports \(user_id, requested_at DESC\)/);
});

test('the table is staging:private', () => {
  // Same reasoning as `events`: an activity log with admin usernames,
  // source IPs and user agents has no business riding along into a
  // staging clone (db-manager.js truncates staging:private tables).
  assert.match(schema, /COMMENT ON TABLE db_exports IS 'staging:private'/);
});

// ─── Append-only ──────────────────────────────────────────────────

test('nothing in the codebase deletes from db_exports', () => {
  const files = ['src/routes/admin.js', 'src/db/migrate.js', 'src/services/db-export.js'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/DELETE FROM db_exports/i.test(text), `${f} must not delete audit rows`);
    assert.ok(!/TRUNCATE\s+db_exports/i.test(text), `${f} must not truncate the audit log`);
  }
});

test('the only UPDATE closes a row out — it never rewrites who or what', () => {
  const updates = adminJs.match(/UPDATE db_exports[\s\S]*?WHERE id = \$1/g) || [];
  assert.ok(updates.length > 0, 'the completion path updates the row it inserted');
  for (const u of updates) {
    for (const immutable of ['user_id', 'username', 'ip', 'user_agent', 'requested_at']) {
      assert.ok(!new RegExp(`SET[\\s\\S]*\\b${immutable}\\s*=`).test(u),
        `an update must never rewrite ${immutable}`);
    }
  }
});

test('the audit row is written BEFORE the export runs', () => {
  const ticketRoute = adminJs.slice(adminJs.indexOf("router.post('/api/admin/db-export/ticket'"));
  const auditAt = ticketRoute.indexOf("recordExportAudit(req, { status: 'requested'");
  const issueAt = ticketRoute.indexOf('dbExport.issueTicket(');
  assert.ok(auditAt > 0 && issueAt > 0, 'both steps located');
  assert.ok(auditAt < issueAt, 'the record is committed before the ticket exists');
  assert.match(ticketRoute.slice(auditAt, issueAt), /if \(!auditId\)[\s\S]*refusing to run it/,
    'if the audit insert fails, the export is refused rather than run unrecorded');
});

test('every denial path is recorded, including the ones that never reach the handler', () => {
  for (const reason of ['view_only', 'rate_limited', 'staging', 'bad_password', 'in_progress', 'unavailable']) {
    assert.ok(adminJs.includes(`'${reason}'`), `denial reason ${reason} is audited`);
  }
  assert.match(adminJs, /res\.on\('finish'[\s\S]{0,200}statusCode === 429/,
    'a throttled attempt is audited from the response hook');
});

// ─── Interrupted-export sweeper ───────────────────────────────────

test('a restart mid-export cannot leave a row stuck in-flight', () => {
  const fn = migrate.slice(
    migrate.indexOf('async function sweepInterruptedDbExports'),
    migrate.indexOf('async function seedStagingDbExports')
  );
  assert.ok(fn.length > 0, 'the sweeper exists');
  assert.match(fn, /status = 'interrupted'/);
  assert.match(fn, /WHERE status IN \('requested', 'streaming'\)/,
    'both pre-stream and mid-stream states are swept');
  assert.ok(!/USERNODE_ENV/.test(fn), 'the sweeper runs in every environment, not just staging');
});

test('the sweeper runs at boot, from the migration path', () => {
  assert.match(migrate, /await sweepInterruptedDbExports\(pool\);/);
});

// ─── Staging seed ─────────────────────────────────────────────────

test('the staging seed follows the mock-data conventions', () => {
  const fn = migrate.slice(migrate.indexOf('async function seedStagingDbExports'));
  const body = fn.slice(0, fn.indexOf('\nasync function', 1));
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'gated to staging previews only');
  assert.match(body, /Staging demo/, 'rows are labelled as demo data');
  assert.match(body, /SELECT 1 FROM db_exports WHERE username LIKE 'Staging demo%'/,
    'idempotent — re-running the migration does not duplicate the seed');
  assert.match(body, /203\.0\.113\./, 'fake IPs come from the RFC 5737 documentation range');
  // The seed should show what the history table looks like in every state,
  // not just the happy one.
  for (const status of ['completed', 'failed', 'denied', 'cancelled']) {
    assert.ok(body.includes(`'${status}'`), `seeded a '${status}' row`);
  }
});

test('the seed invents nothing that could be mistaken for a real export', () => {
  const fn = migrate.slice(migrate.indexOf('async function seedStagingDbExports'));
  const body = fn.slice(0, fn.indexOf('\nasync function', 1));
  // Demo rows name a demo database, never the real platform one, so a
  // preview's history can't be read as evidence about production.
  assert.match(body, /staging_demo_platform_db/);
  assert.ok(!/'usernode'/.test(body), 'the real platform database is never named in demo rows');
  // Nothing credential-shaped: the only 'password' in here is the
  // denied_reason vocabulary value, never a value.
  assert.ok(!/\$2[aby]\$/.test(body), 'no bcrypt-shaped literal');
  assert.ok(!/sk-ant|Bearer\s/.test(body), 'no token-shaped literal');
  const pwMentions = body.match(/password/gi) || [];
  assert.deepEqual(pwMentions, ['password'], "only the 'bad_password' denial reason mentions passwords");
});

// ─── Analytics ────────────────────────────────────────────────────

test('DB_EXPORTED is in the canonical event vocabulary', () => {
  assert.match(eventsJs, /DB_EXPORTED: 'db_exported'/);
  // Emitted only where the dump actually left the building.
  const emit = adminJs.match(/events\.record\(pool, \{[\s\S]{0,200}DB_EXPORTED/g) || [];
  assert.equal(emit.length, 1, 'exactly one emitter');
  const eventAt = adminJs.indexOf('events.EVENT_TYPES.DB_EXPORTED');
  const completedGuard = adminJs.slice(
    adminJs.lastIndexOf("if (result.status === 'completed')", eventAt),
    eventAt
  );
  assert.ok(completedGuard.length > 0 && completedGuard.length < 300,
    'the event is emitted only on the completed path');
});
