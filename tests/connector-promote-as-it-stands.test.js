// #4262 — put a dev session up for the vote in one call, with nothing pushed.
//
// The connector's only way to promote one of the user's dev sessions (a CLI
// hand-off made by proposal_start, a card shared with `share: true`, a
// work-order continuation) was submit_work with proposalId, a branch in the
// user's own fork and `propose: true`. When the session's code was already
// final, the agent had to push the session's own head commit to a fork branch
// just to have an update for `propose: true` to ride on, and cloud coding
// sessions often refuse that push. PR #4258 (proposal 6992), a paused CLI
// hand-off with passing checks, needed exactly that. Its get_proposal also
// said "PR #4258 is paused, so its code is frozen — anything further is a new
// change through prepare_work", which was wrong.
//
// What is pinned here:
//   1. proposalId + propose: true with NO branch runs the owner's
//      Propose-to-group act: the same POST /api/sessions/:id/promote the
//      propose-after-update runs, under the caller's token, so the route
//      applies every gate. Nothing is pushed, nothing is reopened, nothing
//      else is written.
//   2. Its refusals are clear: not the caller's session, already up for a
//      vote, merged or closed, and the route's own words for nothing
//      submitted yet and a turn still moving its branch.
//   3. get_proposal's nextStep for an underway session names that call
//      instead of calling its code frozen.
//   4. The connector's own guidance teaches the one-call path.
//
// Run with: node --test tests/connector-promote-as-it-stands.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const tools = require('../src/services/mcp-tools');
const charter = require('../src/services/mcp-charter');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const HANDOFF_SRC = read('src/routes/proposal-handoff.js');
const VOTES_SRC = read('src/routes/votes.js');

const ORIGIN = 'https://usernode.example';
const OWNER = 7;

// A recorder standing in for the MCP server, and a fetch stub answering the
// loopback calls, on the arrangement tests/mcp-tools.test.js uses. `platform`
// returns a body, or `{ __http: { ok, status, body } }` for a refusal.
function connector(platform, { taskRows = [] } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("AND session_id = $2 AND status = 'open'")) return { rows: taskRows };
      return { rows: [], rowCount: 1 };
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const pathname = String(url).replace('http://platform.internal', '');
    calls.push({ method, pathname, body: init && init.body ? JSON.parse(init.body) : null });
    const answer = platform(method, pathname);
    const http = answer && answer.__http ? answer.__http : null;
    return {
      ok: http ? !!http.ok : true,
      status: http ? http.status : 200,
      text: async () => JSON.stringify(http ? http.body : answer),
    };
  };
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: OWNER, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: null, grantId: null,
  });
  return { handlers, specs, calls, queries, restore: () => { globalThis.fetch = realFetch; } };
}

// The session route's answer for proposal 6992, as the owner reads it.
const sessionRow = (over = {}) => ({
  id: 6992, user_id: OWNER, app_slug: 'social-vibecoding', status: 'paused',
  source: 'cli_handoff', branch_name: 'usernode/handoff-6992', pr_number: 4258,
  pr_url: 'https://github.com/o/r/pull/4258', check_state: 'passing', test_results: [],
  ...over,
});

// The platform, answering the two routes this path may reach: the promote
// and the owner-scoped session read. Anything else is a call it must not make.
function platformWith({ promote, session }) {
  return (method, pathname) => {
    if (method === 'POST' && pathname === '/api/sessions/6992/promote') return promote;
    if (method === 'GET' && pathname === '/api/sessions/6992') {
      return session === null
        ? { __http: { ok: false, status: 404, body: { error: 'Session not found' } } }
        : { session };
    }
    throw new Error(`unexpected platform call: ${method} ${pathname}`);
  };
}

const refusal = (status, body) => ({ __http: { ok: false, status, body } });
const CLOSE_SQL = "SET status = 'submitted'";

// ── 1. The one call ────────────────────────────────────────────────────

test('proposalId + propose: true with no branch promotes the session through the promote route, and nothing else', async () => {
  const c = connector(platformWith({
    promote: { ok: true, prNumber: 4258, prUrl: 'https://github.com/o/r/pull/4258', prTitle: 'T' },
    session: sessionRow({ status: 'promoted' }),
  }), { taskRows: [{ id: 91, session_id: 6992 }] });
  try {
    const res = await c.handlers.get('submit_work')({ proposalId: 6992, propose: true });
    assert.notEqual(res.isError, true, JSON.stringify(res.structuredContent));
    const out = res.structuredContent;
    assert.equal(out.proposed, true);
    assert.equal(out.proposeError, null);
    assert.equal(out.proposalId, 6992);
    assert.equal(out.prNumber, 4258);
    assert.equal(out.appSlug, 'social-vibecoding');
    assert.match(out.webPath, /social-vibecoding/);
    assert.match(out.nextStep, /^PR #4258 \(proposal 6992\) is now UP FOR THE GROUP'S VOTE/);
    assert.match(out.nextStep, /nothing was pushed and no code moved/);
    // Never a claim that it landed: the group decides.
    assert.match(out.nextStep, /only if the group votes it in/);
    // The owner's button and nothing more: no update-from-fork (nothing to
    // push), no resume (the route takes a paused session straight to review),
    // and the read that words the answer comes after the route decided.
    assert.deepEqual(c.calls.map((x) => `${x.method} ${x.pathname}`), [
      'POST /api/sessions/6992/promote',
      'GET /api/sessions/6992',
    ]);
    assert.deepEqual(c.calls[0].body, {}, 'the promote carries nothing but the caller\'s token');
    // The share's work order is finished now, as after the propose-after-update.
    const close = c.queries.find((q) => q.sql.includes(CLOSE_SQL));
    assert.ok(close, 'the work order the session carried is closed');
    assert.deepEqual(close.params.slice(0, 3), [91, 6992, OWNER]);
    // And the answer is what the SDK will accept.
    assert.ok(z.object(c.specs.get('submit_work').outputSchema).safeParse(out).success);
  } finally { c.restore(); }
});

test('the one-call path reuses the promote route the propose-after-update runs, and restates none of its gates', () => {
  const block = TOOLS_SRC.slice(
    TOOLS_SRC.indexOf('if (updating && !branch && propose === true) {'),
    TOOLS_SRC.indexOf('if (updating && !branch) {'),
  );
  assert.ok(block.length > 0, 'the no-branch promote exists, ahead of the branch-required refusal');
  // The same route the branch path's promoteOnce calls.
  assert.match(block, /'POST', `\/api\/sessions\/\$\{proposalId\}\/promote`/);
  assert.match(TOOLS_SRC, /const promoteOnce = \(\) => callPlatform\(\s*baseUrl, accessToken, 'POST', `\/api\/sessions\/\$\{proposalId\}\/promote`/);
  // No reopen, and no copy of the route's own checks in this module.
  assert.doesNotMatch(block, /\/resume/);
  assert.doesNotMatch(block, /isSessionBusy|hasUnsubmittedUpload|currentCheckedHead|promotedSessions|getBranchSha/);
  // The gates the refusals below rely on live in the routes, where the web
  // button meets them too: the CLI hand-off preflight (mounted ahead of the
  // vote routes) and the owner-scoped promote itself.
  const preflight = HANDOFF_SRC.slice(HANDOFF_SRC.indexOf("router.post('/api/sessions/:id/promote'"));
  assert.match(preflight, /Nothing has been submitted to this change yet/);
  assert.match(preflight, /An agent turn is still running on this change/);
  assert.match(preflight, /\['active', 'paused'\]\.includes\(session\.status\)/);
  assert.match(VOTES_SRC,
    /router\.post\('\/api\/sessions\/:id\/promote'[\s\S]{0,600}WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.status IN \('active', 'paused'\)/);
});

test('a field only an update applies is refused before anything is called', async () => {
  const c = connector(() => { throw new Error('must not call the platform'); });
  try {
    const res = await c.handlers.get('submit_work')({
      proposalId: 6992, propose: true, title: 'A better name', testingPaths: ['/'],
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'invalid_request');
    assert.match(res.structuredContent.message, /does not take title, testingPaths/);
    assert.match(res.structuredContent.message, /proposalId and propose: true alone/);
    assert.deepEqual(c.calls, []);
  } finally { c.restore(); }
});

test('without propose, an update still needs its branch, and the refusal names the one-call path', async () => {
  const c = connector(() => { throw new Error('must not call the platform'); });
  try {
    const res = await c.handlers.get('submit_work')({ proposalId: 6992 });
    assert.equal(res.isError, true);
    assert.match(res.structuredContent.message, /An update needs `branch` too/);
    assert.match(res.structuredContent.message, /pass propose: true and no branch instead/);
    assert.deepEqual(c.calls, []);
  } finally { c.restore(); }
});

// ── 2. The refusals ────────────────────────────────────────────────────

async function refused(platform) {
  const c = connector(platform, { taskRows: [{ id: 91, session_id: 6992 }] });
  try {
    const res = await c.handlers.get('submit_work')({ proposalId: 6992, propose: true });
    assert.equal(res.isError, true, JSON.stringify(res.structuredContent));
    // A refusal moves nothing: no reopen, no update, no work order closed.
    assert.ok(c.calls.every((x) => !/\/resume|update-from-fork/.test(x.pathname)));
    assert.equal(c.queries.filter((q) => q.sql.includes(CLOSE_SQL)).length, 0);
    return res.structuredContent;
  } finally { c.restore(); }
}

test('somebody else\'s session is refused as not the caller\'s', async () => {
  // The session route answers only for the owner, so a 404 there is the answer.
  const unseen = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: null,
  }));
  assert.equal(unseen.code, 'not_your_session');
  assert.match(unseen.message, /Proposal 6992 is not a dev session of yours/);
  assert.match(unseen.message, /only the person who started a session can propose it/);
  // An admin can READ another person's session; the promote route still
  // refuses it, and the answer says why rather than "not found".
  const admin = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: sessionRow({ user_id: 3 }),
  }));
  assert.equal(admin.code, 'not_your_session');
});

test('a session already up for a vote, merged or closed is refused by name', async () => {
  // votes.js answers 404 for a session that is not active or paused...
  const voting = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: sessionRow({ status: 'promoted' }),
  }));
  assert.equal(voting.code, 'already_proposed');
  assert.match(voting.message, /^PR #4258 \(proposal 6992\) is already up for the group's vote/);
  // ...and the CLI hand-off preflight answers 409; both read the same.
  const handoff = await refused(platformWith({
    promote: refusal(409, { error: 'proposal_not_ready', message: 'This change is promoted, so it cannot be submitted for review.' }),
    session: sessionRow({ status: 'promoted' }),
  }));
  assert.equal(handoff.code, 'already_proposed');

  const merging = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: sessionRow({ status: 'merging' }),
  }));
  assert.equal(merging.code, 'already_proposed');
  assert.match(merging.message, /already won its vote and is merging/);

  const merged = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: sessionRow({ status: 'merged' }),
  }));
  assert.equal(merged.code, 'already_merged');
  assert.match(merged.message, /has already merged/);

  const closed = await refused(platformWith({
    promote: refusal(404, { error: 'Active session not found' }), session: sessionRow({ status: 'archived' }),
  }));
  assert.equal(closed.code, 'session_closed');
  assert.match(closed.message, /is archived, so it cannot go up for a vote/);
});

test('nothing submitted yet and a turn still moving the branch are refused in the route\'s own words', async () => {
  const empty = await refused(platformWith({
    promote: refusal(409, {
      error: 'proposal_not_ready',
      message: 'Nothing has been submitted to this change yet, so there is nothing to put up for review.',
    }),
    session: sessionRow({ status: 'paused' }),
  }));
  assert.equal(empty.code, 'proposal_not_ready');
  assert.match(empty.message, /^Nothing has been submitted to this change yet/);

  const busy = await refused(platformWith({
    promote: refusal(409, {
      error: 'proposal_not_ready',
      message: 'An agent turn is still running on this change. Submit it for review when the turn finishes.',
    }),
    session: sessionRow({ status: 'active' }),
  }));
  assert.equal(busy.code, 'proposal_not_ready');
  assert.match(busy.message, /An agent turn is still running on this change/);

  // Any other refusal of an open session of the caller's is the route's too:
  // the promoted-session cap, a branch with no commits on it.
  const capped = await refused(platformWith({
    promote: refusal(429, { error: 'You already have 5 changes waiting for approval.' }),
    session: sessionRow({ status: 'active' }),
  }));
  assert.match(capped.message, /5 changes waiting for approval/);
});

// ── 3. get_proposal's nextStep ─────────────────────────────────────────

test('an underway session\'s nextStep names the one call instead of calling its code frozen', () => {
  for (const status of ['paused', 'active']) {
    const step = tools.shapeProposal(sessionRow({ status }), ORIGIN, OWNER).nextStep;
    assert.match(step, /^PR #4258 \(proposal 6992\) is a dev session that is not up for a vote yet/, step);
    assert.match(step, /call submit_work with proposalId 6992 and propose: true and NO branch/);
    assert.match(step, /"Propose to group" button, with nothing to push/);
    assert.match(step, /When the user has asked for it/, 'still only on the user\'s ask');
    assert.doesNotMatch(step, /frozen|new change through prepare_work/);
  }
  assert.match(tools.shapeProposal(sessionRow({ status: 'paused' }), ORIGIN, OWNER).nextStep,
    /it is paused, which only releases its worker/);
  // Read without a caller (the pure shape), it still names the call.
  assert.match(tools.shapeProposal(sessionRow(), ORIGIN).nextStep, /propose: true and NO branch/);
  // Somebody else's session is not handed a call the route would refuse.
  const theirs = tools.shapeProposal(sessionRow({ user_id: 3 }), ORIGIN, OWNER).nextStep;
  assert.match(theirs, /Only the person who started it can put it up for the vote/);
  assert.doesNotMatch(theirs, /submit_work/);
  // A session that IS over keeps its sentence.
  assert.match(tools.shapeProposal(sessionRow({ status: 'merged' }), ORIGIN, OWNER).nextStep,
    /^PR #4258 \(proposal 6992\) is merged, so its code is frozen/);
});

test('get_proposal hands the caller to the nextStep, so it reads for the person asking', async () => {
  for (const [userId, expected] of [[OWNER, /propose: true and NO branch/], [3, /Only the person who started it/]]) {
    const c = connector((method, pathname) => {
      if (method === 'GET' && pathname === '/api/sessions/6992') return { session: sessionRow({ user_id: userId }) };
      throw new Error(`unexpected platform call: ${method} ${pathname}`);
    });
    try {
      const res = await c.handlers.get('get_proposal')({ proposalId: 6992 });
      assert.notEqual(res.isError, true);
      assert.match(res.structuredContent.nextStep, expected);
    } finally { c.restore(); }
  }
});

// ── 4. The guidance ────────────────────────────────────────────────────

test('the connector teaches the one-call path where it teaches promoting', () => {
  const c = connector(() => ({}));
  try {
    const spec = c.specs.get('submit_work');
    assert.match(spec.description, /or as it stands with NO `branch` and nothing pushed/);
    const propose = spec.inputSchema.propose.description;
    assert.match(propose, /With NO `branch`, nothing is pushed and nothing else is written/);
    assert.match(propose, /instead of pushing the same commit to a fork/);
    assert.match(propose, /not the user's session, is already up for a vote, merged or closed, or the platform's own promote checks say it is not ready \(for example nothing submitted yet, or a turn still moving its branch\)/);
    assert.match(spec.inputSchema.share.description, /proposalId and propose: true alone promote it, with no push/);
  } finally { c.restore(); }
  const twoDestinations = charter.CHARTER_SECTIONS.find((s) => s.id === 'two-destinations');
  assert.match(twoDestinations.text, /leave the branch out: `proposalId` and `propose: true` alone put it up for the vote as it stands/);
  assert.match(twoDestinations.text, /a CLI hand-off included, paused or not/);
  assert.match(twoDestinations.text, /never push a commit the session already has to a fork just to carry `propose: true`/);
  assert.ok(!twoDestinations.brief, 'still charter-only');
});
