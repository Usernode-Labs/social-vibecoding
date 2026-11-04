'use strict';

// #6311: "put it on Homeroom's board too", beside the move. A new request is
// filed on Homeroom's own board with the original's title and words, the
// person who asked is named, both requests link to each other, and the
// original stays open: nothing is closed and no close vote is opened. GitHub
// is a stub that records what it is asked to do.
//
// Run with: node --test tests/homeroom-bot-copy-request.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const systemMessages = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    async sendSystemMessage(_pool, appId, content, _type, _meta, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    async sendBotMessage(_pool, appId, message) {
      const id = systemMessages.length + 500;
      systemMessages.push({ appId, content: message.content, thread: message.thread, metadata: message.metadata });
      return { id };
    },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const gh = { created: [], comments: [], closed: [], issues: new Map(), threads: new Map() };
const githubStub = {
  isEnabled: () => true,
  async getIssue(owner, repo, number) {
    const issue = gh.issues.get(`${repo}#${number}`);
    if (!issue) throw Object.assign(new Error('Not Found'), { status: 404 });
    return issue;
  },
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async fetchIssueComments(_owner, repo, number) { return { comments: gh.threads.get(`${repo}#${number}`) || [], truncated: false }; },
  async createIssue(owner, repo, { title, body }) {
    gh.created.push({ owner, repo, title, body });
    return { number: 900 + gh.created.length, title };
  },
  async createIssueComment(owner, repo, number, body) { gh.comments.push({ repo, number, body }); return { id: 1 }; },
  async closeIssue(owner, repo, number) { gh.closed.push({ repo, number }); return {}; },
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

test('#6311: filing a copy on Homeroom\'s own board, and keeping the original open', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_copy_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function project(slug, owner, { members = [], visibility = 'public', title = null } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, 'public') RETURNING id`,
      [title || slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`, visibility],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    for (const member of [owner, ...members]) {
      await pool.query(
        'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [app.community_id, member.id],
      );
    }
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const homeroom = await project('usernode-2d5619', sam, { members: [ada], title: 'Homeroom' });
  const ears = await project('ear-trainer', ada, { members: [sam] });

  const move = require('../src/services/homeroom-bot-move');
  const voice = require('../src/services/homeroom-bot-voice');

  async function request(n, { by = ada, title = `Header ${n}`, body = 'The header frame covers the app.', asked = true } = {}) {
    gh.issues.set(`ear-trainer#${n}`, { number: n, state: 'open', title, body, user: { login: 'usernode-bot' } });
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5)`,
      [ears.id, n, title, body, by.id],
    );
    if (asked) {
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)
         ON CONFLICT (app_id, issue_number) DO NOTHING`,
        [ears.id, n, by.id, title],
      );
    }
  }

  await t.test('the requester may ask, and so may the project\'s creator and admins; a stranger may not', async () => {
    await request(6);
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 6, user: ada }), true, 'its requester');
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 6, user: sam }), false, 'somebody else');
    // Its row's filer counts too, even with no requester row.
    await request(7, { by: sam, asked: false });
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 7, user: sam }), true, 'who filed its row');
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 7, user: ada }), true, 'the project\'s creator');
    const stranger = await user('cy');
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 7, user: stranger }), false, 'a stranger');
    await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [ears.id, stranger.id]);
    require('../src/services/app-admins').invalidateAppAdmins(ears.id);
    assert.equal(await move.asksForRequest(pool, { app: ears, issueNumber: 7, user: stranger }), true, 'an admin');
  });

  await t.test('the copy keeps the original\'s words, names who asked, links both ways, and never closes it', async () => {
    await request(8, { title: 'Signed-out Try it sends me to an authorize page' });
    const filed = await move.copyToHomeroom(pool, CONFIG, {
      user: ada, app: ears, issueNumber: 8, fileKey: 'copy-test:8', settings: null,
      deps: { bot, github: githubStub, domain: 'app.test' },
    });
    assert.equal(filed.ok, true);
    assert.equal(filed.target.slug, 'usernode-2d5619');
    assert.equal(gh.created.length, 1);
    const created = gh.created[0];
    assert.equal(created.repo, 'usernode-2d5619', 'on Homeroom\'s own repository');
    assert.equal(created.title, 'Signed-out Try it sends me to an authorize page');
    assert.match(created.body, /^The header frame covers the app\.\n\n---\nAlso filed from Ear trainer #8 \(https:\/\/app\.test\/#app\/ear-trainer\/dev\/issues\/8\), asked by @ada_\d+\.$/);
    const { rows: [twin] } = await pool.query(
      'SELECT created_by FROM issues WHERE app_id = $1 AND github_issue_number = $2', [homeroom.id, 901],
    );
    assert.equal(twin.created_by, ada.id, 'credited to its author');
    assert.deepEqual(gh.comments.map((c) => [c.repo, c.number]), [['ear-trainer', 8]]);
    assert.match(gh.comments[0].body,
      /^Also on Homeroom's own board as request #901: https:\/\/app\.test\/#app\/usernode-2d5619\/dev\/issues\/901\n\nThis request stays open here\.$/);
    assert.deepEqual(gh.closed, [], 'never closed');
    const { rows: votes } = await pool.query('SELECT id FROM issues WHERE kind = \'close_issue\'');
    assert.equal(votes.length, 0, 'no close vote opened');
    const { rows: [original] } = await pool.query(
      'SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = 8', [ears.id],
    );
    assert.equal(original.status, 'open', 'the original stays open');
  });

  await t.test('a retry with the same file key files no second copy', async () => {
    const before = gh.created.length;
    const again = await move.copyToHomeroom(pool, CONFIG, {
      user: ada, app: ears, issueNumber: 8, fileKey: 'copy-test:8', settings: null,
      deps: { bot, github: githubStub, domain: 'app.test' },
    });
    assert.equal(again.ok, true);
    assert.equal(again.issueNumber, 901, 'the copy found again');
    assert.equal(gh.created.length, before, 'no second request');
  });

  await t.test('a tap under the thread offer files the copy and settles done', async () => {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'off')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const { rows: [message] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata)
       VALUES ($1, $2, 'Can you file it there?', 'message', 'issue', 8, '{}') RETURNING id`,
      [ears.id, ada.id],
    );
    const { rows: [offer] } = await pool.query(
      `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id, message_id)
       VALUES ($1, 'copy_request', $2, $3, $4) RETURNING id`,
      [ears.id, JSON.stringify({ issueNumber: 8, title: 'Signed-out Try it sends me to an authorize page' }), ada.id, message.id],
    );
    const before = gh.created.length;
    const out = await voice.actOnOffer(pool, CONFIG, {
      offerId: Number(offer.id), userId: ada.id, choice: 'yes', key: 'copy-test:tap',
      deps: { bot, github: githubStub, domain: 'app.test' },
    });
    assert.equal(out.decision, 'done');
    assert.equal(gh.created.length, before + 1, 'a new copy from a different ask');
    const { rows: [settled] } = await pool.query(
      'SELECT status, result, decided_at FROM homeroom_bot_voice_offers WHERE id = $1', [offer.id],
    );
    assert.equal(settled.status, 'done');
    assert.ok(Number(settled.result.issueNumber) > 0);
    assert.ok(settled.decided_at);
    assert.deepEqual(gh.closed, [], 'the tap never closes the original');
  });
});
