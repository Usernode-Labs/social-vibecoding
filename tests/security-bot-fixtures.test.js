'use strict';

// The security bot's full synthetic fixture set (services/security-bot/fixtures.js):
// the five personas, two private projects with disjoint membership, obviously
// fake data, per-run secret markers, and the probe-owner mapping.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('../src/services/security-bot/fixtures');

test('the cast has all five personas with their roles', () => {
  const { personas } = fixtures.buildFixtureSet({ runId: 7 });
  assert.equal(personas.alice.role, 'member');
  assert.equal(personas.bob.role, 'member');
  assert.equal(personas.nonMember.role, 'member');
  assert.equal(personas.readOnlyAdmin.role, 'read_only_admin');
  assert.equal(personas.fullAdmin.role, 'full_admin');
  // The full admin exists only inside the disposable build.
  assert.equal(personas.fullAdmin.controllerOnly, true);
  // Distinct identities.
  const refs = Object.values(personas).map((p) => p.identityRef);
  assert.equal(new Set(refs).size, refs.length);
});

test('every fabricated identity is obviously fake', () => {
  const { personas } = fixtures.buildFixtureSet({ runId: 1 });
  for (const p of Object.values(personas)) {
    assert.ok(p.username.startsWith('arena-demo-'), `${p.username} is not obviously fake`);
    assert.ok(p.displayName.startsWith('Arena demo'));
  }
});

test('projects A and B have disjoint membership', () => {
  const { personas, projects } = fixtures.buildFixtureSet({ runId: 2 });
  assert.deepEqual(projects.A.memberRefs, [personas.alice.identityRef]);
  assert.deepEqual(projects.B.memberRefs, [personas.bob.identityRef]);
  const overlap = projects.A.memberRefs.filter((r) => projects.B.memberRefs.includes(r));
  assert.equal(overlap.length, 0);
  // The non-member belongs to neither project.
  assert.ok(!projects.A.memberRefs.includes(personas.nonMember.identityRef));
  assert.ok(!projects.B.memberRefs.includes(personas.nonMember.identityRef));
});

test('each project secret carries this run marker and is obviously fake', () => {
  const set = fixtures.buildFixtureSet({ runId: 42 });
  assert.ok(set.runMarker.startsWith('secbot-run-42-'));
  for (const project of [set.projects.A, set.projects.B]) {
    assert.ok(project.secret.includes(set.runMarker), 'secret must carry the run marker');
    assert.ok(project.secret.startsWith('arena-demo-secret-'));
    assert.ok(project.name.startsWith('Arena demo project'));
  }
  assert.notEqual(set.projects.A.secret, set.projects.B.secret);
});

test('two runs never share a marker', () => {
  const a = fixtures.buildFixtureSet({ runId: 5 });
  const b = fixtures.buildFixtureSet({ runId: 5 });
  assert.notEqual(a.runMarker, b.runMarker);
  assert.notEqual(a.projects.A.secret, b.projects.A.secret);
});

test('probeOwners maps onto the cross-account probe shape', () => {
  const set = fixtures.buildFixtureSet({ runId: 9 });
  const { ownerA, ownerB } = fixtures.probeOwners(set);
  // ownerA is alice authorized for project A; ownerB is bob authorized for B.
  assert.equal(ownerA.identityRef, set.personas.alice.identityRef);
  assert.equal(ownerA.username, set.projects.A.key);
  assert.equal(ownerA.secret, set.projects.A.secret);
  assert.equal(ownerB.identityRef, set.personas.bob.identityRef);
  assert.equal(ownerB.username, set.projects.B.key);
  assert.equal(ownerB.secret, set.projects.B.secret);
});

test('an invalid run id is refused', () => {
  assert.throws(() => fixtures.buildFixtureSet({ runId: -1 }), /invalid_run_id/);
  assert.throws(() => fixtures.buildFixtureSet({}), /invalid_run_id/);
});
