'use strict';

// #6632: Homeroom bot only for verified accounts, against the full schema.
//
// What only the real tables can say: each signal is read from the row that
// proves it (and never from self-declared text), the grandfather moment is
// written once and compared with when an account was let in, the chat's
// fixed reply is sent once a day with no model asked, the doors refuse an
// unverified account and let a verified one through, and a refresh leaves
// an unverified requester's request out of the bot's queue.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/homeroom-bot-verified-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons: nothing here is sent.
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    async handleMessage() { return { ok: true, message: { id: 1 } }; },
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const homeroomBot = require('../src/services/homeroom-bot');
const rule = require('../src/services/homeroom-bot-verified');

test('the verified-accounts rule against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_verified_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                      ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  let seq = 0;
  async function user(prefix, { synthetic = false, access = true, isAdmin = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic, is_admin, platform_access_granted_at)
       VALUES ($1, 'x', $3, $2, $4, CASE WHEN $3 THEN NOW() END)
       RETURNING id, username, has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic, access, isAdmin],
    );
    return rows[0];
  }
  const settings = () => homeroomBot.readSettings(pool, { strict: true });
  const save = (patch) => homeroomBot.writeSettings(pool, patch, null, {});
  const bot = await user('homeroom_bot', { synthetic: true });
  const owner = await user('owner');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Seed swap', 'seed-swap', 'running', $1, 'https://github.com/usernode-bot/seed-swap') RETURNING *`,
    [owner.id],
  );

  await t.test('everyone is the default: nothing is read and everybody let in has the bot', async () => {
    const s = await settings();
    assert.equal(s.worksFor, 'everyone');
    assert.equal(await dm.botWorksFor(pool, s, owner), true);
    assert.equal(await rule.verifyRequired(pool, s, owner), false);
  });

  await t.test('each signal is read from the row that proves it, and self-declared text never counts', async () => {
    const plain = await user('plain');
    await pool.query("UPDATE users SET github = 'plain-gh', x = 'plain_x', github_login = 'plain-gh' WHERE id = $1", [plain.id]);
    assert.deepEqual(
      (({ phone, x, github, zkpassport, oauth, email, isAdmin }) => ({ phone, x, github, zkpassport, oauth, email, isAdmin }))(await rule.readSignals(pool, plain.id)),
      { phone: false, x: false, github: false, zkpassport: false, oauth: false, email: false, isAdmin: false },
      'users.github, users.x and users.github_login are not proofs',
    );
    const phone = await user('phone');
    await pool.query("INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-v1', '+15550100091')", [phone.id]);
    const x = await user('x');
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'x', '9001', 'x_only')", [x.id]);
    const github = await user('gh');
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'github', '9002', 'gh-only')", [github.id]);
    const oauth = await user('oauth');
    await pool.query("INSERT INTO user_oauth_identities (user_id, provider, subject) VALUES ($1, 'google', 'sub-1')", [oauth.id]);
    const email = await user('email');
    await pool.query('UPDATE users SET email_confirmed = TRUE WHERE id = $1', [email.id]);
    const zkpassport = await user('zk');
    const { rows: [season] } = await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, is_active)
       VALUES ('Fixture', NOW(), NOW() + INTERVAL '1 day', TRUE) RETURNING id`);
    const { rows: [event] } = await pool.query(
      `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES ('Fixture', NOW(), NOW() + INTERVAL '1 day', TRUE, '{}'::jsonb, $1, 'season') RETURNING id`, [season.id]);
    const { rows: [template] } = await pool.query(
      `INSERT INTO challenge_templates (category, goal, task, reward)
       VALUES ('ONBOARDING', 'Prove you are a person', 'zkPassport', '0 pts') RETURNING id`);
    const { rows: [challenge] } = await pool.query(
      'INSERT INTO challenges (season_event_id, challenge_template_id, display_order) VALUES ($1, $2, 1) RETURNING id',
      [event.id, template.id]);
    await pool.query(
      `INSERT INTO user_activities (user_id, season_event_id, activity_type, activity_at, source, challenge_id)
       VALUES ($1, $2, 'challenge', NOW(), 'zkpassport', $3)`, [zkpassport.id, event.id, challenge.id]);
    const people = { phone, x, github, zkpassport, oauth, email };
    for (const signal of rule.SIGNALS) {
      const flags = await rule.readSignals(pool, people[signal].id);
      assert.deepEqual(rule.SIGNALS.filter((s) => flags[s]), [signal], `${signal}: its own row and no other`);
    }
    // The rule on, with no grandfathering: each signal alone, ticked and not.
    assert.deepEqual(await save({ worksFor: 'verified', verifiedGrandfather: false }), { ok: true });
    for (const signal of rule.SIGNALS) {
      assert.deepEqual(await save({ verifiedSignals: [signal] }), { ok: true });
      const s = await settings();
      for (const other of rule.SIGNALS) {
        assert.equal(await dm.botWorksFor(pool, s, people[other]), other === signal, `only ${signal} ticked: ${other}`);
      }
      assert.equal(await dm.botWorksFor(pool, s, plain), false);
    }
    await save({ verifiedSignals: ['phone', 'x', 'github'] });
    assert.deepEqual((await save({ worksFor: 'verified', verifiedSignals: [] })).ok, false, 'nothing ticked is refused');
    assert.deepEqual((await settings()).verifiedSignals, ['phone', 'x', 'github'], 'and nothing was written');
  });

  await t.test('the moment is written once, the grandfather box decides, and admins always have the bot', async () => {
    const first = (await settings()).verifiedSince;
    assert.ok(first, 'written when the rule was switched on');
    // Kept apart from "now" without waiting: the stored moment is moved an
    // hour back, so a save that rewrote it would show.
    const moved = new Date(Date.parse(first) - 3600 * 1000).toISOString();
    await pool.query("UPDATE platform_settings SET value = $1 WHERE key = 'homeroom_bot_verified_since'", [moved]);
    assert.deepEqual(await save({ worksFor: 'verified', verifiedGrandfather: true }), { ok: true });
    assert.equal((await settings()).verifiedSince, moved, 'a later save of verified does not move it');
    const since = moved;
    const early = await user('early');
    await pool.query("UPDATE users SET platform_access_granted_at = $2::timestamptz - INTERVAL '1 day' WHERE id = $1", [early.id, since]);
    const late = await user('late');
    await pool.query("UPDATE users SET platform_access_granted_at = $2::timestamptz + INTERVAL '1 minute' WHERE id = $1", [late.id, since]);
    const waited = await user('waited');
    await pool.query("UPDATE users SET created_at = $2::timestamptz - INTERVAL '30 days', platform_access_granted_at = $2::timestamptz + INTERVAL '1 minute' WHERE id = $1", [waited.id, since]);
    const boss = await user('boss', { isAdmin: true });
    await pool.query("UPDATE users SET platform_access_granted_at = $2::timestamptz + INTERVAL '1 minute' WHERE id = $1", [boss.id, since]);
    let s = await settings();
    assert.deepEqual(
      [await dm.botWorksFor(pool, s, early), await dm.botWorksFor(pool, s, late), await dm.botWorksFor(pool, s, waited), await dm.botWorksFor(pool, s, boss)],
      [true, false, false, true],
      'let in before it: kept. Let in after it, however old the account: not. An admin: always',
    );
    await save({ verifiedGrandfather: false });
    s = await settings();
    assert.equal(await dm.botWorksFor(pool, s, early), false, 'unticked, the rule applies to everyone');
    assert.equal(await dm.botWorksFor(pool, s, boss), true);
    assert.equal((await settings()).verifiedSince, moved, 'unticking the box leaves the moment');
    // Off removes the moment; on again writes a new one.
    await save({ worksFor: 'everyone' });
    assert.equal((await settings()).verifiedSince, null);
    assert.equal(await dm.botWorksFor(pool, await settings(), late), true, 'everyone again');
    await save({ worksFor: 'verified', verifiedGrandfather: false });
    assert.ok(Date.parse((await settings()).verifiedSince) > Date.parse(moved), 'a new moment, not the old one');
  });

  await t.test('the chat: one fixed reply with Verify, once a day, no model asked; verified, the model answers', async () => {
    await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_dm_chat', 'on')
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const ada = await user('ada');
    const turns = [];
    const mayor = {
      async decideOffer() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args.message.content); return { model: true }; },
    };
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const hi = await conversations.sendMessage(pool, ada, conversationId, { content: 'build me a quiz' });
    const said = await dm.noteUserMessage(pool, {}, { user: ada, conversationId, message: hi.message, deps: { mayor } });
    const text = await conversations.getMessage(pool, ada, conversationId, said.messageId);
    assert.equal(text.content, dm.VERIFY_TEXT);
    assert.equal(text.reply.id, hi.message.id);
    const meta = text.metadata.homeroomBot;
    assert.deepEqual([meta.kind, meta.status, meta.signals], ['verify', 'open', ['phone', 'x', 'github']]);
    assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.type]), [['verify_account', 'Verify', 'open']]);
    const again = await conversations.sendMessage(pool, ada, conversationId, { content: 'hello?' });
    await dm.noteUserMessage(pool, {}, { user: ada, conversationId, message: again.message, deps: { mayor } });
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 AND content = $3',
      [conversationId, bot.id, dm.VERIFY_TEXT]);
    assert.equal(n, 1, 'at most once in 24 hours');
    assert.deepEqual(turns, [], 'no model was asked');
    // Somebody not let in still hears the other line.
    const sam = await user('sam', { access: false });
    const direct = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const knock = await conversations.sendMessage(pool, sam, direct.conversationId, { content: 'hi' });
    const no = await dm.noteUserMessage(pool, {}, { user: sam, conversationId: direct.conversationId, message: knock.message, deps: { mayor } });
    assert.equal((await conversations.getMessage(pool, sam, direct.conversationId, no.messageId)).content, dm.NOT_ENABLED_TEXT);
    // Verified (a linked X account), the same person's message reaches the model.
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'x', '9101', 'ada_x')", [ada.id]);
    const third = await conversations.sendMessage(pool, ada, conversationId, { content: 'now?' });
    assert.deepEqual(await dm.noteUserMessage(pool, {}, { user: ada, conversationId, message: third.message, deps: { mayor } }), { model: true });
    assert.deepEqual(turns, ['now?']);
  });

  await t.test('the doors: an unverified account is refused with the code, a verified one goes through', async () => {
    const threads = require('../src/services/private-threads');
    const plan = require('../src/services/homeroom-bot-public-plan');
    const locked = await user('locked');
    const open = await user('open');
    await pool.query("INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-v2', '+15550100092')", [open.id]);
    const refusal = { ok: false, status: 403, error: rule.VERIFY_ERROR, code: 'bot_verify_required', signals: ['phone', 'x', 'github'] };
    assert.deepEqual(await threads.startThread(pool, { user: locked }), refusal);
    assert.deepEqual(await threads.startAbout(pool, { user: locked, app, kind: 'request', number: 4 }), refusal);
    assert.deepEqual(await require('../src/services/design-threads').startDesign(pool, {}, {
      user: locked, html: '<p>x</p>', surface: 'app', appSlug: app.slug, title: 'Home', width: 390, height: 800,
    }), refusal);
    assert.deepEqual(await dm.askBotToBuild(pool, { app, user: locked, issueNumber: 4 }), refusal);
    assert.deepEqual(await plan.buildPlan(pool, { app, issueNumber: 4, user: locked }), refusal);
    assert.deepEqual(await rule.refusalFor(pool, locked), refusal, 'what the create route asks before a described project is made');
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [locked.id]);
    assert.equal(n, 0, 'nothing was started');
    // Verified: each door is past the rule (what it then answers is its own).
    const started = await threads.startThread(pool, { user: open });
    assert.equal(started.ok, true);
    assert.equal(await rule.refusalFor(pool, open), null);
    assert.deepEqual(await plan.buildPlan(pool, { app, issueNumber: 4, user: open }), { ok: false, status: 409, error: 'plan_gone' });
    const asked = await dm.askBotToBuild(pool, { app, user: open, issueNumber: 4 });
    assert.notEqual(asked.code, 'bot_verify_required');
  });

  await t.test('the lane: a refresh leaves an unverified requester\'s request out, and queues a verified one\'s', async () => {
    const env = process.env.USERNODE_ENV;
    delete process.env.USERNODE_ENV;
    try {
      const locked = await user('lane_locked');
      const open = await user('lane_open');
      await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'github', '9201', 'lane-open')", [open.id]);
      await pool.query(
        `INSERT INTO issues (app_id, title, description, created_by, github_issue_number, status)
         VALUES ($1, 'From locked', 'x', $2, 301, 'open'), ($1, 'From open', 'x', $3, 302, 'open')`,
        [app.id, locked.id, open.id]);
      const now = new Date().toISOString();
      const github = {
        async fetchPublicIssues() {
          return { issues: [
            { number: 301, title: 'From locked', state: 'open', createdAt: now, updatedAt: now },
            { number: 302, title: 'From open', state: 'open', createdAt: now, updatedAt: now },
            { number: 303, title: 'From nobody on Homeroom', state: 'open', createdAt: now, updatedAt: now },
          ] };
        },
      };
      const s = { ...(await settings()), mode: 'shadow', everyoneSince: '2026-01-01T00:00:00.000Z' };
      const capRoom = { proposals_per_app: 5, proposals_total: 5, builds_per_app: 5 };
      const out = await homeroomBot.refreshApp(pool, app, { github, bot, capRoom, settings: s, everyoneSince: s.everyoneSince });
      assert.equal(out.queued, 2, 'the verified requester\'s, and the one nobody here filed (left as before)');
      // With the rule off, all three.
      const off = await homeroomBot.refreshApp(pool, app, {
        github, bot, capRoom, settings: { ...s, worksFor: 'everyone' }, everyoneSince: s.everyoneSince,
      });
      assert.equal(off.queued, 3);
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });
});
