// Guard test for src/prompts/app-conventions.md (#218). The "Staging mock
// data" section is load-bearing: the build prompt's DATA AVAILABILITY rule
// (src/routes/sessions.js) references it by name, so the coding agent's
// instruction to seed demo data would silently dangle if a future doc edit
// dropped or renamed the section. Same for the platform-escalation section:
// the build prompt's usernode-report-platform-issue paragraph references it
// by name, and its feature-request framing is what keeps agents from being
// overly conservative about drafting platform reports.
//
// Run with: node --test tests/app-conventions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getAppConventions } = require('../src/services/prompts.js');

const ESCALATION_HEADING =
  'Platform-level problems & missing capabilities: escalate, don\'t file workarounds';

test('conventions doc loads non-empty', () => {
  const doc = getAppConventions();
  assert.equal(typeof doc, 'string');
  assert.ok(doc.length > 0, 'app-conventions.md should load');
});

test('conventions doc carries the "Staging mock data" section (#218)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Staging mock data$/m);
});

test('conventions doc carries the escalation section, covering feature requests', () => {
  const doc = getAppConventions();
  assert.ok(
    doc.includes(`## ${ESCALATION_HEADING}`),
    'escalation section heading missing or renamed'
  );
  // The broadened framing is load-bearing: agents must treat missing
  // platform capabilities / feature requests as fair game for
  // usernode-report-platform-issue, not just breakage.
  assert.match(doc, /Missing platform capabilities/);
  assert.match(doc, /Feature requests are as valid as bug reports/);
});

test('conventions doc carries the issue-state snapshots section (#685)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Issue-state snapshots — opt-in app state in filed issues$/m);
  // The sanitization framing is load-bearing: registering the provider
  // is the app's declaration that its snapshot is safe to publish.
  assert.match(doc, /usernode\.issueState\.register/);
  assert.match(doc, /PUBLIC GitHub issue bodies/);
});

test('build prompt cross-references the escalation heading by name', () => {
  const sessions = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8'
  );
  assert.ok(
    sessions.includes(`"${ESCALATION_HEADING}"`),
    'sessions.js build prompt must reference the escalation section by its current heading'
  );
});
