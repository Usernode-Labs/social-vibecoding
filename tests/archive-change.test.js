'use strict';

// #6994 (editor): an archive attached in the Homeroom bot chat becomes a
// change of the person's own, in place of the project's public folder
// (services/archive-change.js).
//   * the archive's files go under public/, its index.html included;
//   * pages the old site had and the archive does not are removed;
//   * files outside public/ are left alone;
//   * the change is put up for the project's vote;
//   * a bad archive or a person who cannot change the project is refused
//     before a session or a branch is made.
//
// Run with: node --test tests/archive-change.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const archiveChange = require('../src/services/archive-change');

// ── A store-only zip, as tests/archive-import.test.js builds one ───────
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const APP = { id: 5, slug: 'ghost', name: 'Ghost', repo_url: 'https://github.com/Usernode-Labs/ghost' };
const USER = { id: 7, username: 'scraido' };

/** A pool that records what was written. */
function fakePool() {
  const writes = { sessions: [], messages: [], deleted: [] };
  const pool = {
    async query(sql, params = []) {
      if (/INSERT INTO chat_sessions/.test(sql)) {
        writes.sessions.push({ sql, params });
        return { rows: [{ id: 77, app_id: APP.id, user_id: USER.id, status: 'paused', branch_name: null }], rowCount: 1 };
      }
      if (/INSERT INTO chat_session_messages/.test(sql)) {
        writes.messages.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM chat_sessions/.test(sql)) {
        writes.deleted.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, writes };
}

function deps({ canChange = true, promote = null, pushed = [] } = {}) {
  return {
    github: {
      isEnabled: () => true,
      async listRepoFiles() {
        return {
          files: [
            { path: 'public/index.html' },
            { path: 'public/old-page.html' },
            { path: 'server.js' },
            { path: 'dapp.json' },
          ],
        };
      },
      async pushFiles(owner, repo, files, options) {
        pushed.push({ owner, repo, files, options });
        return { sha: 'head-sha' };
      },
    },
    appAccess: {
      async getAppForUser() { return canChange ? APP : null; },
    },
    communities: { async appNeedsJoin() { return null; } },
    sessionLifecycle: { async ensureSessionBranch() { return { branchName: 'dev/archive-scraido' }; } },
    platform: {
      async promoteProposal(args) {
        return promote ? promote(args) : { status: 200, body: { ok: true, prNumber: 14437, prUrl: 'https://app.onhomeroom.com/#/change/14437' } };
      },
    },
  };
}

test('an archive replaces the public folder and goes up for the vote', async () => {
  const { pool, writes } = fakePool();
  const pushed = [];
  const data = makeZip([
    { name: 'index.html', data: '<html><head></head><body>Game</body></html>' },
    { name: 'game.js', data: 'console.log(1);' },
  ]);
  const out = await archiveChange.createChange(pool, {}, {
    user: USER, app: APP, data, filename: 'my-game.zip', deps: deps({ pushed }),
  });

  assert.equal(out.ok, true, out.error);
  assert.equal(out.number, 14437);
  assert.equal(out.fileCount, 2);
  assert.equal(out.removed, 1, 'only public/old-page.html is gone; server.js and dapp.json stay');

  const push = pushed[0];
  const paths = push.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['public/game.js', 'public/index.html']);
  assert.match(push.options.message, /my-game\.zip/);
  assert.deepEqual(push.options.deletes, ['public/old-page.html']);

  assert.equal(writes.sessions.length, 1, 'one change session');
  assert.equal(writes.messages.length, 1, 'its description');
  assert.equal(writes.deleted.length, 0, 'nothing was dropped');
});

test('a bad archive is refused before anything is made', async () => {
  const { pool, writes } = fakePool();
  const pushed = [];
  const data = makeZip([{ name: 'game.js', data: 'console.log(1);' }]);
  const out = await archiveChange.createChange(pool, {}, {
    user: USER, app: APP, data, filename: 'no-index.zip', deps: deps({ pushed }),
  });

  assert.equal(out.ok, false);
  assert.match(out.error, /no index\.html/i);
  assert.equal(writes.sessions.length, 0);
  assert.equal(pushed.length, 0);
});

test('a person who cannot change the project is refused first', async () => {
  const { pool, writes } = fakePool();
  const pushed = [];
  const data = makeZip([{ name: 'index.html', data: '<html></html>' }]);
  const out = await archiveChange.createChange(pool, {}, {
    user: USER, app: APP, data, filename: 'site.zip', deps: deps({ canChange: false, pushed }),
  });

  assert.equal(out.ok, false);
  assert.match(out.error, /cannot change/i);
  assert.equal(writes.sessions.length, 0);
  assert.equal(pushed.length, 0);
});

test('the change is dropped when it cannot be put up for a vote', async () => {
  const { pool, writes } = fakePool();
  const pushed = [];
  const data = makeZip([{ name: 'index.html', data: '<html></html>' }]);
  const out = await archiveChange.createChange(pool, {}, {
    user: USER, app: APP, data, filename: 'site.zip',
    deps: deps({ pushed, promote: () => ({ status: 429, body: { error: 'You already have 5 changes waiting for approval.' } }) }),
  });

  assert.equal(out.ok, false);
  assert.match(out.error, /already have 5 changes/);
  assert.equal(writes.deleted.length, 1, 'the empty session is dropped');
});
