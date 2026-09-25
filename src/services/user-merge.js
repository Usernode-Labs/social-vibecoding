'use strict';

// Admin "Deduplicate user": merge two accounts that belong to one person.
//
// One transaction, all or nothing. The KEPT account keeps its row as it is
// (except the email, when the admin chose the other account's address, and
// sign-in methods it did not have); every row anywhere that referenced the
// MERGED account is re-pointed at the kept one; the merged row itself stays
// (so historical ids stay valid) but is anonymised, locked out and signed
// out everywhere. A `user_merges` row records who did it and the per-table
// counts.
//
// ── Which rows move ────────────────────────────────────────────────────
//
// Every foreign key to users(id), discovered from the Postgres catalog at
// run time (about 150 of them, across schemas), plus the short, explicit
// NON_FK_MOVES list below. Nothing is hand-listed per table, so a table
// added next month is merged without anyone remembering this file. The
// exceptions are explicit too: REVOKED_TABLES (sign-in material, deleted)
// and STAY_TABLES (records about the merged identity itself).
//
// ── Conflicts: the kept account wins ───────────────────────────────────
//
// For each table, before its UPDATE:
//   1. Pair tables (two user columns tied by a CHECK or a unique index:
//      friendships, direct-message pairs, blocks, declines, reports) lose
//      rows that would pair the kept account with itself.
//   2. For each unique index that contains a moving user column (composite,
//      partial and expression indexes included; NULLs compared the way the
//      index compares them), the merged account's rows whose re-pointed key
//      already exists for the kept account are removed. Tables in
//      RETAIN_ON_CONFLICT keep those rows on the anonymised account instead,
//      and so does any table where removing the row is blocked by a
//      dependent row.
//   3. One UPDATE re-points every moving column. An ordered pair
//      (CHECK (low < high)) is re-normalised with LEAST/GREATEST.
// Each table runs inside a SAVEPOINT. If a table still fails, the whole
// merge rolls back and the caller gets a 409 naming the table and
// constraint: never a partial merge.
//
// Every identifier in the dynamic SQL below comes from the catalog and is
// quoted by quoteIdent(); request input only ever reaches a query as a
// bound parameter.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { ADMIN_MUTATION_LOCK } = require('./advisory-locks');
const { acquireUserLock, accountRecovery } = require('./cli-auth');
const log = require('./logger');

class UserMergeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function reject(status, code, message) { throw new UserMergeError(status, code, message); }

const ANON_EMAIL_DOMAIN = 'onhomeroom.com';
function anonymisedEmail(keptId, mergedId) {
  return `support+anonym+${keptId}+${mergedId}@${ANON_EMAIL_DOMAIN}`;
}

// Sign-in material and short-lived auth state of the merged account. These
// rows are DELETED, never re-pointed: a moved session or token would sign
// its holder in as the kept account. accountRecovery() (the same boundary a
// password reset uses) first deletes `sessions`, revokes the native session
// credentials, cancels CLI device authorizations and revokes CLI tokens.
const REVOKED_TABLES = Object.freeze([
  'sessions',
  'web_signup_sessions',
  'mobile_auth_tokens',
  'mobile_push_registrations',
  'mcp_tokens',
  'mcp_authorization_codes',
  'mcp_delegations',
  'session_agent_leases',
  'global_chat_action_tokens',
  'social_identity_oauth_states',
  'social_identity_pending_replacements',
  'account_email_verifications',
]);

// Rows that describe the merged identity itself. They stay on the
// anonymised row, revoked where they are credentials.
const STAY_TABLES = Object.freeze(new Map([
  ['cli_access_tokens', 'revoked by accountRecovery; a token belongs to the identity it was issued to'],
  ['cli_device_authorizations', 'cancelled by accountRecovery; same reason'],
  ['cli_auth_audit_events', 'security audit trail of the merged identity'],
  ['mcp_auth_audit_events', 'security audit trail of the merged identity'],
  ['native_session_web_incarnations', 'bound to revoked native credentials of the merged identity'],
  ['native_session_credentials', 'revoked by accountRecovery; bound to the merged identity'],
  ['mobile_push_registration_events', 'device registration log of the merged identity'],
  ['user_merges', 'this audit table'],
]));

// Conflicting rows here are LEFT on the anonymised account rather than
// deleted, because deleting them destroys something that is not a
// duplicate: a season wallet (secret key, funds), a live provider key that
// would be orphaned remotely, a proposal, a sent message, a pledged bounty.
const RETAIN_ON_CONFLICT = Object.freeze(new Set([
  'onchain_accounts',
  'credentials.managed_openrouter_keys',
  'chat_sessions',
  'conversation_messages',
  'issue_bounties',
]));

// User references that are NOT foreign keys. Found by sweeping schema.sql
// and the catalog for user-shaped column names without REFERENCES users.
// Moved: it names who did something, so it follows the person.
const NON_FK_MOVES = Object.freeze([
  { table: 'user_activities', column: 'added_by' }, // the admin who added the points (a users.id)
]);
// Deliberately left alone (pinned by tests/user-merge-postgres.test.js):
//   account_deletions.user_id            ids of DELETED users; a merged user is never one
//   token_allocation.updated_by          an admin id from the imported programme system, not a users.id
//   waitlist_signups.invited_by          a waitlist_signups.id (FK to itself), not a user
//   native_epoch_delegation_policies.user_id  append-only ledger; a trigger rejects UPDATE
//   native_session_attempts.user_id      revoked native sign-in chain of the merged identity
//   slot_outcome_reports.user_id         device telemetry keyed by a wallet address that stays
//   db_exports.username                  snapshot of the name at export time
//   username_history.username            handled explicitly below (history moves, old name added)
//   chat_sessions.imported_pr_author, *.owner, fork_owner  GitHub logins, not Homeroom users
//   ids inside JSON (events.metadata, notifications payloads)  historical text, not references
// Leaderboard snapshots move with the rest; their totals refresh at the
// next scheduled aggregate (src/services/topochain/snapshot-builder.js).
const NON_FK_LEFT = Object.freeze([
  'account_deletions.user_id',
  'token_allocation.updated_by',
  'native_epoch_delegation_policies.user_id',
  'native_session_attempts.user_id',
  'slot_outcome_reports.user_id',
  'db_exports.username',
]);

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
function qualified(schema, table) {
  return schema === 'public' ? table : `${schema}.${table}`;
}
function quotedTable(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}
function mentions(expr, column) {
  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])"?${esc}"?($|[^A-Za-z0-9_$])`).test(expr || '');
}

// ── Catalog ──────────────────────────────────────────────────────────────

async function loadUserColumns(db) {
  const { rows: fks } = await db.query(
    `SELECT r.oid AS relid, n.nspname AS schema_name, r.relname AS table_name,
            a.attname AS column_name, a.attnum::int AS attnum
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
        AND cardinality(c.conkey) = 1
      ORDER BY n.nspname, r.relname, a.attname`
  );
  const extra = [];
  for (const { table, column } of NON_FK_MOVES) {
    const { rows } = await db.query(
      `SELECT r.oid AS relid, n.nspname AS schema_name, r.relname AS table_name,
              a.attname AS column_name, a.attnum::int AS attnum
         FROM pg_attribute a
         JOIN pg_class r ON r.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE r.oid = to_regclass($1) AND a.attname = $2 AND NOT a.attisdropped`,
      [table, column]
    );
    extra.push(...rows);
  }
  const tables = new Map();
  for (const row of [...fks, ...extra]) {
    const name = qualified(row.schema_name, row.table_name);
    if (!tables.has(name)) {
      tables.set(name, {
        name, relid: row.relid, schema: row.schema_name, table: row.table_name,
        sql: quotedTable(row.schema_name, row.table_name), columns: [],
      });
    }
    const t = tables.get(name);
    if (!t.columns.some((c) => c.name === row.column_name)) {
      t.columns.push({ name: row.column_name, attnum: row.attnum });
    }
  }
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadTableShape(db, relid) {
  // Sequential on purpose: `db` is one client inside the transaction.
  const { rows: cols } = await db.query(
    `SELECT attnum::int AS attnum, attname AS name FROM pg_attribute
      WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
    [relid]
  );
  const { rows: indexes } = await db.query(
    `SELECT ic.relname AS name, i.indnullsnotdistinct AS nulls_not_distinct,
            pg_get_expr(i.indpred, i.indrelid) AS pred,
            ARRAY(SELECT u.k::int FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(k, o)
                   WHERE u.o <= i.indnkeyatts ORDER BY u.o) AS keys,
            ARRAY(SELECT pg_get_indexdef(i.indexrelid, g, true)
                    FROM generate_series(1, i.indnkeyatts::int) g ORDER BY g) AS defs
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = $1 AND i.indisunique AND i.indisvalid
      ORDER BY ic.relname`,
    [relid]
  );
  const { rows: checks } = await db.query(
    `SELECT ARRAY(SELECT u.k::int FROM unnest(conkey) u(k)) AS keys, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = $1 AND contype = 'c'`,
    [relid]
  );
  const { rows: inbound } = await db.query(
    `SELECT n.nspname AS schema_name, r.relname AS table_name,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY u(k, o)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.k ORDER BY u.o) AS from_cols,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY u(k, o)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.k ORDER BY u.o) AS to_cols
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND c.confrelid = $1 AND cardinality(c.confkey) > 1`,
    [relid]
  );
  const byNum = new Map(cols.map((c) => [c.attnum, c.name]));
  return { byNum, indexes, checks, inbound };
}

// ── Per-table plan ───────────────────────────────────────────────────────
//
// $1 is always the merged id, $2 the kept id.
function planTable(t, shape) {
  const moving = t.columns.map((c) => c.name);
  const movingNums = new Set(t.columns.map((c) => c.attnum));
  const q = quoteIdent;
  const mapped = (c) => `(CASE WHEN ${q(c)} = $1::integer THEN $2::integer ELSE ${q(c)} END)`;

  // Ordered pairs: CHECK (low < high) over two moving columns.
  const newExpr = new Map(moving.map((c) => [c, mapped(c)]));
  const pairs = [];
  for (const chk of shape.checks) {
    const users = (chk.keys || []).filter((k) => movingNums.has(k));
    if (users.length !== 2 || (chk.keys || []).length !== 2) continue;
    const [a, b] = users.map((k) => shape.byNum.get(k));
    pairs.push([a, b]);
    const m = /^CHECK \(\(?"?([A-Za-z0-9_]+)"? < "?([A-Za-z0-9_]+)"?\)?\)$/.exec(chk.def || '');
    if (m && moving.includes(m[1]) && moving.includes(m[2])) {
      newExpr.set(m[1], `LEAST(${mapped(m[1])}, ${mapped(m[2])})`);
      newExpr.set(m[2], `GREATEST(${mapped(m[1])}, ${mapped(m[2])})`);
    }
  }

  const moveCond = `(${moving.map((c) => `${q(c)} = $1::integer`).join(' OR ')})`;
  const stayCond = `NOT COALESCE(${moveCond}, false)`;

  // Rows another table references through a composite key that includes a
  // moving column (native_session_credentials -> onchain_accounts(id,
  // user_id)) cannot be re-pointed without breaking that reference; they
  // are retained and reported.
  const pinned = [];
  for (const fk of shape.inbound) {
    if (!fk.to_cols.some((c) => moving.includes(c))) continue;
    const on = fk.to_cols.map((c, i) => `d.${q(fk.from_cols[i])} = t.${q(c)}`).join(' AND ');
    pinned.push(`NOT EXISTS (SELECT 1 FROM ${quotedTable(fk.schema_name, fk.table_name)} d WHERE ${on})`);
  }
  const movable = pinned.length ? `(${pinned.join(' AND ')})` : 'TRUE';

  // Pairs from unique indexes with two or more moving columns.
  const unhandled = [];
  const conflictQueries = [];
  for (const idx of shape.indexes) {
    const keys = idx.keys || [];
    const defs = idx.defs || [];
    let skip = false;
    const terms = [];
    const idxUsers = [];
    keys.forEach((attnum, i) => {
      if (attnum > 0) {
        const col = shape.byNum.get(attnum);
        if (movingNums.has(attnum)) { idxUsers.push(col); terms.push(newExpr.get(col)); } else terms.push(q(col));
      } else {
        const expr = defs[i];
        if (moving.some((c) => mentions(expr, c))) { skip = true; return; }
        terms.push(`(${expr})`);
      }
    });
    if (skip) { unhandled.push(idx.name); continue; }
    if (!idxUsers.length) continue;
    if (idxUsers.length >= 2) {
      for (let i = 0; i < idxUsers.length; i++) {
        for (let j = i + 1; j < idxUsers.length; j++) pairs.push([idxUsers[i], idxUsers[j]]);
      }
    }
    const pred = idx.pred ? `(${idx.pred})` : 'TRUE';
    const eq = idx.nulls_not_distinct ? 'IS NOT DISTINCT FROM' : '=';
    const cols = terms.map((x, i) => `${x} AS k${i}`).join(', ');
    const same = (l, r) => terms.map((_, i) => `${l}.k${i} ${eq} ${r}.k${i}`).join(' AND ');
    const srcCond = `(${idxUsers.map((c) => `${q(c)} = $1::integer`).join(' OR ')})`;
    const dstCond = `${stayCond} AND (${idxUsers.map((c) => `${q(c)} = $2::integer`).join(' OR ')})`;
    conflictQueries.push({
      index: idx.name,
      sql: `WITH src AS (SELECT t.ctid AS rid, ${cols} FROM ${t.sql} AS t WHERE ${srcCond} AND ${pred} AND ${movable}),
                 dst AS (SELECT ${cols} FROM ${t.sql} AS t WHERE ${dstCond} AND ${pred})
            SELECT s.rid::text AS rid FROM src s
             WHERE EXISTS (SELECT 1 FROM dst d WHERE ${same('d', 's')})
                OR EXISTS (SELECT 1 FROM src o WHERE o.rid < s.rid AND ${same('o', 's')})`,
    });
  }

  const seen = new Set();
  const selfPairs = [];
  for (const [a, b] of pairs) {
    const key = [a, b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    selfPairs.push(`DELETE FROM ${t.sql} AS t
      WHERE (${q(a)} = $1::integer AND ${q(b)} IN ($1::integer, $2::integer))
         OR (${q(b)} = $1::integer AND ${q(a)} IN ($1::integer, $2::integer))`);
  }

  const sets = moving.map((c) => `${q(c)} = ${newExpr.get(c)}`).join(', ');
  return {
    unhandled,
    selfPairs,
    conflictQueries,
    countPinned: pinned.length
      ? `SELECT COUNT(*)::int AS n FROM ${t.sql} AS t WHERE ${moveCond} AND NOT ${movable}`
      : null,
    deleteRows: `DELETE FROM ${t.sql} WHERE ctid = ANY($1::tid[])`,
    update: `UPDATE ${t.sql} AS t SET ${sets}
              WHERE ${moveCond} AND ${movable} AND NOT (t.ctid = ANY($3::tid[]))`,
  };
}

function bump(obj, key, n) {
  if (n > 0) obj[key] = (obj[key] || 0) + n;
}

async function moveTable(db, t, mergedId, keptId, report) {
  const shape = await loadTableShape(db, t.relid);
  const plan = planTable(t, shape);
  await db.query('SAVEPOINT user_merge_table');
  try {
    for (const sql of plan.selfPairs) {
      const r = await db.query(sql, [mergedId, keptId]);
      bump(report.dropped, t.name, r.rowCount);
    }
    const conflicts = new Set();
    for (const cq of plan.conflictQueries) {
      const { rows } = await db.query(cq.sql, [mergedId, keptId]);
      for (const r of rows) conflicts.add(r.rid);
    }
    let retained = [];
    if (conflicts.size) {
      const rids = [...conflicts];
      if (RETAIN_ON_CONFLICT.has(t.name)) {
        retained = rids;
      } else {
        await db.query('SAVEPOINT user_merge_conflicts');
        try {
          const r = await db.query(plan.deleteRows, [rids]);
          await db.query('RELEASE SAVEPOINT user_merge_conflicts');
          bump(report.dropped, t.name, r.rowCount);
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT user_merge_conflicts');
          if (err.code !== '23503') throw err;
          // A dependent row blocks the delete: keep the duplicate on the
          // anonymised account rather than destroy what depends on it.
          retained = rids;
        }
      }
    }
    bump(report.retained, t.name, retained.length);
    if (plan.countPinned) {
      const { rows } = await db.query(plan.countPinned, [mergedId]);
      bump(report.retained, t.name, rows[0].n);
    }
    const r = await db.query(plan.update, [mergedId, keptId, retained]);
    bump(report.moved, t.name, r.rowCount);
    if (plan.unhandled.length) report.unhandledIndexes.push(...plan.unhandled.map((i) => `${t.name}.${i}`));
    await db.query('RELEASE SAVEPOINT user_merge_table');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT user_merge_table').catch(() => {});
    const what = err.constraint ? ` (${err.constraint})` : (err.code ? ` (${err.code})` : '');
    const e = new UserMergeError(409, 'merge_conflict',
      `The merge was stopped and nothing changed: rows in ${t.name} could not be moved${what}.`);
    e.cause = err;
    throw e;
  }
}

// ── Neutral username for the merged row ─────────────────────────────────

async function freeUsername(db, base) {
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await db.query(
      `SELECT
         EXISTS (SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)) AS taken,
         EXISTS (SELECT 1 FROM username_history WHERE LOWER(username) = LOWER($1)) AS retired,
         EXISTS (SELECT 1 FROM deleted_username_reservations
                  WHERE fingerprint = encode(sha256(convert_to(LOWER($1), 'UTF8')), 'hex')) AS reserved`,
      [candidate]
    );
    if (!rows[0].taken && !rows[0].retired && !rows[0].reserved) return candidate;
  }
  reject(409, 'username_unavailable', 'Could not find a free placeholder username for the merged account.');
  return null;
}

// ── Preview (read-only) ──────────────────────────────────────────────────

const SUMMARY_SQL = `
  SELECT u.id, u.username, u.display_name, u.email, u.email_confirmed, u.created_at,
         u.is_admin, u.admin_readonly, (u.usernode_pubkey IS NOT NULL) AS has_wallet,
         ARRAY(SELECT s.provider::text FROM user_social_identities s WHERE s.user_id = u.id ORDER BY s.provider) AS providers,
         (SELECT COUNT(*)::int FROM apps WHERE created_by = u.id) AS apps,
         (SELECT COUNT(*)::int FROM chat_sessions WHERE user_id = u.id AND pr_number IS NOT NULL) AS proposals,
         (SELECT COUNT(*)::int FROM chat_messages WHERE user_id = u.id)
           + (SELECT COUNT(*)::int FROM conversation_messages WHERE sender_id = u.id) AS messages,
         (SELECT COALESCE(SUM(points), 0)::float8 FROM user_activities WHERE user_id = u.id) AS points,
         EXISTS (SELECT 1 FROM user_merges WHERE merged_user_id = u.id) AS merged_away,
         EXISTS (SELECT 1 FROM account_deletions WHERE user_id = u.id) AS deletion_requested
    FROM users u
   WHERE u.id = ANY($1::int[])`;

function formatSummary(u) {
  return {
    id: Number(u.id),
    username: u.username,
    display_name: u.display_name || null,
    email: u.email || null,
    email_confirmed: !!u.email_confirmed,
    created_at: u.created_at ? new Date(u.created_at).toISOString() : null,
    role: !u.is_admin ? 'user' : (u.admin_readonly ? 'view_admin' : 'admin'),
    has_wallet: !!u.has_wallet,
    providers: u.providers || [],
    apps: Number(u.apps) || 0,
    proposals: Number(u.proposals) || 0,
    messages: Number(u.messages) || 0,
    points: Number(u.points) || 0,
    merged_away: !!u.merged_away,
  };
}

// Why an account cannot be merged AWAY (anonymised), or null.
function mergeAwayBlocker(u) {
  if (u.merged_away) return 'This account was already merged into another one.';
  if (u.deletion_requested) return 'This account was deleted.';
  if (u.is_admin && !u.admin_readonly) return 'This account is a full admin. Demote it before merging it away.';
  return null;
}
function keepBlocker(u) {
  if (u.merged_away) return 'This account was already merged into another one.';
  if (u.deletion_requested) return 'This account was deleted.';
  return null;
}

function movingTables(all) {
  return all.filter((t) => !STAY_TABLES.has(t.name) && !REVOKED_TABLES.includes(t.name));
}

async function mergePreview(pool, { userId, otherId }) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(otherId) || otherId <= 0) {
    reject(400, 'invalid_user', 'Choose two users.');
  }
  if (userId === otherId) reject(400, 'same_user', 'Choose a different user to merge with.');
  const { rows } = await pool.query(SUMMARY_SQL, [[userId, otherId]]);
  const a = rows.find((r) => Number(r.id) === userId);
  const b = rows.find((r) => Number(r.id) === otherId);
  if (!a || !b) reject(404, 'not_found', 'User not found.');

  const tables = movingTables(await loadUserColumns(pool));
  const arms = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const label = `${t.name}.${c.name}`.replace(/'/g, "''");
      arms.push(`SELECT '${label}' AS k,
                        COUNT(*) FILTER (WHERE ${quoteIdent(c.name)} = $1::integer)::int AS a,
                        COUNT(*) FILTER (WHERE ${quoteIdent(c.name)} = $2::integer)::int AS b
                   FROM ${t.sql} WHERE ${quoteIdent(c.name)} IN ($1::integer, $2::integer)`);
    }
  }
  const refs = { [userId]: {}, [otherId]: {} };
  if (arms.length) {
    const { rows: counts } = await pool.query(arms.join('\nUNION ALL\n'), [userId, otherId]);
    for (const r of counts) {
      if (r.a) refs[userId][r.k] = r.a;
      if (r.b) refs[otherId][r.k] = r.b;
    }
  }
  const total = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  const shape = (u) => ({
    ...formatSummary(u),
    merge_away_blocked: mergeAwayBlocker(u),
    keep_blocked: keepBlocker(u),
    references: refs[Number(u.id)],
    reference_total: total(refs[Number(u.id)]),
  });
  return { user: shape(a), other: shape(b) };
}

// ── The merge ────────────────────────────────────────────────────────────

async function mergeUsers(pool, { keepId, mergeId, actorId, emailFrom, confirmation }) {
  if (!Number.isSafeInteger(keepId) || keepId <= 0 || !Number.isSafeInteger(mergeId) || mergeId <= 0) {
    reject(400, 'invalid_user', 'Choose two users.');
  }
  if (keepId === mergeId) reject(400, 'same_user', 'An account cannot be merged with itself.');
  if (emailFrom !== 'kept' && emailFrom !== 'merged') reject(400, 'invalid_email_choice', 'Choose which email address to keep.');

  // Hashed before the transaction: bcrypt is slow and nothing is locked yet.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

  const db = await pool.connect();
  const report = { moved: {}, dropped: {}, retained: {}, unhandledIndexes: [] };
  let result;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
    for (const id of [keepId, mergeId].sort((x, y) => x - y)) await acquireUserLock(db, id);

    const { rows: actors } = await db.query('SELECT is_admin, admin_readonly FROM users WHERE id = $1', [actorId]);
    if (!actors.length || !actors[0].is_admin || actors[0].admin_readonly) {
      reject(403, 'forbidden', 'A full administrator is required.');
    }
    const { rows: locked } = await db.query(
      `SELECT id, username, email, email_confirmed, email_confirmed_at, is_admin, admin_readonly,
              usernode_pubkey
         FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [[keepId, mergeId]]
    );
    const kept = locked.find((r) => Number(r.id) === keepId);
    const merged = locked.find((r) => Number(r.id) === mergeId);
    if (!kept || !merged) reject(404, 'not_found', 'User not found.');
    const { rows: flags } = await db.query(
      `SELECT u.id,
              EXISTS (SELECT 1 FROM user_merges WHERE merged_user_id = u.id) AS merged_away,
              EXISTS (SELECT 1 FROM account_deletions WHERE user_id = u.id) AS deletion_requested
         FROM users u WHERE u.id = ANY($1::int[])`,
      [[keepId, mergeId]]
    );
    const flag = (id) => flags.find((f) => Number(f.id) === id) || {};
    const keptBlock = keepBlocker(flag(keepId));
    if (keptBlock) reject(409, 'kept_unavailable', `The account to keep cannot be used. ${keptBlock}`);
    const mergedBlock = mergeAwayBlocker({ ...merged, ...flag(mergeId) });
    if (mergedBlock) reject(409, flag(mergeId).merged_away ? 'already_merged' : 'merged_unavailable', mergedBlock);
    if (confirmation !== merged.username) {
      reject(400, 'confirmation_mismatch', `Type ${merged.username} exactly to confirm.`);
    }
    if (emailFrom === 'merged' && !merged.email) {
      reject(422, 'no_email', 'The merged account has no email address to keep.');
    }

    // 1. Sign the merged account out everywhere and make its password
    //    unusable. Same boundary a password reset uses.
    await accountRecovery(db, {
      userId: mergeId,
      actorUserId: actorId,
      updatePassword: (tx) => tx.query(
        `UPDATE users SET password = $1, password_reset_token_hash = NULL, password_reset_expires_at = NULL
          WHERE id = $2 RETURNING id, username, is_admin, admin_readonly`,
        [unusable, mergeId]
      ),
    });
    const allTables = await loadUserColumns(db);
    for (const t of allTables) {
      if (!REVOKED_TABLES.includes(t.name)) continue;
      for (const c of t.columns) {
        const r = await db.query(`DELETE FROM ${t.sql} WHERE ${quoteIdent(c.name)} = $1::integer`, [mergeId]);
        bump(report.dropped, t.name, r.rowCount);
      }
    }

    // 2. Move everything else, kept account wins.
    for (const t of movingTables(allTables)) await moveTable(db, t, mergeId, keepId, report);

    // 3. Wallet: copy only when the kept account has none; clear it from
    //    the merged row first either way.
    const walletMoved = !kept.usernode_pubkey && !!merged.usernode_pubkey;
    await db.query(
      `UPDATE users SET usernode_pubkey = NULL, wallet_link_token = NULL, wallet_link_expires_at = NULL WHERE id = $1`,
      [mergeId]
    );
    if (walletMoved) {
      await db.query(
        `UPDATE users SET usernode_pubkey = $2, wallet_link_token = NULL, wallet_link_expires_at = NULL WHERE id = $1`,
        [keepId, merged.usernode_pubkey]
      );
    }
    // The GitHub identity is mirrored on users.github_login for older
    // readers (social-identity.js writeGithubCompatibility). Follow a moved
    // identity; leave the kept account's own link alone.
    await db.query(
      `UPDATE users k
          SET github_login = s.handle, github_oauth_token_enc = NULL,
              github_linked_at = COALESCE(k.github_linked_at, NOW())
         FROM user_social_identities s
        WHERE k.id = $1 AND s.user_id = $1 AND s.provider = 'github'
          AND k.github_login IS DISTINCT FROM s.handle`,
      [keepId]
    );

    // 4. Email. The merged row's address is replaced FIRST, because emails
    //    are unique (users_email_lower_unique) and the kept row may be
    //    about to take it.
    await db.query(
      `UPDATE users SET email = $2, email_confirmed = FALSE, email_confirmed_at = NULL,
              email_confirmation_token = NULL, email_confirmation_sent_at = NULL
        WHERE id = $1`,
      [mergeId, anonymisedEmail(keepId, mergeId)]
    );
    if (emailFrom === 'merged') {
      await db.query(
        `UPDATE users SET email = $2, email_confirmed = $3, email_confirmed_at = $4,
                email_confirmation_token = NULL, email_confirmation_sent_at = NULL
          WHERE id = $1`,
        [keepId, merged.email, !!merged.email_confirmed, merged.email_confirmed ? merged.email_confirmed_at : null]
      );
    }

    // 5. Anonymise the merged row. Its old username goes into the kept
    //    account's history (it moved there with the rest), so Support finds
    //    the kept account by it and nobody else can register it.
    const placeholder = await freeUsername(db, `merged-${mergeId}`);
    await db.query(
      `UPDATE users SET username = $2,
              display_name = NULL, telegram = NULL, discord = NULL, github = NULL, x = NULL,
              country = NULL, city = NULL, bio = NULL, locale = NULL, referrer = NULL, referrer_handle = NULL,
              device_info = NULL, waitlist_ip = NULL, waitlist_answers = NULL, is_in_waitlist = FALSE,
              profile_published = FALSE, home_panel_positions = '{}'::jsonb,
              is_admin = FALSE, admin_readonly = FALSE, can_create_apps = FALSE, app_quota = 0,
              app_quota_requested_at = NULL, has_platform_access = FALSE, exclude_podium = TRUE,
              anthropic_key_enc = NULL, anthropic_key_last4 = NULL,
              github_login = NULL, github_oauth_token_enc = NULL, github_linked_at = NULL,
              needs_username_choice = FALSE, updated_at = NOW()
        WHERE id = $1`,
      [mergeId, placeholder]
    );
    const hist = await db.query(
      `INSERT INTO username_history (user_id, username, changed_at) VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [keepId, merged.username]
    );
    bump(report.moved, 'username_history', hist.rowCount);

    if (report.unhandledIndexes.length) {
      log.warn('user-merge', 'Unique expression indexes over a user column were not pre-checked',
        { indexes: report.unhandledIndexes });
    }
    const { rows: audit } = await db.query(
      `INSERT INTO user_merges (kept_user_id, merged_user_id, actor_id, email_kept_from, moved, dropped, retained)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [keepId, mergeId, actorId, emailFrom, JSON.stringify(report.moved),
        JSON.stringify(report.dropped), JSON.stringify(report.retained)]
    );
    await db.query('COMMIT');
    result = {
      ok: true,
      merge_id: Number(audit[0].id),
      kept_user_id: keepId,
      merged_user_id: mergeId,
      email_kept_from: emailFrom,
      wallet_moved: walletMoved,
      moved: report.moved,
      dropped: report.dropped,
      retained: report.retained,
      unchecked_indexes: report.unhandledIndexes,
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505' && err.constraint === 'user_merges_merged_unique') {
      throw new UserMergeError(409, 'already_merged', 'This account was already merged into another one.');
    }
    throw err;
  } finally { db.release(); }

  log.info('user-merge', 'Accounts merged', {
    mergeId: result.merge_id, keptUserId: keepId, mergedUserId: mergeId, actorId,
    emailKeptFrom: emailFrom, moved: result.moved, dropped: result.dropped, retained: result.retained,
  });
  // Live connections of the merged account close on every pod, and cached
  // visibility / admin rosters that named it are rebuilt.
  try {
    require('./account-deletion-runtime').revoke(mergeId, []);
    require('./agent-models').invalidateUser(keepId);
  } catch {
    log.warn('user-merge', 'Live disconnect will be reconciled', { mergedUserId: mergeId });
  }
  return result;
}

module.exports = {
  UserMergeError,
  mergeUsers,
  mergePreview,
  anonymisedEmail,
  planTable,
  quoteIdent,
  REVOKED_TABLES,
  STAY_TABLES,
  RETAIN_ON_CONFLICT,
  NON_FK_MOVES,
  NON_FK_LEFT,
};
