'use strict';

// Admin "Deduplicate user" (src/services/user-merge.js) against the REAL
// schema in a throwaway PostgreSQL database: schema.sql applied twice (the
// boot migration is idempotent), then real merges. Skipped when no server is
// reachable, and required when TEST_DATABASE_URL is set — the same contract
// as tests/account-deletion-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const merge = require('../src/services/user-merge');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('user merge against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'user_merge_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const password = 'disposable-fixture-password';
  const hash = await bcrypt.hash(password, 4);
  let seq = 0;
  async function user({ fullAdmin = false, readonly = false, email, confirmed = false, pubkey = null } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly, email, email_confirmed, email_confirmed_at,
                          usernode_pubkey, display_name, telegram, city)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NOW() - INTERVAL '3 days' END, $7, $8, $9, 'Lisbon')
       RETURNING *`,
      [`fixture_${n}`, hash, fullAdmin || readonly, readonly,
        email === undefined ? `fixture_${n}@example.invalid` : email, confirmed, pubkey,
        `Fixture ${n}`, `fixture_tg_${n}`]
    );
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [crypto.randomBytes(24).toString('hex'), rows[0].id]);
    return rows[0];
  }
  const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
  const actor = await user({ fullAdmin: true });

  // Programme fixtures user_activities needs.
  const season = (await pool.query(`INSERT INTO seasons (name, starts_at, ends_at) VALUES ('S', NOW() - INTERVAL '9 days', NOW() + INTERVAL '9 days') RETURNING id`)).rows[0].id;
  const event = (await pool.query(`INSERT INTO season_events (name, starts_at, ends_at, scoring_formula, season_id, created_at, updated_at)
    VALUES ('E', NOW() - INTERVAL '9 days', NOW() + INTERVAL '9 days', '{}'::jsonb, $1, NOW(), NOW()) RETURNING id`, [season])).rows[0].id;
  const tpl = (await pool.query(`INSERT INTO challenge_templates (category, goal, task, reward, created_at, updated_at)
    VALUES ('c', 'g', 't', 'r', NOW(), NOW()) RETURNING id`)).rows[0].id;
  const challenge = (await pool.query(`INSERT INTO challenges (season_event_id, challenge_template_id, goal, display_order, created_at, updated_at)
    VALUES ($1, $2, 'g', 0, NOW(), NOW()) RETURNING id`, [event, tpl])).rows[0].id;
  const activity = (userId, points, extra = {}) => pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, challenge_id, activity_type, points, activity_at, metadata, added_by)
     VALUES ($1, $2, $3, 'manual', $4, NOW(), $5, $6)`,
    [userId, event, challenge, points, JSON.stringify(extra.metadata || {}), extra.addedBy || null]
  );

  await t.test('the catalog is what the service assumes', async () => {
    const multi = await count(`SELECT COUNT(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.users'::regclass AND cardinality(conkey) > 1`);
    assert.equal(multi, 0, 'every foreign key to users is a single column');
    const fks = await count(`SELECT COUNT(*) AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.users'::regclass`);
    assert.ok(fks > 140, `discovers the ~150 user foreign keys (found ${fks})`);
    for (const { table, column } of merge.NON_FK_MOVES) {
      const n = await count(`SELECT COUNT(*) AS n FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attname = $2 AND NOT a.attisdropped
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = a.attrelid AND c.contype = 'f' AND a.attnum = ANY(c.conkey))`,
      [table, column]);
      assert.equal(n, 1, `${table}.${column} exists and still has no foreign key`);
    }
    for (const ref of merge.NON_FK_LEFT) {
      const [table, column] = ref.split('.');
      assert.equal(await count(`SELECT COUNT(*) AS n FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2`, [table, column]), 1, ref);
    }
    for (const table of [...merge.REVOKED_TABLES, ...merge.STAY_TABLES.keys(), ...merge.RETAIN_ON_CONFLICT]) {
      assert.ok((await pool.query('SELECT to_regclass($1) AS r', [table])).rows[0].r, `${table} exists`);
    }
    const comment = (await pool.query(`SELECT obj_description('user_merges'::regclass, 'pg_class') AS c`)).rows[0].c;
    assert.equal(comment, 'staging:private');
  });

  await t.test('refusals change nothing', async () => {
    const a = await user();
    const b = await user();
    const fullAdmin = await user({ fullAdmin: true });
    const viewer = await user({ readonly: true });
    const noEmail = await user({ email: null });
    const run = (o) => merge.mergeUsers(pool, { actorId: actor.id, emailFrom: 'kept', ...o });
    await assert.rejects(run({ keepId: a.id, mergeId: a.id, confirmation: a.username }), { status: 400, code: 'same_user' });
    await assert.rejects(run({ keepId: a.id, mergeId: fullAdmin.id, confirmation: fullAdmin.username }), { status: 409, code: 'merged_unavailable' });
    await assert.rejects(run({ keepId: a.id, mergeId: b.id, confirmation: b.username.toUpperCase() }), { status: 400, code: 'confirmation_mismatch' });
    await assert.rejects(run({ keepId: a.id, mergeId: b.id, confirmation: '' }), { code: 'confirmation_mismatch' });
    await assert.rejects(run({ keepId: a.id, mergeId: b.id, confirmation: b.username, actorId: viewer.id }), { status: 403, code: 'forbidden' });
    await assert.rejects(run({ keepId: a.id, mergeId: 99999999, confirmation: 'x' }), { status: 404 });
    await assert.rejects(run({ keepId: a.id, mergeId: noEmail.id, confirmation: noEmail.username, emailFrom: 'merged' }), { status: 422, code: 'no_email' });
    await assert.rejects(run({ keepId: a.id, mergeId: b.id, confirmation: b.username, emailFrom: 'other' }), { status: 400 });
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ANY($1::int[])', [[a.id, b.id, fullAdmin.id]]), 3);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_merges'), 0);
    assert.equal((await pool.query('SELECT username FROM users WHERE id = $1', [b.id])).rows[0].username, b.username);
  });

  await t.test('a full merge: activity moves, the kept account wins, pairs resolve, sign-in rules hold', async () => {
    // Created merged -> peer -> kept, so a friendship (merged, peer) must
    // flip to (peer, kept) to keep CHECK (user_low_id < user_high_id).
    const merged = await user({ email: 'Person@Example.invalid', confirmed: true, pubkey: 'ut1mergedwallet000000000000001' });
    const peer = await user();
    const kept = await user({ email: 'kept-old@example.invalid' });
    const keptBefore = (await pool.query('SELECT * FROM users WHERE id = $1', [kept.id])).rows[0];

    // Additive activity.
    const app = (await pool.query(`INSERT INTO apps (name, slug, created_by) VALUES ('Merged app', 'merge-fixture', $1) RETURNING id`, [merged.id])).rows[0].id;
    await pool.query(`INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'hello'), ($1, $2, 'again')`, [app, merged.id]);
    await activity(merged.id, 40);
    await activity(peer.id, 5, { addedBy: merged.id });
    // Composite unique (app_id, user_id, date): same day conflicts, another day moves.
    await pool.query(`INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES
      ($1, $2, 10, '2026-09-01'), ($1, $3, 99, '2026-09-01'), ($1, $2, 20, '2026-09-02')`, [app, kept.id, merged.id]);
    // Expression unique (user_id, COALESCE(app_id, 0), category): NULL app ids collide.
    await pool.query(`INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES
      ($1, NULL, 'mentions', TRUE), ($2, NULL, 'mentions', FALSE), ($2, NULL, 'replies', FALSE)`, [kept.id, merged.id]);
    // Partial unique (user_id, season_id) WHERE season_event_id IS NULL.
    await pool.query(`INSERT INTO user_enrollments (user_id, season_id) VALUES ($1, $3), ($2, $3)`, [kept.id, merged.id, season]);
    // Partial unique over JSON: one completion per (user, challenge).
    await activity(kept.id, 100, { metadata: { kind: 'challenge_completion' } });
    await activity(merged.id, 100, { metadata: { kind: 'challenge_completion' } });

    // Two-user-column tables.
    const lowHigh = (x, y) => [Math.min(x, y), Math.max(x, y)];
    await pool.query(`INSERT INTO friendships (user_low_id, user_high_id, requester_id, status) VALUES ($1, $2, $1, 'accepted')`, [merged.id, peer.id]);
    await pool.query(`INSERT INTO friendships (user_low_id, user_high_id, requester_id, status) VALUES ($1, $2, $1, 'accepted')`, lowHigh(merged.id, kept.id));
    await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2), ($3, $1)`, [merged.id, kept.id, peer.id]);
    const convo = async (a, b) => {
      const id = (await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [a])).rows[0].id;
      await pool.query('INSERT INTO conversation_direct_pairs VALUES ($1, $2, $3)', [id, ...lowHigh(a, b)]);
      await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [id, a, b]);
      return id;
    };
    const mergedDm = await convo(merged.id, peer.id);
    const keptDm = await convo(kept.id, peer.id);
    await pool.query(`INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'dm')`, [mergedDm, merged.id]);

    // Sign-in methods: kept already has GitHub; merged has GitHub and X.
    await pool.query(`INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES
      ($1, 'github', '333', 'kept-gh'), ($2, 'github', '111', 'merged-gh'), ($2, 'x', '222', 'merged-x')`, [kept.id, merged.id]);
    await pool.query(`INSERT INTO username_history (user_id, username) VALUES ($1, $2)`, [merged.id, `older_${merged.username}`]);
    await pool.query(`INSERT INTO mobile_auth_tokens (user_id, token_hash, ability, expires_at) VALUES ($1, $2, 'session', NOW() + INTERVAL '1 day')`,
      [merged.id, 'e'.repeat(64)]);

    const preview = await merge.mergePreview(pool, { userId: kept.id, otherId: merged.id });
    assert.equal(preview.user.id, kept.id);
    assert.equal(preview.other.username, merged.username);
    assert.equal(preview.other.email, 'Person@Example.invalid');
    assert.equal(preview.other.apps, 1);
    assert.equal(preview.other.messages, 3);
    assert.deepEqual(preview.other.providers, ['github', 'x']);
    assert.equal(preview.other.references['chat_messages.user_id'], 2);
    assert.equal(preview.other.merge_away_blocked, null);
    assert.ok(preview.other.reference_total >= 10);

    const result = await merge.mergeUsers(pool, {
      keepId: kept.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'merged', confirmation: merged.username,
    });
    assert.equal(result.ok, true);

    // Additive rows moved.
    assert.equal(await count('SELECT COUNT(*) AS n FROM apps WHERE created_by = $1', [kept.id]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = $1', [kept.id]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_activities WHERE user_id = $1', [merged.id]), 0);
    assert.equal(Number((await pool.query('SELECT SUM(points) AS s FROM user_activities WHERE user_id = $1', [kept.id])).rows[0].s), 140);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_activities WHERE added_by = $1', [kept.id]), 1, 'non-FK added_by follows');
    // Kept wins on the composite, expression and partial unique keys.
    const days = (await pool.query(`SELECT date::text AS d, seconds_spent FROM app_activity WHERE user_id = $1 ORDER BY date`, [kept.id])).rows;
    assert.deepEqual(days, [{ d: '2026-09-01', seconds_spent: 10 }, { d: '2026-09-02', seconds_spent: 20 }]);
    const prefs = (await pool.query(`SELECT category, enabled FROM notification_preferences WHERE user_id = $1 ORDER BY category`, [kept.id])).rows;
    assert.deepEqual(prefs, [{ category: 'mentions', enabled: true }, { category: 'replies', enabled: false }]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_enrollments WHERE user_id = $1', [kept.id]), 1);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM user_activities WHERE user_id = $1 AND metadata->>'kind' = 'challenge_completion'`, [kept.id]), 1);
    assert.ok(result.dropped.app_activity === 1 && result.dropped.notification_preferences === 1 && result.dropped.user_enrollments === 1);
    // Pairs: the self pairs are gone, the friendship with the peer is re-ordered.
    assert.deepEqual((await pool.query('SELECT user_low_id, user_high_id, requester_id FROM friendships WHERE $1 IN (user_low_id, user_high_id)', [kept.id])).rows,
      [{ user_low_id: peer.id, user_high_id: kept.id, requester_id: kept.id }]);
    assert.deepEqual((await pool.query('SELECT blocker_id, blocked_user_id FROM user_blocks WHERE $1 IN (blocker_id, blocked_user_id)', [kept.id])).rows,
      [{ blocker_id: peer.id, blocked_user_id: kept.id }]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM conversation_direct_pairs WHERE conversation_id = $1', [mergedDm]), 0, 'the colliding DM pair is dropped');
    assert.equal(await count('SELECT COUNT(*) AS n FROM conversation_direct_pairs WHERE conversation_id = $1', [keptDm]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM conversation_messages WHERE sender_id = $1', [kept.id]), 1, 'the message itself moved');
    // Social identities: GitHub stays the kept one, X moves; merged has none left.
    assert.deepEqual((await pool.query('SELECT provider, provider_subject FROM user_social_identities WHERE user_id = $1 ORDER BY provider', [kept.id])).rows,
      [{ provider: 'github', provider_subject: '333' }, { provider: 'x', provider_subject: '222' }]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_social_identities WHERE user_id = $1', [merged.id]), 0);
    // Wallet copied (kept had none) and cleared from the merged row.
    const k = (await pool.query('SELECT * FROM users WHERE id = $1', [kept.id])).rows[0];
    const m = (await pool.query('SELECT * FROM users WHERE id = $1', [merged.id])).rows[0];
    assert.equal(k.usernode_pubkey, 'ut1mergedwallet000000000000001');
    assert.equal(m.usernode_pubkey, null);
    assert.equal(result.wallet_moved, true);
    // Email: the merged address and its confirmed state landed on the kept row.
    assert.equal(k.email, 'Person@Example.invalid');
    assert.equal(k.email_confirmed, true);
    assert.equal(k.email_confirmed_at.toISOString(), merged.email_confirmed_at.toISOString());
    // The kept row is otherwise untouched.
    for (const col of ['username', 'password', 'display_name', 'telegram', 'is_admin', 'app_quota', 'created_at']) {
      assert.deepEqual(k[col], keptBefore[col], `kept.${col} unchanged`);
    }
    // Anonymised merged row.
    assert.equal(m.email, `support+anonym+${kept.id}+${merged.id}@onhomeroom.com`);
    assert.equal(m.email_confirmed, false);
    assert.equal(m.username, `merged-${merged.id}`);
    assert.equal(m.display_name, null); assert.equal(m.telegram, null); assert.equal(m.city, null);
    assert.equal(m.is_admin, false);
    assert.equal(await bcrypt.compare(password, m.password), false, 'the old password no longer works');
    // Signed out everywhere.
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1', [merged.id]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM mobile_auth_tokens WHERE user_id = ANY($1::int[])', [[merged.id, kept.id]]), 0,
      'a token is revoked, never handed to the kept account');
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1', [kept.id]), 1, 'the kept account stays signed in');
    // Usernames: the old one and its history now point at the kept account.
    const history = (await pool.query('SELECT username FROM username_history WHERE user_id = $1 ORDER BY username', [kept.id])).rows.map((r) => r.username);
    assert.deepEqual(history, [merged.username, `older_${merged.username}`].sort());
    await assert.rejects(pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [merged.username, peer.id]), { code: '23505' },
      'nobody else can take the merged username');
    // Audit.
    const audit = (await pool.query('SELECT * FROM user_merges WHERE merged_user_id = $1', [merged.id])).rows[0];
    assert.equal(audit.kept_user_id, kept.id);
    assert.equal(audit.actor_id, actor.id);
    assert.equal(audit.email_kept_from, 'merged');
    assert.equal(audit.moved.chat_messages, 2);
    assert.equal(audit.dropped.app_activity, 1);
    assert.ok(!JSON.stringify(audit).includes('Person@Example.invalid'), 'no email in the audit row');
    // Once merged, never again.
    const other = await user();
    await assert.rejects(merge.mergeUsers(pool, { keepId: other.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'kept', confirmation: m.username }),
      { status: 409, code: 'already_merged' });
    await assert.rejects(merge.mergeUsers(pool, { keepId: merged.id, mergeId: other.id, actorId: actor.id, emailFrom: 'kept', confirmation: other.username }),
      { status: 409, code: 'kept_unavailable' });
  });

  await t.test('the kept wallet and email win when the admin keeps them', async () => {
    const kept = await user({ pubkey: 'ut1keptwallet00000000000000001', email: 'keep-me@example.invalid', confirmed: false });
    const merged = await user({ pubkey: 'ut1mergedwallet000000000000002', email: 'other@example.invalid', confirmed: true });
    const r = await merge.mergeUsers(pool, { keepId: kept.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'kept', confirmation: merged.username });
    assert.equal(r.wallet_moved, false);
    const rows = (await pool.query('SELECT id, usernode_pubkey, email, email_confirmed FROM users WHERE id = ANY($1::int[]) ORDER BY id', [[kept.id, merged.id]])).rows;
    assert.deepEqual(rows[0], { id: kept.id, usernode_pubkey: 'ut1keptwallet00000000000000001', email: 'keep-me@example.invalid', email_confirmed: false });
    assert.deepEqual(rows[1], { id: merged.id, usernode_pubkey: null, email: `support+anonym+${kept.id}+${merged.id}@onhomeroom.com`, email_confirmed: false });
  });

  await t.test('a conflicting season wallet is retained on the anonymised account, never deleted', async () => {
    const kept = await user();
    const merged = await user();
    const wallet = (uid, n) => pool.query(
      `INSERT INTO onchain_accounts (amount, identity_uid, address, public_key, secret_key, tier, registration_code,
                                     season_id, season_event_id, user_id, is_used, created_at)
       VALUES (0, $1, $2, $1, 'fixture-not-a-secret', 'standard', $3, $4, NULL, $5, TRUE, NOW()) RETURNING id`,
      [`uid-${n}`, `ut1fixtureaccount${n}`, `code-${n}`, season, uid]);
    const keptAcct = (await wallet(kept.id, `k${kept.id}`)).rows[0].id;
    const mergedAcct = (await wallet(merged.id, `m${merged.id}`)).rows[0].id;
    const r = await merge.mergeUsers(pool, { keepId: kept.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'kept', confirmation: merged.username });
    assert.equal(r.retained.onchain_accounts, 1);
    const owners = (await pool.query('SELECT id, user_id, secret_key FROM onchain_accounts WHERE id = ANY($1::bigint[]) ORDER BY id', [[keptAcct, mergedAcct]])).rows;
    assert.deepEqual(owners.map((o) => [Number(o.id), Number(o.user_id)]), [[Number(keptAcct), kept.id], [Number(mergedAcct), merged.id]]);
    assert.equal(owners[1].secret_key, 'fixture-not-a-secret', 'the retained wallet is intact');
  });

  await t.test('a failure in any table rolls the whole merge back', async () => {
    const kept = await user();
    const merged = await user();
    const app = (await pool.query(`INSERT INTO apps (name, slug, created_by) VALUES ('Rollback app', 'merge-rollback', $1) RETURNING id`, [merged.id])).rows[0].id;
    await pool.query(`INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'x')`, [app, merged.id]);
    // apps is processed before chat_messages? No: alphabetical, so
    // app_* and apps come first and have already moved when this fires.
    await pool.query(`CREATE FUNCTION merge_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'check_violation', CONSTRAINT = 'merge_fixture_fail'; END $$`);
    await pool.query(`CREATE TRIGGER merge_fixture_fail BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION merge_fixture_fail()`);
    await pool.query(`INSERT INTO events (user_id, event_type) VALUES ($1, 'fixture')`, [merged.id]);
    try {
      await assert.rejects(
        merge.mergeUsers(pool, { keepId: kept.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'kept', confirmation: merged.username }),
        (err) => err.status === 409 && err.code === 'merge_conflict' && /events/.test(err.message) && /merge_fixture_fail/.test(err.message)
      );
    } finally {
      await pool.query('DROP TRIGGER merge_fixture_fail ON events');
      await pool.query('DROP FUNCTION merge_fixture_fail()');
    }
    assert.equal((await pool.query('SELECT created_by FROM apps WHERE id = $1', [app])).rows[0].created_by, merged.id);
    assert.equal(await count('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = $1', [merged.id]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1', [merged.id]), 1, 'still signed in');
    const m = (await pool.query('SELECT username, email FROM users WHERE id = $1', [merged.id])).rows[0];
    assert.equal(m.username, merged.username);
    assert.equal(m.email, merged.email);
    assert.equal(await count('SELECT COUNT(*) AS n FROM user_merges WHERE merged_user_id = $1', [merged.id]), 0);
    // And with the fault gone the same merge goes through.
    const ok = await merge.mergeUsers(pool, { keepId: kept.id, mergeId: merged.id, actorId: actor.id, emailFrom: 'kept', confirmation: merged.username });
    assert.equal(ok.moved.events, 1);
    assert.equal(ok.moved.apps, 1);
  });

  await t.test('every unique index over a user column is pre-checked, not left to fail', async () => {
    const { rows } = await pool.query(`SELECT DISTINCT c.conrelid AS relid, n.nspname AS s, r.relname AS t
      FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass`);
    assert.ok(rows.length > 100);
    // A merge with no conflicts at all still walks every table without error.
    const a = await user();
    const b = await user();
    const r = await merge.mergeUsers(pool, { keepId: a.id, mergeId: b.id, actorId: actor.id, emailFrom: 'kept', confirmation: b.username });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unchecked_indexes, [], 'no unique expression index hides a user column');
  });
});
