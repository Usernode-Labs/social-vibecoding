'use strict';

// The Journey page's flows reading, against the real schema in a throwaway
// database: required when TEST_DATABASE_URL is set, skipped when no server is
// reachable. The pure assembly is pinned in tests/journey-flows.test.js; this
// is the queries themselves: each project's audience, what each person did
// in each project, and the invites they sent, followed or not.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('flows: audience by project, a footprint per person and project, and invites sent whether or not they were followed',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_flows_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 6 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const now = new Date('2026-11-12T12:00:00Z');
    const user = async (username, cols = {}) => {
      const base = { has_platform_access: true, ...cols };
      const keys = Object.keys(base);
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, ${keys.join(', ')})
         VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [username, ...keys.map((k) => base[k])]
      );
      return Number(rows[0].id);
    };
    const project = async (slug, title, by, visibility, at) => {
      const { rows } = await pool.query(
        `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility, created_at)
         VALUES ($1, $2, $3, 'running', $4, $4, $5) RETURNING id`,
        [title, slug, by, visibility, at]
      );
      // The community is made by a trigger after the insert.
      const made = await pool.query('SELECT community_id FROM apps WHERE id = $1', [rows[0].id]);
      return { id: Number(rows[0].id), community: Number(made.rows[0].community_id) };
    };
    const used = (app, who, date, seconds = 90) => pool.query(
      'INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, $3, $4)', [app, who, seconds, date]);

    const ana = await user('ana');
    const ben = await user('ben');
    const cy = await user('cy');
    const dee = await user('dee', { has_platform_access: false });
    const lead = await user('lead', { is_admin: true });
    const tess = await user('tess', { test_account_created_at: '2026-10-01T00:00:00Z' });
    const skipped = await user('left_out');

    const garden = await project('garden', 'Garden', ana, 'private', '2026-09-01T10:00:00Z');
    const atlas = await project('atlas', 'Atlas', ben, 'public', '2026-09-02T10:00:00Z');
    const diary = await project('diary', 'Diary', cy, 'private', '2026-09-03T10:00:00Z');
    const later = await project('later', 'Later', ana, 'public', '2026-12-01T10:00:00Z'); // made after "now"
    for (const p of [garden, atlas, diary, later]) assert.ok(p.community, 'every project has its community');

    // Ana shares Garden by a link Ben follows, and invites Dee by name; a
    // second link of hers is opened once, signed out, and followed by nobody.
    const link = async (app, by, at, sharedAt = null) => Number((await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, created_at, shared_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [crypto.randomBytes(8).toString('hex'), app.community, app.id, by, at, sharedAt])).rows[0].id);
    const first = await link(garden, ana, '2026-09-05T10:00:00Z', '2026-09-05T10:01:00Z');
    await link(garden, ana, '2026-09-20T10:00:00Z');
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
       VALUES ($1, $2, 'joined', '2026-09-06T09:00:00Z', '2026-09-06T09:00:00Z')`, [first, ben]);
    // A link into a private project writes the collaborator row too
    // (apply_community_invite): it is the link's, not an invite by name.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, created_at, accepted_at, accepted_via)
       VALUES ($1, $2, 'member', $3, '2026-09-06T09:00:00Z', '2026-09-06T09:00:00Z', 'link')`, [garden.id, ben, ana]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source, joined_at)
       VALUES ($1, $2, 'joined', '2026-09-06T09:00:00Z') ON CONFLICT DO NOTHING`, [garden.community, ben]);
    await pool.query(
      `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser, opened_at) VALUES
         ($1, $2, $3, NULL, '2026-09-06T08:59:00Z'),
         ($1, $2, NULL, 'b-1', '2026-09-21T08:00:00Z'),
         ($1, $2, $1, NULL, '2026-09-05T10:02:00Z')`, [ana, garden.id, ben]); // her own open is not one
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, created_at)
       VALUES ($1, $2, 'invited', $3, '2026-09-07T10:00:00Z')`, [garden.id, dee, ana]);
    // An admin's link reaches Cy: Cy's row names who invited them, and the
    // admin is nobody's row.
    const staffLink = await link(atlas, lead, '2026-09-08T10:00:00Z');
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at)
       VALUES ($1, $2, 'queued', '2026-09-09T09:00:00Z')`, [staffLink, cy]);

    // What they did, project by project.
    await used(garden.id, ben, '2026-09-06');
    await used(garden.id, ben, '2026-09-07');
    await used(garden.id, ben, '2026-09-08', 10); // under 30 seconds is not a day
    await used(garden.id, ben, '2026-12-02'); // after "now"
    await used(atlas.id, cy, '2026-09-10');
    await used(atlas.id, tess, '2026-09-10');
    await used(atlas.id, skipped, '2026-09-10');
    const change = async (app, who, status) => Number((await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, created_at, merged_at)
       VALUES ($1, $2, $3, 7, '2026-09-11T10:00:00Z', $4) RETURNING id`,
      [app, who, status, status === 'merged' ? '2026-09-12T10:00:00Z' : null])).rows[0].id);
    const live = await change(atlas.id, cy, 'merged');
    await change(atlas.id, cy, 'active');
    await pool.query("INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', '2026-09-11T12:00:00Z')", [live, ana]);
    const issue = Number((await pool.query(
      "INSERT INTO issues (app_id, title, created_by, created_at) VALUES ($1, 'Maps', $2, '2026-09-13T10:00:00Z') RETURNING id",
      [atlas.id, ana])).rows[0].id);
    await pool.query("INSERT INTO issue_votes (issue_id, user_id, vote, created_at) VALUES ($1, $2, 'up', '2026-09-13T11:00:00Z')", [issue, cy]);
    await pool.query(
      "INSERT INTO feedback_reports (user_id, target, app_id, description, created_at) VALUES ($1, 'app', $2, 'slow', '2026-09-14T10:00:00Z')",
      [ben, garden.id]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES
         ($1, $2, 'hi', '2026-09-15T10:00:00Z'), ($1, $2, 'again', '2026-09-16T10:00:00Z')`, [garden.id, ben]);

    const read = await journey.flows(pool, { now, leftOutIds: [skipped] });

    // Audience, as the screen names it, for the projects somebody's row names.
    assert.deepEqual(read.apps.map((a) => [a.slug, a.audience, a.madeBy.name]), [
      ['garden', 'invited', 'ana'], ['atlas', 'open', 'ben'], ['diary', 'solo', 'cy'],
    ], 'a private project with a second member or a pending invite is a private community; one alone is just you');
    assert.equal(read.apps.some((a) => a.slug === 'later'), false, 'a project made after now is not there');
    assert.deepEqual(read.counts.audiences, { solo: 1, invited: 1, open: 1 });

    // Real people only, by name.
    assert.deepEqual(read.people.map((p) => p.name), ['ana', 'ben', 'cy', 'dee']);
    const person = (n) => read.people.find((p) => p.name === n);
    const at = (n, slug) => person(n).apps.find((a) => a.slug === slug);

    assert.deepEqual(at('ben', 'garden'), {
      slug: 'garden', made: false, member: true, invitedBy: 'ana',
      days: 2, firstDay: '2026-09-06', lastDay: '2026-09-08',
      changes: 0, live: 0, votes: 0, requests: 0, feedback: 1, messages: 2,
    }, 'the days are those of 30 seconds or more, up to now');
    assert.equal(at('ben', 'atlas').made, true, 'a project they made is a row with nothing done in it');
    assert.deepEqual(
      [at('cy', 'atlas').days, at('cy', 'atlas').changes, at('cy', 'atlas').live, at('cy', 'atlas').votes, at('cy', 'atlas').invitedBy],
      [1, 2, 1, 1, 'lead'], 'a change of their own, the one that went live, a vote on a request, and who invited them');
    assert.deepEqual([at('ana', 'atlas').votes, at('ana', 'atlas').requests], [1, 1], 'a vote on a change and a request filed');
    assert.deepEqual([at('dee', 'garden').invitedBy, at('dee', 'garden').member, at('dee', 'garden').days], ['ana', false, 0],
      'invited by name and not there yet');

    // The invites ana sent: two links (one shared from the sheet), one person
    // by name, two opens by somebody else, and the two real people reached.
    assert.equal(person('ana').invites.length, 1);
    const sent = person('ana').invites[0];
    assert.deepEqual([sent.slug, sent.links, sent.shared, sent.direct, sent.opened], ['garden', 2, 1, 1, 2]);
    assert.deepEqual(sent.reached.map((r) => [r.name, r.status, r.how]), [['ben', 'joined', 'link'], ['dee', 'invited', 'direct']]);
    assert.deepEqual(person('ben').invites, [], 'nobody invited is no entry');
    assert.equal(read.people.some((p) => p.name === 'lead' || p.name === 'tess' || p.name === 'left_out'), false);
    assert.equal(read.cut, null);
    assert.equal(new Date(read.opensSince).toISOString(), '2026-09-05T10:02:00.000Z');

    // The cap cuts the rows, never the count.
    const { rows: capped } = await pool.query(journey.FLOWS_PEOPLE_SQL,
      [2, now, ['usernode%', 'staging%', 'homeroom%'], [skipped]]);
    assert.equal(capped.length, 2);
    assert.ok(capped[0].total > 2);
  });
