'use strict';

// The stale-fork guard, moved to where it fires in time to matter (#1462).
//
// A session was dispatched onto a ready-made branch in a fork whose main was
// 76 commits behind the app's real repository. It ran `git fetch origin`, saw
// origin/main identical to HEAD, and concluded it was current — a fork that
// far behind is perfectly up to date WITH ITS OWN REMOTE. It then answered a
// question about the app from code that no longer existed. Only the user
// caught it.
//
// Both guards for this already existed and both were out of reach:
//
//   1. get_checkout_status was named only in the full charter, behind
//      get_connector_guidance. An agent answering a question never has to
//      call anything, so it read the charter hours later, after the damage.
//      Fixed by giving `verify-your-checkout` a brief — see
//      tests/connector-checkout-status.test.js, which used to assert the
//      opposite on purpose and now records the decision it demanded.
//   2. The base gate fired at submit_work as `base_mismatch`, after the
//      change was written. prepare_work already holds everything needed to
//      say it at the start, which is what this file covers.
//
// Run with: node --test tests/connector-stale-checkout-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOLS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'mcp-tools.js'), 'utf8');

// Rebuild the warning from the shipped source so the wording under test is
// the wording that ships. It closes over nothing, which is what makes this
// possible — see the arrow it is declared as in mcp-tools.js.
function buildWarning() {
  const start = TOOLS_SRC.indexOf('const staleCheckoutWarning = (checkout) => {');
  assert.ok(start > -1, 'staleCheckoutWarning is defined in mcp-tools.js');
  const end = TOOLS_SRC.indexOf('\n  };', start);
  assert.ok(end > start, 'and its body is delimited as expected');
  const src = TOOLS_SRC.slice(start, end + '\n  };'.length);
  // eslint-disable-next-line no-new-func
  return new Function(`${src} return staleCheckoutWarning;`)();
}

const warn = buildWarning();

const status = (over = {}) => ({
  verdict: 'behind',
  behindBy: 76,
  aheadBy: 0,
  remoteIsCanonical: false,
  canonicalRepo: 'https://github.com/Usernode-Labs/social-vibecoding',
  baseToUse: 'a'.repeat(40),
  note: '',
  ...over,
});

// ── silence is reserved for the two cases that earn it ──────────────────

test('a checkout that was never checked is silent, and says nothing either way', () => {
  // null is "no headSha was passed", which must NOT read as "checked, fine".
  // The connector cannot detect a checkout it was never told about; the
  // instructions brief is what covers that gap, not this.
  assert.equal(warn(null), '');
  assert.equal(warn(undefined), '');
});

test('current and ahead are silent', () => {
  assert.equal(warn(status({ verdict: 'current', behindBy: 0, remoteIsCanonical: true })), '');
  // A branch with commits on it is ahead of the default branch. That is the
  // ordinary state of doing work, not a divergence worth a warning.
  assert.equal(warn(status({ verdict: 'ahead', behindBy: 0, aheadBy: 3 })), '');
});

// ── and every other verdict speaks ──────────────────────────────────────

test('a stale fork is named as a fork, with the distance', () => {
  const out = warn(status());
  assert.match(out, /THIS CHECKOUT IS NOT THE APP'S CURRENT CODE \(behind\)/);
  assert.match(out, /origin is NOT the app's own repository, so it is a fork/);
  assert.match(out, /76 commits behind/);
  // The point of firing here rather than at submit_work: the agent may
  // already have concluded something from this checkout.
  assert.match(out, /may describe a version that no longer exists/);
  assert.match(out, /say so to the user rather than letting the answer stand/);
  // And it must not send the agent off to fix the base itself — which commit
  // a change is diffed against decides what the group votes on.
  assert.match(out, /work order below carries the RIGHT base commit/);
  assert.match(out, /rather than merging a default branch yourself/);
});

test('a behind checkout on the canonical repo is not called a fork', () => {
  const out = warn(status({ remoteIsCanonical: true, behindBy: 4 }));
  assert.match(out, /not at the app's current default branch/);
  assert.doesNotMatch(out, /fork/);
  assert.match(out, /4 commits behind/);
});

test('the distance is omitted rather than guessed when it is unknown', () => {
  for (const behindBy of [null, undefined, 0]) {
    const out = warn(status({ behindBy, remoteIsCanonical: true }));
    assert.ok(out.length > 0, 'it still warns');
    assert.doesNotMatch(out, /commits? behind/, 'but claims no number it does not have');
  }
  assert.match(warn(status({ behindBy: 1, remoteIsCanonical: true })), /1 commit behind/,
    'and the singular reads correctly');
});

test('diverged and unknown_commit both warn', () => {
  assert.match(warn(status({ verdict: 'diverged' })), /NOT THE APP'S CURRENT CODE \(diverged\)/);
  assert.match(
    warn(status({ verdict: 'unknown_commit', behindBy: null })),
    /NOT THE APP'S CURRENT CODE \(unknown_commit\)/,
  );
});

test('a check that could not run is never reported as a pass', () => {
  const out = warn(status({ verdict: 'repo_unreachable', behindBy: null }));
  assert.match(out, /COULD NOT BE VERIFIED/);
  assert.match(out, /Treat it as unverified rather than as checked and fine/);
  // This is the failure the whole request is about, one level up: a check
  // that says nothing must not read as a check that said yes.
  assert.doesNotMatch(out, /NOT THE APP'S CURRENT CODE/);
});

// ── how it is wired into prepare_work ───────────────────────────────────

function prepareWorkBlock() {
  const start = TOOLS_SRC.indexOf("server.registerTool('prepare_work'");
  const end = TOOLS_SRC.indexOf("server.registerTool('submit_work'", start);
  assert.ok(start > -1 && end > start, 'the prepare_work registration is findable');
  return TOOLS_SRC.slice(start, end);
}

test('prepare_work takes the checkout in, and reports it back', () => {
  const block = prepareWorkBlock();
  assert.match(block, /headSha: z\.string\(\)\.optional\(\)/);
  assert.match(block, /remoteUrl: z\.string\(\)\.optional\(\)/);
  assert.match(block, /checkout: z\.object\(\{/, 'the verdict rides in the output');
  assert.match(block, /\}\)\.nullable\(\)/, 'and is nullable, because not asked is not fine');
  assert.match(block, /async \(\{ slug, requestNumber, brief, restart, proposalId, headSha, remoteUrl \}\)/);
});

test('the check is advisory: it never withholds the work order', () => {
  const block = prepareWorkBlock();
  // The work order carries the RIGHT base, so a stale checkout is a thing to
  // say loudly, not a reason to refuse the one artifact that fixes it.
  const checkAt = block.indexOf('let checkout = null;');
  const returnAt = block.indexOf('return toolResult({');
  assert.ok(checkAt > -1 && checkAt < returnAt, 'it runs before the result is built');
  const region = block.slice(checkAt, returnAt);
  assert.doesNotMatch(region, /return toolError/, 'and never turns a verdict into a refusal');
  // A failure inside the check must not lose the work order either — the same
  // rule the board claim above it already follows.
  assert.match(region, /catch \(err\)/);
  assert.match(region, /checkout check failed \(continuing\)/);
});

test('it is opt-in, because the connector cannot see a checkout it was not told about', () => {
  const block = prepareWorkBlock();
  assert.match(block, /if \(typeof headSha === 'string' && headSha\.trim\(\)\)/);
  // Which is exactly why the instructions brief exists as well: this half
  // only fires for a caller that already thought to pass its HEAD.
  const charter = require('../src/services/mcp-charter');
  assert.ok(charter.SERVER_INSTRUCTIONS.includes('get_checkout_status'));
});

test('the same comparison backs both tools, rather than a second copy of it', () => {
  const block = prepareWorkBlock();
  assert.match(block, /require\('\.\/checkout-status'\)/);
  assert.match(block, /checkoutStatus\(\{ gh: require\('\.\/github'\) \}/);
  // get_checkout_status resolves the app the same way, so a divergence
  // between the two answers is not possible.
  assert.match(block, /repoUrl: app\.repo_url \|\| null/);
});
