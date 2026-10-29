// This app's API: events, each a sign-up sheet. An event either has slots
// that people take (volunteer shifts: each slot has a size, and a full slot
// closes) or asks one question everyone answers (who's coming: going, maybe
// or can't, with a short note). server.js mounts it after the sign-in
// check: a write always has req.user ({ id, username }); a read may come
// from a guest with no account (req.guest, no req.user).
//
// "Now" is req.now, never new Date() or SQL's NOW(), so a staging preview
// opened at a chosen moment shows what is coming up at that moment
// ("Time-dependent features" in the platform conventions).
//
// "Hasn't said" counts the project's members (the platform's member list)
// who have not answered, never whoever happened to open the app.
//
// It came from Homeroom's ready-made sign-up sheet. Change it freely.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL || process.env.USERNODE_PLATFORM_API_URL;

// The words this project was made with (words.json beside this file, which
// Homeroom writes when the project is made; the page's {{...}} come from the
// same file). Every project made from this starter runs this same code, and
// only its words.json differs. A missing or unreadable file reads as none.
const WORDS = (() => {
  try {
    const parsed = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'words.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
})();
// How this app answers, set when the project was made: 'slots' (people
// take slots of a given size) or 'rsvp' (everyone says if they are coming).
// A new event is this kind; the screen draws every event by its own kind.
const MODE = WORDS.SHEET_MODE === 'rsvp' ? 'rsvp' : 'slots';
const KINDS = ['slots', 'rsvp'];
const ANSWERS = ['going', 'maybe', 'cant'];

const NAME_MAX = 80;
const PLACE_MAX = 120;
const SLOT_MAX = 80;
const NOTE_MAX = 80;
const SIZE_MAX = 50;
const SLOTS_PER_EVENT = 40;
const UPCOMING_SHOWN = 50;
const PAST_SHOWN = 10;
const HOUR_MS = 60 * 60 * 1000;
// An event stays "coming up" until twelve hours after it starts, so a day
// of shifts is still on the sheet while it runs.
const STILL_ON_MS = 12 * HOUR_MS;

/** One line of text, whitespace tidied, cut to `max`. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}

function isOver(startsAt, now) {
  return startsAt.getTime() < now.getTime() - STILL_ON_MS;
}

const NO_EVENT = 'That event is not on the list any more.';
const NO_SLOT = 'That slot is not on the sheet any more.';
const OVER = 'That event is over.';

// ── Who is in the group ──────────────────────────────────────────────────
//
// The project's members, from the platform ("Members" in the platform
// conventions), for "hasn't said". Asked with the viewer's own token, so
// only a member gets an answer; anyone else (an admin looking in, the
// platform's check runner) sees the answers without that count. Cached for
// a minute per viewer, so the answer one member got is never shown to
// somebody the platform refuses.

const cache = new Map(); // viewer id -> { at, members }
const CACHE_MS = 60 * 1000;

async function members(req) {
  if (!req.user) return { status: 'unavailable', members: null };
  const hit = cache.get(req.user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { status: 'ok', members: hit.members };
  const token = req.query.token || req.headers['x-usernode-token'];
  if (!PLATFORM_API_BASE || !token) return { status: 'unavailable', members: null };
  const headers = { 'x-usernode-user-token': token };
  if (process.env.USERNODE_LLM_PROXY_TOKEN) headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
  try {
    const resp = await fetch(`${PLATFORM_API_BASE}/members?limit=200`, { headers });
    if (resp.status === 403) return { status: 'not_member', members: null };
    if (!resp.ok) return { status: 'unavailable', members: null };
    const body = await resp.json();
    const list = (body.members || []).map((m) => ({ id: m.id, username: m.username }));
    if (!list.length) return { status: 'unavailable', members: null };
    if (cache.size > 500) cache.clear();
    cache.set(req.user.id, { at: Date.now(), members: list });
    return { status: 'ok', members: list };
  } catch (err) {
    console.warn('members lookup failed: ' + err.message);
    return { status: 'unavailable', members: null };
  }
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signup_events (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(8) NOT NULL CHECK (kind IN ('slots', 'rsvp')),
      name VARCHAR(${NAME_MAX}) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      place VARCHAR(${PLACE_MAX}),
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS signup_events_starts_idx ON signup_events (starts_at)');
  // The slots of a 'slots' event: what needs doing, and how many people it takes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signup_slots (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES signup_events(id) ON DELETE CASCADE,
      name VARCHAR(${SLOT_MAX}) NOT NULL,
      size INTEGER NOT NULL CHECK (size BETWEEN 1 AND ${SIZE_MAX}),
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS signup_slots_event_idx ON signup_slots (event_id)');
  // One row per person per slot they took (slot_id set), or per person per
  // 'rsvp' event they answered (answer set).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signup_entries (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES signup_events(id) ON DELETE CASCADE,
      slot_id INTEGER REFERENCES signup_slots(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      answer VARCHAR(8) CHECK (answer IN ('going', 'maybe', 'cant')),
      note VARCHAR(${NOTE_MAX}),
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((slot_id IS NULL) <> (answer IS NULL))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS signup_entries_event_idx ON signup_entries (event_id)');
  // One spot per person per slot, and one answer per person per event.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS signup_entries_slot_person
    ON signup_entries (slot_id, user_id) WHERE slot_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS signup_entries_answer_person
    ON signup_entries (event_id, user_id) WHERE slot_id IS NULL`);

  // A staging preview starts with no rows, so seed one obviously fake event
  // of this app's kind coming up (moved forward whenever it has passed, so
  // the preview always has one) and one that is past, for the checks in
  // dapp.json to find. Fixed ids and ON CONFLICT keep it idempotent across
  // rebuilds; everyone in it is a fake identity. Never runs in production.
  if (IS_STAGING) {
    if (MODE === 'rsvp') {
      await pool.query(`
        INSERT INTO signup_events (id, kind, name, starts_at, place, created_by, created_by_name)
        VALUES (900001, 'rsvp', 'Staging demo game night', date_trunc('day', NOW()) + INTERVAL '5 days 19 hours',
                'Staging demo place', 0, 'staging-demo-user')
        ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at WHERE signup_events.starts_at < NOW()
      `);
      await pool.query(`
        INSERT INTO signup_events (id, kind, name, starts_at, place, created_by, created_by_name)
        VALUES (900002, 'rsvp', 'Staging demo picnic', date_trunc('day', NOW()) - INTERVAL '20 days' + INTERVAL '12 hours',
                'Staging demo park', 0, 'staging-demo-user')
        ON CONFLICT (id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO signup_entries (id, event_id, user_id, username, answer, note)
        VALUES
          (900001, 900001, 0, 'staging-demo-user', 'going', 'Hosting'),
          (900002, 900001, -1, 'staging-demo-ana', 'going', '+1'),
          (900003, 900001, -2, 'staging-demo-ben', 'going', 'Bringing snacks'),
          (900004, 900001, -3, 'staging-demo-cy', 'going', NULL),
          (900005, 900001, -4, 'staging-demo-dev', 'going', 'Late, around 9'),
          (900006, 900001, -5, 'staging-demo-eve', 'maybe', NULL),
          (900007, 900001, -6, 'staging-demo-fay', 'maybe', 'If work ends early'),
          (900008, 900001, -7, 'staging-demo-gus', 'cant', NULL),
          (900009, 900002, -1, 'staging-demo-ana', 'going', NULL),
          (900010, 900002, -2, 'staging-demo-ben', 'cant', NULL)
        ON CONFLICT (id) DO NOTHING
      `);
    } else {
      await pool.query(`
        INSERT INTO signup_events (id, kind, name, starts_at, place, created_by, created_by_name)
        VALUES (900001, 'slots', 'Staging demo park cleanup', date_trunc('day', NOW()) + INTERVAL '9 days 9 hours',
                'Staging demo park', 0, 'staging-demo-user')
        ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at WHERE signup_events.starts_at < NOW()
      `);
      await pool.query(`
        INSERT INTO signup_events (id, kind, name, starts_at, place, created_by, created_by_name)
        VALUES (900002, 'slots', 'Staging demo bake sale', date_trunc('day', NOW()) - INTERVAL '20 days' + INTERVAL '10 hours',
                'Staging demo hall', 0, 'staging-demo-user')
        ON CONFLICT (id) DO NOTHING
      `);
      // Five slots of different sizes, some taken, the last one full.
      await pool.query(`
        INSERT INTO signup_slots (id, event_id, name, size, created_by, created_by_name)
        VALUES
          (900001, 900001, 'Staging demo morning shift, 9 to 11', 6, 0, 'staging-demo-user'),
          (900002, 900001, 'Staging demo midday shift, 11 to 1', 4, 0, 'staging-demo-user'),
          (900003, 900001, 'Staging demo trash bags', 2, 0, 'staging-demo-user'),
          (900004, 900001, 'Staging demo snacks and water', 3, 0, 'staging-demo-user'),
          (900005, 900001, 'Staging demo van driver', 1, 0, 'staging-demo-user'),
          (900006, 900002, 'Staging demo setup crew', 3, 0, 'staging-demo-user')
        ON CONFLICT (id) DO NOTHING
      `);
      await pool.query(`
        INSERT INTO signup_entries (id, event_id, slot_id, user_id, username)
        VALUES
          (900001, 900001, 900001, -1, 'staging-demo-ana'),
          (900002, 900001, 900001, -2, 'staging-demo-ben'),
          (900003, 900001, 900001, -3, 'staging-demo-cy'),
          (900004, 900001, 900002, -4, 'staging-demo-dev'),
          (900005, 900001, 900002, -1, 'staging-demo-ana'),
          (900006, 900001, 900003, -5, 'staging-demo-eve'),
          (900007, 900001, 900005, -2, 'staging-demo-ben'),
          (900008, 900002, 900006, -1, 'staging-demo-ana'),
          (900009, 900002, 900006, -3, 'staging-demo-cy')
        ON CONFLICT (id) DO NOTHING
      `);
    }
  }
}

/** The event `id`, or null. */
async function eventOf(db, id) {
  const { rows } = await db.query('SELECT id, kind, starts_at, created_by FROM signup_events WHERE id = $1', [id]);
  return rows[0] || null;
}

function routes(app, pool) {
  // Events coming up (soonest first) and the last few that have passed,
  // each with its slots and who took them, or its answers and headcount.
  app.get('/api/events', async (req, res) => {
    try {
      const me = req.user ? req.user.id : null;
      const cutoff = new Date(req.now.getTime() - STILL_ON_MS);
      const cols = 'id, kind, name, starts_at, place, created_by, created_by_name';
      const { rows: upcoming } = await pool.query(
        `SELECT ${cols} FROM signup_events WHERE starts_at >= $1 ORDER BY starts_at, id LIMIT $2`,
        [cutoff, UPCOMING_SHOWN]
      );
      const { rows: past } = await pool.query(
        `SELECT ${cols} FROM signup_events WHERE starts_at < $1 ORDER BY starts_at DESC, id DESC LIMIT $2`,
        [cutoff, PAST_SHOWN]
      );
      const ids = upcoming.concat(past).map((e) => e.id);
      const { rows: slots } = ids.length
        ? await pool.query(
          'SELECT id, event_id, name, size, created_by FROM signup_slots WHERE event_id = ANY($1::int[]) ORDER BY id',
          [ids])
        : { rows: [] };
      const { rows: entries } = ids.length
        ? await pool.query(
          `SELECT event_id, slot_id, user_id, username, answer, note FROM signup_entries
            WHERE event_id = ANY($1::int[]) ORDER BY at, id`,
          [ids])
        : { rows: [] };
      // The member list only matters for an upcoming event that asks who's coming.
      const roster = upcoming.some((e) => e.kind === 'rsvp')
        ? await members(req)
        : { status: 'unavailable', members: null };

      const person = (r) => ({ username: r.username, mine: r.user_id === me, note: r.note || null });
      const shape = (e, upcomingOne) => {
        const own = entries.filter((r) => r.event_id === e.id);
        const base = {
          id: e.id,
          kind: e.kind,
          name: e.name,
          startsAt: e.starts_at.toISOString(),
          place: e.place,
          by: e.created_by_name,
          mine: e.created_by === me,
          over: !upcomingOne,
        };
        if (e.kind === 'rsvp') {
          const answers = own.filter((r) => r.slot_id === null);
          const of = (answer) => answers.filter((r) => r.answer === answer).map(person);
          const going = of('going');
          const maybe = of('maybe');
          const cant = of('cant');
          const yours = answers.find((r) => r.user_id === me);
          let unsaid = null;
          if (upcomingOne && roster.members) {
            const said = new Set(answers.map((r) => r.user_id));
            unsaid = roster.members.filter((m) => !said.has(m.id)).length;
          }
          return {
            ...base,
            answer: yours ? { answer: yours.answer, note: yours.note || null } : null,
            going,
            maybe,
            cant,
            counts: { going: going.length, maybe: maybe.length, cant: cant.length, unsaid },
          };
        }
        const these = slots.filter((s) => s.event_id === e.id).map((s) => {
          const people = own.filter((r) => r.slot_id === s.id).map(person);
          const taken = people.length;
          return {
            id: s.id,
            name: s.name,
            size: s.size,
            taken,
            open: Math.max(0, s.size - taken),
            full: taken >= s.size,
            mine: people.some((p) => p.mine),
            people,
          };
        });
        return {
          ...base,
          slots: these,
          spots: these.reduce((n, s) => n + s.size, 0),
          open: these.reduce((n, s) => n + s.open, 0),
          yours: these.filter((s) => s.mine).map((s) => s.name),
        };
      };
      res.json({
        me: req.user ? { id: me, username: req.user.username } : null,
        now: req.now.toISOString(),
        mode: MODE,
        members: roster.status,
        upcoming: upcoming.map((e) => shape(e, true)),
        past: past.map((e) => shape(e, false)),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Make one: a name, when it starts (an ISO time the page builds from the
  // maker's own day and time) and, if they like, where. It is this app's
  // kind unless the body names the other (the screen never does).
  app.post('/api/events', async (req, res) => {
    const body = req.body || {};
    const name = cleanText(body.name, NAME_MAX);
    const place = cleanText(body.place, PLACE_MAX) || null;
    const startsAt = new Date(body.startsAt);
    const kind = body.kind === undefined ? MODE : body.kind;
    if (!name) return res.status(400).json({ error: 'Give the event a name.' });
    if (typeof body.startsAt !== 'string' || Number.isNaN(startsAt.getTime())) {
      return res.status(400).json({ error: 'Pick a day and a time.' });
    }
    if (startsAt.getTime() < req.now.getTime() - HOUR_MS) return res.status(400).json({ error: 'That time has already passed.' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'An event has slots or asks who is coming.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO signup_events (kind, name, starts_at, place, created_by, created_by_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [kind, name, startsAt, place, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id, kind });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever made it can delete it, with every slot and answer on it.
  app.delete('/api/events/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_EVENT });
    try {
      const event = await eventOf(pool, id);
      if (!event) return res.status(404).json({ error: NO_EVENT });
      if (event.created_by !== req.user.id) return res.status(403).json({ error: 'Only the person who made it can delete it.' });
      await pool.query('DELETE FROM signup_events WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Anyone can add a slot: a name and how many people it takes.
  app.post('/api/events/:id/slots', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_EVENT });
    const body = req.body || {};
    const name = cleanText(body.name, SLOT_MAX);
    const size = Number(body.size);
    if (!name) return res.status(400).json({ error: 'Say what the slot is.' });
    if (!Number.isInteger(size) || size < 1 || size > SIZE_MAX) {
      return res.status(400).json({ error: `A slot takes from 1 to ${SIZE_MAX} people.` });
    }
    try {
      const event = await eventOf(pool, id);
      if (!event) return res.status(404).json({ error: NO_EVENT });
      if (event.kind !== 'slots') return res.status(400).json({ error: 'This event asks who is coming; it has no slots.' });
      if (isOver(event.starts_at, req.now)) return res.status(409).json({ error: OVER });
      const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM signup_slots WHERE event_id = $1', [id]);
      if (count[0].n >= SLOTS_PER_EVENT) return res.status(409).json({ error: `A sheet holds ${SLOTS_PER_EVENT} slots at most.` });
      const { rows } = await pool.query(
        `INSERT INTO signup_slots (event_id, name, size, created_by, created_by_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, name, size, req.user.id, req.user.username, req.now]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Whoever made the event can take a slot off it, with whoever took it.
  app.delete('/api/slots/:id', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_SLOT });
    try {
      const { rows } = await pool.query(
        `SELECT e.created_by FROM signup_slots s JOIN signup_events e ON e.id = s.event_id WHERE s.id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: NO_SLOT });
      if (rows[0].created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only the person who made the event can remove a slot.' });
      }
      await pool.query('DELETE FROM signup_slots WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Take a spot on a slot. One spot per person per slot (asking again
  // changes nothing), and a full slot is closed. The slot's row is locked
  // while its spots are counted, so two people tapping the last spot at
  // once cannot both get it.
  app.put('/api/slots/:id/signup', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_SLOT });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT s.id, s.event_id, s.size, e.starts_at FROM signup_slots s
           JOIN signup_events e ON e.id = s.event_id
          WHERE s.id = $1 FOR UPDATE OF s`,
        [id]
      );
      const slot = rows[0];
      let answer = null;
      if (!slot) answer = [404, { error: NO_SLOT }];
      else if (isOver(slot.starts_at, req.now)) answer = [409, { error: OVER }];
      if (!answer) {
        const { rows: on } = await client.query(
          'SELECT 1 FROM signup_entries WHERE slot_id = $1 AND user_id = $2', [id, req.user.id]);
        if (on.length) answer = [200, { on: true }];
      }
      if (!answer) {
        const { rows: count } = await client.query('SELECT COUNT(*)::int AS n FROM signup_entries WHERE slot_id = $1', [id]);
        if (count[0].n >= slot.size) answer = [409, { error: 'That slot is full.' }];
      }
      if (!answer) {
        await client.query(
          `INSERT INTO signup_entries (event_id, slot_id, user_id, username, at) VALUES ($1, $2, $3, $4, $5)`,
          [slot.event_id, id, req.user.id, req.user.username, req.now]
        );
        answer = [201, { on: true }];
      }
      await client.query(answer[0] < 300 ? 'COMMIT' : 'ROLLBACK');
      res.status(answer[0]).json(answer[1]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      if (client) client.release();
    }
  });

  // Leave a slot you took.
  app.delete('/api/slots/:id/signup', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_SLOT });
    try {
      const { rows } = await pool.query(
        'SELECT e.starts_at FROM signup_slots s JOIN signup_events e ON e.id = s.event_id WHERE s.id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: NO_SLOT });
      if (isOver(rows[0].starts_at, req.now)) return res.status(409).json({ error: OVER });
      await pool.query('DELETE FROM signup_entries WHERE slot_id = $1 AND user_id = $2', [id, req.user.id]);
      res.json({ on: false });
    } catch (err) {
      fail(res, err);
    }
  });

  // Going, maybe or can't, changed as often as you like, with a short note
  // ("+1", "bringing snacks"). A body without `note` keeps the note you had.
  app.put('/api/events/:id/answer', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: NO_EVENT });
    const body = req.body || {};
    if (!ANSWERS.includes(body.answer)) return res.status(400).json({ error: 'Say going, maybe or can\'t.' });
    const keepNote = !Object.prototype.hasOwnProperty.call(body, 'note');
    const note = keepNote ? null : (cleanText(body.note, NOTE_MAX) || null);
    try {
      const event = await eventOf(pool, id);
      if (!event) return res.status(404).json({ error: NO_EVENT });
      if (event.kind !== 'rsvp') return res.status(400).json({ error: 'This event has slots to sign up for instead.' });
      if (isOver(event.starts_at, req.now)) return res.status(409).json({ error: OVER });
      const { rows } = await pool.query(
        `INSERT INTO signup_entries (event_id, user_id, username, answer, note, at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, user_id) WHERE slot_id IS NULL DO UPDATE SET
           username = EXCLUDED.username,
           answer = EXCLUDED.answer,
           note = CASE WHEN $7 THEN signup_entries.note ELSE EXCLUDED.note END,
           at = CASE WHEN signup_entries.answer = EXCLUDED.answer THEN signup_entries.at ELSE EXCLUDED.at END
         RETURNING answer, note`,
        [id, req.user.id, req.user.username, body.answer, note, req.now, keepNote]
      );
      res.json({ answer: rows[0].answer, note: rows[0].note || null });
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { migrate, routes };
