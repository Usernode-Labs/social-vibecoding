'use strict';

// The move's third step (services/github-move.js): a moved app's proposals
// still linked to their pull requests on GitHub, dead since the suspension
// (25 Oct 2026), and the change's Details drew "Open on GitHub" for each.
// Each becomes its change page in Homeroom (native-pulls changeUrl), which
// the shared link reader (frontend/src/lib/repo-link.js) reads as a Homeroom
// page, so no outbound link is drawn. Pinned here without a database:
//
//   1. which rows move, and to where: only a pull request of the app's own
//      old repository, on an app whose repository is on the git host now;
//      the platform's repository and an app still on GitHub keep theirs;
//   2. the boot step's two queries, a second boot finding nothing to move,
//      and a failed read that leaves boot going.
//
// The whole migration against the real schema is
// tests/github-move-postgres.test.js.
//
// Run with: node --test tests/github-move-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const move = require('../src/services/github-move');
const { repoLink } = require('./lib/repo-link');

function withEnv(t, vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const HOST = { GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: undefined, GIT_HOST_ORG: 'apps', USERNODE_DOMAIN: 'homeroom.example.test' };

const moved = {
  slug: 'todo-list-b91765',
  repo_url: 'https://git.example.test/apps/todo-list-b91765',
  github_repo_url: 'https://github.com/usernode-bot/todo-list-b91765',
};
const row = (id, prNumber, prUrl, app = moved) => ({ id, pr_number: prNumber, pr_url: prUrl, ...app });

test("a moved app's GitHub pull request links become its change pages, open, merged or closed", (t) => {
  withEnv(t, HOST);
  const gh = 'https://github.com/usernode-bot/todo-list-b91765/pull';
  const out = move.changePages([
    row(1, 20, `${gh}/20`),
    row(2, 21, `${gh}/21/files`),
    // The address's case is GitHub's, not the stored one's.
    row(3, 22, 'https://github.com/Usernode-Bot/Todo-List-B91765/pull/22'),
  ]);
  const page = 'https://homeroom.example.test/#app/todo-list-b91765/dev/changes';
  assert.deepEqual(out, [
    { id: 1, was: `${gh}/20`, url: `${page}/20` },
    { id: 2, was: `${gh}/21/files`, url: `${page}/21` },
    { id: 3, was: 'https://github.com/Usernode-Bot/Todo-List-B91765/pull/22', url: `${page}/22` },
  ]);
  for (const { url } of out) {
    assert.equal(repoLink.linkKind(url), 'homeroom', 'no "Open on GitHub" for it');
    assert.match(repoLink.homeroomRoute(url), /^#app\/todo-list-b91765\/dev\/changes\/2[0-2]$/);
  }
});

test('the session keeps its own number: the change page is what the platform writes for it', (t) => {
  withEnv(t, HOST);
  const [one] = move.changePages([row(9, 31, 'https://github.com/usernode-bot/todo-list-b91765/pull/30')]);
  assert.equal(one.url, require('../src/services/native-pulls').changeUrl('todo-list-b91765', 31));
});

test("the platform's repository, an app still on GitHub and another repository's pull request keep theirs", (t) => {
  withEnv(t, HOST);
  const platform = {
    slug: 'usernode-2d5619',
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    github_repo_url: null,
  };
  const held = {
    slug: 'dtv-610ccb',
    repo_url: 'https://github.com/usernode-bot/dtv-610ccb',
    github_repo_url: 'https://github.com/usernode-bot/dtv-610ccb',
  };
  assert.deepEqual(move.changePages([
    row(1, 5821, 'https://github.com/Usernode-Labs/social-vibecoding/pull/5821', platform),
    row(2, 4, 'https://github.com/usernode-bot/dtv-610ccb/pull/4', held),
    // A moved app's row naming some other repository's pull request.
    row(3, 7, 'https://github.com/someone/elsewhere/pull/7'),
    // Not a pull request page.
    row(4, 8, 'https://github.com/usernode-bot/todo-list-b91765/issues/8'),
    // No number to address a change page by.
    row(5, null, 'https://github.com/usernode-bot/todo-list-b91765/pull/9'),
  ]), []);
});

test('a link already moved is left as it is, so a second pass changes nothing', (t) => {
  withEnv(t, HOST);
  const [once] = move.changePages([row(1, 20, 'https://github.com/usernode-bot/todo-list-b91765/pull/20')]);
  assert.deepEqual(move.changePages([row(1, 20, once.url)]), []);
});

test('without a git host configured nothing is on it, so nothing moves', (t) => {
  withEnv(t, { ...HOST, GIT_HOST_URL: undefined });
  assert.deepEqual(move.changePages([row(1, 20, 'https://github.com/usernode-bot/todo-list-b91765/pull/20')]), []);
});

// A pool that answers the candidates query with `rows` and records the rest.
function fakePool(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('relation "git_host_moves" does not exist');
      if (sql === move.GITHUB_LINKS_SQL) return { rows: rows.splice(0) };
      if (sql === move.RELINK_SQL) return { rowCount: params[0].length };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('the boot step moves the links in one update, guarded on the link it read, then finds none', async (t) => {
  withEnv(t, HOST);
  const gh = 'https://github.com/usernode-bot/todo-list-b91765/pull';
  const pool = fakePool([
    row(1, 20, `${gh}/20`),
    row(2, 4, 'https://github.com/usernode-bot/dtv-610ccb/pull/4', {
      slug: 'dtv-610ccb', repo_url: 'https://github.com/usernode-bot/dtv-610ccb', github_repo_url: 'https://github.com/usernode-bot/dtv-610ccb',
    }),
    row(3, 22, `${gh}/22`),
  ]);
  assert.equal(await move.relinkProposals(pool), 2);
  assert.equal(pool.calls.length, 2);
  assert.deepEqual(pool.calls[1].params, [
    [1, 3],
    [`${gh}/20`, `${gh}/22`],
    ['https://homeroom.example.test/#app/todo-list-b91765/dev/changes/20', 'https://homeroom.example.test/#app/todo-list-b91765/dev/changes/22'],
  ]);
  assert.match(move.RELINK_SQL, /cs\.pr_url = l\.was/, 'a link written since the read is not overwritten');
  // Only applied moves, numbered proposals, GitHub pull request links.
  for (const clause of [/m\.applied_at IS NOT NULL/, /cs\.pr_number > 0/, /cs\.pr_url ILIKE 'https:\/\/github\.com\/%\/pull\/%'/]) {
    assert.match(move.GITHUB_LINKS_SQL, clause);
  }

  // The next boot: nothing left to move, one read and no write.
  assert.equal(await move.relinkProposals(pool), 0);
  assert.equal(pool.calls.length, 3);
});

test('a failed read logs and lets boot go on', async (t) => {
  withEnv(t, HOST);
  const pool = fakePool([], { fail: true });
  assert.equal(await move.relinkProposals(pool), 0);
  assert.equal(pool.calls.length, 1);
});
