// Route tests for the discovery listing metadata (category + tagline):
//   PATCH /api/apps/:slug/listing   — collaborator-gated edit
//   GET   /api/apps/:slug/builders  — view-gated merged-PR attribution
//   GET   /api/apps                 — carries the two new fields
//
// The PATCH gate mirrors the rename route (appAccess.getAppForUser at
// 'collab' level, 404 on deny — private apps stay non-enumerable); the
// builders gate is deliberately VIEW level because it feeds the
// public-facing app detail page. Validation must match the manifest
// reader (services/app-manifest.js): category in {game, tool} or null,
// tagline trimmed / <= 80 chars / no control characters.
//
// Same harness shape as tests/home-app-activity-counts.test.js:
// override getPool BEFORE requiring the route module, mount the router
// on a real express app, inject req.user, and route mock responses by
// inspecting each issued query.
//
// Run with: node --test tests/app-listing-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// Query router: getAppForUser resolves the app by slug, then (for a
// non-admin on a private-visibility app) checks app_collaborators.
// The PATCH itself is the UPDATE ... RETURNING.
function makeHandler({ app, isMember, updatedRow, builders }) {
  return async (sql, params) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: app ? [app] : [] };
    }
    if (/FROM app_collaborators/.test(sql)) {
      return { rows: isMember ? [{ '?column?': 1 }] : [] };
    }
    if (/UPDATE apps/.test(sql) && /RETURNING category, tagline/.test(sql)) {
      return { rows: [updatedRow || { category: null, tagline: null }] };
    }
    if (/FROM chat_sessions cs/.test(sql)) {
      return { rows: builders || [] };
    }
    return { rows: [] };
  };
}

function privateApp(overrides = {}) {
  return {
    id: 42,
    slug: 'demo',
    name: 'Demo App',
    created_by: 99,
    self_hosted: false,
    collab_visibility: 'private',
    view_visibility: 'public',
    ...overrides,
  };
}

async function patchListing(server, body, slug = 'demo') {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps/${slug}/listing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

test('PATCH /listing 404s non-collaborators of a collab-private app', async () => {
  capturedQueries = [];
  poolQueryHandler = makeHandler({ app: privateApp(), isMember: false });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, { category: 'game' });
    assert.strictEqual(res.status, 404);
    // The 404 must fire before any UPDATE is attempted.
    assert.ok(!capturedQueries.some((q) => /UPDATE apps/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('PATCH /listing rejects a category outside the allowed set', async () => {
  poolQueryHandler = makeHandler({ app: privateApp(), isMember: true });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, { category: 'casino' });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /listing rejects a tagline over 80 characters', async () => {
  poolQueryHandler = makeHandler({ app: privateApp(), isMember: true });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, { tagline: 'x'.repeat(81) });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /listing rejects control characters in the tagline', async () => {
  poolQueryHandler = makeHandler({ app: privateApp(), isMember: true });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, { tagline: 'line one\nline two' });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /listing rejects an empty body', async () => {
  poolQueryHandler = makeHandler({ app: privateApp(), isMember: true });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, {});
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /listing persists valid input for a collaborator', async () => {
  capturedQueries = [];
  poolQueryHandler = makeHandler({
    app: privateApp(),
    isMember: true,
    updatedRow: { category: 'game', tagline: 'Guess the number before your friends do' },
  });
  const server = await startServer();
  try {
    const { res, body } = await patchListing(server, {
      // Mixed case + padding must normalize (trim, lowercase category).
      category: ' Game ',
      tagline: '  Guess the number before your friends do  ',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.category, 'game');
    assert.strictEqual(body.tagline, 'Guess the number before your friends do');
    const upd = capturedQueries.find((q) => /UPDATE apps/.test(q.sql));
    assert.ok(upd, 'UPDATE was issued');
    assert.strictEqual(upd.params[1], 'game');
    assert.strictEqual(upd.params[3], 'Guess the number before your friends do');
  } finally {
    server.close();
  }
});

test('PATCH /listing accepts nulls to clear both fields', async () => {
  poolQueryHandler = makeHandler({
    app: privateApp(),
    isMember: true,
    updatedRow: { category: null, tagline: null },
  });
  const server = await startServer();
  try {
    const { res, body } = await patchListing(server, { category: null, tagline: null });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.category, null);
    assert.strictEqual(body.tagline, null);
  } finally {
    server.close();
  }
});

test('PATCH /listing leaves an omitted field untouched (flag params)', async () => {
  capturedQueries = [];
  poolQueryHandler = makeHandler({
    app: privateApp(),
    isMember: true,
    updatedRow: { category: 'tool', tagline: 'kept' },
  });
  const server = await startServer();
  try {
    const { res } = await patchListing(server, { category: 'tool' });
    assert.strictEqual(res.status, 200);
    const upd = capturedQueries.find((q) => /UPDATE apps/.test(q.sql));
    // hasCategory=true, hasTagline=false — the CASE WHEN guards keep
    // the tagline column as-is.
    assert.strictEqual(upd.params[0], true);
    assert.strictEqual(upd.params[2], false);
  } finally {
    server.close();
  }
});

// ── Builders ─────────────────────────────────────────────────────────

async function fetchBuilders(server, slug = 'demo') {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps/${slug}/builders`);
  return { res, body: await res.json() };
}

test('GET /builders returns merged counts for a view-public app', async () => {
  capturedQueries = [];
  poolQueryHandler = makeHandler({
    app: privateApp(), // collab-private but view-public — view gate passes
    isMember: false,
    builders: [
      { user_id: 1, username: 'alice', merged_count: 22 },
      { user_id: 2, username: 'bob', merged_count: 1 },
    ],
  });
  const server = await startServer();
  try {
    const { res, body } = await fetchBuilders(server);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.builders.map((b) => b.username), ['alice', 'bob']);
    assert.strictEqual(body.builders[0].merged_count, 22);
    const q = capturedQueries.find((c) => /FROM chat_sessions cs/.test(c.sql));
    assert.ok(q, 'builders aggregate query was issued');
    // Same predicate as GET /api/apps/:slug/merged in routes/votes.js.
    assert.match(q.sql, /cs\.status = 'merged'/);
    assert.match(q.sql, /GROUP BY cs\.user_id, u\.username/);
  } finally {
    server.close();
  }
});

test('GET /builders 404s outsiders of a view-private app', async () => {
  poolQueryHandler = makeHandler({
    app: privateApp({ view_visibility: 'private' }),
    isMember: false,
  });
  const server = await startServer();
  try {
    const { res } = await fetchBuilders(server);
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /builders 404s the self-app for non-admins', async () => {
  poolQueryHandler = makeHandler({
    app: privateApp({ self_hosted: true, view_visibility: 'public' }),
    isMember: false,
  });
  const server = await startServer();
  try {
    const { res } = await fetchBuilders(server);
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

// ── GET /api/apps carries the new fields ─────────────────────────────

test('GET /api/apps surfaces category and tagline and keeps the visibility filter', async () => {
  capturedQueries = [];
  poolQueryHandler = async (sql) => {
    if (/FROM apps a/.test(sql)) {
      return {
        rows: [{
          id: 1,
          slug: 'demo',
          name: 'Demo App',
          status: 'error',
          self_hosted: false,
          manifest_snapshot: null,
          repo_url: null,
          main_sha: null,
          created_by: 7,
          collab_visibility: 'public',
          view_visibility: 'public',
          is_collaborator: false,
          is_favorited: false,
          favorite_order: null,
          active_users: '0',
          category: 'game',
          tagline: 'Guess the number before your friends do',
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.apps[0].category, 'game');
    assert.strictEqual(body.apps[0].tagline, 'Guess the number before your friends do');
    // Non-disclosure invariant: view-private apps are absent from the
    // list entirely (SQL WHERE), not blanked per-field.
    const q = capturedQueries.find((c) => /FROM apps a/.test(c.sql));
    assert.match(q.sql, /a\.view_visibility = 'public' OR me\.user_id IS NOT NULL/);
  } finally {
    server.close();
  }
});
