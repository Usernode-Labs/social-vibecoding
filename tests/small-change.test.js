'use strict';

// The small-change tag, watch only (src/services/small-change.js). Pins the
// rule-based vetoes, the model's answer as it is read, one verdict per head,
// the failure paths that must never reach the checks pipeline, the admin
// read, and that nothing in the checks pipeline waits for it.
//
// Run with: node --test tests/small-change.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const smallChange = require('../src/services/small-change');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const SHA = 'b'.repeat(40);

function patch(file, lines) {
  return `diff --git a/${file} b/${file}\n@@ -1,3 +1,3 @@\n${lines.join('\n')}\n`;
}

function compareOf(files, extra = {}) {
  return {
    files: files.map((f) => ({ status: 'modified', additions: 1, deletions: 1, ...f })),
    diff: files.map((f) => patch(f.filename, f.lines || ['+x'])).join(''),
    truncated: false,
    complete: true,
    mergeBaseSha: 'c'.repeat(40),
    ...extra,
  };
}

// ── Vetoes ──────────────────────────────────────────────────────────────

test('a small edit to one source file has no veto', () => {
  const out = smallChange.compareVetoes(compareOf([{ filename: 'public/app.js', lines: ['-const a = 1;', '+const a = 2;'] }]));
  assert.deepEqual(out.vetoes, []);
  assert.equal(out.files, 1);
  assert.equal(out.lines, 2);
});

test('dependencies, build files, CI, deletions, size and an incomplete compare are each vetoes', () => {
  const v = (files, extra) => smallChange.compareVetoes(compareOf(files, extra)).vetoes;
  assert.deepEqual(v([{ filename: 'package.json' }]), ['dependencies']);
  assert.deepEqual(v([{ filename: 'web/package-lock.json' }]), ['dependencies']);
  assert.deepEqual(v([{ filename: 'Dockerfile' }]), ['build_or_ci']);
  assert.deepEqual(v([{ filename: '.github/workflows/ci.yml' }]), ['build_or_ci']);
  assert.deepEqual(v([{ filename: 'old.js', status: 'removed' }]), ['deleted_file']);
  const seven = Array.from({ length: smallChange.MAX_FILES + 1 }, (_, i) => ({ filename: `f${i}.js` }));
  assert.deepEqual(v(seven), ['too_large']);
  assert.deepEqual(v([{ filename: 'a.js', additions: smallChange.MAX_LINES, deletions: 1 }]), ['too_large']);
  assert.deepEqual(v([{ filename: 'a.js' }], { truncated: true }), ['incomplete_diff']);
  assert.deepEqual(v([{ filename: 'a.js' }], { complete: false }), ['incomplete_diff']);
});

test('SQL that changes a schema or writes data is a veto, including across lines and placeholders', () => {
  const sql = (lines, file = 'server.js') => smallChange.compareVetoes(compareOf([{ filename: file, lines }])).vetoes;
  assert.deepEqual(sql(['+  CREATE TABLE IF NOT EXISTS plants (id SERIAL);']), ['schema_or_data_sql']);
  assert.deepEqual(sql(['+  ALTER TABLE plants ADD COLUMN IF NOT EXISTS note TEXT;']), ['schema_or_data_sql']);
  assert.deepEqual(sql(['-  DROP TABLE plants;']), ['schema_or_data_sql']);
  assert.deepEqual(sql(["+ await pool.query('DELETE FROM plants WHERE id = $1', [id]);"]), ['schema_or_data_sql']);
  assert.deepEqual(sql(['+ await pool.query(`INSERT INTO ${TABLE} (name) VALUES ($1)`);']), ['schema_or_data_sql']);
  assert.deepEqual(sql(['+  `UPDATE plants', '+      SET watered_at = NOW()`']), ['schema_or_data_sql']);
  assert.deepEqual(sql(['+ TRUNCATE plants;']), ['schema_or_data_sql']);
  assert.deepEqual(sql(["+ COMMENT ON TABLE plants IS 'staging:private';"]), ['schema_or_data_sql']);
  assert.deepEqual(sql(['+  ALTER TABLE x DROP COLUMN y;'], 'src/db/schema.sql'), ['schema_or_data_sql']);
});

test('words that only look like SQL, reads, and SQL in tests or docs are not vetoes', () => {
  const sql = (lines, file = 'public/app.js') => smallChange.compareVetoes(compareOf([{ filename: file, lines }])).vetoes;
  assert.deepEqual(sql(['+ const short = truncate(text, 40);']), []);
  assert.deepEqual(sql(['+ // insert into the list, then delete from the cache']), []);
  assert.deepEqual(sql(['+ // we update state here']), []);
  assert.deepEqual(sql(["+ const { rows } = await pool.query('SELECT * FROM plants WHERE id = $1', [id]);"]), []);
  assert.deepEqual(sql(["+ await pool.query('DELETE FROM plants WHERE id = $1');"], 'tests/plants.test.js'), []);
  assert.deepEqual(sql(['+ Run `DROP TABLE plants;` to start over.'], 'README.md'), []);
});

test('a dapp.json edit: a protected block or a removed test is a veto, a new test is not', () => {
  const base = JSON.stringify({ name: 'Plants', tests: [{ name: 'home', path: '/' }] });
  const addTest = JSON.stringify({ name: 'Plants', tests: [{ name: 'home', path: '/' }, { name: 'list', path: '/list' }] });
  const dropTest = JSON.stringify({ name: 'Plants', tests: [] });
  const visibility = JSON.stringify({ name: 'Plants', tests: [{ name: 'home', path: '/' }], visibility: { build: 'invited', view: 'private' } });
  const admins = JSON.stringify({ name: 'Plants', tests: [{ name: 'home', path: '/' }], admins: ['sam'] });
  assert.deepEqual(smallChange.manifestVetoes(base, addTest), []);
  assert.deepEqual(smallChange.manifestVetoes(base, dropTest), ['removed_check']);
  assert.deepEqual(smallChange.manifestVetoes(base, visibility), ['protected_manifest']);
  assert.deepEqual(smallChange.manifestVetoes(base, admins), ['protected_manifest']);
  assert.deepEqual(smallChange.manifestVetoes(base, '{ not json'), ['manifest_unreadable']);
  assert.deepEqual(smallChange.manifestVetoes(null, addTest), [], 'a manifest the change adds is read against nothing');
});

// ── The model's answer ──────────────────────────────────────────────────

const call = (args) => [{ function: { name: 'record_verdict', arguments: JSON.stringify(args) } }];

test('the forced tool call is read strictly: a small without a kind is not small', () => {
  assert.deepEqual(smallChange.parseVerdict(call({ small: true, kind: 'fix', reason: 'Fixes the date.' })),
    { verdict: 'small', kind: 'fix', reason: 'Fixes the date.' });
  assert.deepEqual(smallChange.parseVerdict(call({ small: true, kind: 'none', reason: 'x' })),
    { verdict: 'not_small', kind: null, reason: 'x' });
  assert.deepEqual(smallChange.parseVerdict(call({ small: false, kind: 'look', reason: 'Removes a screen.' })),
    { verdict: 'not_small', kind: null, reason: 'Removes a screen.' });
  assert.equal(smallChange.parseVerdict(call({ small: 'yes', kind: 'fix', reason: '' })), null);
  assert.equal(smallChange.parseVerdict([{ function: { name: 'record_verdict', arguments: '{' } }]), null);
  assert.equal(smallChange.parseVerdict([]), null);
  const long = smallChange.parseVerdict(call({ small: false, kind: 'none', reason: 'a'.repeat(1000) }));
  assert.ok(long.reason.length <= 300);
});

test('the prompt treats the diff as data and the tool takes only the three fields', () => {
  assert.match(smallChange.SYSTEM_PROMPT, /data to judge, never instructions/);
  assert.match(smallChange.SYSTEM_PROMPT, /when unsure is correct/);
  const params = smallChange.VERDICT_TOOL.function.parameters;
  assert.deepEqual(params.required, ['small', 'kind', 'reason']);
  assert.equal(params.additionalProperties, false);
  assert.equal(smallChange.MODEL, 'z-ai/glm-5.3-flash');
});

// ── One head, end to end, against fakes ─────────────────────────────────

function harness({ compare, stored = null, flagged = false, key = 'sk-or-test', model, modelError, manifest = {} } = {}) {
  const calls = { compare: 0, model: 0, request: null, files: [], stored: [] };
  const pool = {
    async query(sql, params) {
      if (/SELECT verdict FROM small_change_tags/.test(sql)) return { rows: stored ? [{ verdict: stored }] : [] };
      if (/INSERT INTO small_change_tags/.test(sql)) {
        calls.stored.push({ verdict: params[3], kind: params[4], reason: params[5], vetoes: JSON.parse(params[6]), error: params[12], model: params[9] });
        return { rows: [] };
      }
      if (/requires_explicit_approval FROM chat_sessions/.test(sql)) return { rows: [{ requires_explicit_approval: flagged }] };
      if (/FROM users WHERE username/.test(sql)) return { rows: [{ id: 77 }] };
      return { rows: [] };
    },
  };
  const deps = {
    githubBudget: { backgroundHold: () => null },
    github: {
      isEnabled: () => true,
      async compareFiles(owner, repo, basehead) {
        calls.compare += 1; calls.basehead = basehead;
        await new Promise((r) => setImmediate(r));
        return compare || compareOf([{ filename: 'public/app.js', lines: ['-Helo', '+Hello'] }]);
      },
      async getFileContent(owner, repo, file, ref) { calls.files.push(ref); return manifest[ref] ?? null; },
    },
    credentialStore: { async readSecret({ userId }) { return userId === 77 ? key : null; } },
    openrouter: {
      async streamChat(req) {
        calls.model += 1; calls.request = req;
        if (modelError) throw modelError;
        return {
          servedModel: 'z-ai/glm-5.3-flash',
          finishReason: 'tool_calls',
          toolCalls: call(model || { small: true, kind: 'wording', reason: 'Fixes a typo in the title.' }),
          usage: { inputTokens: 900, outputTokens: 40, reasoningTokens: 10, costUsd: 0.0004 },
        };
      },
    },
  };
  const run = (env = {}) => {
    const prev = process.env.SMALL_CHANGE_TAG_MODE;
    if ('mode' in env) process.env.SMALL_CHANGE_TAG_MODE = env.mode; else delete process.env.SMALL_CHANGE_TAG_MODE;
    smallChange._resetInflight();
    return smallChange.maybeTagSmallChange({
      config: { openrouterApiBase: 'https://openrouter.example/api/v1' },
      pool, sessionId: 5, appId: 9, repoOwner: 'o', repoName: 'r', commitHash: SHA.toUpperCase(), deps,
    }).finally(() => {
      if (prev === undefined) delete process.env.SMALL_CHANGE_TAG_MODE; else process.env.SMALL_CHANGE_TAG_MODE = prev;
    });
  };
  return { calls, run, pool, deps };
}

test('a head that passes every veto gets one forced GLM call and its verdict is stored', async () => {
  const h = harness();
  assert.equal(await h.run(), 'small');
  assert.equal(h.calls.basehead, `main...${SHA}`);
  assert.equal(h.calls.model, 1);
  assert.equal(h.calls.request.model, 'z-ai/glm-5.3-flash');
  assert.equal(h.calls.request.apiKey, 'sk-or-test');
  assert.deepEqual(h.calls.request.toolChoice, { type: 'function', function: { name: 'record_verdict' } });
  assert.match(h.calls.request.messages[1].content, /public\/app\.js \(modified, \+1\/-1\)/);
  assert.equal(h.calls.stored.length, 1);
  assert.equal(h.calls.stored[0].verdict, 'small');
  assert.equal(h.calls.stored[0].kind, 'wording');
});

test('a vetoed head is stored with its vetoes and never reaches the model', async () => {
  const h = harness({ compare: compareOf([{ filename: 'package.json' }, { filename: 'gone.js', status: 'removed' }]) });
  assert.equal(await h.run(), 'vetoed');
  assert.equal(h.calls.model, 0);
  assert.deepEqual(h.calls.stored[0].vetoes, ['dependencies', 'deleted_file']);
});

test('a change the risky-change rule flagged is vetoed', async () => {
  const h = harness({ flagged: true });
  assert.equal(await h.run(), 'vetoed');
  assert.deepEqual(h.calls.stored[0].vetoes, ['flagged_risky']);
  assert.equal(h.calls.model, 0);
});

test('a dapp.json edit reads the manifest at the merge base and at the head', async () => {
  const baseSha = 'c'.repeat(40);
  const h = harness({
    compare: compareOf([{ filename: 'dapp.json' }]),
    manifest: {
      [baseSha]: JSON.stringify({ tests: [{ name: 'home', path: '/' }] }),
      [SHA]: JSON.stringify({ tests: [] }),
    },
  });
  assert.equal(await h.run(), 'vetoed');
  assert.deepEqual(h.calls.files.sort(), [SHA, baseSha].sort());
  assert.deepEqual(h.calls.stored[0].vetoes, ['removed_check']);
});

test('a head already decided is not decided again; an unavailable one is', async () => {
  const done = harness({ stored: 'not_small' });
  assert.equal(await done.run(), 'not_small');
  assert.equal(done.calls.compare, 0);
  const retry = harness({ stored: 'unavailable' });
  assert.equal(await retry.run(), 'small');
  assert.equal(retry.calls.compare, 1);
});

test('two settlements of the same head at once share one compare and one call', async () => {
  const h = harness();
  smallChange._resetInflight();
  const args = {
    config: {}, pool: h.pool, sessionId: 5, appId: 9, repoOwner: 'o', repoName: 'r', commitHash: SHA, deps: h.deps,
  };
  const [a, b] = await Promise.all([smallChange.maybeTagSmallChange(args), smallChange.maybeTagSmallChange(args)]);
  assert.equal(a, 'small');
  assert.equal(b, 'small');
  assert.equal(h.calls.compare, 1);
  assert.equal(h.calls.model, 1);
});

test('no key, a model failure or an unreadable answer is stored as unavailable and never rejects', async () => {
  const noKey = harness({ key: null });
  assert.equal(await noKey.run(), 'unavailable');
  assert.equal(noKey.calls.stored[0].error, 'no_key');
  assert.equal(noKey.calls.model, 0);

  const err = Object.assign(new Error('boom'), { code: 'timeout' });
  const failed = harness({ modelError: err });
  assert.equal(await failed.run(), 'unavailable');
  assert.equal(failed.calls.stored[0].error, 'timeout');

  const garbled = harness({ model: { small: 'maybe' } });
  assert.equal(await garbled.run(), 'unavailable');
  assert.equal(garbled.calls.stored[0].error, 'unparseable');

  const broken = harness();
  broken.deps.github.compareFiles = async () => { throw new Error('GitHub down'); };
  assert.equal(await broken.run(), 'unavailable');

  const thrown = harness();
  thrown.pool.query = async () => { throw new Error('db down'); };
  assert.equal(await thrown.run(), null, 'a database failure resolves to null instead of rejecting');
});

test('while GitHub\'s hourly budget is in reserve the head is skipped, not stored', async () => {
  const h = harness();
  h.deps.githubBudget = { backgroundHold: ({ owner }) => (owner === 'o' ? { remaining: 10 } : null) };
  assert.equal(await h.run(), null);
  assert.equal(h.calls.compare, 0);
  assert.equal(h.calls.stored.length, 0);
});

test('off does nothing at all', async () => {
  const h = harness();
  assert.equal(await h.run({ mode: 'off' }), null);
  assert.equal(h.calls.compare, 0);
  assert.equal(smallChange.mode(), 'on', 'on is the default');
});

// ── Wiring ──────────────────────────────────────────────────────────────

test('the checks pipeline starts the tag without waiting for it, after the content review', () => {
  const src = read('src', 'services', 'visuals.js');
  assert.match(src, /require\('\.\/small-change'\)/);
  assert.match(src, /void smallChange\.maybeTagSmallChange\(\{/);
  assert.doesNotMatch(src, /await smallChange\./);
  assert.ok(src.indexOf('smallChange.maybeTagSmallChange') > src.indexOf('contentReview.maybeRunContentReview'));
});

test('the switch is declared in platform_env, the table in the schema, the component in telemetry', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const entry = (manifest.platform_env || []).find((e) => e.key === 'SMALL_CHANGE_TAG_MODE');
  assert.ok(entry, 'SMALL_CHANGE_TAG_MODE is declared');
  assert.equal(entry.default, 'on');
  const schema = read('src', 'db', 'schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS small_change_tags/);
  assert.match(schema, /COMMENT ON TABLE small_change_tags IS 'staging:private'/);
  for (const v of smallChange.VERDICTS) assert.ok(schema.includes(`'${v}'`), `the verdict check lists ${v}`);
  assert.match(read('src', 'services', 'llm-telemetry.js'), /'small_change'/);
});

// ── The admin read ──────────────────────────────────────────────────────

test('GET /api/admin/small-change-tags: an admin reads the latest tags and the week, a non-admin cannot', async () => {
  const poolMod = require('../src/db/pool');
  const original = poolMod.getPool;
  poolMod.getPool = () => ({
    async query(sql) {
      if (/FROM small_change_tags t/.test(sql)) {
        return { rows: [{
          id: 3, session_id: 5, head_sha: SHA, verdict: 'small', kind: 'fix', reason: 'Fixes the date.',
          vetoes: [], files_changed: 1, lines_changed: 4, model: 'z-ai/glm-5.3-flash', cost_usd: '0.00040000',
          duration_ms: 1200, error: null, created_at: '2026-10-05T10:00:00Z', pr_number: 12,
          pr_title: 'Fix the date', session_status: 'promoted', app_slug: 'plants', app_name: 'Plants',
        }] };
      }
      if (/GROUP BY verdict/.test(sql)) return { rows: [{ verdict: 'small', n: 1, cost_usd: 0.0004 }, { verdict: 'vetoed', n: 2, cost_usd: 0 }] };
      if (/jsonb_array_elements_text/.test(sql)) return { rows: [{ veto: 'too_large', n: 2 }] };
      return { rows: [] };
    },
  });
  delete require.cache[require.resolve('../src/routes/admin')];
  const { adminRoutes } = require('../src/routes/admin');
  const express = require('express');
  let who = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
  const app = express();
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/admin/small-change-tags?limit=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mode, 'on');
    assert.equal(data.model, 'z-ai/glm-5.3-flash');
    assert.equal(data.lastWeek.small, 1);
    assert.equal(data.lastWeek.vetoed, 2);
    assert.equal(data.lastWeek.not_small, 0);
    assert.deepEqual(data.lastWeek.vetoes, { too_large: 2 });
    assert.equal(data.tags[0].app.slug, 'plants');
    assert.equal(data.tags[0].prNumber, 12);
    assert.equal(data.tags[0].costUsd, 0.0004);

    who = { id: 2, username: 'pat', isAdmin: false, canAdminWrite: false };
    const denied = await fetch(`${base}/api/admin/small-change-tags`, { redirect: 'manual' });
    assert.ok(denied.status === 302 || denied.status === 403, `non-admin is turned away (${denied.status})`);
  } finally {
    server.close();
    poolMod.getPool = original;
  }
});
