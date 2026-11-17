'use strict';

// services/message-attachments.js against the real chat_message_attachments
// and chat_messages tables: the connector enriches a discussion page from
// this table, and the two guards here are the ones the transcript route and
// the serve route use. What is pinned:
//   * a visible message's rows come back with kind, stored type, size and the
//     first bytes of a picture, and nothing of a text file;
//   * a message hidden by moderation, or deleted, gives up nothing at all,
//     and its bytes cannot be read;
//   * bytes are only ever read as part of the message id they belong to.
//
// Run with: node --test tests/message-attachments-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('message attachments against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'msg_att_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  const config = {
    databaseUrl: String(url),
    adminUsername: 'attach-admin',
    adminPassword: 'only-for-tests',
    selfAppSlug: 'attach-platform',
    platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding',
  };
  await require('../src/db/migrate').migrate(config);
  const attachmentsSvc = require('../src/services/message-attachments');

  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status) VALUES ('Attachments', 'attachments-test', 'running') RETURNING id`
  );
  const message = async (extra = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, content, msg_type, deleted_at, moderation_hidden_at)
       VALUES ($1, 'see the file', 'message', $2, $3) RETURNING id`,
      [app.id, extra.deleted ? new Date() : null, extra.hidden ? new Date() : null]
    );
    return rows[0].id;
  };
  const visible = await message();
  const hidden = await message({ hidden: true });
  const deleted = await message({ deleted: true });

  // Signature and IHDR: a 640x480 PNG header, then a little padding.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
    Buffer.from([0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0, 8, 6, 0, 0, 0]),
    Buffer.alloc(40, 1),
  ]);
  const text = Buffer.from('an alternative look, in words');
  const add = async (messageId, kind, filename, contentType, data) => {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO chat_message_attachments (id, app_id, message_id, kind, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, app.id, messageId, kind, filename, contentType, data.length, data]
    );
    return id;
  };
  const pngId = await add(visible, 'image', 'alternative.png', 'image/png', png);
  const textId = await add(visible, 'text', 'notes.txt', 'text/plain', text);
  const hiddenId = await add(hidden, 'image', 'hidden.png', 'image/png', png);
  const deletedId = await add(deleted, 'image', 'deleted.png', 'image/png', png);

  // The page's facts: only the visible message's rows, with the head of a
  // picture and nothing of a text file.
  const rows = await attachmentsSvc.loadFacts(pool, [visible, hidden, deleted]);
  assert.deepEqual(rows.map((r) => r.id).sort(), [pngId, textId].sort());
  const pngRow = rows.find((r) => r.id === pngId);
  const textRow = rows.find((r) => r.id === textId);
  assert.equal(pngRow.kind, 'image');
  assert.equal(pngRow.content_type, 'image/png');
  assert.equal(Number(pngRow.size_bytes), png.length);
  assert.deepEqual(pngRow.head.subarray(0, 8), png.subarray(0, 8));
  assert.equal(textRow.kind, 'text');
  assert.equal(textRow.content_type, 'text/plain');
  assert.equal(textRow.head, null, 'no bytes are read for a file that is not a picture');

  // Bytes: the visible picture comes back whole, and the hidden or deleted
  // messages' files do not exist as far as this reader is concerned.
  const read = await attachmentsSvc.readBytes(pool, { attachmentId: pngId, messageId: visible });
  assert.deepEqual(read.data, png);
  assert.equal(
    (await attachmentsSvc.readBytes(pool, { attachmentId: textId, messageId: visible })).data.toString(),
    text.toString()
  );
  assert.equal(
    (await attachmentsSvc.readBytes(pool, { attachmentId: hiddenId, messageId: hidden })).reason,
    'not_found'
  );
  assert.equal(
    (await attachmentsSvc.readBytes(pool, { attachmentId: deletedId, messageId: deleted })).reason,
    'not_found'
  );
  // An id is only ever read as part of the message it belongs to.
  assert.equal(
    (await attachmentsSvc.readBytes(pool, { attachmentId: pngId, messageId: hidden })).reason,
    'not_found'
  );
});
