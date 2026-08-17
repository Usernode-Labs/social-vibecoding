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

test('conventions doc carries the test-suite discipline section', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Repo test suites on build turns — run them efficiently$/m);
  // The batch-fix rule is the load-bearing instruction: it is what stops
  // the fix-one-rerun-all loop that made big build turns (e.g. session
  // 3255) spend 20+ minutes on redundant full-suite passes.
  assert.match(doc, /Batch-fix before retesting/);
  assert.match(doc, /At most two full-suite passes per turn/);
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

test('conventions doc carries the screenshot-state deep-link section (#768)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^### Make the changed screen URL-reachable — screenshot-state deep links$/m);
  // The @mobile annotation is documented alongside it — the capture
  // pipeline parses it (testing-notes.js), so the doc must keep teaching it.
  assert.match(doc, /@mobile/);
  // The build prompt cross-references the section by name, so the
  // heading's first half is load-bearing.
  const sessions = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8'
  );
  assert.ok(
    sessions.includes('"Make the changed screen URL-reachable"'),
    'sessions.js TESTING rules must reference the deep-link section by its current heading'
  );
  assert.ok(
    sessions.includes('@mobile'),
    'sessions.js TESTING rules must document the @mobile annotation'
  );
});

test('conventions doc carries the user-directory section (#1195)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## User directory — does this handle exist\?$/m);
  // Both surfaces: the server-side platform API and the bridge helpers.
  assert.match(doc, /\/users\/lookup\?username=/);
  assert.match(doc, /\/users\/search\?q=/);
  assert.match(doc, /usernode\.lookupUser/);
  assert.match(doc, /usernode\.searchUsers/);
  // The field allowlist is the point of the section — apps must not
  // plan features around data the directory will never return.
  assert.match(doc, /only\*\* `\{ id, username \}`/);
  // The staging story: BOTH paths now work in previews (#1213), and the
  // frontend degrade rule is still fail-OPEN.
  assert.match(doc, /staging previews/i);
  assert.match(doc, /degrade open/i);
  // The case-collision flag apps have to handle.
  assert.match(doc, /ambiguous.*true/);
});

test('the server-side directory section covers staging previews (#1213)', () => {
  const doc = getAppConventions();
  // Retitled from "(production)" — previews can reach the directory now.
  assert.match(doc, /^### From your server \(production AND staging previews\)$/m);
  // One code path, one conditional header: the app token is sent only
  // when its env var exists (production); previews send the user token
  // alone.
  assert.match(doc, /if \(process\.env\.USERNODE_LLM_PROXY_TOKEN\) \{/);
  assert.match(doc, /send \*\*only\*\*\n\s*`x-usernode-user-token`/);
  // The URL is now injected into both environments…
  assert.match(doc, /`USERNODE_PLATFORM_API_URL` is injected into \*\*both\*\* production and\nstaging containers/);
  // …but the governance feed stays token-gated, so the FEED_ENABLED
  // check that ANDs both env vars must still be documented as required.
  assert.match(doc, /`FEED_ENABLED` check above \(which ANDs `USERNODE_PLATFORM_API_URL`\n\*\*and\*\* `USERNODE_LLM_PROXY_TOKEN`\) remains correct and required/);
});

test('the offline essentials excerpt points at the user directory (#1195)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);
  // One clause on rule 8, next to the LLM proxy and file storage — an
  // agent that never reads the full doc still learns the capability
  // exists rather than inventing a directory from seen users.
  assert.match(excerpt, /usernode\.lookupUser\(\)/);
  assert.match(excerpt, /never a guess from users your app has already seen/);
});

test('conventions doc warns that seeding must not fabricate a signal (#1212)', () => {
  const doc = getAppConventions();
  assert.match(
    doc, /^### Seeded data must not fabricate a signal your logic reads$/m,
    'the seeding/logic-interaction subsection is missing or renamed'
  );
  const section = doc.slice(
    doc.indexOf('### Seeded data must not fabricate a signal your logic reads'),
    doc.indexOf('### Make the changed screen URL-reachable')
  );
  // The three habits are the load-bearing part: each one is what the real
  // case (Todo List invite validation, #1212) actually needed.
  assert.match(section, /\*\*Never seed the visitor\.\*\*/);
  assert.match(section, /\*\*Request-time seeding only behind `\?demo=1`\.\*\*/);
  assert.match(section, /\*\*Ask what the empty database answers\.\*\*/);
  // And the remedy an author can act on: assert the production shape on
  // the route that carries no seeding.
  assert.match(section, /declare a test on the\nunseeded route/);
});

test('the Proposal tests section names the gate\'s staging-only blind spot (#1212)', () => {
  const doc = getAppConventions();
  const checks = doc.slice(
    doc.indexOf('## Proposal tests — "CI for proposals"'),
    doc.indexOf('## Repo test suites on build turns')
  );
  assert.ok(checks.length > 500, 'the Proposal tests section is still there');
  assert.match(checks, /What the checks cannot see/);
  // The cross-reference has to keep matching the subsection's heading, or
  // the pointer dangles the way #218's did.
  assert.match(checks, /Seeded data must not fabricate a signal your logic reads/);
});

test('the offline essentials excerpt carries the fake-identity seed rule (#1212)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);
  // Rule 3 is the seeding rule, and an agent that only ever reads the
  // excerpt has to learn that seeding can become an INPUT to its own logic.
  assert.match(excerpt, /Seed FAKE identities only/);
  assert.match(excerpt, /never a signal your own logic reads/);
});

test('the excerpt and the full Tailwind section agree about the CDN (#1215)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);

  // The excerpt used to call a `cdn.tailwindcss.com` tag forbidden and
  // "rejected by two automated checks", while the section below called the
  // hosted copy a MIGRATION TARGET for apps still on that CDN. An agent
  // reading only the excerpt could only conclude the app was in violation
  // or the rules were wrong; both cost more than the sentence saved.
  const tailwind = doc.slice(
    doc.indexOf('## Tailwind — precompiled per app, runtime centrally hosted'),
    doc.indexOf('## Vendored shared files')
  );
  assert.ok(tailwind.length > 500, 'the full Tailwind section is still there');

  // Both halves name the same one-line migration target.
  const TARGET = /usernode-tailwind\/v1\/tailwind\.js/;
  assert.match(excerpt, TARGET);
  assert.match(tailwind, TARGET);

  // And neither claims a check rejects the CDN, because none does.
  assert.doesNotMatch(excerpt, /rejected by/i);
  assert.match(tailwind, /No proposal check rejects a `cdn\.tailwindcss\.com` tag/);
});
