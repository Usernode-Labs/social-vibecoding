// What a release hands to app-creation (src/workflow/platform.ts ADOPTIONS,
// run by the release machine's release.adopt): the projects an older build
// was making, and the first requests it left open. Never on a staging
// preview: its rows are a copy of production's, so adopting them would set
// up production's projects again, and file their requests a second time, on
// the copy.
//
// Run with: node --test tests/workflow-creation-adoptions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const platform = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'platform.ts'), 'utf8');
const body = (name) => {
  const fn = platform.slice(platform.indexOf(`async function ${name}(`));
  return fn.slice(0, fn.indexOf('\n}\n'));
};

test('a release adopts the projects being made and the first requests left open', () => {
  const adoptions = platform.slice(platform.indexOf('const ADOPTIONS'));
  const list = adoptions.slice(0, adoptions.indexOf(']);'));
  assert.match(list, /\['appCreations', \(\) => adoptAppCreations\(\)\]/);
  assert.match(list, /\['firstRequests', \(\) => adoptFirstRequests\(\)\]/);
});

for (const name of ['adoptAppCreations', 'adoptFirstRequests']) {
  test(`${name} runs only where the platform maintains its own rows, never on a staging preview`, () => {
    assert.match(body(name), /^async function \w+\(\): Promise<number> \{\n {2}if \(!runtime \|\| !legacy\('config'\)\.runsClusterMaintenance\(\)\) return 0;/);
  });
}

test('the guard is false on a staging preview', () => {
  const { runsClusterMaintenance } = require('../src/config');
  const env = process.env.USERNODE_ENV;
  const hatch = process.env.STAGING_CLUSTER_MAINTENANCE;
  try {
    process.env.USERNODE_ENV = 'staging';
    delete process.env.STAGING_CLUSTER_MAINTENANCE;
    assert.equal(runsClusterMaintenance(), false);
    delete process.env.USERNODE_ENV;
    assert.equal(runsClusterMaintenance(), true);
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    if (hatch === undefined) delete process.env.STAGING_CLUSTER_MAINTENANCE; else process.env.STAGING_CLUSTER_MAINTENANCE = hatch;
  }
});
