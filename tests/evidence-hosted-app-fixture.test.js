'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer, HTML } = require('../evidence/hosted-app-fixture');

test('the evidence hosted app is self-contained, healthy, and does not reflect launch credentials', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const page = await fetch(`${origin}/?token=must-not-appear&un-theme=light`, {
      headers: { referer: 'https://paired-platform.example.invalid/private/path?token=secret' },
    });
    const body = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'origin');
    assert.match(body, /Hosted app frame/);
    assert.match(body, /\/usernode-bridge\/v1\/bridge\.js/);
    assert.match(body, /__usernode_locale/);
    assert.match(body, /__usernode_safe_area/);
    assert.match(body, /event\.source !== parent/);
    assert.doesNotMatch(body, /must-not-appear|paired-platform|private\/path/);
    assert.doesNotMatch(HTML, /https?:\/\//);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
