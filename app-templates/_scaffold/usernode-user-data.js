'use strict';

// One person's data in this app's database: what Homeroom asks for when that
// person deletes their account (erase it) or asks for a copy of their data
// (export it). See "Your people's data" in the platform conventions.
//
//   POST /usernode/user-deletion   erase or anonymise the person's rows
//   GET  /usernode/user-export     return the person's rows as JSON
//
// Only Homeroom can call these. Each request carries a platform token in the
// `x-usernode-platform-token` header, signed with the same key as a person's
// sign-in token (verified with USERNODE_JWT_PUBLIC_KEY), for this app's
// audience, with `pur` 'user-deletion' or 'user-export' and the person's
// `id` and `usernode_pubkey` (their wallet address, or null). Anything else
// is refused.
//
// WHAT IT ERASES BY DEFAULT: every row, in every table of the `public`
// schema, whose `user_id` column is the person's id or whose
// `usernode_pubkey` column is their wallet address. That is right for the
// tables this scaffold's conventions produce (a vote, an entry, a comment,
// a reaction: the person's own row, keyed by `user_id`).
//
// TELL IT ABOUT YOUR OTHER TABLES (when you add a table, check it here):
//   - A row the person made that is keyed some other way (`author_id`,
//     `created_by`) goes in OWNED_BY: `delete` it, or `anonymise` it when
//     other people's rows hang off it (a poll other people voted in), which
//     clears the owner column and the `clear` columns (their name).
//   - A table whose `user_id` does NOT mean "this row is about that person"
//     goes in SKIP, so the default leaves it alone.

const jwt = require('jsonwebtoken');

// Examples, not tables this scaffold has:
//   { table: 'posts', column: 'author_id', action: 'delete' },
//   { table: 'polls', column: 'created_by', action: 'anonymise', clear: ['created_by_name'] },
const OWNED_BY = [];
const SKIP = [];

const TOKEN_HEADER = 'x-usernode-platform-token';
const DELETION_PATH = '/usernode/user-deletion';
const EXPORT_PATH = '/usernode/user-export';
const KEY_COLUMNS = ['user_id', 'usernode_pubkey'];

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// Tables of the public schema with a `user_id` or `usernode_pubkey` column,
// less SKIP.
async function keyedTables(db) {
  const { rows } = await db.query(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = ANY($1::text[])
      ORDER BY c.table_name, c.column_name`,
    [KEY_COLUMNS]
  );
  const skip = new Set(SKIP);
  return rows.filter((r) => !skip.has(r.table_name));
}

// The value a key column is compared with: the id for `user_id`, the wallet
// address for `usernode_pubkey` (no address, nothing to match).
function keyFor(column, person) {
  if (column === 'usernode_pubkey') return person.usernodePubkey || null;
  return String(person.id);
}

async function deleteUserData(pool, person) {
  const db = await pool.connect();
  const counts = {};
  try {
    await db.query('BEGIN');
    // Anonymise first, so a shared row other people's rows hang off stays.
    for (const entry of OWNED_BY.filter((e) => e.action === 'anonymise')) {
      const sets = [entry.column, ...(entry.clear || [])].map((c) => ident(c) + ' = NULL').join(', ');
      const r = await db.query(
        `UPDATE ${ident(entry.table)} SET ${sets} WHERE ${ident(entry.column)}::text = $1`, [String(person.id)]);
      counts[entry.table] = (counts[entry.table] || 0) + r.rowCount;
    }
    let pending = [
      ...OWNED_BY.filter((e) => e.action === 'delete').map((e) => ({ table_name: e.table, column_name: e.column, id: true })),
      ...await keyedTables(db),
    ];
    // A row another table still points at is deleted after that table's
    // rows go: retry what a foreign key blocked until nothing is left.
    while (pending.length) {
      const blocked = [];
      for (const target of pending) {
        const key = target.id ? String(person.id) : keyFor(target.column_name, person);
        if (key === null) continue;
        await db.query('SAVEPOINT user_data');
        try {
          const r = await db.query(
            `DELETE FROM ${ident(target.table_name)} WHERE ${ident(target.column_name)}::text = $1`, [key]);
          await db.query('RELEASE SAVEPOINT user_data');
          counts[target.table_name] = (counts[target.table_name] || 0) + r.rowCount;
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT user_data');
          if (err.code !== '23503') throw err;
          blocked.push(target);
        }
      }
      if (blocked.length === pending.length) throw new Error('user data deletion is blocked by a foreign key');
      pending = blocked;
    }
    await db.query('COMMIT');
    return counts;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function exportUserData(pool, person) {
  const tables = {};
  const targets = [
    ...OWNED_BY.map((e) => ({ table_name: e.table, column_name: e.column, id: true })),
    ...await keyedTables(pool),
  ];
  for (const target of targets) {
    const key = target.id ? String(person.id) : keyFor(target.column_name, person);
    if (key === null) continue;
    const { rows } = await pool.query(
      `SELECT * FROM ${ident(target.table_name)} WHERE ${ident(target.column_name)}::text = $1`, [key]);
    if (rows.length) tables[target.table_name] = (tables[target.table_name] || []).concat(rows);
  }
  return tables;
}

// The person a platform request is about, or null when the token is missing,
// forged, expired, for another app, or for the other purpose.
// The verified token is the only thing read: the request has no body.
function verifyPlatformRequest(req, purpose, { publicKey, audience }) {
  const token = req.get(TOKEN_HEADER);
  if (!token || !publicKey || !audience) return null;
  try {
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'usernode', audience });
    if (!claims || claims.pur !== purpose) return null;
    if (!Number.isSafeInteger(claims.id) || claims.id <= 0) return null;
    return { id: claims.id, usernodePubkey: claims.usernode_pubkey || null };
  } catch {
    return null;
  }
}

// Mounted by server.js BEFORE its sign-in check: these requests carry no
// person's sign-in token, only the platform's own, verified here.
function mount(app, pool, {
  publicKey = (process.env.USERNODE_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
  audience = process.env.USERNODE_APP_ID ? 'usernode:app:' + process.env.USERNODE_APP_ID : null,
} = {}) {
  app.post(DELETION_PATH, async (req, res) => {
    const person = verifyPlatformRequest(req, 'user-deletion', { publicKey, audience });
    if (!person) return res.status(403).json({ error: 'platform_token_required' });
    try {
      const deleted = await deleteUserData(pool, person);
      res.json({ ok: true, deleted });
    } catch (err) {
      console.error('user data deletion failed: ' + err.message);
      res.status(500).json({ error: 'deletion_failed' });
    }
  });
  app.get(EXPORT_PATH, async (req, res) => {
    const person = verifyPlatformRequest(req, 'user-export', { publicKey, audience });
    if (!person) return res.status(403).json({ error: 'platform_token_required' });
    try {
      res.json({ userId: person.id, tables: await exportUserData(pool, person) });
    } catch (err) {
      console.error('user data export failed: ' + err.message);
      res.status(500).json({ error: 'export_failed' });
    }
  });
}

module.exports = { OWNED_BY, SKIP, mount, deleteUserData, exportUserData, verifyPlatformRequest };
