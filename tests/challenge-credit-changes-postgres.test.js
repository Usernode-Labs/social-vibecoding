'use strict';

// #3247: which change a challenge credit links to, against the real schema:
// both stored key shapes, only the viewer's own, only on a project they may
// see now. The route's use of it is in tests/topochain-mobile-data2.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { fetchFirstChallengeCredits, resolveCreditChanges } = require('../src/routes/topochain/mobile');
const { loadCandidates } = require('../src/services/topochain/challenge-scorer');
const { seedStagingCountedCredit } = require('../src/db/migrate');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('credits resolve through records the viewer may see, and the staging seed resolves (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = `credit_changes_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    const env = process.env.USERNODE_ENV;
    t.after(async () => {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const person = async (username) => (await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id`, [username]
    )).rows[0].id;
    const viewer = await person('credit_viewer');
    const other = await person('credit_other');
    const project = async (slug, visibility = 'public') => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, $3, $3) RETURNING id`, [slug, other, visibility]
    )).rows[0].id;
    const session = async (appId, userId, branch, pr, title) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, pr_number, pr_title, status)
       VALUES ($1, $2, $3, $4, $5, 'merged') RETURNING id`, [appId, userId, branch, pr, title]
    )).rows[0].id;
    const merge = async (sessionId, userId, appId, type = 'pr_merged') => (await pool.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`, [userId, appId, sessionId, type]
    )).rows[0].id;

    const open = await project('open-app');
    const closed = await project('closed-app', 'private');
    const member = await project('member-app', 'private');
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [member, viewer]
    );
    const suspended = await project('suspended-app');
    await pool.query('UPDATE apps SET moderation_suspended_at = NOW() WHERE id = $1', [suspended]);

    const accepted = await session(open, viewer, 'a', 7, 'Accepted one');
    const sent = await session(open, viewer, 'b', null, null);
    const keys = {
      accepted: `merged:${await merge(accepted, viewer, open)}`,
      sent: `session:${sent}`,
      memberApp: `merged:${await merge(await session(member, viewer, 'c', 8, 'Members only'), viewer, member)}`,
      privateMerged: `merged:${await merge(await session(closed, viewer, 'd', 9, 'Secret'), viewer, closed)}`,
      privateSent: `session:${await session(closed, viewer, 'e', 10, 'Secret too')}`,
      suspended: `session:${await session(suspended, viewer, 'f', 11, 'Suspended')}`,
      foreignMerge: `merged:${await merge(await session(open, other, 'g', 12, 'Theirs'), other, open)}`,
      foreignSession: `session:${await session(open, other, 'h', 13, 'Theirs too')}`,
      notAMerge: `merged:${await merge(accepted, viewer, open, 'pr_opened')}`,
      gone: 'merged:999999999',
      historical: 'feedback:12',
      overflow: 'session:99999999999999999999999',
    };
    const rows = [...Object.values(keys), null, 7].map((source_key) => ({ metadata: { source_key } }));
    rows.push({ metadata: null });
    const changes = await resolveCreditChanges(pool, { id: viewer, isAdmin: false }, rows);
    assert.deepEqual(Object.fromEntries(changes), {
      [keys.accepted]: { app_slug: 'open-app', session_id: accepted, pr_number: 7, title: 'Accepted one' },
      [keys.sent]: { app_slug: 'open-app', session_id: sent, pr_number: null, title: null },
      [keys.memberApp]: changes.get(keys.memberApp),
    });
    assert.equal(changes.get(keys.memberApp).title, 'Members only', 'a private project the viewer is in');

    // A blocked project is one they do not see, as everywhere else.
    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [viewer, member]);
    const blocked = await resolveCreditChanges(pool, { id: viewer, isAdmin: false }, rows);
    assert.equal(blocked.has(keys.memberApp), false);
    await pool.query('DELETE FROM user_app_blocks WHERE user_id = $1 AND app_id = $2', [viewer, member]);

    // ── #6986: an accepted merge credits its author and the person who
    // filed the request it was built for, once each.
    const bot = await person('credit_bot');
    await pool.query('UPDATE users SET is_synthetic = TRUE WHERE id = $1', [bot]);
    const request = async (number, createdBy, appId = open) => {
      await pool.query(
        `INSERT INTO requests (app_id, number, title, created_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, number) DO NOTHING`,
        [appId, number, `Request ${number}`, createdBy]
      );
    };
    const built = async (branch, author, { linked = null, from = null, pr = 30 } = {}) => (await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status,
          linked_issues, created_from_issue_number)
       VALUES ($1, $2, $3, $4, $5, 'merged',
               COALESCE($6::int[], '{}'), $7) RETURNING id`,
      [open, author, branch, pr, `Change ${pr}`, linked, from]
    )).rows[0].id;
    const acceptedWindow = { startMs: Date.now() - 3600000, endMs: Date.now() + 3600000 };

    // The bot built the viewer's request: both are credited, keyed to the
    // same merge, and the viewer's credit says what it was for.
    await request(21, viewer);
    const botBuiltEvent = await merge(await built('bot-built', bot, { linked: [21] }), bot, open);
    const forBuilt = (await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${botBuiltEvent}`);
    assert.equal(forBuilt.length, 2, 'the author and the filer, once each');
    const credited = new Map(forBuilt.map((c) => [Number(c.userId), c]));
    assert.equal(credited.get(bot).description, 'Accepted proposal on open-app');
    assert.equal(credited.get(viewer).description, 'Your request went live on open-app');
    // #6986: the ledger row says which relationship earned it, so the page
    // can print the request's sentence rather than the bot's change title.
    assert.equal(credited.get(bot).via, 'author');
    assert.equal(credited.get(viewer).via, 'request');
    const filerChange = await resolveCreditChanges(pool, { id: viewer, isAdmin: false },
      [{ metadata: { source_key: `merged:${botBuiltEvent}` } }]);
    assert.equal(filerChange.get(`merged:${botBuiltEvent}`).title, 'Change 30',
      'a filer\'s credit links to the change');
    assert.equal(filerChange.get(`merged:${botBuiltEvent}`).app_slug, 'open-app');

    // The filer authored it too: one credit, as the author.
    await request(22, viewer);
    const ownEvent = await merge(await built('own-request', viewer, { linked: [22], from: 22, pr: 31 }), viewer, open);
    const own = (await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${ownEvent}`);
    assert.equal(own.length, 1, 'filed and authored: still one');
    assert.equal(own[0].description, 'Accepted proposal on open-app');
    assert.equal(own[0].via, 'author', 'one credit, and it is the author\'s');

    // The request the change was started from, with nothing in linked_issues.
    await request(23, viewer);
    const fromOnly = await merge(await built('from-only', bot, { from: 23, pr: 32 }), bot, open);
    const fromCandidates = (await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${fromOnly}`);
    assert.equal(fromCandidates.length, 2);
    assert.equal(fromCandidates.find((c) => Number(c.userId) === Number(viewer)).description,
      'Your request went live on open-app');

    // A request the bot took from a DM: only homeroom_bot_requesters says who
    // it is for, and that person is credited alongside the filed-by account.
    await request(24, other);
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 24, $2)',
      [open, viewer]
    );
    const fromDm = await merge(await built('from-dm', bot, { linked: [24], pr: 33 }), bot, open);
    const dmCandidates = (await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${fromDm}`);
    assert.deepEqual(dmCandidates.map((c) => Number(c.userId)).sort((a, b) => a - b),
      [bot, viewer, other].sort((a, b) => a - b), 'the author, the filed-by person and the requester');

    // A merge an admin forced is not an acceptance: nobody is credited.
    await request(25, viewer);
    const forcedSession = await built('forced', bot, { linked: [25], pr: 34 });
    const forcedEvent = (await pool.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, created_at, metadata)
       VALUES ($1, $2, $3, 'pr_merged', NOW(), '{"forced": true}'::jsonb) RETURNING id`,
      [bot, open, forcedSession]
    )).rows[0].id;
    assert.equal((await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${forcedEvent}`).length, 0);

    // A change linked to no request credits only its author.
    const unlinked = await merge(await built('unlinked', other, { pr: 35 }), other, open);
    const unlinkedCandidates = (await loadCandidates(pool, 'PROPOSAL_ACCEPTED', acceptedWindow, { target: 2 }))
      .filter((c) => c.sourceKey === `merged:${unlinked}`);
    assert.deepEqual(unlinkedCandidates.map((c) => Number(c.userId)), [Number(other)]);

    // Nothing to resolve runs no query.
    const silent = { query() { throw new Error('no query expected'); } };
    assert.equal((await resolveCreditChanges(silent, { id: viewer }, [{ metadata: { source_key: 'feedback:1' } }])).size, 0);

    // The shots' fixture: two request-built credits, this week, however often
    // it boots — the challenge the request reported sits at 2 of 2.
    process.env.USERNODE_ENV = 'staging';
    const capture = await person('usernode-capture');
    await project('homeroom-self');
    const seasonRow = (await pool.query(
      `INSERT INTO seasons (id, name, starts_at, ends_at, is_active)
       VALUES (900500, 'Fixture', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE) RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO season_events (id, name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES (900501, 'Fixture', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE, '{}'::jsonb, $1, 'season')`,
      [seasonRow.id]
    );
    await seedStagingCountedCredit(pool, { selfAppSlug: 'homeroom-self' });
    await pool.query(`UPDATE user_activities SET activity_at = NOW() - INTERVAL '30 days' WHERE challenge_id = 900724`);
    await seedStagingCountedCredit(pool, { selfAppSlug: 'homeroom-self' });
    const credits = (await pool.query(
      `SELECT metadata, activity_at FROM user_activities WHERE challenge_id = 900724 AND user_id = $1
        ORDER BY metadata->>'source_key'`, [capture]
    )).rows;
    assert.equal(credits.length, 2, 'idempotent: two credits, not four');
    assert.ok(credits.every((c) => Date.now() - c.activity_at.getTime() < 60000), 'dated this boot');
    const seeded = await resolveCreditChanges(pool, { id: capture, isAdmin: false }, credits);
    assert.deepEqual(credits.map((c) => seeded.get(c.metadata.source_key).pr_number), [9043, 9044],
      'each credit links to its change, through the request the bot built');
    assert.ok(credits.every((c) => seeded.get(c.metadata.source_key).app_slug === 'homeroom-self'));
    assert.ok(credits.every((c) => c.metadata.via === 'request'),
      'the fixture is the bot\'s change from the capture account\'s request');

    // A First challenge's credits, wherever on its template they landed.
    const first = await fetchFirstChallengeCredits(pool, capture, [900512]);
    assert.equal(first.length, 2);
    assert.ok(first.every((r) => Number(r.challenge_id) === 900724 && Number(r.challenge_template_id) === 900512));
    assert.deepEqual(await fetchFirstChallengeCredits(pool, viewer, [900512]), []);
  });
