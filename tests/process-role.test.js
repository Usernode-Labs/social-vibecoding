'use strict';

// What a platform process runs (services/process-role.js,
// docs/plans/web-and-conductor.md): read from PROCESS_ROLE, 'all' when unset,
// and refused at boot when it names no role.
//
// Run with: node --test tests/process-role.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const processRole = require('../src/services/process-role');

test('PROCESS_ROLE names what a process runs; unset is all', () => {
  assert.equal(processRole.processRole({}), 'all');
  assert.equal(processRole.processRole({ PROCESS_ROLE: '' }), 'all');
  assert.equal(processRole.processRole({ PROCESS_ROLE: 'web' }), 'web');
  assert.equal(processRole.processRole({ PROCESS_ROLE: ' Conductor ' }), 'conductor');
  assert.equal(processRole.processRole({ PROCESS_ROLE: 'all' }), 'all');
});

test('a value that names no role fails boot rather than guess', () => {
  assert.throws(() => processRole.processRole({ PROCESS_ROLE: 'conductr' }), /PROCESS_ROLE must be one of all, web, conductor/);
});

test('a web process runs no workflow; the others do, and none is elected', () => {
  assert.equal(processRole.runsWorkflow('web'), false);
  assert.equal(processRole.runsWorkflow('conductor'), true);
  assert.equal(processRole.runsWorkflow('all'), true);
  assert.equal(processRole.standsForLeader, undefined);
});

test('a release replaces a workflow process with a workflow process and a web process with a server', () => {
  assert.deepEqual([...processRole.successorRoles('conductor')].sort(), ['all', 'conductor']);
  assert.deepEqual([...processRole.successorRoles('all')].sort(), ['all', 'conductor']);
  assert.deepEqual([...processRole.successorRoles('web')].sort(), ['all', 'web']);
  assert.ok(!processRole.successorRoles('web').includes('conductor'), 'a conductor takes no requests');
  assert.ok(!processRole.successorRoles('conductor').includes('web'), 'a web process never leads');
});
