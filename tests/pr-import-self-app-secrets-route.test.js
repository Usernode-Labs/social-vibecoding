// Issue #727 — the self-app secrets surface must (a) badge staging-preview-only
// flags in its GET /secrets view and (b) refuse writes with an ACCURATE 403
// message: a tailored "staging-preview-only toggle" message for a flag like
// PR_IMPORT_MOCK_GITHUB (declared with a staging_default, absent from the
// platform's live process.env), and a corrected generic "edit the deploy
// workflow" message for an ordinary platform key.
//
// The staging-only rule is data-derived: manifest entry has a defined
// `staging_default` AND `!process.env[key]`. A key the deploy workflow writes
// carries a live process.env value and is therefore NOT badged/tailored.
//
// Harness shape mirrors tests/apps-last-failure-route.test.js: stub the heavy
// service imports, override getPool, mount on a real express app, hit over HTTP.
//
// Run with: node --test tests/pr-import-self-app-secrets-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  appCreator: require.resolve('../src/services/app-creator'),
  appForker: require.resolve('../src/services/app-forker'),
  caddy: require.resolve('../src/services/caddy'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  driftPoller: require.resolve('../src/services/main-drift-poller'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appManifest: require.resolve('../src/services/app-manifest'),
  renamePr: require.resolve('../src/services/rename-pr'),
  staging: require.resolve('../src/services/staging'),
  appAccess: require.resolve('../src/services/app-access'),
  lifecycle: require.resolve('../src/services/lifecycle'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => {} });
stub(ids.appForker, { forkApp: async () => {} });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
// The self-hosted branches short-circuit before touching app_secrets, so these
// throw loudly if the refusal ever falls through to a real write.
stub(ids.appSecrets, {
  setValue: async () => { throw new Error('setValue must not run for the self-app'); },
  deleteValue: async () => { throw new Error('deleteValue must not run for the self-app'); },
  getRedactedView: async () => [],
});
stub(ids.appManifest, { KEY_RE: /^[A-Z0-9_]+$/, RESERVED_KEYS: new Set() });
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });
stub(ids.appAccess, { checkAppAccess: async () => true });
stub(ids.lifecycle, { drainGuard: (_req, _res, next) => next() });

const poolMod = require('../src/db/pool');
let appRow = null;
poolMod.getPool = () => ({
  query: async (sql) => {
    const s = String(sql);
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      return appRow ? { rows: [appRow] } : { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let currentUser = null;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ selfAppPublicVoting: false }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// A key the deploy workflow writes: it has a staging_default in the manifest
// but is PRESENT in process.env, so it must NOT be badged staging-only.
const DEPLOY_WIRED_KEY = 'DEPLOY_WIRED_TEST_KEY';

function makeSelfAppRow() {
  return {
    id: 1,
    slug: 'social-vibecoding',
    self_hosted: true,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: {
      secrets: [
        {
          key: 'PR_IMPORT_MOCK_GITHUB',
          description: 'opt-in mock-GitHub adapter for previews',
          required: false,
          private: true,
          default: 'false',
          staging_default: 'true',
        },
        {
          key: 'PR_IMPORT_ENABLED',
          description: 'master switch for importing a GitHub PR as a proposal',
          required: false,
          private: true,
          default: 'false',
          staging_default: 'true',
        },
        {
          // Ordinary platform key: no staging_default → never staging-only.
          key: 'SOME_PLATFORM_URL',
          description: 'an infrastructure URL',
          required: false,
          private: false,
          default: 'https://example.test',
        },
        {
          // Declares a staging_default BUT is wired into the deploy heredoc
          // (present in process.env) → self-corrects to NOT staging-only.
          key: DEPLOY_WIRED_KEY,
          description: 'a key the operator actually wired into deploy',
          required: false,
          private: true,
          staging_default: 'true',
        },
      ],
    },
  };
}

function byKey(view, key) {
  return view.find((r) => r.key === key);
}

test('GET /secrets marks the PR-import flags stagingOnly; deploy-wired + no-staging_default keys are not', async () => {
  appRow = makeSelfAppRow();
  currentUser = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  const prevWired = process.env[DEPLOY_WIRED_KEY];
  const prevMock = process.env.PR_IMPORT_MOCK_GITHUB;
  const prevEnabled = process.env.PR_IMPORT_ENABLED;
  // The PR-import flags must be ABSENT from the platform env for the rule to
  // fire (production reality — never in the deploy heredoc); the wired key
  // must be PRESENT.
  delete process.env.PR_IMPORT_MOCK_GITHUB;
  delete process.env.PR_IMPORT_ENABLED;
  process.env[DEPLOY_WIRED_KEY] = 'live-value';
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/social-vibecoding/secrets`);
    assert.equal(res.status, 200);
    const { secrets, readOnly } = await res.json();
    assert.equal(readOnly, true, 'self-app secrets stay read-only');
    assert.equal(byKey(secrets, 'PR_IMPORT_MOCK_GITHUB').stagingOnly, true);
    assert.equal(byKey(secrets, 'PR_IMPORT_ENABLED').stagingOnly, true);
    assert.equal(byKey(secrets, 'SOME_PLATFORM_URL').stagingOnly, false,
      'a key without staging_default is never staging-only');
    assert.equal(byKey(secrets, DEPLOY_WIRED_KEY).stagingOnly, false,
      'a staging_default key present in process.env self-corrects to not-staging-only');
  } finally {
    server.close();
    if (prevWired === undefined) delete process.env[DEPLOY_WIRED_KEY]; else process.env[DEPLOY_WIRED_KEY] = prevWired;
    if (prevMock === undefined) delete process.env.PR_IMPORT_MOCK_GITHUB; else process.env.PR_IMPORT_MOCK_GITHUB = prevMock;
    if (prevEnabled === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prevEnabled;
  }
});

async function expect403(server, method, key) {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/apps/social-vibecoding/secrets/${key}`,
    method === 'PUT'
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) }
      : { method }
  );
  assert.equal(res.status, 403, `${method} ${key} should 403`);
  return (await res.json()).error;
}

test('PUT/DELETE against a staging-only flag 403s with the tailored (non-Actions-secrets) message', async () => {
  appRow = makeSelfAppRow();
  currentUser = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  const prevMock = process.env.PR_IMPORT_MOCK_GITHUB;
  delete process.env.PR_IMPORT_MOCK_GITHUB;
  const server = await startServer();
  try {
    for (const method of ['PUT', 'DELETE']) {
      const err = await expect403(server, method, 'PR_IMPORT_MOCK_GITHUB');
      assert.match(err, /staging-preview-only toggle/i, `${method}: tailored staging message`);
      assert.ok(!/Actions secret/i.test(err), `${method}: must not misdirect to Actions secrets`);
      assert.match(err, /PR_IMPORT_MOCK_GITHUB/, `${method}: names the key`);
    }
  } finally {
    server.close();
    if (prevMock === undefined) delete process.env.PR_IMPORT_MOCK_GITHUB; else process.env.PR_IMPORT_MOCK_GITHUB = prevMock;
  }
});

test('PUT/DELETE against an ordinary platform key 403s with the corrected generic message', async () => {
  appRow = makeSelfAppRow();
  currentUser = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  const server = await startServer();
  try {
    for (const method of ['PUT', 'DELETE']) {
      const err = await expect403(server, method, 'SOME_PLATFORM_URL');
      assert.match(err, /deploy workflow/i, `${method}: points at the deploy workflow`);
      assert.ok(!/staging-preview-only toggle/i.test(err), `${method}: not the staging-only wording`);
    }
  } finally {
    server.close();
  }
});
