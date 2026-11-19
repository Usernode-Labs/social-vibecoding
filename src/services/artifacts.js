'use strict';

// Artifacts (docs/plans/artifacts.md): the ONE store of every page Homeroom
// bot writes with a person. An artifact is a self-contained page (HTML, its
// own styles and scripts), held in a thread of the person's chat with the
// bot, changed in place, one version at a time. A design is one KIND of
// artifact; so is a plain page.
//
//   design_threads    the artifact: what it is (kind), its name, what it is
//                     of (surface, route), the size it is drawn at
//                     (viewport, width, height) and where it lives (place)
//   design_versions   its versions: 1, then each change, whole each time
//
// The tables keep the names they had when only designs were stored
// (migration 0002): old and new builds run side by side during a release,
// and a build from before this still reads and writes them by those names.
// `kind` says what a row is; every row from before is a design.
//
// This module is the store's one writer and its reader by thread. A few
// list queries name the tables themselves, to join a title or a newest
// version into their own rows (private-threads.js, ai-search.js,
// ai-history.js, ai-work.js, homeroom-bot-dm.js), and bot-pictures.js keeps
// a design's added pictures in a column of its own; the staging seeds in
// db/migrate.js write fixture rows. Nothing else decides what an artifact is.
//
// Every read is the thread's owner's alone: an artifact is in their private
// chat, and nobody else's request can name one. Nothing here publishes one.
//
// No status: an artifact has versions and nothing else. Where its thread
// stands (open, posted, filed, done) is the thread's own state
// (private-threads.js), said by the thread's own words.

const log = require('./logger');

// The most one version may be: the column allows 1 MB, and a version is
// drawn whole in a frame and read whole by the model that edits it.
const MAX_HTML_BYTES = 900 * 1024;
const MAX_TITLE = 120;
const MAX_NOTE = 300;
const MAX_ROUTE = 500;
const MAX_VERSIONS = 80;
const SIZE = Object.freeze({ min: 200, max: 4000 });
// What an artifact is of: Homeroom's own pages, a project's app, or nothing
// that exists yet (a project not made, or a page of its own).
const SURFACES = new Set(['platform', 'app', 'new']);
// The two sizes a page is drawn at, as a plan's screens are (spec-html.js).
const VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});
// A pinned comment's point, as fractions of the version's drawn size, and
// the element under it in a few words (comment-pin's describeElement).
const MAX_PIN_TEXT = 80;

// The kinds. `sheets`: Homeroom writes the project's own stylesheets into
// each version (design-bot.js), so the page is drawn with this site's and
// its frame's policy names this site (frontend/src/features/artifact/
// policy.ts); a kind without them loads nothing at all. `capability`: the
// capability of a private thread's turn that works on it (bot-profiles.js
// CAPABILITIES), loaded only while a thread holds one.
const KINDS = Object.freeze({
  design: Object.freeze({ kind: 'design', sheets: true, capability: 'design' }),
  page: Object.freeze({ kind: 'page', sheets: false, capability: 'artifact' }),
});
// Where an artifact lives: its author's private thread with the bot. The
// only place there is (nothing publishes one to a project).
const PLACES = Object.freeze(['thread']);

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function id(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pure: a size in pixels a page may be drawn at, or null. */
function size(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(SIZE.max, Math.max(SIZE.min, n)) : null;
}

/** Pure: a kind's definition; an unknown one is a design, as every row from before is. */
function kindOf(kind) {
  return KINDS[kind] || KINDS.design;
}

/** Pure: the viewport a row is drawn at: the one stored, else by its width. */
function viewportOf(row) {
  if (row?.viewport && VIEWPORTS[row.viewport]) return row.viewport;
  return Number(row?.width) < 768 ? 'phone' : 'desktop';
}

/** Pure: the HTML a version may hold, or null when it is empty or too big. */
function validHtml(html) {
  const text = typeof html === 'string' ? html : '';
  if (!text.trim()) return null;
  return Buffer.byteLength(text, 'utf8') <= MAX_HTML_BYTES ? text : null;
}

/**
 * Pure: `text` cut to at most `max` characters at a word's end, with "…"
 * where it was cut: never mid-word. A first word longer than that is cut at
 * `max`, the one place a word can be.
 */
function clipWords(text, max) {
  const said = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (said.length <= max) return said;
  const room = said.slice(0, max);
  const at = room.lastIndexOf(' ');
  const kept = (at > 0 ? room.slice(0, at) : room.slice(0, max - 1)).replace(/[\s,;:.\-–]+$/, '');
  return `${kept}…`;
}

/**
 * The artifact one of the person's threads holds, by the thread's first
 * message: { threadId, rootId, conversationId, state, number, kind, about,
 * app, artifactKind, place, title, surface, route, viewport, width, height,
 * latest, versions } (versions without their HTML), or null when the thread
 * is not theirs or holds none. `state`, `number`, `kind` and `about` are the
 * thread's own (private-threads.js): the artifact has no state, and what it
 * is (a design, a page) is `artifactKind`.
 */
async function artifactFor(pool, { userId, rootId }) {
  const root = id(rootId);
  if (!root || !id(userId)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT p.id, p.root_message_id, p.conversation_id, p.state, p.result_ref, p.kind,
            p.about_kind, p.about_number,
            a.slug, a.name, d.title, d.surface, d.route, d.width, d.height,
            d.kind AS artifact_kind, d.viewport, d.place
       FROM private_threads p
       JOIN design_threads d ON d.private_thread_id = p.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`,
    [root, Number(userId)],
  );
  if (!row) return null;
  const { rows: versions } = await pool.query(
    `SELECT version, author, note, message_id, created_at FROM design_versions
      WHERE private_thread_id = $1 ORDER BY version`,
    [row.id],
  );
  return {
    threadId: Number(row.id),
    rootId: Number(row.root_message_id),
    conversationId: Number(row.conversation_id),
    state: row.state,
    number: row.result_ref == null ? null : Number(row.result_ref),
    // The thread's kind (private_threads.kind), under the name it always had here.
    kind: row.kind,
    about: row.about_kind && row.about_number ? { kind: row.about_kind, number: Number(row.about_number) } : null,
    app: row.slug ? { slug: row.slug, name: row.name || row.slug } : null,
    // What the artifact is: a design, or a plain page.
    artifactKind: kindOf(row.artifact_kind).kind,
    place: PLACES.includes(row.place) ? row.place : 'thread',
    title: row.title,
    surface: row.surface,
    route: row.route || null,
    viewport: viewportOf(row),
    width: Number(row.width),
    height: Number(row.height),
    latest: versions.length ? Number(versions[versions.length - 1].version) : 0,
    versions: versions.map((v) => ({
      version: Number(v.version), author: v.author, note: v.note || null,
      messageId: v.message_id == null ? null : Number(v.message_id), at: v.created_at,
    })),
  };
}

/**
 * The artifact a thread holds, made the first time the bot writes one in
 * it: the thread's private_threads row when it has none (an idea, as a
 * thread with no row is), given `app` when it was in no project, and its
 * artifact row (`kind`, `title`, what it is of, the size drawn at). One it
 * holds already takes the size of its newest page and keeps its kind: a
 * thread holds one artifact, and a design never turns into a page. Resolves
 * the artifact (artifactFor), or null when the thread is not one the person
 * may write in.
 */
async function ensureArtifact(pool, {
  user, thread, app = null, kind = 'design', title, viewport = 'phone', surface = 'new', route = null,
}) {
  if (!user?.id || !thread?.rootId) return null;
  const named = clip(title, MAX_TITLE) || 'Screen';
  const drawnAt = VIEWPORTS[viewport] ? viewport : 'phone';
  const { width, height } = VIEWPORTS[drawnAt];
  const project = thread.app || app || null;
  const { rows: [row] } = await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'idea', 'open')
     ON CONFLICT (root_message_id) DO UPDATE
       SET app_id = COALESCE(private_threads.app_id, EXCLUDED.app_id), updated_at = NOW()
     RETURNING id, user_id`,
    [Number(user.id), Number(thread.conversationId), Number(thread.rootId), project?.id ? Number(project.id) : null],
  );
  if (!row || Number(row.user_id) !== Number(user.id)) return null;
  await pool.query(
    `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height, kind, viewport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (private_thread_id) DO UPDATE
       SET width = EXCLUDED.width, height = EXCLUDED.height,
           viewport = EXCLUDED.viewport,
           surface = EXCLUDED.surface,
           route = COALESCE(EXCLUDED.route, design_threads.route)`,
    [row.id, named, SURFACES.has(surface) ? surface : 'new', route ? clip(route, MAX_ROUTE) : null, width, height,
      kindOf(kind).kind, drawnAt],
  );
  return artifactFor(pool, { userId: user.id, rootId: thread.rootId });
}

/**
 * The artifact row of a thread whose private_threads row is already written
 * (a captured screen opens its thread first: design-threads.js startDesign),
 * at an exact size. Written once: a thread that holds one keeps it.
 */
async function createFor(pool, { threadId, kind = 'design', title, surface, route = null, width, height }) {
  const w = size(width);
  const h = size(height);
  if (!id(threadId) || !w || !h) return false;
  await pool.query(
    `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height, kind, viewport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (private_thread_id) DO NOTHING`,
    [Number(threadId), clip(title, MAX_TITLE) || 'Screen', SURFACES.has(surface) ? surface : 'new',
      route ? clip(route, MAX_ROUTE) : null, w, h, kindOf(kind).kind, w < 768 ? 'phone' : 'desktop'],
  );
  return true;
}

/** One version's HTML, for the thread's owner: { version, html, artifact } or null. */
async function versionOf(pool, { userId, rootId, version = null }) {
  const artifact = await artifactFor(pool, { userId, rootId });
  if (!artifact || !artifact.latest) return null;
  const want = version == null ? artifact.latest : id(version);
  if (!want) return null;
  const { rows: [row] } = await pool.query(
    'SELECT version, html FROM design_versions WHERE private_thread_id = $1 AND version = $2',
    [artifact.threadId, want],
  );
  // `design`: the name this had while only designs were stored; its readers keep it.
  return row ? { version: Number(row.version), html: row.html, artifact, design: artifact } : null;
}

/**
 * The next version of an artifact, written once: { version } or null when
 * the HTML is not one a version may hold, or the artifact has reached
 * MAX_VERSIONS. Numbered under the thread's own row lock, so two edits never
 * take one number.
 */
async function addVersion(pool, { threadId, html, author = 'bot', note = null, messageId = null }) {
  const body = validHtml(html);
  if (!body || !id(threadId) || !['capture', 'bot'].includes(author)) return null;
  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const db = client || pool;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE', [Number(threadId)]);
    const { rows: [last] } = await db.query(
      'SELECT COALESCE(MAX(version), 0) AS n FROM design_versions WHERE private_thread_id = $1', [Number(threadId)]);
    const version = Number(last.n) + 1;
    if (version > MAX_VERSIONS) {
      await db.query('ROLLBACK');
      return null;
    }
    await db.query(
      `INSERT INTO design_versions (private_thread_id, version, html, author, note, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [Number(threadId), version, body, author, note ? clipWords(note, MAX_NOTE) : null, id(messageId)],
    );
    await db.query('UPDATE private_threads SET updated_at = NOW() WHERE id = $1', [Number(threadId)]);
    await db.query('COMMIT');
    return { version };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

/** The message that says a version, once it is sent: its id on the version's row. */
async function noteVersionMessage(pool, { threadId, version, messageId }) {
  if (!id(messageId)) return;
  await pool.query(
    'UPDATE design_versions SET message_id = $3 WHERE private_thread_id = $1 AND version = $2 AND message_id IS NULL',
    [Number(threadId), Number(version), Number(messageId)],
  ).catch((err) => log.warn('artifacts', 'Could not note a version\'s message', { err: err.message }));
}

/**
 * Pure-ish: a pinned comment's point as it rides on the person's message
 * (metadata.designPin, the name it had while only designs took pins),
 * checked against the artifact their thread `threadRootId` holds, whatever
 * its kind: { version, x, y, element? } or null when anything about it is
 * wrong.
 */
async function pinFor(pool, { user, conversationId, threadRootId, pin }) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  const artifact = await artifactFor(pool, { userId: user?.id, rootId: threadRootId });
  if (!artifact || artifact.conversationId !== Number(conversationId)) return null;
  const version = id(pin.version);
  const x = Number(pin.x);
  const y = Number(pin.y);
  if (!version || version > artifact.latest || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
  const el = pin.element && typeof pin.element === 'object' ? pin.element : null;
  const element = el ? {
    tag: /^[a-z][a-z0-9-]{0,30}$/.test(String(el.tag || '')) ? String(el.tag) : '',
    id: clip(el.id, 60),
    text: clip(el.text, MAX_PIN_TEXT),
  } : null;
  return {
    version, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000,
    ...(element && (element.tag || element.text) ? { element } : {}),
  };
}

module.exports = {
  MAX_HTML_BYTES,
  MAX_VERSIONS,
  MAX_TITLE,
  MAX_NOTE,
  MAX_ROUTE,
  VIEWPORTS,
  KINDS,
  PLACES,
  SURFACES,
  kindOf,
  viewportOf,
  size,
  validHtml,
  clipWords,
  artifactFor,
  ensureArtifact,
  createFor,
  versionOf,
  addVersion,
  noteVersionMessage,
  pinFor,
};
