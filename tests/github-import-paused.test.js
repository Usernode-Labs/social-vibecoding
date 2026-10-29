'use strict';

// Importing a repository from GitHub made the bot a collaborator on it, and
// the bot's token is never sent again, so importing is paused. The import
// form's Check (GET /api/github/verify-access) and the submit (POST
// /api/apps with a repoUrl) still answer what they always answered for a
// URL that is no repository's and for the platform's own repository, and
// say the pause for any other, without a call to GitHub or the database.
//
// Run with: node --test tests/github-import-paused.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
const queries = [];
const pool = { query: async (sql) => { queries.push(String(sql)); return { rows: [] }; } };
poolMod.getPool = () => pool;

const github = require('../src/services/github');
const { appRoutes } = require('../src/routes/apps');
const PLATFORM = require('../src/services/repo-ref').platformRepoUrl();

const PAUSED = 'Importing a repository from GitHub is paused while Homeroom moves off GitHub.';

function server(t) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7, username: 'maker', hasPlatformAccess: true }; next(); });
  app.use(appRoutes({ platformRepoUrl: PLATFORM }, { pool }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => { t.after(() => s.close()); resolve(s); });
  });
}

test('the Check and the submit answer an import the same, and send nothing to GitHub', async (t) => {
  const sent = [];
  for (const name of ['getOctokit', 'getReadOctokit', 'getFileContent']) {
    t.mock.method(github, name, async () => { sent.push(name); throw new Error('no GitHub call'); });
  }
  const s = await server(t);
  const base = `http://127.0.0.1:${s.address().port}`;
  const check = async (url) => {
    const res = await fetch(`${base}/api/github/verify-access?url=${encodeURIComponent(url)}`);
    return [res.status, await res.json()];
  };
  const submit = async (repoUrl) => {
    const res = await fetch(`${base}/api/apps`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Imported', repoUrl }),
    });
    return [res.status, await res.json()];
  };

  assert.deepEqual(await check('https://github.com/someone/their-repo'), [503, { error: PAUSED, code: 'github_paused' }]);
  assert.deepEqual(await submit('https://github.com/someone/their-repo'), [503, { error: PAUSED }]);
  const [bad, badBody] = await check('not a repository');
  assert.equal(bad, 400);
  assert.match(badBody.error, /Repo URL must look like/);
  assert.equal((await submit('not a repository'))[0], 400);
  assert.equal((await check(PLATFORM))[0], 409);
  assert.match((await submit(PLATFORM))[1].error, /This is the platform repo/);
  assert.deepEqual(sent, []);
  assert.ok(!queries.some((q) => /INSERT INTO apps/.test(q)), 'nothing is made');
});
