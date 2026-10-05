'use strict';
const { withLanguage } = require("./lib/platform-language");


// Demo rows are found and talked about by id: a declared check's path, a
// proposal author's steps, the shots agent's notes. So one number must name
// one row. The ?demo=1 governance mocks once shared 9100001-9100008 with the
// merged mocks, and an author described the wrong row for 9100002; the
// archived-session mock shared 990104 with the chat-shared session mock.
//
// Pinned here: each family of ?demo=1 mock rows has its own ids, a session
// mock id names one mock session, and the before & after shots demo states
// (src/services/shots-demo-states.js) keep a block nothing else uses, bound to
// the staging seeds they build on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const demoStates = require('../src/services/shots-demo-states');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Run one top-level mock builder on its own, the way tests/gov-apply-pending
// does, and return the ids of the rows it builds.
function mockIds(file, name, call) {
  const source = read(file);
  const from = source.slice(source.indexOf(`function ${name}(`));
  assert.ok(from.length, `${file} still has ${name}`);
  const fn = from.slice(0, from.indexOf('\n}\n') + 2);
  const rows = vm.runInNewContext(`${fn}; ${call}`, withLanguage({
    Date, Math, Number, String, JSON, Array, Object,
    connectionExhaustionMessage: () => 'fixture',
    ROLLOUT_RETRY_DETAIL: 'fixture',
  }));
  return rows.map((row) => Number(row.id));
}

const FAMILIES = {
  governance: mockIds('src/routes/issues.js', 'stagingMockGovernance', 'stagingMockGovernance()'),
  proposals: mockIds('src/routes/votes.js', 'stagingMockProposals', 'stagingMockProposals({})'),
  merged: mockIds('src/routes/votes.js', 'stagingMockMerged', 'stagingMockMerged()'),
  closedIssues: mockIds('src/routes/votes.js', 'stagingMockCompletedCloseIssues', 'stagingMockCompletedCloseIssues()'),
};

test('each family of ?demo=1 mock rows has ids of its own', () => {
  for (const [family, ids] of Object.entries(FAMILIES)) {
    assert.ok(ids.length > 0, `${family} builds rows`);
    assert.equal(new Set(ids).size, ids.length, `${family} ids are unique`);
  }
  const owner = new Map();
  for (const [family, ids] of Object.entries(FAMILIES)) {
    for (const id of ids) {
      assert.ok(!owner.has(id), `${id} is in both ${owner.get(id)} and ${family}`);
      owner.set(id, family);
    }
  }
  assert.deepEqual([Math.min(...FAMILIES.governance), Math.max(...FAMILIES.governance)], [9100070, 9100077]);
});

test('a session mock id names one mock session', () => {
  const source = read('src/routes/sessions.js');
  const branches = new Map();
  for (const match of source.matchAll(/id: (99\d{4}), branch_name: '([^']+)'/g)) {
    const id = Number(match[1]);
    if (!branches.has(id)) branches.set(id, new Set());
    branches.get(id).add(match[2]);
  }
  assert.ok(branches.size >= 8, 'the session mocks are found');
  for (const [id, names] of branches) {
    assert.equal(names.size, 1, `${id} is ${[...names].join(' and ')}`);
  }
});

test('the shots demo states keep a block of ids nothing else uses', () => {
  const [low, high] = demoStates.RESERVED_RANGE;
  const reserved = Object.values(demoStates.IDS).flat();
  assert.equal(new Set(reserved).size, reserved.length);
  assert.ok(reserved.every((id) => id >= low && id <= high));

  const inBlock = new RegExp(`\\b(${Array.from({ length: high - low + 1 }, (_, i) => low + i).join('|')})\\b`);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const users = [...walk('src'), ...walk('public/js'), 'dapp.json']
    .filter((file) => /\.(js|ts|tsx|sql|json)$/.test(file) && file !== path.join('src', 'services', 'shots-demo-states.js'))
    .filter((file) => inBlock.test(read(file)));
  assert.deepEqual(users, [], 'only the shots demo states use their block');
});

test('the shots demo states build on staging seeds that still exist', () => {
  // The challenge states join the topochain fixture season and event and
  // credit its one open challenge; the friend request comes from a #general
  // demo account. A seed that moves these leaves the states out of every
  // run, so move them here too.
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /const SEASON_ID = 900500;/);
  assert.match(migrate, /const EVENT_SEASON_ID = 900501;/);
  assert.match(migrate, /\(900507, \$2, 900502, 'Share the season announcement',[\s\S]{0,200}?TRUE, 3, FALSE, FALSE/,
    'challenge 900507 is enabled and open');
  assert.match(migrate, /'staging-demo-general-lin'/);
  const states = read('src/services/shots-demo-states.js');
  assert.match(states, /const FIXTURE_SEASON_ID = 900500;/);
  assert.match(states, /const FIXTURE_EVENT_ID = 900501;/);
  assert.match(states, /const FIXTURE_EVENT_CHALLENGE_ID = 900507;/);
});
