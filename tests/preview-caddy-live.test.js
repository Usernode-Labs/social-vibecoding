'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createBindingAdapters } = require('../src/services/preview-flow/binding-adapters');

const exec = promisify(execFile);
const image = process.env.PREVIEW_CADDY_TEST_IMAGE;

// Explicit opt-in: never touch an existing edge or depend on Docker in unit CI.
// No published ports, no external network; the admin endpoint stays loopback.
test('real Caddy conditional API preserves a successor and supports the Docker exec transport', { skip: !image }, async () => {
  const name = `preview-b1-caddy-${randomUUID()}`;
  async function wget(args) {
    return exec('docker', ['exec', name, 'wget', '-S', '-O', '-', ...args], { timeout: 15000 });
  }

  await exec('docker', ['run', '--rm', '--detach', '--network', 'none', '--name', name, image]);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await wget(['http://127.0.0.1:2019/config/']);
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const map = {
      handler: 'map',
      source: '{http.request.host}',
      destinations: ['{upstream}', '{applink}'],
      mappings: [{
        input_regexp: '^([a-z0-9-]+?)--s(\\d+)(?:--[a-z0-9]+)?\\.',
        outputs: ['usernode-staging-s${2}', ''],
      }],
    };
    const body = { apps: { http: { servers: { test: {
      listen: [':8080'],
      routes: [{ handle: [map, { handler: 'static_response', body: 'test' }] }],
    } } } } };
    await wget(['--header=Content-Type: application/json', `--post-data=${JSON.stringify(body)}`, 'http://127.0.0.1:2019/load']);
    const config = { previewCaddyContainer: name };
    const routes = createBindingAdapters();
    const ref = { runtimeKind: 'docker', hostname: 'demo--s42.example.test' };
    const expected = await routes.inspect(config, ref);
    assert.equal(expected.target, 'usernode-staging-s42');
    assert.ok(expected.token);
    await routes.activate(config, ref, expected, { runtimeName: 'candidate-a' });
    assert.equal((await routes.inspect(config, ref)).target, 'candidate-a');
    await assert.rejects(routes.activate(config, ref, expected, { runtimeName: 'stale-candidate' }), /changed/);
    await assert.rejects(wget([
      '--header=Content-Type: application/json', `--header=If-Match: ${expected.token}`,
      `--post-data=${JSON.stringify(body)}`, 'http://127.0.0.1:2019/config/',
    ]), error => /412/.test(error.stderr));
    assert.equal((await routes.inspect(config, ref)).target, 'candidate-a');
  } finally {
    await exec('docker', ['rm', '--force', name]);
  }
});
