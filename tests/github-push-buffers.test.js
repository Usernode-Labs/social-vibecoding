'use strict';

// #6994: an uploaded archive's files travel as Buffers, and GitHub's tree
// API takes text in the tree itself but bytes only as a base64 blob. This
// pins services/github.js pushFiles: a Buffer becomes a blob (base64) and
// its tree entry names the blob's sha; text is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [], rowCount: 0 }) });

const github = require('../src/services/github');
github.isEnabled = () => true;
github._setAppForTests({
  eachInstallation: { async *iterator() { yield { installation: { id: 1, account: { login: 'Usernode-Labs' } } }; } },
  octokit: { auth: async () => ({ token: 'test-installation-token' }) },
});

const realFetch = global.fetch;
let blobs = [];
let tree = null;
global.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url));
  const method = (opts.method || 'GET').toUpperCase();
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.github.com')) {
    if (u.includes('/git/ref/')) return json({ object: { sha: 'base-sha' } });
    if (u.includes('/git/commits/')) return json({ sha: 'base-sha', tree: { sha: 'base-tree' } });
    if (u.endsWith('/git/blobs') && method === 'POST') {
      blobs.push(JSON.parse(opts.body));
      return json({ sha: `blob-${blobs.length}` }, 201);
    }
    if (u.endsWith('/git/trees') && method === 'POST') {
      tree = JSON.parse(opts.body);
      return json({ sha: 'new-tree' }, 201);
    }
    if (u.endsWith('/git/commits') && method === 'POST') return json({ sha: 'new-commit', tree: { sha: 'new-tree' } }, 201);
    if (u.includes('/git/refs/')) return json({ object: { sha: 'new-commit' } });
    return json({});
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

test('a Buffer is pushed as a base64 blob; text stays in the tree', async () => {
  blobs = [];
  tree = null;
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  await github.pushFiles('Usernode-Labs', 'site', [
    { path: 'public/logo.png', content: bytes },
    { path: 'public/index.html', content: '<html></html>' },
  ], { message: 'Start from the archive' });

  assert.equal(blobs.length, 1, 'one blob for the one binary file');
  assert.equal(blobs[0].encoding, 'base64');
  assert.equal(blobs[0].content, bytes.toString('base64'));
  const byPath = Object.fromEntries(tree.tree.map((entry) => [entry.path, entry]));
  assert.equal(byPath['public/logo.png'].sha, 'blob-1');
  assert.equal(byPath['public/logo.png'].content, undefined);
  assert.equal(byPath['public/index.html'].content, '<html></html>');
});

test('a delete is a tree entry with a null sha', async () => {
  blobs = [];
  tree = null;
  await github.pushFiles('Usernode-Labs', 'site', [
    { path: 'public/index.html', content: '<html>new</html>' },
  ], { message: 'Replace the site', deletes: ['public/old-page.html'] });

  const byPath = Object.fromEntries(tree.tree.map((entry) => [entry.path, entry]));
  assert.equal(byPath['public/old-page.html'].sha, null, 'the path is removed by the new tree');
});
