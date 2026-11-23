'use strict';

// #6994 (editor): use_archive, the Homeroom bot's tool for a website
// archive somebody attached in the chat (homeroom-bot-mayor.js useArchive).
//   * it finds the archive on the person's own message in this thread;
//   * it hands the bytes to services/archive-change.js for the project the
//     thread is about;
//   * its answer names the change, and says nothing is live until the vote;
//   * a thread with no archive, or not the person's, says what to do next.
//
// Run with: node --test tests/homeroom-bot-use-archive.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');

const APP = { id: 5, slug: 'ghost', name: 'Ghost', repo_url: 'https://github.com/Usernode-Labs/ghost' };
const USER = { id: 7, username: 'scraido' };

function fakePool({ attachment = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT app_id FROM private_threads/.test(sql)) return { rows: [{ app_id: APP.id }] };
      if (/FROM apps WHERE id = \$1/.test(sql)) return { rows: [{ ...APP }] };
      if (/FROM conversation_message_attachments/.test(sql)) {
        return {
          rows: attachment.id
            ? [{ id: attachment.id, filename: attachment.filename, size_bytes: attachment.data?.length || 0, data: attachment.data }]
            : [],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function ctx(stub, extra = {}) {
  return {
    user: USER,
    conversationId: 11,
    config: {},
    deps: {
      threadRootId: 3,
      appAccess: { nonSecretAppColumnList: () => 'id, slug, name, repo_url' },
      archiveChange: stub,
      ...extra,
    },
  };
}

test('an attached archive goes to the project as a change of theirs', async () => {
  const data = Buffer.from('PK');
  const pool = fakePool({ attachment: { id: 'att-1', filename: 'my-game.zip', data } });
  let asked = null;
  const stub = {
    async createChange(p, config, args) {
      asked = args;
      return { ok: true, sessionId: 77, number: 14437, pending: false, fileCount: 42, removed: 3 };
    },
  };
  const context = ctx(stub);
  const out = await mayor.useArchive(pool, context, { attachment: 'att-1' });

  assert.equal(out.ok, true, out.error);
  assert.equal(asked.filename, 'my-game.zip');
  assert.equal(asked.data, data);
  assert.equal(asked.app.slug, 'ghost');
  assert.equal(asked.user.id, USER.id);
  assert.equal(out.number, 14437);
  assert.match(out.note, /Change #14437/);
  assert.match(out.note, /Nothing is live until the project votes/);
  assert.deepEqual(context.archiveChange, { sessionId: 77, number: 14437 });
});

test('a tar.gz is found among the thread\'s files, not only a zip', async () => {
  const data = Buffer.from([0x1f, 0x8b]);
  const pool = fakePool({ attachment: { id: 'att-3', filename: 'my-game.tar.gz', data } });
  let asked = null;
  const stub = {
    async createChange(p, config, args) { asked = args; return { ok: true, sessionId: 78, number: 2, fileCount: 1, removed: 0 }; },
  };
  const out = await mayor.useArchive(pool, ctx(stub), { attachment: 'att-3' });
  assert.equal(out.ok, true, out.error);
  assert.equal(asked.filename, 'my-game.tar.gz');
});

test('a thread with no archive says to attach one', async () => {
  const pool = fakePool();
  const out = await mayor.useArchive(pool, ctx({ async createChange() { throw new Error('must not run'); } }), { attachment: '' });
  assert.equal(out.ok, false);
  assert.match(out.error, /attach the archive here/);
});

test('an attachment that is not an archive is refused plainly', async () => {
  const pool = fakePool({ attachment: { id: 'att-2', filename: 'notes.txt', data: Buffer.from('hi') } });
  const out = await mayor.useArchive(pool, ctx({ async createChange() { throw new Error('must not run'); } }), { attachment: 'att-2' });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a website archive/);
});
