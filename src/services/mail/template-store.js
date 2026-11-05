'use strict';

// Storage for the admin-editable email templates and layouts (tables in
// src/db/migrations/email-templates.sql). Nothing here renders or sends mail.
//
// Every edit adds a version row and archives the previous live one; a row is
// never rewritten, so an older version can come back as the replacement for a
// deleted one. Each write runs in one transaction that first takes an advisory
// lock named for the action (or layout family), so two saves for the same
// thing queue up and the loser sees the winner's row. A write whose caller
// last saw a different live row throws `conflict` instead of overwriting it.
//
// Errors carry a `code` for routes to map: conflict, replacement_required,
// invalid_replacement, unknown_action, not_found, invalid_origin.

const { actionFor } = require('./actions');

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A first save for an action that raced past the lock check still meets the
    // one-live-row index; that is the same "somebody else saved first".
    if (err && err.code === '23505') throw fail('conflict', 'Another version was saved first');
    throw err;
  } finally {
    client.release();
  }
}

const lock = (client, scope, key) => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${scope}:${key}`]);

// A save that points at a layout holds it FOR SHARE until it commits. Deleting
// a layout takes it FOR UPDATE (`exclusive`), which waits for those saves and so
// counts and moves them, and which a later save waits behind until it sees the
// layout deleted.
async function assertLiveLayout(client, familyId, exclusive = false) {
  const { rows } = exclusive
    ? await client.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [familyId])
    : await client.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR SHARE", [familyId]);
  return rows.length > 0;
}

// The live row the caller believes is current must still be the live one.
function checkExpected(liveRow, expectedLiveId) {
  const liveId = liveRow ? liveRow.id : null;
  if ((expectedLiveId == null ? null : Number(expectedLiveId)) !== liveId) throw fail('conflict', 'Another version was saved first');
}

async function saveTemplate(pool, input, userId) {
  const { action, name, layoutFamilyId = null, subject, preheader = '', why = '', html, text, expectedLiveId = null } = input;
  if (!actionFor(action)) throw fail('unknown_action', `Unknown email action: ${action}`);
  return inTransaction(pool, async (client) => {
    await lock(client, 'email_templates', action);
    if (layoutFamilyId != null && !(await assertLiveLayout(client, layoutFamilyId))) throw fail('not_found', 'That layout does not exist');
    const { rows: [liveRow] } = await client.query(
      "SELECT id FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [action]);
    checkExpected(liveRow, expectedLiveId);
    if (liveRow) await client.query("UPDATE email_templates SET status = 'archived' WHERE id = $1", [liveRow.id]);
    const { rows: [{ version }] } = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM email_templates WHERE action = $1', [action]);
    const { rows: [row] } = await client.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, preheader, why, html, text, created_by)
       VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, $9, $10) RETURNING *`,
      [action, name, layoutFamilyId, version, subject, preheader, why, html, text, userId == null ? null : userId]);
    return row;
  });
}

async function saveLayout(pool, input, userId) {
  const { familyId = null, name, html, text, expectedLiveId = null } = input;
  return inTransaction(pool, async (client) => {
    let family = familyId;
    let version = 1;
    if (family == null) {
      checkExpected(null, expectedLiveId);
      family = (await client.query("SELECT nextval('email_layout_family_seq')::int AS id")).rows[0].id;
    } else {
      await lock(client, 'email_layouts', family);
      const { rows: [liveRow] } = await client.query(
        "SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [family]);
      if (!liveRow) throw fail('not_found', 'That layout does not exist');
      checkExpected(liveRow, expectedLiveId);
      await client.query("UPDATE email_layouts SET status = 'archived' WHERE id = $1", [liveRow.id]);
      version = (await client.query('SELECT MAX(version) + 1 AS version FROM email_layouts WHERE family_id = $1', [family])).rows[0].version;
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO email_layouts (family_id, name, version, status, html, text, created_by)
       VALUES ($1, $2, $3, 'live', $4, $5, $6) RETURNING *`,
      [family, name, version, html, text, userId == null ? null : userId]);
    return row;
  });
}

// Deleting the live version needs an archived version of the same action to
// take its place, so an action is never left without a template by accident.
// Deleting an archived version needs nothing.
async function deleteTemplate(pool, id, { replacementId = null } = {}, userId) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    const { rows: [peek] } = await client.query('SELECT action FROM email_templates WHERE id = $1', [id]);
    if (!peek) throw fail('not_found', 'That template does not exist');
    await lock(client, 'email_templates', peek.action);
    const { rows: [row] } = await client.query('SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!row) throw fail('not_found', 'That template does not exist');
    let replacement = null;
    if (row.status === 'live') {
      if (replacementId == null) throw fail('replacement_required', 'Choose a version to put live instead');
      const { rows: [found] } = await client.query(
        "SELECT * FROM email_templates WHERE id = $1 AND action = $2 AND status = 'archived' AND deleted_at IS NULL AND id <> $3 FOR UPDATE",
        [replacementId, row.action, id]);
      if (!found) throw fail('invalid_replacement', 'The replacement must be an archived version of the same action');
      if (found.layout_family_id != null && !(await assertLiveLayout(client, found.layout_family_id))) {
        throw fail('invalid_replacement', 'The replacement uses a layout that was deleted');
      }
      replacement = found;
    }
    await client.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE id = $1", [id]);
    if (replacement) await client.query("UPDATE email_templates SET status = 'live' WHERE id = $1", [replacement.id]);
    return { deletedId: row.id, liveId: replacement ? replacement.id : null };
  });
}

// A layout is deleted as a whole family. While live templates use it, they are
// moved to the replacement family so none is left pointing at a deleted layout.
async function deleteLayout(pool, familyId, { replacementFamilyId = null } = {}, userId) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    await lock(client, 'email_layouts', familyId);
    if (!(await assertLiveLayout(client, familyId, true))) throw fail('not_found', 'That layout does not exist');
    const { rows: [{ n }] } = await client.query(
      "SELECT count(*)::int AS n FROM email_templates WHERE layout_family_id = $1 AND status = 'live' AND deleted_at IS NULL", [familyId]);
    if (n > 0 && replacementFamilyId == null) throw fail('replacement_required', 'Choose a layout for the templates that use this one');
    if (replacementFamilyId != null) {
      if (Number(replacementFamilyId) === Number(familyId) || !(await assertLiveLayout(client, replacementFamilyId))) {
        throw fail('invalid_replacement', 'The replacement must be a different, live layout');
      }
      await client.query(
        'UPDATE email_templates SET layout_family_id = $2 WHERE layout_family_id = $1 AND deleted_at IS NULL', [familyId, replacementFamilyId]);
    }
    await client.query("UPDATE email_layouts SET status = 'archived', deleted_at = NOW() WHERE family_id = $1 AND deleted_at IS NULL", [familyId]);
    return { familyId: Number(familyId), movedTo: replacementFamilyId == null ? null : Number(replacementFamilyId) };
  });
}

// Puts the chosen version live, so an admin can undo a bad edit: the current
// live row is archived, and a deleted version comes back (deleted_at cleared).
// `expectedLiveId` is the live row the caller saw; a different one is a conflict.
// A version whose layout was deleted cannot go live.
async function restoreTemplate(pool, id, { expectedLiveId = null } = {}, userId) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    const { rows: [peek] } = await client.query('SELECT action FROM email_templates WHERE id = $1', [id]);
    if (!peek) throw fail('not_found', 'That template does not exist');
    await lock(client, 'email_templates', peek.action);
    const { rows: [row] } = await client.query('SELECT * FROM email_templates WHERE id = $1 FOR UPDATE', [id]);
    if (row.status === 'live' && row.deleted_at == null) return row;
    const { rows: [liveRow] } = await client.query(
      "SELECT id FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [row.action]);
    checkExpected(liveRow, expectedLiveId);
    if (row.layout_family_id != null && !(await assertLiveLayout(client, row.layout_family_id))) {
      throw fail('invalid_replacement', 'That version uses a layout that was deleted');
    }
    if (liveRow) await client.query("UPDATE email_templates SET status = 'archived' WHERE id = $1", [liveRow.id]);
    const { rows: [restored] } = await client.query(
      "UPDATE email_templates SET deleted_at = NULL, status = 'live' WHERE id = $1 RETURNING *", [id]);
    return restored;
  });
}

// Insert or replace one language of one version. `origin` says whether a
// machine or an admin wrote it, so a later machine pass can leave admin text alone.
// The statements are written out, not assembled, so the SQL inventory can read them.
async function saveTranslation(pool, kind, id, locale, fields, origin) {
  if (kind !== 'template' && kind !== 'layout') throw fail('not_found', `Unknown translation kind: ${kind}`);
  if (origin !== 'machine' && origin !== 'admin') throw fail('invalid_origin', 'origin must be machine or admin');
  const f = (name) => (fields && fields[name] != null ? String(fields[name]) : '');
  const exists = kind === 'template'
    ? await pool.query('SELECT id FROM email_templates WHERE id = $1', [id])
    : await pool.query('SELECT id FROM email_layouts WHERE id = $1', [id]);
  if (!exists.rows.length) throw fail('not_found', 'That version does not exist');
  const { rows: [row] } = kind === 'template'
    ? await pool.query(
      `INSERT INTO email_template_translations (template_id, locale, subject, preheader, why, html, text, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (template_id, locale) DO UPDATE SET subject = EXCLUDED.subject, preheader = EXCLUDED.preheader,
         why = EXCLUDED.why, html = EXCLUDED.html, text = EXCLUDED.text, origin = EXCLUDED.origin, updated_at = NOW()
       RETURNING *`,
      [id, locale, f('subject'), f('preheader'), f('why'), f('html'), f('text'), origin])
    : await pool.query(
      `INSERT INTO email_layout_translations (layout_id, locale, html, text, origin)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (layout_id, locale) DO UPDATE SET html = EXCLUDED.html, text = EXCLUDED.text,
         origin = EXCLUDED.origin, updated_at = NOW()
       RETURNING *`,
      [id, locale, f('html'), f('text'), origin]);
  return row;
}

// What the sender reads: each action's live template and each layout family's
// live layout, with every translation of that live row, in one query each.
async function snapshot(pool) {
  const [templates, layouts] = await Promise.all([
    pool.query(`SELECT e.*, (SELECT COALESCE(json_object_agg(t.locale, to_jsonb(t) - 'template_id' - 'locale'), '{}'::json)
                  FROM email_template_translations t WHERE t.template_id = e.id) AS translations
                FROM email_templates e WHERE e.status = 'live' AND e.deleted_at IS NULL`),
    pool.query(`SELECT e.*, (SELECT COALESCE(json_object_agg(t.locale, to_jsonb(t) - 'layout_id' - 'locale'), '{}'::json)
                  FROM email_layout_translations t WHERE t.layout_id = e.id) AS translations
                FROM email_layouts e WHERE e.status = 'live' AND e.deleted_at IS NULL`),
  ]);
  const out = { templates: {}, layouts: {} };
  for (const row of templates.rows) out.templates[row.action] = row;
  for (const row of layouts.rows) out.layouts[row.family_id] = row;
  return out;
}

// Every version, archived and deleted included, for the admin's history and
// restore views.
async function listAll(pool) {
  const [templates, layouts] = await Promise.all([
    pool.query('SELECT * FROM email_templates ORDER BY action, version'),
    pool.query('SELECT * FROM email_layouts ORDER BY family_id, version'),
  ]);
  return { templates: templates.rows, layouts: layouts.rows };
}

module.exports = { snapshot, saveTemplate, saveLayout, deleteTemplate, deleteLayout, restoreTemplate, saveTranslation, listAll };
