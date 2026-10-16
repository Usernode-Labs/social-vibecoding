'use strict';

// The challenge page's "Your invites" list against a real PostgreSQL
// (services/topochain/invite-statuses.js, #3650).
//
// The reader reuses the scorer's own rule row and first-invite union, so the
// tables it touches are the scorer's: challenge_scoring_rules and the
// season tables, the two invite tables, app_collaborators, the ledger. They
// are created here as the minimal shape those statements read — the point
// being the STATUS each seeded row produces, not the schema around it.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `invite_status_test_${process.pid}`;

const { inviteStatuses } = require('../src/services/topochain/invite-statuses');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT, display_name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      username_provisional_since TIMESTAMPTZ,
      is_synthetic BOOLEAN NOT NULL DEFAULT FALSE);
    CREATE TABLE communities (id SERIAL PRIMARY KEY);
    CREATE TABLE community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (community_id, user_id));
    CREATE TABLE apps (
      id SERIAL PRIMARY KEY, community_id INTEGER REFERENCES communities(id),
      self_hosted BOOLEAN NOT NULL DEFAULT FALSE,
      collab_visibility TEXT NOT NULL DEFAULT 'public');
    CREATE TABLE app_collaborators (
      app_id INTEGER NOT NULL REFERENCES apps(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'member',
      invited_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE seasons (
      id BIGSERIAL PRIMARY KEY, starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      internal BOOLEAN NOT NULL DEFAULT FALSE);
    CREATE TABLE season_events (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE, internal BOOLEAN NOT NULL DEFAULT FALSE,
      season_id BIGINT REFERENCES seasons(id));
    CREATE TABLE challenge_templates (
      id BIGSERIAL PRIMARY KEY, category VARCHAR(50) NOT NULL,
      goal VARCHAR(255) NOT NULL, reward VARCHAR(255) NOT NULL,
      schedule_start TIMESTAMPTZ, schedule_end TIMESTAMPTZ,
      metric_target NUMERIC(20,4));
    CREATE TABLE challenges (
      id BIGSERIAL PRIMARY KEY,
      season_event_id BIGINT NOT NULL REFERENCES season_events(id),
      challenge_template_id BIGINT NOT NULL REFERENCES challenge_templates(id),
      schedule_start TIMESTAMPTZ, schedule_end TIMESTAMPTZ,
      metric_target NUMERIC(20,4), reward NUMERIC(20,4),
      enabled BOOLEAN NOT NULL DEFAULT TRUE, completed BOOLEAN NOT NULL DEFAULT FALSE,
      display_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE challenge_scoring_rules (
      id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
      measure VARCHAR(40) NOT NULL,
      challenge_template_id BIGINT, challenge_id BIGINT,
      target NUMERIC(20,4), points NUMERIC(10,2),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      interval_minutes INTEGER, last_scored_at TIMESTAMPTZ,
      CONSTRAINT one_binding CHECK (
        (challenge_template_id IS NOT NULL AND challenge_id IS NULL)
        OR (challenge_template_id IS NULL AND challenge_id IS NOT NULL)));
    CREATE TABLE user_activities (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      season_event_id BIGINT NOT NULL,
      activity_type VARCHAR(100) NOT NULL,
      points NUMERIC(10,2) NOT NULL DEFAULT 0,
      metadata JSONB, activity_at TIMESTAMPTZ NOT NULL,
      challenge_id BIGINT NOT NULL);
    CREATE UNIQUE INDEX user_activities_source_key_unique
      ON user_activities (challenge_id, user_id, (metadata->>'source_key'))
      WHERE metadata->>'source_key' IS NOT NULL;
    CREATE TABLE community_invites (
      id SERIAL PRIMARY KEY, token VARCHAR(32) NOT NULL UNIQUE,
      community_id INTEGER NOT NULL REFERENCES communities(id),
      app_id INTEGER NOT NULL REFERENCES apps(id),
      created_by INTEGER REFERENCES users(id),
      expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE community_invite_redemptions (
      id SERIAL PRIMARY KEY,
      invite_id INTEGER NOT NULL REFERENCES community_invites(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_at TIMESTAMPTZ,
      UNIQUE (invite_id, user_id));

    -- The maker-standing function, lifted from schema.sql and run as it
    -- ships: a queued person's Waiting vs Won't join is read off it.
    CREATE OR REPLACE FUNCTION community_invite_maker_holds(p_invite INTEGER) RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1
          FROM community_invites i
          JOIN apps a ON a.id = i.app_id
          JOIN users u ON u.id = i.created_by
         WHERE i.id = p_invite
           AND (u.is_admin
                OR CASE WHEN a.collab_visibility = 'private' AND NOT a.self_hosted
                        THEN EXISTS (SELECT 1 FROM app_collaborators c
                                      WHERE c.app_id = a.id AND c.user_id = u.id AND c.status = 'member')
                        ELSE EXISTS (SELECT 1 FROM community_members m
                                      WHERE m.community_id = a.community_id AND m.user_id = u.id)
                   END)
      );
    $$;
  `);

  // The season/event the challenges hang off: active, not internal, and its
  // window open (started 30 days ago, ends 30 days from now).
  const { rows: [{ id: seasonId }] } = await pool.query(
    `INSERT INTO seasons (starts_at, ends_at, is_active)
     VALUES (NOW() - interval '90 days', NOW() + interval '90 days', TRUE) RETURNING id`);
  const { rows: [{ id: eventId }] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, internal, season_id)
     VALUES ('Event', NOW() - interval '30 days', NOW() + interval '30 days', TRUE, FALSE, $1) RETURNING id`,
    [seasonId]);
  await pool.query(`INSERT INTO communities (id) VALUES (1), (2), (3)`);
  await pool.query(`INSERT INTO apps (id, community_id) VALUES (1, 1), (2, 2), (3, 3)`);

  return { pool, eventId };
}

// ── Seed helpers ──────────────────────────────────────────────────────

async function seedUser(pool, username, { provisional = false, synthetic = false, displayName = null, admin = false } = {}) {
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO users (username, display_name, is_admin, username_provisional_since, is_synthetic)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [username, displayName, admin, provisional ? new Date(NOW - DAY) : null, synthetic]);
  return Number(id);
}

async function seedChallenge(pool, eventId, { measure = 'INVITES_JOINED', target = 3 } = {}) {
  const { rows: [{ id: templateId }] } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, reward)
     VALUES ('ONBOARDING', 'Invite 3 people', '250 pts each') RETURNING id`);
  const { rows: [{ id: challengeId }] } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id`,
    [eventId, templateId]);
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_id, target, points)
     VALUES ('Invite rule', $1, $2, $3, 250)`,
    [measure, challengeId, target]);
  return Number(challengeId);
}

// A link of the maker's on `appId`, whose community the maker is a member
// of unless `standing: false` — community_invite_maker_holds() reads that
// membership, so a link whose maker lost standing queues for nobody.
async function seedLink(pool, makerId, appId, { revokedAt = null, standing = true } = {}) {
  if (standing) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $1 FROM apps WHERE id = $2
       ON CONFLICT DO NOTHING`, [makerId, appId]);
  }
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at, revoked_at)
     VALUES ($1, (SELECT community_id FROM apps WHERE id = $2), $2, $3, NULL, $4) RETURNING id`,
    [`tok${Math.random().toString(36).slice(2, 10)}`, appId, makerId, revokedAt]);
  return Number(id);
}

async function redeem(pool, inviteId, userId, status, { createdAt = null, appliedAt = null } = {}) {
  await pool.query(
    `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [inviteId, userId, status, createdAt, appliedAt]);
}

async function collab(pool, appId, userId, invitedBy, status, { createdAt = null, acceptedAt = null } = {}) {
  await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, invited_by, status, created_at, accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [appId, userId, invitedBy, status, createdAt, acceptedAt]);
}

// A ledger credit the scorer would have written: the points are the
// VIEWER's (user_id), the person they name is the source_key.
async function credit(pool, challengeId, viewerId, inviteeId) {
  await pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
     VALUES ($1, 1, 'challenge_scoring', 250, $2, NOW(), $3)`,
    [viewerId, JSON.stringify({ source_key: `invitee:${inviteeId}` }), challengeId]);
}

const statusesOf = (data) => Object.fromEntries(data.people.map((p) => [p.user_id, p.status]));
const namesOf = (data) => Object.fromEntries(data.people.map((p) => [p.user_id, p.name]));

// ── The tests ─────────────────────────────────────────────────────────

test('the invite list against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool, eventId } = setup;

  await t.test('each status reads off its seeded rows', async () => {
    const viewer = await seedUser(pool, 'maker');
    const challengeId = await seedChallenge(pool, eventId);

    // Counted: joined through the viewer's link, and the ledger has them.
    const counted = await seedUser(pool, 'evan');
    const linkA = await seedLink(pool, viewer, 1);
    await redeem(pool, linkA, counted, 'joined', { createdAt: new Date(NOW - 3 * DAY), appliedAt: new Date(NOW - 2 * DAY) });
    await credit(pool, challengeId, viewer, counted);

    // Counts soon: joined through the viewer's link, next scheduled pass pays.
    const soon = await seedUser(pool, 'ocank14');
    await redeem(pool, linkA, soon, 'joined', { createdAt: new Date(NOW - DAY), appliedAt: new Date(NOW - DAY) });

    // Waiting: followed the link, queued for the day they are let in.
    const waiting = await seedUser(pool, 'snait');
    await redeem(pool, linkA, waiting, 'queued', { createdAt: new Date(NOW - DAY) });

    // Not accepted: a collaborator invite still open.
    const invited = await seedUser(pool, 'cyrcle');
    await collab(pool, 1, invited, viewer, 'invited', { createdAt: new Date(NOW - 2 * HOUR) });

    // Not counted, someone else's invite first: the viewer's record is later
    // than the one that names their real inviter.
    const otherFirst = await seedUser(pool, 'later');
    const otherMaker = await seedUser(pool, 'other-maker');
    const otherLink = await seedLink(pool, otherMaker, 1);
    await redeem(pool, otherLink, otherFirst, 'joined', { createdAt: new Date(NOW - 5 * DAY), appliedAt: new Date(NOW - 4 * DAY) });
    await redeem(pool, linkA, otherFirst, 'joined', { createdAt: new Date(NOW - 3 * DAY), appliedAt: new Date(NOW - 3 * DAY) });

    // Not counted, outside the challenge's dates: their join predates the
    // event the challenge hangs off.
    const early = await seedUser(pool, 'earlybird');
    await redeem(pool, linkA, early, 'joined', { createdAt: new Date(NOW - 40 * DAY), appliedAt: new Date(NOW - 40 * DAY) });

    // Won't join: queued, but the link was turned off while they waited.
    const off = await seedUser(pool, 'gone');
    const deadLink = await seedLink(pool, viewer, 2, { revokedAt: new Date(NOW - HOUR) });
    await redeem(pool, deadLink, off, 'queued', { createdAt: new Date(NOW - 2 * DAY) });

    // And a person whose maker lost standing: the same Won't join. The link
    // lives in a community the viewer is NOT a member of (the other links
    // above made them one elsewhere), so maker_holds is FALSE for it.
    const lost = await seedUser(pool, 'unheld');
    const deadStanding = await seedLink(pool, viewer, 3, { standing: false });
    await redeem(pool, deadStanding, lost, 'queued', { createdAt: new Date(NOW - 2 * DAY) });

    // A synthetic account the viewer's link caught is nobody's invitee.
    const bot = await seedUser(pool, 'bench_bot', { synthetic: true });
    await redeem(pool, linkA, bot, 'joined', { createdAt: new Date(NOW - DAY), appliedAt: new Date(NOW - DAY) });

    const data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.ok(data, 'the invite challenge has a list');
    assert.equal(data.target, 3);
    const st = statusesOf(data);
    assert.equal(st[counted], 'counted');
    assert.equal(st[soon], 'pending_count');
    assert.equal(st[waiting], 'waiting_access');
    assert.equal(st[invited], 'not_accepted');
    assert.equal(st[otherFirst], 'other_invite');
    assert.equal(st[early], 'outside_window');
    assert.equal(st[off], 'link_off');
    assert.equal(st[lost], 'link_off');
    assert.equal(st[bot], undefined, 'a synthetic account is not listed');

    // Names: the handle for a real username, the display name (without an @)
    // for a provisional handle.
    assert.equal(namesOf(data)[counted], '@evan');
    const provisional = await seedUser(pool, 'pat-s', { provisional: true, displayName: 'Pat' });
    await redeem(pool, linkA, provisional, 'joined', { createdAt: new Date(NOW - HOUR), appliedAt: new Date(NOW - HOUR) });
    const again = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(namesOf(again)[provisional], 'Pat');
  });

  await t.test('the ledger wins, and a person with two of the viewer’s records is one row', async () => {
    const viewer = await seedUser(pool, 'maker2');
    const challengeId = await seedChallenge(pool, eventId);

    // Counted even though they ALSO queued on a second link of the viewer's
    // that was later turned off, and also accepted a collaborator invite:
    // the ledger is what counts.
    const both = await seedUser(pool, 'evan2');
    const link = await seedLink(pool, viewer, 1);
    const revoked = await seedLink(pool, viewer, 1, { revokedAt: new Date(NOW - HOUR) });
    await redeem(pool, link, both, 'joined', { createdAt: new Date(NOW - 3 * DAY), appliedAt: new Date(NOW - 2 * DAY) });
    await redeem(pool, revoked, both, 'queued', { createdAt: new Date(NOW - DAY) });
    await collab(pool, 1, both, viewer, 'member', { createdAt: new Date(NOW - DAY), acceptedAt: new Date(NOW - DAY) });
    await credit(pool, challengeId, viewer, both);

    // Deduped without the ledger, too: joined on the link AND accepted the
    // collaborator invite, one row.
    const deduped = await seedUser(pool, 'twice');
    await redeem(pool, link, deduped, 'joined', { createdAt: new Date(NOW - DAY), appliedAt: new Date(NOW - DAY) });
    await collab(pool, 2, deduped, viewer, 'member', { createdAt: new Date(NOW - 2 * DAY), acceptedAt: new Date(NOW - DAY) });

    const data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(data.people.length, 2, 'one row per person, not per record');
    assert.equal(statusesOf(data)[both], 'counted', 'the ledger wins over a later revoked link');
    assert.equal(statusesOf(data)[deduped], 'pending_count');
  });

  await t.test('only the viewer’s people are returned, never another inviter’s', async () => {
    const viewer = await seedUser(pool, 'maker3');
    const challengeId = await seedChallenge(pool, eventId);

    // Another inviter's person: the viewer has no record for them at all.
    const otherMaker = await seedUser(pool, 'other3');
    const theirPerson = await seedUser(pool, 'theirs');
    const theirLink = await seedLink(pool, otherMaker, 1);
    await redeem(pool, theirLink, theirPerson, 'joined', { createdAt: new Date(NOW - DAY), appliedAt: new Date(NOW - DAY) });

    // The viewer's person, whose first record is the OTHER inviter's.
    const contested = await seedUser(pool, 'contested');
    await redeem(pool, theirLink, contested, 'joined', { createdAt: new Date(NOW - 5 * DAY), appliedAt: new Date(NOW - 5 * DAY) });
    const link = await seedLink(pool, viewer, 1);
    await redeem(pool, link, contested, 'joined', { createdAt: new Date(NOW - 2 * DAY), appliedAt: new Date(NOW - 2 * DAY) });

    const data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.deepEqual(data.people.map((p) => p.user_id), [contested],
      'only the person the viewer holds a record for, not the other inviter’s');
    assert.equal(statusesOf(data)[contested], 'other_invite');
  });

  await t.test('over the limit reads once the paid count reaches the target', async () => {
    const viewer = await seedUser(pool, 'maker4');
    const challengeId = await seedChallenge(pool, eventId, { target: 2 });

    const link = await seedLink(pool, viewer, 1);
    const a = await seedUser(pool, 'a4');
    const b = await seedUser(pool, 'b4');
    const c = await seedUser(pool, 'c4');
    await redeem(pool, link, a, 'joined', { createdAt: new Date(NOW - 3 * DAY), appliedAt: new Date(NOW - 3 * DAY) });
    await redeem(pool, link, b, 'joined', { createdAt: new Date(NOW - 2 * DAY), appliedAt: new Date(NOW - 2 * DAY) });
    await redeem(pool, link, c, 'joined', { createdAt: new Date(NOW - DAY), appliedAt: new Date(NOW - DAY) });

    // Two paid of three joined: the first two are counted / counting, the
    // third reads Over the limit.
    await credit(pool, challengeId, viewer, a);
    let data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(statusesOf(data)[a], 'counted');
    assert.equal(statusesOf(data)[b], 'pending_count', 'under the target, a join is still counting');
    assert.equal(statusesOf(data)[c], 'pending_count');

    // The scheduled pass pays for b: now c is over the limit.
    await credit(pool, challengeId, viewer, b);
    data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(statusesOf(data)[c], 'over_target');
  });

  await t.test('a challenge the invite measure does not score has no list', async () => {
    const viewer = await seedUser(pool, 'maker5');
    const other = await seedChallenge(pool, eventId, { measure: 'PROPOSAL_SENT' });
    assert.equal(await inviteStatuses(pool, { userId: viewer, challengeId: other, now: NOW }), null);
    assert.equal(await inviteStatuses(pool, { userId: viewer, challengeId: 99999, now: NOW }), null);
  });

  await t.test('counted first, then the waits, then the rest; capped at 100', async () => {
    const viewer = await seedUser(pool, 'maker6');
    const challengeId = await seedChallenge(pool, eventId);

    const link = await seedLink(pool, viewer, 1);
    // 105 people joined through the link, three of them paid: 3 counted
    // (newest first), then 102 counting — and the list stops at 100.
    const ids = [];
    for (let i = 1; i <= 105; i++) {
      const u = await seedUser(pool, `p${i}`);
      ids[i] = u;
      await redeem(pool, link, u, 'joined', {
        createdAt: new Date(NOW - i * 60 * 1000), appliedAt: new Date(NOW - i * 60 * 1000),
      });
      if (i <= 3) await credit(pool, challengeId, viewer, u);
    }
    const data = await inviteStatuses(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(data.people.length, 100, 'capped at 100');
    const groups = data.people.map((p) => p.status);
    assert.equal(groups.slice(0, 3).filter((s) => s === 'counted').length, 3, 'the paid three lead');
    assert.ok(groups.slice(3).every((s) => s === 'over_target'),
      'past the target, the rest read Over the limit (all joined, none unpaid can be counting)');
    // Newest first within a group: the unpaid people joined at NOW - i
    // minutes, so the newest of them (i=4) leads the still-counting rows.
    assert.equal(data.people[3].user_id, ids[4]);
  });
});
