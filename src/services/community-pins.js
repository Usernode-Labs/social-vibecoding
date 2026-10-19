'use strict';

// The communities a person pinned to the desktop sidebar (schema.sql,
// "Pinned communities"; frontend/src/features/nav/rail-pinned.tsx draws
// them): read them, pin one, unpin one, and take in the pins a device kept
// before pins were the account's.
//
// A pin is a member's: the table's key is the membership row's, so leaving
// a community drops its pin, and pinning one you are not in is answered
// `join_required`, which the client's fetch wrapper turns into a Join prompt
// and a retry (frontend/src/lib/join-required.ts). Four at most, in the order
// they were pinned. Each change runs under a lock on the person's own row,
// so two tabs pinning at once cannot pass the cap between them.

const appAccess = require('./app-access');

/** The most pins the sidebar keeps. The client's pin store says the same. */
const PINS_MAX = 4;

const fail = (status, body) => { throw Object.assign(new Error(body.error), { status, body }); };

// Each pin as the sidebar draws it before anything else has loaded: the
// slug, name and face of the community's project (one to one today), in
// pin order. A project the person has blocked for themselves is left out.
async function list(db, userId) {
  const { rows } = await db.query(
    `SELECT slug, name, icon_image_id, icon_emoji FROM (
       SELECT DISTINCT ON (p.community_id) p.position, p.pinned_at,
              a.slug, a.name, a.icon_image_id, a.icon_emoji
         FROM community_pins p
         JOIN apps a ON a.community_id = p.community_id
        WHERE p.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = p.user_id AND b.app_id = a.id)
        ORDER BY p.community_id, a.id
     ) pins
     ORDER BY position, pinned_at`,
    [userId]
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name || r.slug,
    iconUrl: r.icon_image_id ? `/app-icons/${r.icon_image_id}` : null,
    iconEmoji: r.icon_emoji || null,
  }));
}

// The project `slug` names, if the person may see it, with its community.
async function findApp(db, user, slug) {
  const { rows } = await db.query(
    `SELECT ${appAccess.ACCESS_COLUMNS}, name, community_id FROM apps WHERE slug = $1`,
    [slug]
  );
  const app = rows[0];
  if (!app || !app.community_id || !(await appAccess.checkAppAccess(db, app, user, 'view'))) return null;
  return app;
}

// Pin one more, at the end, unless it is pinned already. Throws { status,
// body } for a refusal: 404 unseen, 403 join_required, 409 pins_full.
async function addPin(db, user, slug) {
  const app = await findApp(db, user, slug);
  if (!app) fail(404, { error: 'Community not found' });
  const member = await db.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2',
    [app.community_id, user.id]
  );
  if (!member.rowCount) {
    const name = app.name || app.slug;
    fail(403, { error: `Join ${name} to pin it.`, code: 'join_required', app: { slug: app.slug, name } });
  }
  const { rows } = await db.query('SELECT community_id, position FROM community_pins WHERE user_id = $1', [user.id]);
  if (rows.some((r) => r.community_id === app.community_id)) return;
  if (rows.length >= PINS_MAX) fail(409, { error: 'Unpin one first: four is the most.', code: 'pins_full' });
  const next = rows.reduce((n, r) => Math.max(n, r.position + 1), 0);
  await db.query(
    `INSERT INTO community_pins (community_id, user_id, position) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, community_id) DO NOTHING`,
    [app.community_id, user.id, next]
  );
}

// One person's change at a time, then the list as it now stands.
async function locked(pool, user, change) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    await change(db);
    const pins = await list(db, user.id);
    await db.query('COMMIT');
    return pins;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Pin the community of the project `slug`. Returns the pins. */
function pin(pool, user, slug) {
  return locked(pool, user, (db) => addPin(db, user, slug));
}

/** Unpin it. Always allowed, whatever has become of the project since. Returns the pins. */
function unpin(pool, user, slug) {
  return locked(pool, user, (db) => db.query(
    `DELETE FROM community_pins p USING apps a
      WHERE p.user_id = $1 AND a.slug = $2 AND p.community_id = a.community_id`,
    [user.id, slug]
  ));
}

/**
 * Take in the pins a device kept before they were the account's, in its
 * order, after any the account has: the ones it may pin, while there is
 * room. A community it is not in, or cannot see, is skipped without a word,
 * because nobody asked for anything just now. Returns the pins.
 */
function importPins(pool, user, slugs) {
  const wanted = (Array.isArray(slugs) ? slugs : [])
    .filter((s) => typeof s === 'string' && s)
    .slice(0, PINS_MAX);
  return locked(pool, user, async (db) => {
    for (const slug of wanted) {
      try {
        await addPin(db, user, slug);
      } catch (err) {
        if (!err.status) throw err;
      }
    }
  });
}

module.exports = { PINS_MAX, list, pin, unpin, importPins };
