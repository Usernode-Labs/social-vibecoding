'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const followups = require('../src/services/merge-followups');

const SHA = 'a'.repeat(40);

function journalPool(session = null) {
  const actions = new Map();
  const calls = [];
  return {
    actions, calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO merge_followup_actions/.test(sql)) {
        for (const action of params[1]) actions.set(action, null);
        return { rows: [] };
      }
      if (/SELECT completed_at FROM merge_followup_actions/.test(sql)) {
        return { rows: actions.has(params[1]) ? [{ completed_at: actions.get(params[1]) }] : [] };
      }
      if (/SET completed_at = COALESCE/.test(sql)) {
        actions.set(params[1], new Date());
        return { rows: [] };
      }
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(sql)) {
        return { rows: session && [...actions.values()].some((v) => !v) ? [session] : [] };
      }
      if (/UPDATE chat_sessions SET status = 'merged'/.test(sql)) {
        session.status = 'merged';
        session.merge_commit_sha = params[2];
        return { rows: [] };
      }
      if (/SELECT main_check_sha, main_check_state, repo_url FROM apps/.test(sql)) {
        return { rows: [{ main_check_sha: SHA, main_check_state: 'running' }] };
      }
      return { rows: [] };
    },
  };
}

test('a crash just after GitHub merges is reconciled and resumes the recorded plan', async () => {
  const session = {
    id: 42, app_id: 7, status: 'merging', pr_number: 9,
    repo_url: 'https://github.com/acme/example', merge_commit_sha: null,
  };
  const pool = journalPool(session);
  await followups.prepare(pool, session.id);
  let lookups = 0;
  let finalizations = 0;
  const result = await followups.recover({}, {
    pool,
    githubClient: {
      isEnabled: () => true,
      parseGithubUrl: () => ({ owner: 'acme', repo: 'example' }),
      getPR: async () => { lookups++; return { merged: true, merged_at: '2026-09-28T00:00:00Z', merge_commit_sha: SHA }; },
    },
    finalize: async ({ mergeCommitSha, recovering }) => {
      finalizations++;
      assert.equal(mergeCommitSha, SHA);
      assert.equal(recovering, true);
      for (const action of followups.ACTIONS) {
        await followups.run(pool, session.id, action, async () => ({ done: true }));
      }
    },
  });
  assert.deepEqual(result, [42]);
  assert.equal(session.status, 'merged');
  assert.equal(lookups, 1);
  assert.equal(finalizations, 1);
  assert.ok([...pool.actions.values()].every(Boolean));
  await followups.recover({}, { pool, finalize: async () => { throw new Error('should not replay'); } });
});

test('a successful deployment is observed from the runtime before retry', async (t) => {
  const pool = journalPool();
  await followups.prepare(pool, 42);
  const runtime = require('../src/services/application-runtime');
  t.mock.method(runtime, 'productionRef', () => ({ runtimeKind: 'docker', runtimeName: 'usernode-app-demo' }));
  t.mock.method(runtime, 'inspect', async () => ({
    status: 'running', labels: { 'social.usernode.io/source-revision': SHA },
  }));
  const app = { id: 7, slug: 'demo', self_hosted: false, repo_url: 'https://github.com/acme/example' };
  let externalCalls = 0;
  await assert.rejects(() => followups.run(pool, 42, 'production_deploy', async () => {
    externalCalls++;
    throw new Error('process stopped after external success');
  }), /process stopped/);
  const observed = await followups.run(pool, 42, 'production_deploy', async () => {
    externalCalls++;
  }, { observe: () => followups.observedProduction({}, app, SHA) });
  assert.equal(observed.state, 'observed');
  assert.equal(externalCalls, 1);
  assert.ok(pool.actions.get('production_deploy'));
});

test('a main check claimed before a crash is not scheduled twice', async () => {
  const pool = journalPool();
  await followups.prepare(pool, 42);
  let schedules = 0;
  const result = await followups.run(pool, 42, 'main_check', async () => { schedules++; }, {
    observe: () => followups.observedMainCheck(pool, 7, SHA),
  });
  assert.equal(result.state, 'observed');
  assert.equal(schedules, 0);
  assert.ok(pool.actions.get('main_check'));
});
