'use strict';

// One parser for a stored repository address (services/repo-ref.js): app
// repositories on Homeroom's git host, the platform's own on GitHub.
//
// Run with: node --test tests/repo-ref.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const repoRef = require('../src/services/repo-ref');

function withEnv(t, vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const HOST = { GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: 'http://forgejo-http.forgejo:3000', GIT_HOST_ORG: 'apps' };

test('both hosts parse; anything else is null', (t) => {
  withEnv(t, HOST);
  assert.deepEqual(repoRef.parse('https://git.example.test/apps/todo-list-b91765'), { host: 'git_host', owner: 'apps', repo: 'todo-list-b91765' });
  assert.deepEqual(repoRef.parse('http://forgejo-http.forgejo:3000/apps/x.git'), { host: 'git_host', owner: 'apps', repo: 'x' });
  assert.deepEqual(repoRef.parse('https://github.com/Usernode-Labs/social-vibecoding'), { host: 'github', owner: 'Usernode-Labs', repo: 'social-vibecoding' });
  assert.deepEqual(repoRef.parse('https://github.com/usernode-bot/my.app.git/'), { host: 'github', owner: 'usernode-bot', repo: 'my.app' });
  assert.deepEqual(repoRef.parse('git@github.com:o/r.git'), { host: 'github', owner: 'o', repo: 'r' });
  assert.equal(repoRef.parse('https://gitlab.com/o/r'), null);
  assert.equal(repoRef.parse('https://github.com/o'), null);
  assert.equal(repoRef.parse(''), null);
  assert.equal(repoRef.parse(null), null);
  assert.deepEqual(repoRef.ownerRepo('https://git.example.test/apps/x'), { owner: 'apps', repo: 'x' });
});

test('pages and clone addresses follow the host', (t) => {
  withEnv(t, HOST);
  const hosted = 'https://git.example.test/apps/x';
  assert.equal(repoRef.webUrl(`${hosted}.git`), hosted);
  assert.equal(repoRef.commitUrl(hosted, 'abc'), `${hosted}/commit/abc`);
  assert.equal(repoRef.treeUrl(hosted, 'dev/a b'), `${hosted}/src/branch/dev/a%20b`);
  assert.equal(repoRef.compareUrl(hosted, 'main', 'dev/x'), `${hosted}/compare/main...dev%2Fx`);
  assert.equal(repoRef.cloneUrl(hosted), 'http://forgejo-http.forgejo:3000/apps/x.git');
  assert.equal(repoRef.cloneUrl(hosted, { internal: false }), 'https://git.example.test/apps/x.git');
  const gh = 'https://github.com/Usernode-Labs/social-vibecoding';
  assert.equal(repoRef.treeUrl(gh, 'main'), `${gh}/tree/main`);
  assert.equal(repoRef.cloneUrl(gh), `${gh}.git`);
});

test('the owner alone says which host a GitHub-shaped helper is talking to', (t) => {
  withEnv(t, HOST);
  assert.equal(repoRef.hostOfOwner('apps'), 'git_host');
  assert.equal(repoRef.hostOfOwner('Apps'), 'git_host');
  assert.equal(repoRef.hostOfOwner('Usernode-Labs'), 'github');
  withEnv(t, { GIT_HOST_URL: undefined });
  assert.equal(repoRef.hostOfOwner('apps'), 'github', 'no git host configured: everything is GitHub, as before');
});

test('the platform repository is recognised whichever way it is spelled', (t) => {
  withEnv(t, { ...HOST, USERNODE_PLATFORM_REPO: undefined, USERNODE_REPO_URL: undefined });
  assert.equal(repoRef.isPlatformRepo('https://github.com/usernode-labs/Social-Vibecoding.git'), true);
  assert.equal(repoRef.isPlatformRepo({ repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' }), true);
  assert.equal(repoRef.isPlatformRepo('https://git.example.test/apps/social-vibecoding'), false);
  assert.equal(repoRef.isPlatformRepo('https://git.example.test/apps/x', { platformRepoUrl: 'https://git.example.test/apps/x' }), true);
});
