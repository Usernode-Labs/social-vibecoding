'use strict';

// What web may ask of the workflow (SEC-09): each machine lists the events
// web may append, and the rules that trust a `system` source do not trust
// web's claim of one where it would let web choose what the platform alone
// chooses. The pipeline and the database's side are
// tests/workflow-producers-postgres.test.js. No database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appDelivery } = require('../src/workflow/app-delivery/machine.ts');
const { benchLane } = require('../src/workflow/bench-lane/machine.ts');
const { botChange } = require('../src/workflow/bot-change/machine.ts');
const { workerInterrupt, DISPATCH } = require('../src/workflow/worker-stop/interrupt.ts');

const REPO = path.join(__dirname, '..');
const event = (type, payload, o = {}) => ({
  id: 1, type, payload, source: { kind: 'system' }, producer: 'platform', actor: null,
  requestKey: 'r', appId: null, causedBy: null, ...o,
});
const rule = (machine, type) => (e, facts = {}) => machine.authorize.get(type)(e, facts, { name: 'idle', data: null });
const refused = { reject: 'not_a_producer' };

test('every workflow machine says what web may append, even when it is nothing', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory() && f.name !== 'kernel') walk(p);
      else if (f.isFile() && p.endsWith('.ts') && /\bdefineMachine</.test(fs.readFileSync(p, 'utf8'))) files.push(p);
    }
  };
  walk(path.join(REPO, 'src/workflow'));
  assert.ok(files.length >= 27, `found ${files.length} machine files`);
  for (const f of files) {
    const n = (fs.readFileSync(f, 'utf8').match(/\bdefineMachine</g) || []).length;
    const lists = (fs.readFileSync(f, 'utf8').match(/^\s+(?:\/\/.*\n\s+)*web: \[|, web: \[/gm) || []).length;
    assert.equal(lists, n, `${path.relative(REPO, f)}: each defineMachine names its web list`);
  }
});

test('web asks app delivery for an admin\'s redeploy of main, never for an image or a commit', () => {
  const ask = rule(appDelivery(), 'DeployRequested');
  const redeploy = { appId: 7, reason: 'redeploy', prNumber: null, revision: null, reuse: null };
  const admin = { source: { kind: 'admin', name: 'redeploy' }, producer: 'web', actor: 'user:1' };
  assert.equal(ask(event('DeployRequested', redeploy, admin)), true);
  const image = { owner: 'acme', repo: 'victim', commitSha: 'a'.repeat(40), imageRef: 'registry.example/x:1' };
  for (const extra of [{ reuse: image }, { revision: 'b'.repeat(40) }, { prNumber: 3 }, { reason: 'rollover' }]) {
    assert.deepEqual(ask(event('DeployRequested', { ...redeploy, ...extra }, admin)), refused, JSON.stringify(extra));
  }
  // Claiming the platform's own source changes nothing for web.
  assert.deepEqual(ask(event('DeployRequested', { ...redeploy, reason: 'rollover', reuse: image },
    { source: { kind: 'system', name: 'rollover' }, producer: 'web' })), refused);
  // The conductor's rollover still offers the image it built.
  assert.equal(ask(event('DeployRequested', { ...redeploy, reason: 'rollover', reuse: image })), true);
});

test('only the conductor makes a dispatch interrupt; web interrupts as a person', () => {
  const ask = rule(workerInterrupt(), 'Requested');
  const dispatch = { userId: null, strategy: 'turn', active: true, turnId: 't1', journal: '/j' };
  assert.equal(ask(event('Requested', dispatch, { source: { kind: 'system', name: DISPATCH } }), { reason: null }), true);
  assert.deepEqual(ask(event('Requested', dispatch, { source: { kind: 'system', name: DISPATCH }, producer: 'web' }), { reason: null }), refused);
});

test('a bench cancel or a follow-up retry from web is an admin\'s', () => {
  const lane = benchLane();
  for (const type of ['RunCancelled', 'TrialCancelled']) {
    const ask = rule(lane, type);
    assert.deepEqual(ask(event(type, {}, { producer: 'web' })), refused, type);
    assert.equal(ask(event(type, {}, { producer: 'web', source: { kind: 'admin' }, actor: 'user:1' })), true, type);
    assert.equal(ask(event(type, {})), true, `${type} from the conductor`);
  }
  const retry = rule(botChange(), 'RetryFollowup');
  assert.deepEqual(retry(event('RetryFollowup', {}, { producer: 'web' })), refused);
  assert.equal(retry(event('RetryFollowup', {}, { producer: 'web', source: { kind: 'admin' }, actor: 'user:1' })), true);
  assert.equal(retry(event('RetryFollowup', {})), true);
});

test('an admin\'s release of a faulted instance runs on a conductor, as the admin it still is', async (t) => {
  const op = require('../src/services/workflow-release-operation');
  const platformPath = require.resolve('../src/workflow/platform.ts');
  const saved = require.cache[platformPath];
  const calls = [];
  let answer = { released: true, heldEvents: 2 };
  require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true,
    exports: { releaseFaulted: async (...args) => { calls.push(args); return answer; } } };
  t.after(() => { if (saved) require.cache[platformPath] = saved; else delete require.cache[platformPath]; });
  const request = { op: 'workflow.release', input: { machine: 'proposal', key: 'session:9', mode: 'skip' } };
  assert.equal(await op.authorize({}, request, { canAdminWrite: true }), null);
  assert.equal((await op.authorize({}, request, { canAdminWrite: false })).status, 403);
  assert.deepEqual(await op.run({}, request, { id: 5 }), answer);
  assert.deepEqual(calls, [['proposal', 'session:9', 'skip', 5]]);
  // Demoted between the route and the release: the kernel's own admission says so.
  answer = { released: false, reason: 'not_authorized' };
  const out = await op.run({}, request, { id: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
});
