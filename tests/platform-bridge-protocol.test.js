'use strict';

// Actual cookie routes must refuse old parent relays before touching data.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let queries = 0;
require('../src/db/pool').getPool = () => ({ async query() { queries++; return { rows: [] }; } });
const { appFileShellRoutes } = require('../src/routes/app-files');
const appDirectoryRoutes = require('../src/routes/app-directory');
const { llmGrantsRoutes } = require('../src/routes/llm-grants');
const { appPermissionsRoutes } = require('../src/routes/app-permissions');
const paths = [
  '/api/apps/fixture-app/files/usage', '/api/app-directory/users/search?q=fixture',
  '/api/apps/fixture-app/llm-grant', '/api/apps/fixture-app/permissions',
];

test('every data-bearing parent bridge endpoint requires the current relay protocol', async () => {
  const web = express();
  web.use((req, _res, next) => { req.user = { id: 5, username: 'fixture-user' }; next(); });
  web.use(appFileShellRoutes({}, { store: null }));
  web.use(appDirectoryRoutes({}));
  web.use(llmGrantsRoutes({}));
  web.use(appPermissionsRoutes({}));
  const server = web.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const headers of [{}, { 'X-Usernode-Directory-Bridge': 'platform-isolated-v1' }, { 'X-Usernode-App-Bridge': 'isolated-v1' }]) {
      for (const path of paths) {
        const result = await fetch(base + path, { headers });
        assert.equal(result.status, 403, path);
        assert.equal((await result.json()).code, 'bridge_refresh_required', path);
      }
    }
    assert.equal(queries, 0, 'stale relays never query rows');
    for (const path of paths) {
      const before = queries;
      const result = await fetch(base + path, { headers: { 'X-Usernode-App-Bridge': 'isolated-v2' } });
      assert.equal(result.status, path.includes('/app-directory/') ? 200 : 404, path);
      assert.ok(queries > before, 'current relay reaches the existing route authorization/data checks');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
