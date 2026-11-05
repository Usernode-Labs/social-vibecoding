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
// invalid_replacement, unknown_action, not_found, invalid_origin, invalid (with
// `errors: [{ field, message }]`) and retry.
//
// A write that puts content live takes an optional `check(context)`, run inside
// its transaction once the rows it changes are locked, with the rows the new
// content will meet (the layout a template wears, the templates a layout
// frames). The admin routes validate there, so a layout edit and a template
// edit that each pass on their own cannot both land and break a mail together:
// the second waits for the first and is checked against it. A check that throws
// rolls the write back.

const log = require('../logger');
const { ACTIONS, actionFor } = require('./actions');

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// A client whose ROLLBACK failed is in an unknown state, so release(err) closes
// it instead of handing it to the next caller, who might be a sign-in.
async function inTransaction(pool, work) {
  const client = await pool.connect();
  let rollbackFailed;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackError) => { rollbackFailed = rollbackError; });
    // A first save for an action that raced past the lock check still meets the
    // one-live-row index; that is the same "somebody else saved first".
    if (err && err.code === '23505') throw fail('conflict', 'Another version was saved first');
    // A deadlock between two edits, or a lock that waited too long: nothing
    // was written, and the same request is likely to work a moment later.
    if (err && (err.code === '40P01' || err.code === '55P03')) throw fail('retry', 'The database was busy with another change');
    throw err;
  } finally {
    client.release(rollbackFailed);
  }
}

const lock = (client, scope, key) => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${scope}:${key}`]);

// A save that points at a layout holds it FOR SHARE until it commits. Deleting
// a layout takes it FOR UPDATE (`exclusive`), which waits for those saves and so
// counts and moves them, and which a later save waits behind until it sees the
// layout deleted.
async function liveLayout(client, familyId, exclusive = false) {
  const { rows } = exclusive
    ? await client.query("SELECT * FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [familyId])
    : await client.query("SELECT * FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR SHARE", [familyId]);
  return rows[0] || null;
}

// The live templates that wear a layout family, for a check.
async function wearers(client, familyId) {
  const { rows } = await client.query(
    "SELECT * FROM email_templates WHERE layout_family_id = $1 AND status = 'live' AND deleted_at IS NULL ORDER BY action", [familyId]);
  return rows;
}

const noCheck = async () => {};

// The live row the caller believes is current must still be the live one.
function checkExpected(liveRow, expectedLiveId) {
  const liveId = liveRow ? liveRow.id : null;
  if ((expectedLiveId == null ? null : Number(expectedLiveId)) !== liveId) throw fail('conflict', 'Another version was saved first');
}

async function saveTemplate(pool, input, userId, { check = noCheck } = {}) {
  const { action, name, layoutFamilyId = null, subject, preheader = '', why = '', html, text, expectedLiveId = null } = input;
  if (!actionFor(action)) throw fail('unknown_action', `Unknown email action: ${action}`);
  return inTransaction(pool, async (client) => {
    await lock(client, 'email_templates', action);
    const layout = layoutFamilyId == null ? null : await liveLayout(client, layoutFamilyId);
    if (layoutFamilyId != null && !layout) throw fail('not_found', 'That layout does not exist');
    const { rows: [liveRow] } = await client.query(
      "SELECT id FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [action]);
    checkExpected(liveRow, expectedLiveId);
    await check({ layout });
    if (liveRow) await client.query("UPDATE email_templates SET status = 'archived' WHERE id = $1", [liveRow.id]);
    const { rows: [{ version }] } = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM email_templates WHERE action = $1', [action]);
    const { rows: [row] } = await client.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, preheader, why, html, text, created_by)
       VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, $9, $10) RETURNING *`,
      [action, name, layoutFamilyId, version, subject, preheader, why, html, text, userId == null ? null : userId]);
    return row;
  });
}

async function saveLayout(pool, input, userId, { check = noCheck } = {}) {
  const { familyId = null, name, html, text, expectedLiveId = null } = input;
  return inTransaction(pool, async (client) => {
    let family = familyId;
    let version = 1;
    if (family == null) {
      checkExpected(null, expectedLiveId);
      await check({ templates: [] });
      family = (await client.query("SELECT nextval('email_layout_family_seq')::int AS id")).rows[0].id;
    } else {
      await lock(client, 'email_layouts', family);
      const { rows: [liveRow] } = await client.query(
        "SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [family]);
      if (!liveRow) throw fail('not_found', 'That layout does not exist');
      checkExpected(liveRow, expectedLiveId);
      await check({ templates: await wearers(client, family) });
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
//
// `expectedLiveId`, when given (null included), is the live version the caller
// saw. If another save, restore or delete has changed it since, the delete is
// a conflict: otherwise a stale screen could delete what is now an archived
// row, drop its chosen replacement and report it as live. Left undefined, it
// is not checked, for callers that act on what they just read.
async function deleteTemplate(pool, id, { replacementId = null, expectedLiveId } = {}, userId, { check = noCheck } = {}) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    const { rows: [peek] } = await client.query('SELECT action FROM email_templates WHERE id = $1', [id]);
    if (!peek) throw fail('not_found', 'That template does not exist');
    await lock(client, 'email_templates', peek.action);
    const { rows: [row] } = await client.query('SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!row) throw fail('not_found', 'That template does not exist');
    if (expectedLiveId !== undefined) {
      const { rows: [liveRow] } = await client.query(
        "SELECT id FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL", [row.action]);
      checkExpected(liveRow, expectedLiveId);
    }
    // A replacement only makes sense for the live version: a caller naming one
    // for an archived row believed it was live, so it saw an older state.
    if (row.status !== 'live' && replacementId != null) throw fail('conflict', 'Another version was saved first');
    let replacement = null;
    if (row.status === 'live') {
      if (replacementId == null) throw fail('replacement_required', 'Choose a version to put live instead');
      const { rows: [found] } = await client.query(
        "SELECT * FROM email_templates WHERE id = $1 AND action = $2 AND status = 'archived' AND deleted_at IS NULL AND id <> $3 FOR UPDATE",
        [replacementId, row.action, id]);
      if (!found) throw fail('invalid_replacement', 'The replacement must be an archived version of the same action');
      const layout = found.layout_family_id == null ? null : await liveLayout(client, found.layout_family_id);
      if (found.layout_family_id != null && !layout) {
        throw fail('invalid_replacement', 'The replacement uses a layout that was deleted');
      }
      await check({ row: found, layout });
      replacement = found;
    }
    await client.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE id = $1", [id]);
    if (replacement) await client.query("UPDATE email_templates SET status = 'live' WHERE id = $1", [replacement.id]);
    return { deletedId: row.id, liveId: replacement ? replacement.id : null };
  });
}

// A layout is deleted as a whole family. While live templates use it, they are
// moved to the replacement family so none is left pointing at a deleted layout.
// `expectedLiveId` is the live version of the family the caller saw, checked
// as in deleteTemplate when given.
async function deleteLayout(pool, familyId, { replacementFamilyId = null, expectedLiveId } = {}, userId, { check = noCheck } = {}) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    await lock(client, 'email_layouts', familyId);
    const live = await liveLayout(client, familyId, true);
    if (!live) throw fail('not_found', 'That layout does not exist');
    if (expectedLiveId !== undefined) checkExpected(live, expectedLiveId);
    const { rows: [{ n }] } = await client.query(
      "SELECT count(*)::int AS n FROM email_templates WHERE layout_family_id = $1 AND status = 'live' AND deleted_at IS NULL", [familyId]);
    if (n > 0 && replacementFamilyId == null) throw fail('replacement_required', 'Choose a layout for the templates that use this one');
    if (replacementFamilyId != null) {
      const layout = Number(replacementFamilyId) === Number(familyId) ? null : await liveLayout(client, replacementFamilyId);
      if (!layout) throw fail('invalid_replacement', 'The replacement must be a different, live layout');
      await check({ templates: await wearers(client, familyId), layout });
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
async function restoreTemplate(pool, id, { expectedLiveId = null } = {}, userId, { check = noCheck } = {}) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    const { rows: [peek] } = await client.query('SELECT action FROM email_templates WHERE id = $1', [id]);
    if (!peek) throw fail('not_found', 'That template does not exist');
    await lock(client, 'email_templates', peek.action);
    const { rows: [row] } = await client.query('SELECT * FROM email_templates WHERE id = $1 FOR UPDATE', [id]);
    if (row.status === 'live' && row.deleted_at == null) return row;
    const { rows: [liveRow] } = await client.query(
      "SELECT id FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL FOR UPDATE", [row.action]);
    checkExpected(liveRow, expectedLiveId);
    const layout = row.layout_family_id == null ? null : await liveLayout(client, row.layout_family_id);
    if (row.layout_family_id != null && !layout) {
      throw fail('invalid_replacement', 'That version uses a layout that was deleted');
    }
    await check({ row, layout });
    if (liveRow) await client.query("UPDATE email_templates SET status = 'archived' WHERE id = $1", [liveRow.id]);
    const { rows: [restored] } = await client.query(
      "UPDATE email_templates SET deleted_at = NULL, status = 'live' WHERE id = $1 RETURNING *", [id]);
    return restored;
  });
}

// Puts an archived version of a live layout back live, archiving the current
// one: the layout counterpart of restoreTemplate. A deleted layout stays deleted
// (it was deleted as a whole family, and its templates moved elsewhere), so a
// version of one is not_found here.
async function restoreLayout(pool, id, { expectedLiveId = null } = {}, userId, { check = noCheck } = {}) { // eslint-disable-line no-unused-vars
  return inTransaction(pool, async (client) => {
    const { rows: [peek] } = await client.query('SELECT family_id FROM email_layouts WHERE id = $1', [id]);
    if (!peek) throw fail('not_found', 'That layout version does not exist');
    await lock(client, 'email_layouts', peek.family_id);
    const live = await liveLayout(client, peek.family_id, true);
    if (!live) throw fail('not_found', 'That layout was deleted');
    if (live.id === Number(id)) return live;
    const { rows: [row] } = await client.query('SELECT * FROM email_layouts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!row) throw fail('not_found', 'That layout version does not exist');
    checkExpected(live, expectedLiveId);
    await check({ row, templates: await wearers(client, peek.family_id) });
    await client.query("UPDATE email_layouts SET status = 'archived' WHERE id = $1", [live.id]);
    const { rows: [restored] } = await client.query("UPDATE email_layouts SET status = 'live' WHERE id = $1 RETURNING *", [id]);
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
  // A translation without these is not a translation of the mail, and resolve()
  // would skip it anyway; refusing it here tells the admin why.
  const blank = (kind === 'template' ? TEMPLATE_NEEDS : LAYOUT_NEEDS).filter((name) => !f(name).trim());
  if (blank.length) {
    const err = fail('invalid', 'A translation needs every part of the mail');
    err.errors = blank.map((field) => ({ field, message: `The ${field === 'html' ? 'HTML version' : field === 'text' ? 'text version' : field} cannot be empty.` }));
    throw err;
  }
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
// live layout, with every translation of that live row. The two reads share one
// REPEATABLE READ transaction, so they see the same moment: the sender keeps the
// result for a while, and a layout deleted between two separate reads would
// leave a template pointing at nothing until the next refresh.
async function snapshot(pool) {
  const client = await pool.connect();
  let templates;
  let layouts;
  let rollbackFailed;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // A read stuck behind a lock gives its connection back when the sender stops
    // waiting for it, instead of holding one of the connections sign-in uses.
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(LOAD_LIMIT_MS)]);
    templates = await client.query(`SELECT e.*, (SELECT COALESCE(json_object_agg(t.locale, to_jsonb(t) - 'template_id' - 'locale'), '{}'::json)
                  FROM email_template_translations t WHERE t.template_id = e.id) AS translations
                FROM email_templates e WHERE e.status = 'live' AND e.deleted_at IS NULL`);
    layouts = await client.query(`SELECT e.*, (SELECT COALESCE(json_object_agg(t.locale, to_jsonb(t) - 'layout_id' - 'locale'), '{}'::json)
                  FROM email_layout_translations t WHERE t.layout_id = e.id) AS translations
                FROM email_layouts e WHERE e.status = 'live' AND e.deleted_at IS NULL`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackError) => { rollbackFailed = rollbackError; });
    throw err;
  } finally {
    client.release(rollbackFailed);
  }
  const out = { templates: {}, layouts: {} };
  for (const row of templates.rows) out.templates[row.action] = row;
  for (const row of layouts.rows) out.layouts[row.family_id] = row;
  return out;
}

// ── What a send uses ───────────────────────────────────────────────────

const TEMPLATE_FIELDS = ['subject', 'preheader', 'why', 'html', 'text'];
const LAYOUT_FIELDS = ['html', 'text'];
// A translation without these is not a translation of the mail.
const TEMPLATE_NEEDS = ['subject', 'html', 'text'];
const LAYOUT_NEEDS = ['html', 'text'];

// The row in `language` where it has a usable translation, else the row itself.
function inLanguage(row, language, fields, needs) {
  const translations = row.translations;
  const own = language && translations && typeof translations === 'object' && Object.hasOwn(translations, language)
    ? translations[language] : null;
  if (!own || !needs.every((field) => typeof own[field] === 'string' && own[field].trim())) return row;
  const out = { ...row };
  for (const field of fields) out[field] = typeof own[field] === 'string' ? own[field] : '';
  return out;
}

/** A template or layout row as a send in `language` would use it. */
function inReaderLanguage(row, language, part) {
  return part === 'layout'
    ? inLanguage(row, language, LAYOUT_FIELDS, LAYOUT_NEEDS)
    : inLanguage(row, language, TEMPLATE_FIELDS, TEMPLATE_NEEDS);
}

/**
 * The template and layout a send renders with, each in `language` if that part
 * has a usable translation, else English (the owner's per-part rule). `english`
 * is both parts in English, for when a translation turns out unusable at send
 * time. A null template means there is nothing to send with: no snapshot, no
 * live row for the kind, or a layout that is not in the snapshot. A template
 * whose layout is missing is not sent unframed: it goes the failure path.
 */
function resolve(snap, kind, language) {
  const none = { template: null, layout: null };
  const action = actionFor(kind);
  if (!action || !snap || !snap.templates || !Object.hasOwn(snap.templates, kind)) return none;
  const template = snap.templates[kind];
  const family = template.layout_family_id;
  const layout = family == null ? null : (snap.layouts && Object.hasOwn(snap.layouts, family) ? snap.layouts[family] : undefined);
  if (layout === undefined) return none;
  const reader = action.englishOnly ? null : language;
  const translated = {
    template: inLanguage(template, reader, TEMPLATE_FIELDS, TEMPLATE_NEEDS),
    layout: layout && inLanguage(layout, reader, LAYOUT_FIELDS, LAYOUT_NEEDS),
  };
  return { ...translated, english: { template, layout } };
}

// ── The sender's copy ──────────────────────────────────────────────────
//
// Each server keeps the last snapshot it read, per pool, and serves sends from
// memory. A complete snapshot is good for SNAPSHOT_FRESH_MS; after that the next
// send reads again, waiting for it as long as a first read (READ_PATIENCE_MS),
// so an edit reaches mail within half a minute even on a process that sent
// nothing meanwhile. A refresh that is slow or fails sends the copy in hand. A snapshot that is empty or misses a
// kind is not kept as good: on a fresh database a server that lost the seed lock
// can read before the winner commits, and a preview's rows arrive after its
// import, so the next send asks again. A failed or worse read keeps what was in
// hand: the owner's first rule is that a database problem does not stop mail.

const SNAPSHOT_FRESH_MS = 30 * 1000;
// An empty or incomplete read is asked again after this long, not on every send:
// a kind that stays missing would otherwise cost every mail a read and a log line.
const INCOMPLETE_RETRY_MS = 5 * 1000;
// A read that has not answered in this long no longer counts as in flight, so
// one stuck connection cannot stop every later refresh.
const LOAD_LIMIT_MS = 15 * 1000;

const copies = new WeakMap();

function copyFor(pool) {
  let copy = copies.get(pool);
  if (!copy) {
    copy = { snapshot: null, complete: false, loadedAt: 0, retryAt: 0, loading: null };
    copies.set(pool, copy);
  }
  return copy;
}

const hasRows = (snap) => !!snap && Object.keys(snap.templates).length > 0;

// Every action has its live template, and every layout one of them names is there.
function isComplete(snap) {
  return Object.keys(ACTIONS).every((kind) => Object.hasOwn(snap.templates, kind))
    && Object.values(snap.templates).every((row) => row.layout_family_id == null || Object.hasOwn(snap.layouts, row.layout_family_id));
}

function load(pool, copy, clock) {
  if (copy.loading) return copy.loading;
  let timer;
  const limit = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`no answer in ${LOAD_LIMIT_MS} ms`)), LOAD_LIMIT_MS);
    timer.unref?.();
  });
  const loading = Promise.race([snapshot(pool), limit])
    .then((fresh) => {
      if (isComplete(fresh)) {
        Object.assign(copy, { snapshot: fresh, complete: true, loadedAt: clock.now() });
      } else {
        if (!copy.complete && hasRows(fresh)) copy.snapshot = fresh;
        copy.retryAt = clock.now() + INCOMPLETE_RETRY_MS;
        log.error('platform-mail', 'The email templates read are incomplete: asking again shortly', {
          templates: Object.keys(fresh.templates).length, kinds: Object.keys(ACTIONS).length,
        });
        // A good copy in hand waits its time like a good read before asking again.
        if (copy.complete) copy.loadedAt = clock.now();
      }
    }, (err) => {
      log.error('platform-mail', 'Could not load the email templates: keeping the last copy', { message: err && err.message });
      if (copy.complete) copy.loadedAt = clock.now();
    })
    // Nothing a load does may become an unhandled rejection: a send may not be
    // waiting for it.
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      if (copy.loading === loading) copy.loading = null;
    });
  copy.loading = loading;
  return loading;
}

/**
 * The templates to send with, or null when none can be had. Memory while fresh;
 * a first read or a due refresh races READ_PATIENCE_MS, the patience a mail
 * gives its translation, so a slow database costs this mail the newest wording
 * (the copy in hand) or, with no copy, its templates (the failure path), and
 * never a login. Never rejects. Called at server start so a cold server has a copy.
 */
async function getSnapshot(pool, clock = Date) {
  try {
    if (!pool) return null;
    const copy = copyFor(pool);
    if (copy.complete && clock.now() - copy.loadedAt < SNAPSHOT_FRESH_MS) return copy.snapshot;
    if (!copy.complete && clock.now() < copy.retryAt) return copy.snapshot;
    const { READ_PATIENCE_MS } = require('./language');
    let timer;
    const patience = new Promise((done) => {
      timer = setTimeout(done, READ_PATIENCE_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([load(pool, copy, clock), patience]);
    } finally {
      clearTimeout(timer);
    }
    return copy.snapshot;
  } catch (err) {
    try {
      log.error('platform-mail', 'Could not read the email templates', { message: err && err.message });
    } catch { /* never a rejection, whatever the logger does */ }
    return null;
  }
}

// A process with no database configured at all (a test or a script that sends
// with only a transport) has no store to read or to have lost. It words its mail
// from the first templates in memory, in English, as a fresh database would hold
// them: the send still happens, as it always has without a database. A process
// whose database is configured but unreachable never comes here; it goes the
// owner's failure order.
let seeded;
function seededSnapshot() {
  if (seeded === undefined) {
    try {
      const { SEEDS, englishTemplate } = require('../../db/email-template-seeds');
      const layouts = {};
      const families = new Map(SEEDS.layouts.map((layout, i) => [layout.name, i + 1]));
      SEEDS.layouts.forEach((layout, i) => { layouts[i + 1] = { family_id: i + 1, name: layout.name, html: layout.html, text: layout.text, translations: {} }; });
      const templates = {};
      for (const kind of Object.keys(ACTIONS)) {
        const { name, layout, ...fields } = englishTemplate(kind);
        templates[kind] = { action: kind, name, layout_family_id: layout ? families.get(layout) : null, translations: {}, ...fields };
      }
      seeded = { templates, layouts };
    } catch (err) {
      log.error('platform-mail', 'Could not build the first email templates in memory', { message: err && err.message });
      seeded = null;
    }
  }
  return seeded;
}

/** Resolves once no load is in flight for `pool` (tests). */
async function settled(pool) {
  const copy = copies.get(pool);
  while (copy && copy.loading) await copy.loading;
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

module.exports = {
  snapshot,
  resolve,
  inReaderLanguage,
  getSnapshot,
  seededSnapshot,
  settled,
  SNAPSHOT_FRESH_MS,
  INCOMPLETE_RETRY_MS,
  LOAD_LIMIT_MS,
  saveTemplate, saveLayout, deleteTemplate, deleteLayout, restoreTemplate, restoreLayout, saveTranslation, listAll };
