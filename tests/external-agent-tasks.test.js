// Hosted MCP connector — handing work to the user's own coding agent.
//
// This service is the only place a proposal can be created without a human
// clicking anything, and it used to be the only place the platform used a
// USER'S GitHub token. It no longer holds one at all: the fork and the
// branch are made by the user's own coding agent, and everything this file
// reads about them is public. The tests below are weighted accordingly:
//
//   1. NO user credential is used anywhere. The GitHub link is identity-only
//      now (services/github-link), so a re-introduced `authorization: Bearer
//      <user token>` header would silently re-widen the OAuth scope this
//      whole design exists to avoid.
//   2. The attribution gate. A proposal opened this way carries the
//      caller's name and their agent's badge, so the pull request's head
//      must live in a repository owned by the login THEY verified. This is
//      checked on every path — created, adopted, and named-by-number — and
//      it must refuse before the platform is asked to import anything. Only
//      the OWNER is checked: the fork's name is the agent's choice.
//   3. The caps are applied BEFORE a pull request is opened, so a refusal
//      never leaves a stray PR on someone's app.
//   4. The work order is complete — it now has to create the fork and the
//      branch too — carries no credential, and the user-written brief inside
//      it stays marked as data.
//   5. source stays 'imported'. The connector adds an author, not a new
//      kind of proposal.
//
// Run with: node --test tests/external-agent-tasks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/external-agent-tasks.js'), 'utf8'
);

// ── Fakes ──────────────────────────────────────────────────────────────

// A fetch stub for the service's PUBLIC GitHub reads. `routes` maps
// "METHOD /path" to a response; anything unmatched is a hard failure so a
// test can never pass by accidentally hitting a real network path.
function fakeFetch(routes, calls) {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const pathname = String(url).replace('https://api.github.com', '');
    const key = `${method} ${pathname}`;
    calls.push({ key, body: init && init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const hit = routes[key];
    if (!hit) throw new Error(`unstubbed GitHub call: ${key}`);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => (hit.body === undefined ? '' : JSON.stringify(hit.body)),
    };
  };
}

function withFetch(routes, calls, fn) {
  const original = global.fetch;
  global.fetch = fakeFetch(routes, calls);
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

// A pool that dispatches on a substring of the SQL, so a test states what
// it expects to be asked rather than the order it is asked in.
function fakePool(handlers, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const okLimits = {
  checkPrepareRate: async () => null,
  checkPromotedCap: async () => null,
  checkProposalRate: async () => null,
};

const APP = {
  id: 7, slug: 'recipe-box', name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

// A real-shaped base commit: 40 hex characters. prepareWork now refuses
// anything else outright, so the fixture has to be the real thing — which
// is also what lets the work-order assertions below pin the exact
// `git checkout -b <branch> <40 hex>` line the connector must emit.
const BASE_SHA = `ba5e${'0'.repeat(34)}fe`;

function baseGh(overrides = {}) {
  return {
    isEnabled: () => true,
    parseGithubUrl: (url) => {
      const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    getBranchSha: async () => BASE_SHA,
    ...overrides,
  };
}

// A deployment that HAS a GitHub OAuth app configured, with this user
// linked through it. `isEnabled` is the deployment-level question asked
// before the per-user one — see connector-config-unset.test.js for the
// unconfigured deployment. The link is a LOGIN and nothing else: there is no
// token for a fake to hand out.
const linkedAs = (login) => ({
  isEnabled: () => true,
  linkStatus: async () => ({ linked: true, login, linkedAt: null, access: 'identity' }),
});

// ── Agent vocabulary ───────────────────────────────────────────────────

test('the agent label is a closed vocabulary, inferred from the client', () => {
  assert.equal(svc.normalizeAgent('claude-code'), 'claude-code');
  assert.equal(svc.normalizeAgent('codex'), 'codex');
  // Inferred from the connected chat product when the tool call omits it.
  assert.equal(svc.normalizeAgent(null, 'Claude'), 'claude-code');
  assert.equal(svc.normalizeAgent(null, 'ChatGPT'), 'codex');
  assert.equal(svc.normalizeAgent(null, 'Some MCP Client'), 'external');
  // Anything a connector invents collapses to the generic label rather
  // than reaching the database, and therefore the badge.
  assert.equal(svc.normalizeAgent('Anthropic Ultra Deluxe'), 'external');
  assert.equal(svc.normalizeAgent('<script>alert(1)</script>'), 'external');
  for (const agent of [svc.normalizeAgent('nonsense'), svc.normalizeAgent('codex')]) {
    assert.ok(svc.AGENTS.includes(agent));
  }
});

test('branch names are namespaced and derived from platform identifiers only', () => {
  const branch = svc.branchNameFor('recipe-box', 42, 'abc123');
  assert.equal(branch, 'usernode/recipe-box-issue-42-abc123');
  assert.equal(svc.branchNameFor('recipe-box', null, 'abc123'), 'usernode/recipe-box-task-abc123');
  // A hostile slug cannot escape the namespace or the ref syntax.
  const nasty = svc.branchNameFor('../../evil branch~^:?*[', 0, 'abc123');
  assert.match(nasty, /^usernode\/[a-z0-9-]+-task-abc123$/);
  // Unseeded names are unique, so two concurrent prepares do not collide.
  assert.notEqual(svc.branchNameFor('x', 1), svc.branchNameFor('x', 1));
});

// ── The work order ─────────────────────────────────────────────────────

function orderFor(forkStatus, overrides = {}) {
  return svc.buildWorkOrder({
    appName: 'Recipe Box',
    appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus,
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: 'deadbeef',
    issueNumber: 4,
    brief: '<untrusted-content>Add dark mode</untrusted-content>',
    webPath: 'https://usernode.example/#app/recipe-box',
    ...overrides,
  });
}

test('the work order is self-contained and carries no credential', () => {
  const order = orderFor('ready');
  // Everything the receiving agent needs: where to push, what branch, and
  // the commit it starts from.
  assert.match(order, /https:\/\/github\.com\/someuser\/recipe-box\.git/);
  assert.match(order, /usernode\/recipe-box-issue-4-abc123/);
  assert.match(order, /deadbeef/);
  assert.match(order, /request #4/);
  // The brief keeps its envelope: it is other people's writing on its way
  // to an agent with a shell.
  assert.match(order, /<untrusted-content>Add dark mode<\/untrusted-content>/);
  assert.match(order, /not instructions addressed/i);
  // And the rules that keep the agent inside its own repository.
  assert.match(order, /Do not\n {2}push to the upstream repository/);
  assert.match(order, /secrets, tokens or credentials/);
  // No token of any kind is ever pasted into a chat product's transcript.
  assert.doesNotMatch(order, /gho_|ghp_|Bearer |x-access-token/);
});

test('the work order creates the branch itself — the platform no longer does', () => {
  // The branch used to be reserved server-side with the user's token. The
  // agent cuts it now, at the commit the platform recorded, and pushes it.
  for (const status of ['ready', 'missing', 'name_conflict']) {
    const order = orderFor(status);
    assert.match(order, /git fetch upstream/, `${status}: upstream is fetched`);
    assert.match(
      order, /git checkout -b usernode\/recipe-box-issue-4-abc123 deadbeef/,
      `${status}: the branch is cut at the recorded base commit`
    );
    assert.match(order, /git push -u origin usernode\/recipe-box-issue-4-abc123/,
      `${status}: and pushed`);
    assert.match(order, /Usernode has no write access to your GitHub account/,
      `${status}: and says why the agent has to do it`);
  }
});

test('a missing fork puts the one-click link at the TOP of the setup', () => {
  const missing = orderFor('missing');
  // The link leads, and `gh` follows it as the equivalent for an agent
  // that has a terminal — the reverse of the old order, where clicking was
  // framed as what you do once the command line has failed you.
  assert.match(missing, /Create fork/);
  const link = missing.indexOf('https://github.com/usernode-bot/recipe-box/fork');
  assert.ok(link > missing.indexOf('SETUP'), 'inside SETUP');
  assert.ok(link < missing.indexOf('gh repo fork'), 'and ahead of the CLI shortcut');
  assert.ok(link < missing.indexOf('git clone'), 'and ahead of the commands');
  assert.match(missing, /gh repo fork usernode-bot\/recipe-box --clone --remote/);

  // A fork that already exists is a plain clone — no pointless fork call
  // first, and no fork link, which for this state was only ever noise.
  const ready = orderFor('ready');
  assert.match(ready, /git clone https:\/\/github\.com\/someuser\/recipe-box\.git/);
  assert.doesNotMatch(ready, /gh repo fork/);
  assert.doesNotMatch(ready, /recipe-box\/fork/);
  assert.match(ready, /You already have this copy of the repository\./);
});

test('one canonical clone/upstream/checkout block, whatever the fork state', () => {
  // The `missing` branch used to run `gh repo fork --clone --remote`, which
  // creates the `upstream` remote itself, while `ready` added it by hand —
  // two shapes of the same four steps. Now only the preamble differs.
  for (const status of ['ready', 'missing', 'name_conflict']) {
    const order = orderFor(status);
    const block = order.slice(order.indexOf('```bash'), order.indexOf('```', order.indexOf('```bash') + 3));
    assert.match(block, /git clone https:\/\/github\.com\/someuser\/recipe-box\.git recipe-box && cd recipe-box/,
      `${status}: clones the fork`);
    assert.match(block, /git remote add upstream https:\/\/github\.com\/usernode-bot\/recipe-box/,
      `${status}: names upstream`);
  }
});

test('a same-named repo in the way becomes a differently-named fork, never a refusal', () => {
  const order = orderFor('name_conflict', {
    forkRepo: 'recipe-box-usernode',
    forkUrl: 'https://github.com/someuser/recipe-box-usernode',
    forkCloneUrl: 'https://github.com/someuser/recipe-box-usernode.git',
  });
  assert.match(order, /--fork-name recipe-box-usernode/);
  assert.match(order, /cd recipe-box-usernode/);
  assert.match(order, /never touches that other repository/i);
});

test('a work order with no brief tells the agent to ask rather than guess', () => {
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'missing',
    branch: 'b', baseSha: 's', brief: '',
  });
  assert.match(order, /ask the user what they want before writing code/);
});

// ── The attribution gate ───────────────────────────────────────────────

test('attribution: only a pull request from the caller’s own fork passes', () => {
  const fromMe = { head: { repo: { owner: { login: 'SomeUser' } } } };
  // GitHub logins are case-preserving, not case-sensitive.
  assert.equal(svc.attributionError(fromMe, 'someuser'), null);
  assert.equal(svc.attributionError(fromMe, 'SomeUser'), null);

  const fromSomeoneElse = { head: { repo: { owner: { login: 'attacker' } } } };
  const err = svc.attributionError(fromSomeoneElse, 'someuser');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'fork_mismatch');
  assert.match(err.message, /attacker's repository/);
  assert.match(err.message, /import it from the app’s Dev page|import it from the app's Dev page/);

  // Head repo deleted: GitHub keeps the owner in the label, and that is
  // still enough to refuse — it must never fall through to "allowed".
  assert.equal(svc.headOwnerOf({ head: { label: 'attacker:feat/x' } }), 'attacker');
  assert.equal(svc.attributionError({ head: { label: 'attacker:feat/x' } }, 'someuser').code, 'fork_mismatch');
  // No head information at all is a refusal, not a pass.
  assert.equal(svc.attributionError({}, 'someuser').code, 'fork_mismatch');
  assert.equal(svc.attributionError(null, 'someuser').code, 'fork_mismatch');
  // And an empty verified login can never match an empty head owner.
  assert.equal(svc.attributionError({ head: { repo: { owner: { login: '' } } } }, '').code, 'fork_mismatch');
});

// ── inspectFork ────────────────────────────────────────────────────────

test('inspecting the fork is one PUBLIC read and never a write', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': {
      status: 200,
      body: { fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } },
    },
  }, calls, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'ready');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'GET /repos/someuser/recipe-box');
  // No user credential exists to send. The bot PAT may authenticate the read
  // for rate-limit headroom, but nothing user-scoped is ever attached.
  const auth = calls[0].headers.Authorization || calls[0].headers.authorization;
  assert.ok(!auth || /^Bearer /.test(auth) === false || auth === `Bearer ${process.env.GITHUB_BOT_TOKEN}`,
    'only the platform’s own public-read credential, if any');
});

test('a same-named repo that is not our fork is a named conflict, never touched', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 200, body: { fork: false, name: 'recipe-box' } },
  }, calls, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'name_conflict');
  });
  assert.equal(calls.length, 1, 'nothing is written to that repository');

  // A fork of a DIFFERENT upstream with the same name is also a conflict.
  const calls2 = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': {
      status: 200, body: { fork: true, name: 'recipe-box', parent: { full_name: 'elsewhere/recipe-box' } },
    },
  }, calls2, async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'name_conflict');
  });
});

test('a missing fork is `missing`, and an unreadable GitHub is `unknown`', async () => {
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
  }, [], async () => {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'missing');
  });

  // A rate-limited or down GitHub must not become a refusal: the work
  // order's fork command is a no-op when the fork already exists.
  const original = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await svc.inspectFork('someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'unknown');
  } finally {
    global.fetch = original;
  }
});

// ── prepareWork ────────────────────────────────────────────────────────

const FORK_READY = {
  'GET /repos/someuser/recipe-box': {
    status: 200,
    body: { fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } },
  },
};

test('prepare_work records the work order at the UPSTREAM base commit', async () => {
  const queries = [];
  const calls = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 31 }]]], queries);
  const result = await withFetch(FORK_READY, calls, () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, issueNumber: 4,
      brief: '<untrusted-content>Add dark mode</untrusted-content>',
      clientId: 'claude-ai', clientName: 'Claude — claude.ai',
      origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 31);
  assert.equal(result.forkOwner, 'someuser');
  assert.equal(result.forkStatus, 'ready');
  assert.equal(result.baseSha, BASE_SHA);
  assert.match(result.branch, /^usernode\/recipe-box-issue-4-/);

  // The base commit comes from UPSTREAM, read with the platform's own
  // credentials — never from the fork, which may be stale or edited — and it
  // is what the work order tells the agent to branch from.
  assert.match(
    result.workOrder,
    new RegExp(`git checkout -b ${result.branch} ${BASE_SHA}`)
  );

  // An existing fork drops the fork step: open, choose, paste, hand back.
  assert.equal(result.guidance.length, 4);
  assert.ok(!result.guidance.some((s) => s.includes('/fork')), 'no fork step when one exists');
  assert.match(result.guidance[0], /claude\.ai\/code/);
  assert.match(result.guidance[0], /new session/i);
  assert.match(result.guidance[1], /repository picker/i);
  assert.ok(result.guidance[1].includes('someuser/recipe-box'));
  assert.ok(!/the copy you just made/.test(result.guidance[1]), 'they did not just make it');

  // Nothing is written to GitHub at all: one read, no more.
  assert.deepEqual(calls.map((c) => c.key), ['GET /repos/someuser/recipe-box']);
  assert.equal(calls.filter((c) => c.body !== null).length, 0, 'no request has a body');

  // The row records the work order so submit_work can find it again.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.deepEqual(insert.params.slice(0, 3), [3, 7, 4]);
  assert.equal(insert.params[5], result.branch);
});

test('a missing fork still produces a work order — it is the agent’s job now', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 32 }]]], queries);
  const result = await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
  }, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: 'x',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true, 'a missing fork is not a refusal');
  assert.equal(result.forkStatus, 'missing');
  assert.equal(result.forkPageUrl, 'https://github.com/usernode-bot/recipe-box/fork');
  assert.match(result.workOrder, /gh repo fork usernode-bot\/recipe-box/);
  assert.match(result.workOrder, /https:\/\/github\.com\/usernode-bot\/recipe-box\/fork/);

  // Making the copy is step ONE, and it is not skippable: both hosted
  // agents start a session by PICKING a repository that already exists in
  // the user's account, so "your agent will fork for you" would send a web
  // user to a picker with nothing in it.
  assert.equal(result.guidance.length, 5);
  assert.ok(result.guidance[0].includes(result.forkPageUrl));
  assert.doesNotMatch(result.guidance[0], /skip|GitHub CLI|\bgh\b/i);
  assert.match(result.guidance[1], /claude\.ai\/code/);
  assert.match(result.guidance[2], /the copy you just made/);

  // The one-click link leads SETUP rather than trailing it as a fallback.
  const setupAt = result.workOrder.indexOf('SETUP');
  assert.ok(setupAt > 0);
  assert.ok(result.workOrder.indexOf(result.forkPageUrl) > setupAt);
  assert.ok(result.workOrder.indexOf(result.forkPageUrl) < result.workOrder.indexOf('git clone'));

  // The reservation exists, so a retry after the user clicks "Create fork"
  // needs no new task row.
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO external_agent_tasks')));
});

test('a name conflict suggests another fork name instead of refusing', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 33 }]]], queries);
  const result = await withFetch({
    'GET /repos/someuser/recipe-box': { status: 200, body: { fork: false, name: 'recipe-box' } },
  }, [], () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: 'x',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.forkStatus, 'name_conflict');
  assert.equal(result.forkRepo, 'recipe-box-usernode');
  assert.match(result.workOrder, /--fork-name recipe-box-usernode/);

  // The human's step names the OTHER name and says the existing repository
  // is left alone — the reassurance is the point of the step.
  assert.equal(result.guidance.length, 5);
  assert.ok(result.guidance[0].includes(result.forkPageUrl));
  assert.ok(result.guidance[0].includes('recipe-box-usernode'));
  assert.match(result.guidance[0], /never touches/);
  assert.ok(result.guidance[2].includes('someuser/recipe-box-usernode'));

  // The task row carries the suggested name as a HINT; the attribution gate
  // still only checks the owner, so another name works too.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[4], 'recipe-box-usernode');
  assert.equal(insert.params[3], 'someuser');
});

// ── The hand-off text ──────────────────────────────────────────────────

const prepareWith = (params, fetchMap = FORK_READY) => withFetch(
  fetchMap, [], () => svc.prepareWork(
    {
      pool: fakePool([['INSERT INTO external_agent_tasks', [{ id: 40 }]]], []),
      config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example', ...params }
  )
);

const FORK_MISSING = {
  'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
};

test('every guidance step is an action the HUMAN takes, never agent narration', async () => {
  for (const clientName of ['Claude — claude.ai', 'ChatGPT — chatgpt.com', null]) {
    const result = await prepareWith({ clientName }, FORK_MISSING);
    assert.equal(result.ok, true);

    for (const step of result.guidance) {
      // "It will clone your fork, create the branch and push; it will not
      // open a pull request" was a line to read and nothing to do — every
      // clause of it is already in the work order, addressed to the agent.
      assert.doesNotMatch(step, /will clone|create the branch|pull request|it will /i,
        `guidance must not narrate the agent: ${step}`);
      // Short enough to survive a host model's urge to reflow it, and free
      // of anything that reads as a command for the person to run.
      assert.ok(step.length <= svc.MAX_GUIDANCE_CHARS, `too long: ${step}`);
      assert.ok(!step.includes('$'), `no shell in guidance: ${step}`);
      assert.ok(!step.includes('```'), `no fenced block in guidance: ${step}`);
      assert.ok(!step.includes('git '), `no git commands in guidance: ${step}`);
      assert.ok(!/^\s*\d+[.)]/.test(step), `unnumbered — the host numbers them: ${step}`);
    }

    // The hand-off back to this conversation is always last.
    assert.match(result.guidance[result.guidance.length - 1], /branch is pushed/);
    assert.match(result.guidance[result.guidance.length - 2], /exactly as written/);
  }
});

test('guidance names the actual web UI of the client that called it', async () => {
  const claude = await prepareWith({ clientName: 'Claude — claude.ai' }, FORK_MISSING);
  assert.match(claude.guidance[1], /Open https:\/\/claude\.ai\/code and start a new session\./);
  assert.match(claude.guidance[2], /repository picker/i);
  assert.ok(claude.guidance[2].includes('someuser/recipe-box'));

  const codex = await prepareWith({ clientName: 'ChatGPT — chatgpt.com' }, FORK_MISSING);
  assert.match(codex.guidance[1], /Open https:\/\/chatgpt\.com\/codex and start a new task\./);
  assert.ok(codex.guidance[2].includes('someuser/recipe-box'));
  assert.equal(codex.guidance.length, 5);

  // An unrecognised client gets the one thing true everywhere — and is the
  // only variant where a terminal is likely enough to mention the CLI.
  const other = await prepareWith({ clientName: 'some-cli/0.1' }, FORK_MISSING);
  assert.equal(other.guidance.length, 4, 'open + choose collapse into one step');
  assert.ok(other.guidance[1].includes('someuser/recipe-box'));
  assert.match(other.guidance[1], /cloning it first/);
  assert.match(other.guidance[0], /GitHub CLI/);
});

test('the work order is addressed to the agent and to nobody else', async () => {
  const result = await prepareWith({ clientName: 'Claude — claude.ai' });
  for (const human of ['tell the assistant', 'paste', 'verbatim', 'come back']) {
    assert.ok(!result.workOrder.toLowerCase().includes(human),
      `the work order must not address the human: ${human}`);
  }
  // One canonical command block, whatever the fork state.
  assert.match(result.workOrder, /git clone https:\/\/github\.com\/someuser\/recipe-box\.git recipe-box/);
  assert.match(result.workOrder, /git remote add upstream https:\/\/github\.com\/usernode-bot\/recipe-box/);
  // And it says what to do instead of coming back here.
  assert.match(result.workOrder, /Do not open a pull\nrequest/);
});

test('the base commit renders as one unbroken 40-character word', async () => {
  for (const fetchMap of [FORK_READY, FORK_MISSING]) {
    const result = await prepareWith({ clientName: 'Claude — claude.ai' }, fetchMap);
    const checkouts = result.workOrder
      .split('\n')
      .filter((l) => /^git checkout -b \S+ [0-9a-f]{40}$/.test(l));
    assert.equal(checkouts.length, 1, 'exactly one checkout line, exactly one shape');
    // The failure this guards: a commit id split by a stray space. Nothing
    // in a generated work order should ever look like two hex runs.
    for (const line of result.workOrder.split('\n')) {
      assert.doesNotMatch(line, /[0-9a-f]{8,}\s+[0-9a-f]{8,}/, `split hex id: ${line}`);
    }
    // The invariant is stated where the agent can act on it.
    assert.match(result.workOrder, /40-character hex id/);
    assert.match(result.workOrder, /git rev-parse upstream\/main/);
  }
});

test('a base commit that is not a clean 40-hex id never reaches a work order', async () => {
  for (const bad of [`ba5e0000000000 ${'0'.repeat(20)}fe`, 'ba5e0000', 'not-a-sha', '']) {
    const queries = [];
    const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 41 }]]], queries);
    const result = await withFetch(FORK_READY, [], () => svc.prepareWork(
      {
        pool,
        config: {},
        gh: baseGh({ getBranchSha: async () => bad }),
        githubLink: linkedAs('someuser'),
        limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    ));
    assert.equal(result.ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(result.code, 'platform_unavailable');
    assert.ok(!queries.some((q) => q.sql.includes('INSERT INTO external_agent_tasks')),
      'and no task row is reserved against a commit that cannot be branched from');
  }
});

test('prepare_work refuses before touching GitHub when the account is not linked', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: {
          isEnabled: () => true,
          linkStatus: async () => ({ linked: false, login: null, linkedAt: null, access: 'identity' }),
        },
        limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_not_linked');
    assert.equal(result.settingsUrl, 'https://usernode.example/#settings/connectors');
    // And it says what the link actually asks for, since that is the whole
    // question a user hesitating over the button has.
    assert.match(result.message, /no access to your repositories/);
    assert.equal(fetched, false);
    assert.equal(queries.length, 0, 'and nothing is recorded');
  } finally {
    global.fetch = original;
  }
});

test('prepare_work is bounded before it records anything', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: linkedAs('someuser'),
        limits: { ...okLimits, checkPrepareRate: async () => ({ code: 'at_capacity', message: 'Slow down.' }) },
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.code, 'at_capacity');
    assert.equal(result.retryable, true);
    assert.equal(fetched, false, 'a rate-limited caller never reaches GitHub');
    assert.equal(queries.length, 0);
  } finally {
    global.fetch = original;
  }
});

// ── submitWork ─────────────────────────────────────────────────────────

const TASK_ROW = {
  id: 31, user_id: 3, app_id: 7, issue_number: 4,
  fork_owner: 'someuser', fork_repo: 'recipe-box',
  branch_name: 'usernode/recipe-box-issue-4-abc123',
  base_sha: 'base00000000000000000000000000000000sha',
  brief: 'Add dark mode', status: 'open',
  app_slug: 'recipe-box', app_name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

const PUSHED_BRANCH = {
  'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
    status: 200, body: { commit: { sha: 'newsha1111111111111111111111111111111' } },
  },
};

function submitPool(queries, extra = []) {
  return fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [TASK_ROW]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
    ...extra,
  ], queries);
}

test('submit_work opens the cross-fork PR and stamps the agent on the session', async () => {
  const queries = [];
  const calls = [];
  const created = [];
  const imports = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      created.push({ owner, repo, opts });
      return { number: 88, html_url: 'https://github.com/usernode-bot/recipe-box/pull/88', head: { repo: { owner: { login: 'SomeUser' } } } };
    },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, clientName: 'Claude', taskId: 31, title: 'Dark mode',
      body: 'Adds a toggle.',
      importProposal: async (slug, prNumber) => {
        imports.push({ slug, prNumber });
        return { ok: true, status: 200, body: { sessionId: 55 } };
      },
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.proposalId, 55);
  assert.equal(result.prNumber, 88);
  assert.equal(result.externalAgent, 'claude-code');

  // The PR targets the app's repo but its head is the user's fork.
  assert.equal(created[0].owner, 'usernode-bot');
  assert.equal(created[0].opts.head, 'someuser:usernode/recipe-box-issue-4-abc123');

  // The proposal is made by the platform's own import route, replaying the
  // caller's token — this service never inserts a chat_sessions row itself.
  assert.deepEqual(imports, [{ slug: 'recipe-box', prNumber: 88 }]);
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);

  // The only thing stamped afterwards is the badge column, scoped to the
  // caller's own row. source is untouched, so an imported proposal keeps
  // behaving like one.
  const stamp = queries.find((q) => q.sql.includes('UPDATE chat_sessions SET external_agent'));
  assert.deepEqual(stamp.params, ['claude-code', 55, 3]);
  assert.doesNotMatch(SRC, /source\s*=\s*'(?!imported)/);
  assert.doesNotMatch(SRC, /SET source/);

  // And the reservation is closed so it stops counting against the caps.
  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.match(close.sql, /status = 'submitted'/);
});

test('submit_work refuses a pull request from someone else’s fork before importing', async () => {
  const queries = [];
  const calls = [];
  let imported = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 90, html_url: 'x', head: { repo: { owner: { login: 'attacker' } } },
    }),
    createPR: async () => { throw new Error('should not create'); },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  ));

  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false, 'the platform is never asked to import it');
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE chat_sessions')));
});

test('submitting an already-open pull request by number is gated the same way', async () => {
  const queries = [];
  let imported = false;
  const gh = baseGh({
    getPR: async () => ({ number: 77, state: 'open', head: { repo: { owner: { login: 'someone-else' } } } }),
  });
  const result = await svc.submitWork(
    { pool: fakePool([], queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, prNumber: 77, slug: 'recipe-box',
      repoUrl: 'https://github.com/usernode-bot/recipe-box',
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  );
  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false);
});

test('the promoted-session cap is applied before a pull request is opened', async () => {
  const queries = [];
  let createdPr = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => { createdPr = true; return { number: 1 }; },
  });
  const result = await svc.submitWork(
    {
      pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'),
      limits: {
        ...okLimits,
        checkPromotedCap: async () => ({
          code: 'at_capacity',
          message: 'You already have 5 PRs up for vote. Wait for one to merge, or archive one first.',
        }),
      },
    },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'at_capacity');
  assert.match(result.message, /5 PRs up for vote/, 'the browser’s own wording');
  assert.equal(createdPr, false, 'a refused submit leaves no stray pull request behind');
});

test('a branch still at the base commit is named precisely, not left to GitHub', async () => {
  const gh = baseGh({ findOpenPrByBranch: async () => null, createPR: async () => ({ number: 1 }) });
  const empty = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
      status: 200, body: { commit: { sha: TASK_ROW.base_sha } },
    },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));
  assert.equal(empty.code, 'no_commits');
  assert.equal(empty.retryable, true);
});

test('the pre-push check is advisory: a fork under another name still submits', async () => {
  // The agent may have forked under a name we did not predict, so our public
  // read of the expected fork 404s while the branch exists perfectly well.
  // That must not refuse — GitHub's own answer to createPR is authoritative.
  const queries = [];
  let created = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => {
      created = true;
      return { number: 91, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } } };
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': { status: 404, body: {} },
  }, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, status: 200, body: { sessionId: 61 } }) }
  ));
  assert.equal(created, true, 'GitHub gets the final word on whether the head exists');
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 91);
});

test('a head GitHub really cannot find is reported as the missing branch it is', async () => {
  // GitHub answers an unknown head with an UNTYPED 422 ("invalid field:
  // head"). Our own read already said the branch is not on the expected
  // fork, so say the useful thing rather than "could not be opened".
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => {
      const err = new Error('Validation Failed');
      err.status = 422;
      throw err;
    },
  });
  const result = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': { status: 404, body: {} },
  }, [], () => svc.submitWork(
    { pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  ));
  assert.equal(result.code, 'branch_not_found');
  assert.equal(result.retryable, true);
  assert.match(result.message, /someuser\/recipe-box/);
});

test('a task that is not the caller’s own is simply unknown', async () => {
  const queries = [];
  const result = await svc.submitWork(
    {
      pool: fakePool([['FROM external_agent_tasks t JOIN apps a', []]], queries),
      config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 99 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'unknown_task');
  // Ownership is in the WHERE clause, not in a branch after the read.
  assert.match(SRC, /WHERE t\.id = \$1 AND t\.user_id = \$2 AND t\.status = 'open'/);
});

test('a platform refusal to import is passed back with the platform’s own answer', async () => {
  const queries = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 88, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } },
    }),
  });
  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => ({ ok: false, status: 409, body: { error: 'That PR is already imported.' } }),
    }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'import_failed');
  assert.equal(result.platformResult.status, 409);
  assert.match(result.message, /already imported/);
  // The task stays open so the user can retry once the conflict is cleared.
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE external_agent_tasks')));
});

// ── Structural guarantees ──────────────────────────────────────────────

test('NO user credential is used, and every direct GitHub call is a public read', () => {
  // The load-bearing property of the identity-only link. A re-introduced
  // user-token header here would mean the OAuth scope has to widen back to
  // `public_repo` — read/write access to code in every public repository the
  // user can reach — which is exactly what this design removed.
  assert.doesNotMatch(SRC, /authorization:\s*`Bearer \$\{(token|link\.token|userToken)/);
  assert.doesNotMatch(SRC, /loadUserToken/);
  assert.doesNotMatch(SRC, /githubAsUser/);
  // github-link exposes no token loader to call, either.
  const LINK_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/github-link.js'), 'utf8'
  );
  assert.doesNotMatch(LINK_SRC, /async function loadUserToken/);

  // Direct fetches go through ONE helper, which builds its headers from the
  // platform's own public-read builder and never takes a credential.
  const helper = SRC.slice(
    SRC.indexOf('async function githubPublic'),
    SRC.indexOf('function sameRepo')
  );
  assert.match(helper, /githubService\.publicApiHeaders\(\)/);
  assert.doesNotMatch(helper, /authorization/i);
  const calls = [...SRC.matchAll(/githubPublic\(\s*\n?\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'the fork read and the branch read');
  for (const method of calls) {
    assert.equal(method, 'GET', 'nothing this service sends directly is a write');
  }
  // No fork/ref/merge-upstream write anywhere.
  assert.doesNotMatch(SRC, /\/forks`/);
  assert.doesNotMatch(SRC, /merge-upstream/);
  assert.doesNotMatch(SRC, /git\/refs/);
});

test('the service never opens a proposal itself', () => {
  // Creating the chat_sessions row, the staging preview, the checks and the
  // vote is the import route's job — reached over loopback with the
  // caller's own token. Reimplementing any of it here would route around
  // the authorization the browser goes through.
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);
  assert.doesNotMatch(SRC, /INSERT INTO pr_votes/);
  assert.match(SRC, /await importProposal\(slug, pr\.number\)/);
});
