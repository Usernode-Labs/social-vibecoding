'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const edit = require('../src/services/proposal-description-edit');

function fixture(patch = {}) {
  let row = {
    id: 42, user_id: 7, app_id: 1, app_slug: 'demo', status: 'paused',
    is_headless: false, source: 'cli_handoff', pr_number: 91,
    repo_url: 'https://github.com/Acme/Demo', pr_summary_md: 'Old description',
    pr_summary_input_version: '4', pr_summary_source: 'generated', pr_summary_stale: true,
    pr_body: 'Old description\n\n## Technical details\nDo the thing.\n\nCloses #123\n\n==== TESTING ====\n/open',
    branch_name: 'dev/test', check_state: 'passing', checks_commit_sha: 'a'.repeat(40),
    handoff_head_sha: 'a'.repeat(40), votes: [1, 2], linked_issues: [123],
    ...patch,
  };
  let body = row.pr_body;
  const updates = [];
  const writes = [];
  const pool = { query: async (sql, args) => {
    if (/SELECT cs\.\*/.test(sql)) {
      return { rows: row.id === args[0] && row.user_id === args[1]
        && !row.is_headless && edit.OPEN_STATUSES.includes(row.status) ? [{ ...row }] : [] };
    }
    if (/pr_summary_input_version = pr_summary_input_version \+ 1/.test(sql)) {
      if (row.pr_summary_input_version != args[4]) return { rows: [] };
      writes.push(sql);
      row = { ...row, pr_summary_previous_md: row.pr_summary_md,
        pr_summary_md: args[0], pr_summary_source: 'author', pr_summary_stale: false,
        pr_summary_input_version: Number(row.pr_summary_input_version) + 1 };
      return { rows: [{ ...row }] };
    }
    if (/SET pr_body =/.test(sql)) { row.pr_body = args[0]; return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const gh = {
    parseGithubUrl: () => ({ owner: 'Acme', repo: 'Demo' }),
    getPR: async () => ({ body }),
    updatePR: async (owner, repo, n, value) => { updates.push(value); body = value.body; },
  };
  return { pool, gh, row: () => row, updates, writes,
    save: (description, expectedVersion = 4, extra = {}) => edit.edit({
      pool, gh, sessionId: 42, userId: 7,
      input: edit.parseEdit({ description, expectedVersion }),
      serialize: (_id, fn) => fn(), lock: (_pool, _id, fn) => fn(), ...extra,
    }) };
}

test('bounded Markdown is retained without silent truncation', () => {
  const description = '### Problems found\n\n' + 'word '.repeat(2000);
  assert.equal(edit.parseEdit({ description, expectedVersion: 0 }).description, description.trim());
  for (const body of [null, [], {}, { description: '  ', expectedVersion: 0 },
    { description: 123, expectedVersion: 0 }, { description: 'x'.repeat(16001), expectedVersion: 0 },
    { description: 'x' }, { description: 'x', expectedVersion: -1 },
    { description: 'x', expectedVersion: 1.5 }, { description: 'x', expectedVersion: '4' },
    { description: 'x', expectedVersion: 0, status: 'promoted' }]) {
    assert.throws(() => edit.parseEdit(body), JSON.stringify(body));
  }
});

test('saving updates the reader-facing text and native PR prefix, preserving the rest', async () => {
  const f = fixture(); const before = f.row();
  const result = await f.save('### Problems found\n\n- Independent counts misstate conversion.');
  assert.equal(result.status, 200);
  assert.equal(result.body.version, 5);
  assert.equal(result.body.stale, false);
  assert.equal(result.body.prBodyStatus, 'synced');
  assert.equal(f.row().pr_summary_source, 'author');
  assert.match(f.updates[0].body, /^### Problems found/);
  assert.equal(f.updates[0].body.split('\n\n## Technical details')[1], before.pr_body.split('\n\n## Technical details')[1]);
  for (const field of ['branch_name', 'check_state', 'checks_commit_sha', 'handoff_head_sha', 'votes', 'linked_issues', 'status']) {
    assert.deepEqual(f.row()[field], before[field], field);
  }
});

test('a stale editor cannot overwrite a newer description', async () => {
  const f = fixture();
  assert.equal((await f.save('New description', 3)).status, 409);
  assert.deepEqual(f.updates, []);
  assert.equal(f.row().pr_summary_md, 'Old description');
});

test('a retry after a lost response synchronizes without another version bump', async () => {
  const f = fixture();
  await f.save('New description');
  const retry = await f.save('New description');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.changed, false);
  assert.equal(retry.body.version, 5);
  assert.equal(f.writes.length, 1);
  assert.equal(f.updates.length, 1);
});

test('GitHub failure keeps the saved description and is explicitly retryable', async () => {
  const f = fixture(); const update = f.gh.updatePR;
  f.gh.updatePR = async () => { throw new Error('unavailable'); };
  const saved = await f.save('New description');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.prBodyStatus, 'github_write_failed');
  assert.equal(saved.body.description, 'New description');
  f.gh.updatePR = update;
  assert.equal((await f.save('New description', saved.body.version)).body.prBodyStatus, 'synced');
  assert.equal(f.updates.length, 1);
});

test('imported proposals change only their Homeroom description', async () => {
  const f = fixture({ source: 'imported' });
  const result = await f.save('Clear description');
  assert.equal(result.body.description, 'Clear description');
  assert.equal(result.body.prBodyStatus, 'imported_pr');
  assert.deepEqual(f.updates, []);
});

test('a retry repairs the local PR mirror when GitHub already has the saved description', async () => {
  const f = fixture(); const query = f.pool.query;
  f.pool.query = async (sql, args) => {
    if (/SET pr_body =/.test(sql)) throw new Error('database interrupted');
    return query(sql, args);
  };
  assert.equal((await f.save('New description')).body.prBodyStatus, 'github_mirror_failed');
  assert.equal(f.updates.length, 1);
  f.pool.query = query;
  assert.equal((await f.save('New description', 5)).body.prBodyStatus, 'synced');
  assert.equal(f.updates.length, 1, 'GitHub does not need another write');
  assert.match(f.row().pr_body, /^New description\n\n## Technical details/);
});

test('authors can edit every open lifecycle without GitHub linking', async () => {
  for (const status of edit.OPEN_STATUSES) {
    const f = fixture({ status, pr_number: null });
    assert.equal((await f.save('Clear description')).status, 200, status);
    assert.deepEqual(f.updates, []);
  }
});

test('foreign, headless and settled changes are not editable', async () => {
  for (const patch of [{ user_id: 8 }, { is_headless: true },
    { status: 'merged' }, { status: 'archived' }, { status: 'closed' }]) {
    const f = fixture(patch);
    assert.equal((await f.save('Not mine')).status, 404, JSON.stringify(patch));
    assert.equal(f.writes.length, 0);
    assert.equal(f.updates.length, 0);
  }
});

test('a head/summary invalidation racing the read is caught by the atomic version check', async () => {
  const f = fixture(); const query = f.pool.query;
  f.pool.query = async (sql, args) => /RETURNING \*/.test(sql) ? { rows: [] } : query(sql, args);
  assert.equal((await f.save('Draft from previous head')).status, 409);
  assert.deepEqual(f.updates, []);
});

test('#4098: parseEdit stores an explain fence canonically and keeps an invalid one as the text typed', () => {
  const explainBlocks = require('../src/services/explain-blocks');
  const steps = { kind: 'steps', steps: ['Open Settings', 'Tap Dark'] };
  const typed = `Adds a switch.\n\n\`\`\`explain\n${JSON.stringify({ v: 1, blocks: [{ ...steps, colour: 'x' }] }, null, 2)}\n\`\`\`  `;
  assert.equal(edit.parseEdit({ description: typed, expectedVersion: 0 }).description,
    explainBlocks.embed('Adds a switch.', [steps]));
  const bad = 'Adds a switch.\n\n```explain\n{oops\n```';
  assert.equal(edit.parseEdit({ description: bad, expectedVersion: 0 }).description, bad);
});
