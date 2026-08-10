'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const votes = fs.readFileSync(path.join(root, 'src/routes/votes.js'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

test('staging proposal mocks have unique ids', () => {
  const start = votes.indexOf('function stagingMockProposals(viewer)');
  const end = votes.indexOf('\nfunction stagingMockMerged', start);
  const block = votes.slice(start, end);
  const ids = [...block.matchAll(/\.\.\.mk\((900\d+)/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate staging proposal ids: ${duplicates.join(', ')}`);
});

test('testing-phase and approvals demos deep-link to separate fixtures', () => {
  const byName = new Map(dapp.tests.map((entry) => [entry.name, entry]));
  assert.match(byName.get('Checks card names the test stage on a testing run').path, /9000026$/);
  assert.match(byName.get('At-least-approvals proposal renders the approvals pill (#646)').path, /9000023$/);
});

test('declared checks do not require removed All Apps UI or write access from the view-only identity', () => {
  const names = new Set(dapp.tests.map((entry) => entry.name));
  assert.equal(names.has('All Apps tiles carry the drag-to-add grab cursor (#746)'), false);
  assert.equal(names.has("Dev '+' menu shows Proposal approvals on the self-app (#646)"), false);
});
