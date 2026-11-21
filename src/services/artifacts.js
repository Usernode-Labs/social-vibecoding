'use strict';

// Artifacts (docs/plans/artifacts.md): the ONE store of every page Homeroom
// bot writes with a person. An artifact is a self-contained page (HTML, its
// own styles and scripts), held in a thread of the person's chat with the
// bot, changed in place, one version at a time. A design is one KIND of
// artifact; so is a plain page.
//
// 20 Nov 2026 (live-draft review, K): a thread holds SEVERAL artifacts, up
// to MAX_ARTIFACTS_PER_THREAD, each numbered within its thread in the order
// it was made (its `artifactId`), each with its own versions from 1:
//
//   design_threads            the thread's FIRST artifact (number 1): what it
//                             is (kind), its name, what it is of (surface,
//                             route), the size it is drawn at (viewport,
//                             width, height) and where it lives (place)
//   design_versions           its versions: 1, then each change, whole each time
//   thread_artifacts          each LATER artifact (number 2 and up), with the
//                             same columns
//   thread_artifact_versions  their versions, numbered per artifact
//
// The first stays in the tables it always had (migration 0002) on purpose:
// old and new builds run side by side during a release, and a build from
// before still reads and writes them by those names, so nothing about a
// thread's first artifact may move or change meaning (migration
// thread-artifacts). A build from before sees a thread's first artifact and
// nothing else. A row, message, pin or plan that names no artifact means the
// first.
//
// This module is the store's one writer and its reader by thread. A few list
// queries name design_threads or design_versions themselves, to join a title
// or a newest version into their own rows (private-threads.js, ai-search.js,
// ai-history.js, ai-work.js, homeroom-bot-dm.js, plan-design-source.js). They
// read a thread's FIRST artifact, on purpose: it is where a thread's own
// name, its New project door and an older build's plans come from, and its
// row is there exactly when the thread holds any artifact, since a later one
// is only ever made beside it. They stay written out whole, so the SQL
// check still reads each one (scripts/check-sql.js). Nothing but this module
// names thread_artifacts or thread_artifact_versions. The staging seeds in
// db/migrate.js write fixture rows. Nothing else decides what an artifact is.
//
// Every read is the thread's owner's alone: an artifact is in their private
// chat, and nobody else's request can name one. Nothing here publishes one.
//
// No status: an artifact has versions and nothing else. Where its thread
// stands (open, posted, filed, done) is the thread's own state
// (private-threads.js), said by the thread's own words.

const log = require('./logger');
const { DESIGN_LIMITS, ARTIFACT_LIMITS } = require('./bot-profiles');

// The most one version may be: the column allows 1 MB, and a version is
// drawn whole in a frame and read whole by the model that edits it.
const MAX_HTML_BYTES = 900 * 1024;
const MAX_TITLE = 120;
const MAX_NOTE = 300;
const MAX_ROUTE = 500;
const MAX_VERSIONS = 80;
// 20 Nov 2026 (live-draft review, K): the most artifacts one thread holds.
// A new subject is a new artifact, never written over an old one, so a long
// thread grows several; past this many, a new one is asked for in a new
// thread. Raising it needs no migration (the tables cap nothing).
const MAX_ARTIFACTS_PER_THREAD = 12;
// The number of a thread's first artifact: the one design_threads holds, and
// the one a row, message, pin or plan from before means.
const FIRST = 1;
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
// CAPABILITIES), loaded only while a thread holds one. `limits`: the kind's
// own (stage 3), which a turn grows to while its artifact is open: a
// design's rounds, output room and clock are its drawing's, more than a
// plain page needs.
const KINDS = Object.freeze({
  design: Object.freeze({ kind: 'design', sheets: true, capability: 'design', limits: DESIGN_LIMITS }),
  page: Object.freeze({ kind: 'page', sheets: false, capability: 'artifact', limits: ARTIFACT_LIMITS }),
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

// ── Reading ───────────────────────────────────────────────────────────────

// The thread, and its first artifact with its newest version's number.
const THREAD_SQL = `SELECT p.id, p.root_message_id, p.conversation_id, p.state, p.result_ref, p.kind,
            p.about_kind, p.about_number,
            a.slug, a.name, d.title, d.surface, d.route, d.width, d.height,
            d.kind AS artifact_kind, d.viewport, d.place,
            (SELECT MAX(fv.version) FROM design_versions fv WHERE fv.private_thread_id = p.id) AS first_latest
       FROM private_threads p
       JOIN design_threads d ON d.private_thread_id = p.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`;

// Its later artifacts, in the order they were made.
const LATER_SQL = `SELECT t.id, t.number, t.title, t.surface, t.route, t.width, t.height,
            t.kind AS artifact_kind, t.viewport, t.place,
            (SELECT MAX(tv.version) FROM thread_artifact_versions tv WHERE tv.artifact_id = t.id) AS latest
       FROM thread_artifacts t
      WHERE t.private_thread_id = $1
      ORDER BY t.number`;

/** Pure: an artifact as the thread's list names it: { artifactId, title, artifactKind, latest, viewport }. */
function entryOf(row, number, latest) {
  return {
    artifactId: number,
    title: row.title,
    artifactKind: kindOf(row.artifact_kind).kind,
    latest: Number(latest) || 0,
    viewport: viewportOf(row),
  };
}

/**
 * The artifact one of the person's threads holds, by the thread's first
 * message and the artifact's number in it (`artifactId`; none is the first):
 * { threadId, rootId, conversationId, state, number, kind, about, app,
 * artifactId, artifactKind, place, title, surface, route, viewport, width,
 * height, latest, versions, artifacts } (versions without their HTML), or
 * null when the thread is not theirs, holds none, or holds no such one.
 * `state`, `number`, `kind` and `about` are the thread's own
 * (private-threads.js): the artifact has no state, and what it is (a design,
 * a page) is `artifactKind`. `artifacts` lists every artifact the thread
 * holds, in the order they were made: { artifactId, title, artifactKind,
 * latest, viewport }.
 */
async function artifactFor(pool, { userId, rootId, artifactId = null }) {
  const root = id(rootId);
  if (!root || !id(userId)) return null;
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!want) return null;
  const { rows: [row] } = await pool.query(THREAD_SQL, [root, Number(userId)]);
  if (!row) return null;
  const later = (await pool.query(LATER_SQL, [row.id]))?.rows || [];
  const chosen = want === FIRST ? row : later.find((r) => Number(r.number) === want);
  if (!chosen) return null;
  const { rows: versions } = want === FIRST
    ? await pool.query(
      `SELECT version, author, note, message_id, created_at FROM design_versions
      WHERE private_thread_id = $1 ORDER BY version`,
      [row.id],
    )
    : await pool.query(
      `SELECT version, author, note, message_id, created_at FROM thread_artifact_versions
      WHERE artifact_id = $1 ORDER BY version`,
      [chosen.id],
    );
  const latest = versions.length ? Number(versions[versions.length - 1].version) : 0;
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
    // Which of the thread's artifacts this is: 1 for the first.
    artifactId: want,
    // What the artifact is: a design, or a plain page.
    artifactKind: kindOf(chosen.artifact_kind).kind,
    place: PLACES.includes(chosen.place) ? chosen.place : 'thread',
    title: chosen.title,
    surface: chosen.surface,
    route: chosen.route || null,
    viewport: viewportOf(chosen),
    width: Number(chosen.width),
    height: Number(chosen.height),
    latest,
    versions: versions.map((v) => ({
      version: Number(v.version), author: v.author, note: v.note || null,
      messageId: v.message_id == null ? null : Number(v.message_id), at: v.created_at,
    })),
    artifacts: [
      entryOf(row, FIRST, want === FIRST ? latest : row.first_latest),
      ...later.map((r) => entryOf(r, Number(r.number), Number(r.number) === want ? latest : r.latest)),
    ],
  };
}

/**
 * The number of the artifact in thread `threadId` whose newest version was
 * written last (ties: the later artifact), or null when none has a version.
 * A turn opens it when nothing says which one the person is looking at.
 */
async function newestWritten(pool, { threadId }) {
  if (!id(threadId)) return null;
  const { rows: [row] = [] } = await pool.query(
    `SELECT n FROM (
        SELECT 1 AS n, MAX(created_at) AS at FROM design_versions WHERE private_thread_id = $1
        UNION ALL
        SELECT t.number, MAX(v.created_at) FROM thread_artifacts t
          JOIN thread_artifact_versions v ON v.artifact_id = t.id
         WHERE t.private_thread_id = $1 GROUP BY t.number
      ) w
      WHERE at IS NOT NULL
      ORDER BY at DESC, n DESC
      LIMIT 1`,
    [Number(threadId)],
  );
  return row ? id(row.n) : null;
}

// ── Writing ───────────────────────────────────────────────────────────────

/** The thread's private_threads row, written when it has none: { id, user_id } or null when it is not theirs. */
async function threadRowFor(pool, { user, thread, app = null }) {
  const project = thread.app || app || null;
  const { rows: [row] } = await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
     VALUES ($1, $2, $3, $4, 'idea', 'open')
     ON CONFLICT (root_message_id) DO UPDATE
       SET app_id = COALESCE(private_threads.app_id, EXCLUDED.app_id), updated_at = NOW()
     RETURNING id, user_id`,
    [Number(user.id), Number(thread.conversationId), Number(thread.rootId), project?.id ? Number(project.id) : null],
  );
  return row && Number(row.user_id) === Number(user.id) ? row : null;
}

/**
 * An artifact of a thread, kept as the bot writes a version of it: the
 * thread's private_threads row when it has none (an idea, as a thread with
 * no row is), given `app` when it was in no project, and the artifact's row.
 * `artifactId` names one the thread holds (none: its first, made here when
 * the thread holds nothing yet); it takes the size of its newest page and
 * keeps its kind and title: a design never turns into a page. `fresh`: a NEW
 * artifact instead (addArtifact), the thread's next. Resolves the artifact
 * (artifactFor), or null when the thread is not one the person may write
 * in, holds no such artifact, or (fresh) holds as many as it may.
 */
async function ensureArtifact(pool, {
  user, thread, app = null, kind = 'design', title, viewport = 'phone', surface = 'new', route = null, artifactId = null, fresh = false,
}) {
  if (!user?.id || !thread?.rootId) return null;
  if (fresh) {
    const made = await addArtifact(pool, { user, thread, app, kind, title, viewport, surface, route });
    return made.ok ? made.artifact : null;
  }
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!want) return null;
  const named = clip(title, MAX_TITLE) || 'Screen';
  const drawnAt = VIEWPORTS[viewport] ? viewport : 'phone';
  const { width, height } = VIEWPORTS[drawnAt];
  const row = await threadRowFor(pool, { user, thread, app });
  if (!row) return null;
  if (want === FIRST) {
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
  } else {
    await pool.query(
      `UPDATE thread_artifacts
          SET width = $3, height = $4, viewport = $5, surface = $6, route = COALESCE($7, route)
        WHERE private_thread_id = $1 AND number = $2`,
      [row.id, want, width, height, drawnAt, SURFACES.has(surface) ? surface : 'new', route ? clip(route, MAX_ROUTE) : null],
    );
  }
  return artifactFor(pool, { userId: user.id, rootId: thread.rootId, artifactId: want });
}

/**
 * 20 Nov 2026 (live-draft review, K): a NEW artifact in a thread, the next
 * by number: the thread's first when it holds none (design_threads, as a
 * build from before writes one), else a row of thread_artifacts, numbered
 * under the thread's own row lock so two never take one number. Resolves
 * { ok: true, artifact } (artifactFor, with no version yet), or { ok:
 * false, why } with why 'no_thread' (not theirs), 'full' (the thread holds
 * MAX_ARTIFACTS_PER_THREAD already) or 'unread'.
 */
async function addArtifact(pool, {
  user, thread, app = null, kind = 'page', title, viewport = 'desktop', surface = 'new', route = null,
}) {
  if (!user?.id || !thread?.rootId) return { ok: false, why: 'no_thread' };
  const row = await threadRowFor(pool, { user, thread, app });
  if (!row) return { ok: false, why: 'no_thread' };
  const named = clip(title, MAX_TITLE) || (kindOf(kind).kind === 'page' ? 'Page' : 'Screen');
  const drawnAt = VIEWPORTS[viewport] ? viewport : 'phone';
  const { width, height } = VIEWPORTS[drawnAt];
  const where = SURFACES.has(surface) ? surface : 'new';
  const path = route ? clip(route, MAX_ROUTE) : null;
  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const db = client || pool;
  let number = FIRST;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE', [Number(row.id)]);
    // The first is design_threads' row. One a build from before wrote a
    // moment ago (it takes no lock) stands, and this one is the next.
    const { rows: first = [] } = await db.query(
      `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height, kind, viewport)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (private_thread_id) DO NOTHING
       RETURNING private_thread_id`,
      [Number(row.id), named, where, path, width, height, kindOf(kind).kind, drawnAt],
    );
    if (!first.length) {
      const { rows: [last] } = await db.query(
        'SELECT COALESCE(MAX(number), 1) AS n FROM thread_artifacts WHERE private_thread_id = $1', [Number(row.id)]);
      number = Number(last?.n || 1) + 1;
      if (number > MAX_ARTIFACTS_PER_THREAD) {
        await db.query('ROLLBACK');
        return { ok: false, why: 'full' };
      }
      await db.query(
        `INSERT INTO thread_artifacts (private_thread_id, number, kind, title, surface, route, width, height, viewport)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [Number(row.id), number, kindOf(kind).kind, named, where, path, width, height, drawnAt],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
  const artifact = await artifactFor(pool, { userId: user.id, rootId: thread.rootId, artifactId: number });
  return artifact ? { ok: true, artifact } : { ok: false, why: 'unread' };
}

/**
 * The artifact row of a thread whose private_threads row is already written
 * (a captured screen opens its thread first: design-threads.js startDesign),
 * at an exact size: its first. Written once: a thread that holds one keeps it.
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

/** One version's HTML, for the thread's owner: { version, html, artifact } or null. `artifactId`: none is the first. */
async function versionOf(pool, { userId, rootId, artifactId = null, version = null }) {
  const artifact = await artifactFor(pool, { userId, rootId, artifactId });
  if (!artifact || !artifact.latest) return null;
  const want = version == null ? artifact.latest : id(version);
  if (!want) return null;
  const { rows: [row] } = artifact.artifactId === FIRST
    ? await pool.query(
      'SELECT version, html FROM design_versions WHERE private_thread_id = $1 AND version = $2',
      [artifact.threadId, want],
    )
    : await pool.query(
      `SELECT v.version, v.html FROM thread_artifact_versions v
         JOIN thread_artifacts t ON t.id = v.artifact_id
        WHERE t.private_thread_id = $1 AND t.number = $2 AND v.version = $3`,
      [artifact.threadId, artifact.artifactId, want],
    );
  // `design`: the name this had while only designs were stored; its readers keep it.
  return row ? { version: Number(row.version), html: row.html, artifact, design: artifact } : null;
}

/**
 * The next version of an artifact (`artifactId` in thread `threadId`; none
 * is the first), written once: { version } or null when the HTML is not one
 * a version may hold, the thread holds no such artifact, or the artifact has
 * reached MAX_VERSIONS. Numbered under the thread's own row lock, so two
 * edits never take one number: the lock a build from before takes for the
 * first artifact too.
 */
async function addVersion(pool, { threadId, artifactId = null, html, author = 'bot', note = null, messageId = null }) {
  const body = validHtml(html);
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!body || !id(threadId) || !want || !['capture', 'bot'].includes(author)) return null;
  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const db = client || pool;
  const said = note ? clipWords(note, MAX_NOTE) : null;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM private_threads WHERE id = $1 FOR UPDATE', [Number(threadId)]);
    let version;
    if (want === FIRST) {
      const { rows: [last] } = await db.query(
        'SELECT COALESCE(MAX(version), 0) AS n FROM design_versions WHERE private_thread_id = $1', [Number(threadId)]);
      version = Number(last.n) + 1;
      if (version > MAX_VERSIONS) {
        await db.query('ROLLBACK');
        return null;
      }
      await db.query(
        `INSERT INTO design_versions (private_thread_id, version, html, author, note, message_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [Number(threadId), version, body, author, said, id(messageId)],
      );
    } else {
      const { rows: [held] = [] } = await db.query(
        'SELECT id FROM thread_artifacts WHERE private_thread_id = $1 AND number = $2', [Number(threadId), want]);
      if (!held) {
        await db.query('ROLLBACK');
        return null;
      }
      const { rows: [last] } = await db.query(
        'SELECT COALESCE(MAX(version), 0) AS n FROM thread_artifact_versions WHERE artifact_id = $1', [held.id]);
      version = Number(last.n) + 1;
      if (version > MAX_VERSIONS) {
        await db.query('ROLLBACK');
        return null;
      }
      await db.query(
        `INSERT INTO thread_artifact_versions (artifact_id, version, html, author, note, message_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [held.id, version, body, author, said, id(messageId)],
      );
    }
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
async function noteVersionMessage(pool, { threadId, artifactId = null, version, messageId }) {
  if (!id(messageId)) return;
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!want) return;
  try {
    if (want === FIRST) {
      await pool.query(
        'UPDATE design_versions SET message_id = $3 WHERE private_thread_id = $1 AND version = $2 AND message_id IS NULL',
        [Number(threadId), Number(version), Number(messageId)],
      );
    } else {
      await pool.query(
        `UPDATE thread_artifact_versions v SET message_id = $4
           FROM thread_artifacts t
          WHERE t.id = v.artifact_id AND t.private_thread_id = $1 AND t.number = $2 AND v.version = $3
            AND v.message_id IS NULL`,
        [Number(threadId), want, Number(version), Number(messageId)],
      );
    }
  } catch (err) {
    log.warn('artifacts', 'Could not note a version\'s message', { err: err.message });
  }
}

/**
 * A design made into a project's first screen is a screen of that project
 * now (homeroom-bot-dm.js recordDesignFirstVersion): its surface, in the
 * create's own transaction `db`.
 */
async function markSurface(db, { threadId, artifactId = null, surface }) {
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!id(threadId) || !want || !SURFACES.has(surface)) return;
  if (want === FIRST) {
    await db.query('UPDATE design_threads SET surface = $2 WHERE private_thread_id = $1 AND surface <> $2',
      [Number(threadId), surface]);
  } else {
    await db.query('UPDATE thread_artifacts SET surface = $3 WHERE private_thread_id = $1 AND number = $2 AND surface <> $3',
      [Number(threadId), want, surface]);
  }
}

// ── A design's added pictures (bot-pictures.js addToDesign) ───────────────

const PICTURE_ID_RE = /^[0-9a-f]{32}$/;

/** The pictures an artifact was given (a gallery's Add to the design), oldest first. */
async function picturesOf(pool, { threadId, artifactId = null }) {
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!id(threadId) || !want) return [];
  const { rows: [row] = [] } = want === FIRST
    ? await pool.query('SELECT pictures FROM design_threads WHERE private_thread_id = $1', [Number(threadId)])
    : await pool.query('SELECT pictures FROM thread_artifacts WHERE private_thread_id = $1 AND number = $2',
      [Number(threadId), want]);
  return Array.isArray(row?.pictures) ? row.pictures.filter((p) => p && PICTURE_ID_RE.test(String(p.id || ''))) : [];
}

/**
 * A picture put on an artifact's list, once (the oldest goes when it holds
 * `max`): the list as kept, or null when the thread holds no such artifact.
 */
async function addPicture(pool, { threadId, artifactId = null, entry, max }) {
  const want = artifactId == null ? FIRST : id(artifactId);
  if (!id(threadId) || !want || !entry || !PICTURE_ID_RE.test(String(entry.id || ''))) return null;
  // Both statements written out whole, so the SQL check reads each one.
  const { rows: [kept] = [] } = want === FIRST
    ? await pool.query(
      `UPDATE design_threads
          SET pictures = CASE WHEN pictures @> jsonb_build_array(jsonb_build_object('id', $2::text)) THEN pictures
                              ELSE (CASE WHEN jsonb_array_length(pictures) >= $4 THEN pictures - 0 ELSE pictures END) || jsonb_build_array($3::jsonb)
                         END
        WHERE private_thread_id = $1
        RETURNING pictures`,
      [Number(threadId), entry.id, JSON.stringify(entry), Number(max)],
    )
    : await pool.query(
      `UPDATE thread_artifacts
          SET pictures = CASE WHEN pictures @> jsonb_build_array(jsonb_build_object('id', $2::text)) THEN pictures
                              ELSE (CASE WHEN jsonb_array_length(pictures) >= $4 THEN pictures - 0 ELSE pictures END) || jsonb_build_array($3::jsonb)
                         END
        WHERE private_thread_id = $1 AND number = $5
        RETURNING pictures`,
      [Number(threadId), entry.id, JSON.stringify(entry), Number(max), want],
    );
  return kept ? kept.pictures : null;
}

/**
 * Pure-ish: a pinned comment's point as it rides on the person's message
 * (metadata.designPin, the name it had while only designs took pins),
 * checked against the artifact of their thread `threadRootId` it was pinned
 * on (`pin.artifactId`; none is the first), whatever its kind: { artifactId?,
 * version, x, y, element? } or null when anything about it is wrong.
 * `artifactId` is kept when the client named one.
 */
async function pinFor(pool, { user, conversationId, threadRootId, pin }) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  const named = pin.artifactId == null ? null : id(pin.artifactId);
  if (pin.artifactId != null && !named) return null;
  const artifact = await artifactFor(pool, { userId: user?.id, rootId: threadRootId, artifactId: named });
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
    ...(named ? { artifactId: named } : {}),
    version, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000,
    ...(element && (element.tag || element.text) ? { element } : {}),
  };
}

module.exports = {
  MAX_HTML_BYTES,
  MAX_VERSIONS,
  MAX_ARTIFACTS_PER_THREAD,
  FIRST,
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
  newestWritten,
  ensureArtifact,
  addArtifact,
  createFor,
  versionOf,
  addVersion,
  noteVersionMessage,
  markSurface,
  picturesOf,
  addPicture,
  pinFor,
};
