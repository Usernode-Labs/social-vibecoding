'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyDeletionInventory } = require('../scripts/kpack-local-fixture');
const { LABEL } = require('./lib/isolated-kpack-fixture');

function inventory() {
  const state = {
    fixtureId: 'dedicated', createdAt: '2026-01-01T00:00:00Z', clusterName: 'c4-test',
    networkId: 'network-id', images: { node: 'node@sha256:pinned' },
    nodes: [{ id: 'node-id', name: '/c4-test-control-plane', volumes: ['new-volume'] }],
    database: { containerId: 'database-id', image: 'postgres@sha256:pinned' },
  };
  const node = {
    Id: 'node-id', Name: '/c4-test-control-plane', Created: '2026-01-01T00:00:01Z',
    Config: { Image: state.images.node, Labels: { 'io.x-k8s.kind.cluster': state.clusterName } },
    Mounts: [{ Type: 'volume', Name: 'new-volume' }],
  };
  const database = {
    Id: 'database-id', Name: '/c4-test-postgres', Created: node.Created,
    Config: { Image: state.database.image, Labels: { [LABEL]: state.fixtureId } }, Mounts: [],
  };
  return {
    state, containers: [node, database],
    net: { Id: state.networkId, Name: 'c4-test-network', Labels: { [LABEL]: state.fixtureId }, Containers: { 'node-id': {}, 'database-id': {} } },
    volumes: [{ Name: 'new-volume', CreatedAt: node.Created }], consumers: { 'new-volume': ['node-id'] },
  };
}

function verify(f) {
  verifyDeletionInventory(f.state, f.containers, f.net, f.volumes, f.consumers);
}

test('fixture teardown accepts only recorded identities and remains resumable after partial removal', () => {
  const f = inventory();
  verify(f);
  f.containers.pop();
  delete f.net.Containers['database-id'];
  verify(f);
  f.containers = [];
  f.net = null;
  verify(f);
});

for (const [name, change] of [
  ['successor container', f => { f.containers[0].Id = 'successor'; }],
  ['changed image', f => { f.containers[0].Config.Image = 'another-image'; }],
  ['changed owner label', f => { f.containers[1].Config.Labels[LABEL] = 'another'; }],
  ['old volume', f => { f.volumes[0].CreatedAt = '2025-01-01T00:00:00Z'; }],
  ['unrecorded volume', f => { f.state.nodes[0].volumes = []; }],
  ['shared volume', f => { f.consumers['new-volume'].push('unrelated-container'); }],
  ['successor network', f => { f.net.Id = 'successor'; }],
  ['unrelated network member', f => { f.net.Containers.other = {}; }],
]) {
  test(`fixture teardown rejects ${name} before deletion`, () => {
    const f = inventory();
    change(f);
    assert.throws(() => verify(f), /ownership mismatch|network has changed/);
  });
}

for (const [name, alter] of [
  ['version', state => { state.version = 2; }],
  ['cluster name', state => { state.clusterName = 'existing-cluster'; }],
]) {
  test(`fixture commands reject a mismatched journal ${name} before Docker access`, t => {
    const id = randomUUID();
    const directory = path.join(os.tmpdir(), `preview-recovery-test-${id}`);
    fs.mkdirSync(directory);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const state = { version: 1, fixtureId: id, directory, clusterName: `c4-preview-${id}` };
    alter(state);
    fs.writeFileSync(path.join(directory, 'setup-state.json'), JSON.stringify(state));
    for (const command of ['setup', 'teardown']) {
      const result = spawnSync(process.execPath, ['scripts/kpack-local-fixture.js', command, directory], {
        env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /fixture journal identity mismatch/);
    }
  });
}
