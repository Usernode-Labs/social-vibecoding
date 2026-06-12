// Guard test for src/prompts/app-conventions.md (#218). The "Staging mock
// data" section is load-bearing: the build prompt's DATA AVAILABILITY rule
// (src/routes/sessions.js) references it by name, so the coding agent's
// instruction to seed demo data would silently dangle if a future doc edit
// dropped or renamed the section.
//
// Run with: node --test tests/app-conventions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAppConventions } = require('../src/services/prompts.js');

test('conventions doc loads non-empty', () => {
  const doc = getAppConventions();
  assert.equal(typeof doc, 'string');
  assert.ok(doc.length > 0, 'app-conventions.md should load');
});

test('conventions doc carries the "Staging mock data" section (#218)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Staging mock data$/m);
});
