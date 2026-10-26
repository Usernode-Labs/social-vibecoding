'use strict';

// The chart supplies the git host app repositories live on
// (services/git-host.js): its address, organisation and service account as
// env, its token from the Secret, and every value declared for the variables
// panel. Pinned on the templates' text, so it runs without helm.
//
// Run with: node --test tests/helm-git-host.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHART = 'deploy/helm/social-vibecoding-platform';

test('the platform gets the git host as env and its token from the Secret', () => {
  const platform = read(`${CHART}/templates/platform.yaml`);
  for (const [name, value] of [['GIT_HOST_URL', 'url'], ['GIT_HOST_INTERNAL_URL', 'internalUrl'], ['GIT_HOST_ORG', 'org'], ['GIT_HOST_USER', 'user']]) {
    assert.ok(platform.includes(`- {name: ${name}, value: {{ .Values.config.gitHost.${value} | quote }}}`), name);
  }
  assert.match(read(`${CHART}/templates/secret.yaml`), /GIT_HOST_TOKEN: \{\{ \.Values\.secrets\.gitHostToken \| default "" \| quote \}\}/);
  const values = read(`${CHART}/values.yaml`);
  assert.match(values, /gitHost:\n    url: ""\n    internalUrl: ""\n    org: apps\n    user: ""/);
  assert.match(values, /\n  gitHostToken: ""\n/);
});

test('dapp.json declares every git host variable, the token as private', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const env = new Map(manifest.platform_env.map((e) => [e.key, e]));
  for (const key of ['GIT_HOST_URL', 'GIT_HOST_INTERNAL_URL', 'GIT_HOST_ORG', 'GIT_HOST_USER']) assert.ok(env.has(key), key);
  assert.equal(env.get('GIT_HOST_ORG').default, 'apps');
  const token = manifest.secrets.find((e) => e.key === 'GIT_HOST_TOKEN');
  assert.equal(token.private, true);
});
