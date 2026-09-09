// #1433 — the connector's checkout-drift check.
//
// The bug this covers is not "a field is missing", it is that the check an
// agent naturally runs against a fork returns a FALSE PASS. So the tests
// that matter are the ones pinning the two things that make the answer
// trustworthy: that it compares against the CANONICAL repository rather than
// the caller's remote, and that a fork one week behind comes back as
// `behind` with a number, rather than as `current`.
//
// Run with: node --test tests/connector-checkout-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkoutStatus } = require('../src/services/checkout-status');
const charter = require('../src/services/mcp-charter');
const {
  READ_ONLY_TOOL_PREFIXES,
  SERVER_INSTRUCTIONS_MAX_CHARS,
} = require('../src/services/mcp-connect-constants');

const TOOLS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8'
);

const CANONICAL = 'https://github.com/Usernode-Labs/social-vibecoding';
// The two commits from the session that found this: the fork's main, and the
// platform build that was actually live a week later.
const FORK_HEAD = '16787300a26563ebbb089335d3e5072d5f9f9fb8';
const LIVE_HEAD = '79f89486addfd113760689aee6589fcce7ed1303';

const realGh = require('../src/services/github');

// A gh stub carrying the real URL parser — parseGithubUrl is pure, and the
// fork/canonical comparison is exactly what must not be faked.
function ghStub({ head, compare, headThrows, compareThrows }) {
  return {
    parseGithubUrl: realGh.parseGithubUrl,
    async getRepoHead() {
      if (headThrows) throw headThrows;
      return head;
    },
    async compareCommitAncestry() {
      if (compareThrows) throw compareThrows;
      return compare;
    },
  };
}

const LIVE = {
  defaultBranch: 'main',
  headSha: LIVE_HEAD,
  headCommittedAt: '2026-08-26T06:19:29Z',
};

// ── The false pass ─────────────────────────────────────────────────────

test('a fork a week behind reports behind, with the count', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'diverged', aheadBy: 0, behindBy: 92, mergeBaseSha: FORK_HEAD } }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD, remoteUrl: 'https://github.com/es92/social-vibecoding' }
  );

  assert.equal(answer.verdict, 'behind');
  assert.equal(answer.behindBy, 92);
  assert.equal(answer.aheadBy, 0);
  assert.equal(answer.containsCommit, true);

  // The whole point: the caller's remote is NOT the canonical repository,
  // and the answer says so rather than letting `git fetch origin` stand.
  assert.equal(answer.remoteIsCanonical, false);
  assert.match(answer.note, /fork/i);
  assert.match(answer.note, /git fetch origin/);

  // And it hands back the commit to catch up to, not an instruction to merge.
  assert.equal(answer.baseToUse, LIVE_HEAD);
  assert.equal(answer.canonicalRepo, CANONICAL);
});

test('the same checkout on the canonical remote is behind but not flagged as a fork', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'behind', aheadBy: 0, behindBy: 92, mergeBaseSha: FORK_HEAD } }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD, remoteUrl: CANONICAL }
  );
  assert.equal(answer.verdict, 'behind');
  assert.equal(answer.remoteIsCanonical, true);
  assert.doesNotMatch(answer.note, /fork/i);
});

test('an omitted remote leaves remoteIsCanonical null, not false', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'behind', aheadBy: 0, behindBy: 3, mergeBaseSha: FORK_HEAD } }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD }
  );
  // "not told" must not read as "confirmed wrong".
  assert.equal(answer.remoteIsCanonical, null);
  assert.doesNotMatch(answer.note, /fork/i);
});

test('the four URL spellings of one repository all count as canonical', async () => {
  for (const remote of [
    'https://github.com/Usernode-Labs/social-vibecoding',
    'https://github.com/Usernode-Labs/social-vibecoding/',
    'https://github.com/Usernode-Labs/social-vibecoding.git',
    'git@github.com:Usernode-Labs/social-vibecoding',
    // Case differs from the recorded URL; the same repository nonetheless.
    'https://github.com/usernode-labs/SOCIAL-VIBECODING',
  ]) {
    const answer = await checkoutStatus(
      { gh: ghStub({ head: LIVE, compare: { status: 'identical', aheadBy: 0, behindBy: 0, mergeBaseSha: LIVE_HEAD } }) },
      { repoUrl: CANONICAL, headSha: LIVE_HEAD, remoteUrl: remote }
    );
    assert.equal(answer.remoteIsCanonical, true, remote);
  }
});

// ── The other verdicts ─────────────────────────────────────────────────

test('an exact match is current, and spends no compare call', async () => {
  let compared = false;
  const gh = ghStub({ head: LIVE, compare: null });
  gh.compareCommitAncestry = async () => { compared = true; return {}; };

  const answer = await checkoutStatus({ gh }, { repoUrl: CANONICAL, headSha: LIVE_HEAD });
  assert.equal(answer.verdict, 'current');
  assert.equal(answer.behindBy, 0);
  assert.equal(compared, false, 'the common case costs one GitHub call, not two');
});

test('an abbreviated sha matches the canonical head', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: null }) },
    { repoUrl: CANONICAL, headSha: '79f8948' }
  );
  assert.equal(answer.verdict, 'current');
});

test('a commit the canonical repository has never seen is unknown_commit', async () => {
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compareThrows: notFound }) },
    { repoUrl: CANONICAL, headSha: 'a'.repeat(40) }
  );
  assert.equal(answer.verdict, 'unknown_commit');
  assert.equal(answer.containsCommit, false);
  assert.match(answer.note, /prepare_work/);
});

test('local work on top of the canonical head is ahead, not a problem', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseSha: LIVE_HEAD } }) },
    { repoUrl: CANONICAL, headSha: 'b'.repeat(40) }
  );
  assert.equal(answer.verdict, 'ahead');
  assert.doesNotMatch(answer.note, /behind/i);
});

test('both directions at once is diverged', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'diverged', aheadBy: 2, behindBy: 92, mergeBaseSha: FORK_HEAD } }) },
    { repoUrl: CANONICAL, headSha: 'c'.repeat(40) }
  );
  assert.equal(answer.verdict, 'diverged');
  assert.match(answer.note, /prepare_work/);
});

// ── Failing safe ───────────────────────────────────────────────────────

test('an unreachable GitHub says it does not know, rather than current', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ headThrows: new Error('socket hang up') }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD }
  );
  assert.equal(answer.verdict, 'repo_unreachable');
  assert.notEqual(answer.verdict, 'current');
  assert.match(answer.note, /says nothing/);
});

test('a non-404 compare failure also degrades rather than claiming current', async () => {
  const boom = Object.assign(new Error('502'), { status: 502 });
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compareThrows: boom }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD }
  );
  assert.equal(answer.verdict, 'repo_unreachable');
});

test('an empty canonical repository does not read as a wrong checkout', async () => {
  // Comparing against a null base would 404 and surface as `unknown_commit`,
  // which blames the caller for the repository having no commits.
  const answer = await checkoutStatus(
    { gh: ghStub({ head: { defaultBranch: 'main', headSha: null, headCommittedAt: null } }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD }
  );
  assert.equal(answer.verdict, 'repo_unreachable');
  assert.notEqual(answer.verdict, 'unknown_commit');
  assert.match(answer.note, /no commits/);
});

test('a caller-supplied remote is parsed, never fetched', async () => {
  // remoteUrl is attacker-controllable input in the sense that matters here:
  // it arrives as text from whatever the model read. It must only ever be
  // compared as owner/repo — never turned into a request.
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/checkout-status.js'), 'utf8'
  );
  assert.doesNotMatch(src, /fetch\(|axios|http\.request|got\(/,
    'checkout-status makes no outbound request of its own');
  // A non-GitHub remote simply is not the canonical repo; it is not followed.
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE, compare: { status: 'behind', aheadBy: 0, behindBy: 1, mergeBaseSha: FORK_HEAD } }) },
    { repoUrl: CANONICAL, headSha: FORK_HEAD, remoteUrl: 'https://evil.example/Usernode-Labs/social-vibecoding' }
  );
  assert.equal(answer.remoteIsCanonical, false);
});

test('a malformed head sha is refused with a code, not guessed at', async () => {
  for (const bad of ['', 'HEAD', 'zzzz', 'abc', null, undefined, 42]) {
    const answer = await checkoutStatus(
      { gh: ghStub({ head: LIVE }) },
      { repoUrl: CANONICAL, headSha: bad }
    );
    assert.equal(answer.code, 'invalid_head_sha', String(bad));
  }
});

test('an app with no repository says so instead of comparing nothing', async () => {
  const answer = await checkoutStatus(
    { gh: ghStub({ head: LIVE }) },
    { repoUrl: null, headSha: FORK_HEAD }
  );
  assert.equal(answer.code, 'no_canonical_repo');
});

// ── The permission contract ────────────────────────────────────────────

test('the tool is named so the shipped read-only allow rules cover it', () => {
  assert.ok(
    TOOLS_SRC.includes("server.registerTool('get_checkout_status'"),
    'get_checkout_status is registered'
  );
  // The rule the scaffolded settings.json ships is `mcp__usernode__get_*`.
  // A drift check that prompts on every call is a drift check nobody runs,
  // so this name is load-bearing rather than stylistic.
  assert.ok(
    READ_ONLY_TOOL_PREFIXES.some((p) => 'get_checkout_status'.startsWith(p)),
    'and its name matches a read-only prefix'
  );
});

// ── The budget that shaped the design ──────────────────────────────────

test('the checkout rule reaches the server instructions, not just the charter', () => {
  const section = charter.CHARTER_SECTIONS.find((s) => s.id === 'verify-your-checkout');
  assert.ok(section, 'the charter explains the failure mode');
  assert.ok(section.text.includes('get_checkout_status'), 'and names the tool');

  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right to.
  //
  // #1433 left this section charter-only because SERVER_INSTRUCTIONS was at
  // 1399 of 1400: a brief would have had to be paid for by deleting a safety
  // clause. It asked that a raised budget be a deliberate decision rather than
  // a drift, and this is that decision being recorded.
  //
  // What forced it: charter-only was not enough. An agent reads the charter
  // when it calls get_connector_guidance, and a session that answers a
  // question about an app never has to call anything — so a fork 76 commits
  // behind produced a confident answer about code that no longer existed, and
  // only the user caught it. The instructions are the one text that arrives
  // before any tool call, which is why the brief has to be there.
  //
  // The budget moved 1400 -> 1536, which is the ceiling the >=512 headroom
  // invariant below already permitted; that invariant is untouched.
  assert.ok(section.brief, 'the section now carries a brief');
  assert.ok(section.brief.includes('get_checkout_status'), 'which names the tool');
  assert.ok(
    charter.BRIEF_ORDER.includes('verify-your-checkout'),
    'and is delivered in the initialize instructions'
  );
  assert.ok(
    charter.SERVER_INSTRUCTIONS.includes('get_checkout_status'),
    'so the resolved instructions name it without any tool call'
  );

  // Position is load-bearing: the briefs are ordered by what survives a
  // truncation that cuts from the end, and a stale checkout poisons an ANSWER
  // rather than only a diff — so it outranks the workflow guidance. It also
  // sits after no-code-here, which is the clause that implies a checkout
  // exists at all.
  const order = charter.BRIEF_ORDER;
  assert.ok(
    order.indexOf('verify-your-checkout') === order.indexOf('no-code-here') + 1,
    'directly after the "you are the coding agent" clause'
  );
  for (const later of ['where-to-start', 'conventions-pointer', 'work-order-handling']) {
    assert.ok(
      order.indexOf('verify-your-checkout') < order.indexOf(later),
      `and above ${later}, which it must outlive under truncation`
    );
  }

  assert.ok(
    charter.SERVER_INSTRUCTIONS.length <= SERVER_INSTRUCTIONS_MAX_CHARS,
    `SERVER_INSTRUCTIONS is ${charter.SERVER_INSTRUCTIONS.length} chars, `
    + `over the ${SERVER_INSTRUCTIONS_MAX_CHARS} budget`
  );
});

test('list_apps points at the comparison where repoUrl is actually read', () => {
  const idx = TOOLS_SRC.indexOf("server.registerTool('list_apps'");
  const block = TOOLS_SRC.slice(idx, TOOLS_SRC.indexOf('server.registerTool(', idx + 10));
  assert.match(block, /get_checkout_status/);
  assert.match(block, /fork/i);
});

test('get_app reports where the canonical default branch points', () => {
  const idx = TOOLS_SRC.indexOf("server.registerTool('get_app'");
  const block = TOOLS_SRC.slice(idx, TOOLS_SRC.indexOf('server.registerTool(', idx + 10));
  for (const field of ['defaultBranch', 'headSha', 'headCommittedAt']) {
    assert.match(block, new RegExp(field), `get_app returns ${field}`);
  }
  // Best-effort, exactly like the two counts beside it: a GitHub hiccup must
  // degrade a field rather than fail the lookup.
  assert.match(block, /catch\s*\{/, 'and tolerates a GitHub failure');
});

test('list_apps does NOT take a GitHub round trip per app', () => {
  const idx = TOOLS_SRC.indexOf("server.registerTool('list_apps'");
  const block = TOOLS_SRC.slice(idx, TOOLS_SRC.indexOf('server.registerTool(', idx + 10));
  assert.doesNotMatch(
    block, /getRepoHead/,
    'the head lookup belongs on the single-app read, not on a 39-app list'
  );
});
