'use strict';

// #7136: a file somebody attached for Homeroom bot is carried onto the
// request it drafts, so that request's build can save it. Against the real
// PostgreSQL schema: the query that keeps only their own attachments on
// this chat's visible messages, the chat's own limits checked again, the copy
// into issue_files, and the body the request is filed with.
//
// Run with: node --test tests/issue-files-carry-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const mayor = require('../src/services/homeroom-bot-mayor');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A central-directory-only zip, as tests/attachments.test.js builds one:
// validateZip walks the directory and never reads local data.
function buildZip(entries) {
  const cdParts = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(e.flags || 0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt32LE((e.compressed || 0) >>> 0, 20);
    h.writeUInt32LE((e.uncompressed || 0) >>> 0, 24);
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt32LE((e.extAttrs || 0) >>> 0, 38);
    cdParts.push(h, nameBuf);
  }
  const cd = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  return Buffer.concat([cd, eocd]);
}

const SITE_ZIP = buildZip([
  { name: 'index.html', compressed: 400, uncompressed: 900 },
  { name: 'style.css', compressed: 200, uncompressed: 500 },
]);

test('a file attached for the bot is carried onto the request', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `issue_files_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const mkUser = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const ada = await mkUser('ada');
  const bo = await mkUser('bo');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'https://github.com/usernode-bot/plant-pal', 'private', 'private')
     RETURNING id, slug, repo_url`,
    [ada.id],
  );
  const mkConversation = async () => (await pool.query(
    `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [ada.id],
  )).rows[0].id;
  const conversationId = await mkConversation();
  const otherConversation = await mkConversation();

  const say = async (conversation, sender, content, { hidden = false, deleted = false } = {}) => (await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, deleted_at, moderation_hidden_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [conversation, sender, content, deleted ? new Date() : null, hidden ? new Date() : null],
  )).rows[0].id;

  const attach = async (conversation, messageId, who, {
    filename = 'site.zip', kind = 'binary', contentType = 'application/zip', data = SITE_ZIP,
  } = {}) => {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO conversation_message_attachments
         (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, meta, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
      [id, conversation, messageId, who, kind, filename, contentType, data.length, data],
    );
    return id;
  };

  const theirMessage = await say(conversationId, ada.id, 'here is a zip of my site');
  const zipId = await attach(conversationId, theirMessage, ada.id);

  await t.test('their own zip is kept, with its name and size', async () => {
    const out = await mayor.draftAttachments(pool, { ids: [zipId], conversationId, userId: ada.id });
    assert.equal(out.ok, true);
    assert.deepEqual(out.pictures, []);
    assert.deepEqual(out.files, [{ id: zipId, name: 'site.zip', size: SITE_ZIP.length }]);
  });

  await t.test('a picture still splits off as a picture', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const pngId = await attach(conversationId, theirMessage, ada.id, {
      filename: 'look.png', kind: 'image', contentType: 'image/png', data: PNG,
    });
    const out = await mayor.draftAttachments(pool, { ids: [pngId, zipId], conversationId, userId: ada.id });
    assert.equal(out.ok, true);
    assert.deepEqual(out.pictures, [pngId]);
    assert.deepEqual(out.files.map((f) => f.name), ['site.zip']);
  });

  await t.test('another person\'s file, another chat\'s file, and a hidden message\'s file are refused', async () => {
    // Attached by somebody else, on their message.
    const boMessage = await say(conversationId, bo.id, 'mine too');
    const boFile = await attach(conversationId, boMessage, bo.id);
    const byOther = await mayor.draftAttachments(pool, { ids: [boFile], conversationId, userId: ada.id });
    assert.equal(byOther.ok, false);
    assert.match(byOther.error, /not pictures or files they attached in this chat/);

    // Theirs, but in another conversation.
    const elsewhere = await attach(otherConversation, await say(otherConversation, ada.id, 'here'), ada.id);
    const byChat = await mayor.draftAttachments(pool, { ids: [elsewhere], conversationId, userId: ada.id });
    assert.equal(byChat.ok, false);
    assert.match(byChat.error, /not pictures or files they attached in this chat/);

    // Theirs, on a message moderation hid.
    const hiddenMessage = await say(conversationId, ada.id, 'hid this', { hidden: true });
    const hiddenFile = await attach(conversationId, hiddenMessage, ada.id);
    const byHidden = await mayor.draftAttachments(pool, { ids: [hiddenFile], conversationId, userId: ada.id });
    assert.equal(byHidden.ok, false);
  });

  await t.test('a file over the chat\'s limits is refused, naming it', async () => {
    const tooManyEntries = await attach(conversationId, theirMessage, ada.id, {
      filename: 'huge.zip',
      data: buildZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, compressed: 1, uncompressed: 1 }))),
    });
    const out = await mayor.draftAttachments(pool, { ids: [tooManyEntries], conversationId, userId: ada.id });
    assert.equal(out.ok, false);
    assert.match(out.error, /"huge\.zip" cannot go with the request/);
    assert.match(out.error, /too many files/);
  });

  await t.test('at most three files go with one request', async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await attach(conversationId, theirMessage, ada.id, { filename: `part${i}.csv`, kind: 'text', contentType: 'text/plain', data: Buffer.from('a,b\n1,2\n') }));
    const out = await mayor.draftAttachments(pool, { ids, conversationId, userId: ada.id });
    assert.equal(out.ok, false);
    assert.match(out.error, /At most 3 files/);
  });

  await t.test('filing copies the file into issue_files, stamped with its request, and the body lists it', async () => {
    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue(owner, repo, { title, body }) {
        created.push({ owner, repo, title, body });
        return { number: 4210, title };
      },
    };
    const ws = { async sendSystemMessage() { return { id: 1 }; }, pushIssueUpdate() {} };
    const deps = {
      github, ws,
      notifications: { notifyIssueFiled() {} },
      botSvc: { noteIssueActivity() {}, enqueueFront: async () => ({ id: 1 }) },
      liveSvc: { isLiveFor: () => false },
      domain: 'example.test',
    };
    const filed = await mayor.fileRequest(pool, {}, {
      user: ada, app, settings: {}, deps, title: 'Build it from my zip',
      details: 'Use the pages in the zip.',
      extras: { attachmentIds: [], fileIds: [zipId], files: [{ id: zipId, name: 'site.zip', size: SITE_ZIP.length }] },
      conversationId,
    });
    assert.equal(filed.issueNumber, 4210);

    const { rows } = await pool.query(
      'SELECT id, filename, issue_owner, issue_repo, issue_number, size_bytes FROM issue_files ORDER BY created_at',
    );
    assert.equal(rows.length, 1, 'one copy, its own record, not a screenshot');
    assert.equal(rows[0].filename, 'site.zip');
    assert.equal(rows[0].issue_owner, 'usernode-bot');
    assert.equal(rows[0].issue_repo, 'plant-pal');
    assert.equal(rows[0].issue_number, 4210);
    assert.equal(rows[0].size_bytes, SITE_ZIP.length);
    assert.notEqual(rows[0].id, zipId, 'a copy of its own, so deleting the chat message cannot take it');

    const body = created[0].body;
    assert.match(body, /\*\*Files\*\*\n- site\.zip \([0-9.]+ (B|KB|MB)\), file id [a-f0-9]{32}/);
    assert.ok(body.includes(rows[0].id), 'the id the body names is the copy the build fetches');
    assert.doesNotMatch(body, /screenshot/i);
  });

  await t.test('copying refuses another person\'s file and one on a hidden or deleted message', async () => {
    const theirs = await attach(conversationId, await say(conversationId, bo.id, 'not yours'), bo.id,
      { filename: 'theirs.csv', kind: 'text', contentType: 'text/plain', data: Buffer.from('a,b\n') });
    const onHidden = await attach(conversationId, await say(conversationId, ada.id, 'hid', { hidden: true }), ada.id,
      { filename: 'hidden.csv', kind: 'text', contentType: 'text/plain', data: Buffer.from('a,b\n') });
    const onDeleted = await attach(conversationId, await say(conversationId, ada.id, 'gone', { deleted: true }), ada.id,
      { filename: 'deleted.csv', kind: 'text', contentType: 'text/plain', data: Buffer.from('a,b\n') });
    const own = await attach(conversationId, await say(conversationId, ada.id, 'mine'), ada.id,
      { filename: 'mine.csv', kind: 'text', contentType: 'text/plain', data: Buffer.from('a,b\n') });

    const refused = await mayor.copyRequestFiles(pool, {
      ids: [theirs, onHidden, onDeleted], conversationId, userId: ada.id,
    });
    assert.deepEqual(refused, [], 'a foreign, hidden or deleted file is never copied');
    const kept = await mayor.copyRequestFiles(pool, { ids: [own], conversationId, userId: ada.id });
    assert.deepEqual(kept.map((f) => f.name), ['mine.csv'], 'their own file on a visible message is copied');

    const { rows } = await pool.query(
      "SELECT filename FROM issue_files WHERE filename IN ('theirs.csv', 'hidden.csv', 'deleted.csv')",
    );
    assert.deepEqual(rows, [], 'nothing else reached the request');
  });

  await t.test('a file named for a request but gone from the chat is skipped, not fatal', async () => {
    const out = await mayor.copyRequestFiles(pool, {
      ids: ['f'.repeat(32)], conversationId, userId: ada.id,
    });
    assert.deepEqual(out, []);
  });
});
