// #2570 — what each model is good for, what a change on it is expected to
// cost, and what changes on it actually cost.
//
// The properties worth pinning are the ones a wrong answer would be hard to
// notice:
//   1. the ESTIMATE is derived, never invented: per-token pricing times one
//      token profile, and a model with no published price gets no estimate
//      rather than a plausible-looking zero;
//   2. the token profile comes from the platform's own recorded usage when
//      there is enough of it, and from ONE documented constant otherwise —
//      and says which;
//   3. the OBSERVED figures are per CHANGE, not per turn, and the two
//      per-turn records that carry a model id are folded into one bucket
//      per model whichever label they used;
//   4. an admin override replaces the shown estimate and clears back to the
//      derived one, and nothing rewrites an estimate automatically.
//
// Run with: node --test tests/model-costs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modelCosts = require('../src/services/model-costs');
const models = require('../src/services/models');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── 1. The estimate is arithmetic, not an opinion ───────────────────────

test('an estimate is per-token pricing times the typical change, in cents', () => {
  const profile = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  // $1/MTok in and $2/MTok out over exactly one MTok each = $3 = 300 cents.
  assert.equal(
    modelCosts.estimateCents(
      { inputPricePerMillion: 1, outputPricePerMillion: 2 }, profile,
    ),
    300,
  );
  // The real default profile, on the published Opus price.
  const opus = modelCosts.estimateCents(modelCosts.publishedPricing('claude-opus-5'));
  const { inputTokens, outputTokens } = modelCosts.TYPICAL_CHANGE;
  assert.equal(opus, Math.round(
    ((inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25) * 100 * 100,
  ) / 100);
  // The ladder the picker will show is the ladder the prices describe.
  const sonnet = modelCosts.estimateCents(modelCosts.publishedPricing('claude-sonnet-5'));
  const fable = modelCosts.estimateCents(modelCosts.publishedPricing('claude-fable-5-1'));
  const glm = modelCosts.estimateCents(modelCosts.publishedPricing('z-ai/glm-5.3-flash'));
  assert.ok(glm < sonnet && sonnet < opus && opus < fable,
    `expected glm < sonnet < opus < fable, got ${glm} ${sonnet} ${opus} ${fable}`);
});

test('a model with no published price gets no estimate rather than a zero', () => {
  assert.equal(modelCosts.publishedPricing('some/unknown-model'), null);
  assert.equal(modelCosts.estimateCents(null), null);
  assert.equal(modelCosts.estimateCents({ inputPricePerMillion: 1 }), null);
  assert.equal(modelCosts.estimateCents({ outputPricePerMillion: 1 }), null);
});

test('the Anthropic notes are models.js’s own copy, not a second opinion', () => {
  for (const [id, meta] of Object.entries(models.MODELS)) {
    assert.equal(modelCosts.noteFor(id), meta.changeSize.short,
      `${id}'s note must come from services/models.js`);
  }
  // The OpenRouter ids are stated here because nothing else states them.
  assert.match(modelCosts.noteFor('z-ai/glm-5.3-flash'), /\w/);
  assert.match(modelCosts.noteFor('deepseek/deepseek-v4.1-flash'), /\w/);
  assert.equal(modelCosts.noteFor('nobody/knows'), '');
});

test('one model reached by several labels is one model', () => {
  for (const label of [
    'z-ai/glm-5.3-flash',
    'openrouter/z-ai/glm-5.3-flash',
    'codex-openrouter/z-ai/glm-5.3-flash',
  ]) {
    assert.equal(modelCosts.normalizeModelId(label), 'z-ai/glm-5.3-flash', label);
  }
  assert.equal(modelCosts.normalizeModelId('scout/claude-opus-5'), 'claude-opus-5');
  assert.equal(modelCosts.normalizeModelId('  '), '');
  assert.equal(modelCosts.normalizeModelId(null), '');
});

// ── 2. The typical change ───────────────────────────────────────────────

function poolFor(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, answer] of rows) {
        if (pattern.test(sql)) return { rows: answer };
      }
      return { rows: [] };
    },
  };
}

test('the token profile is measured when there is enough history, and named either way', async () => {
  const enough = poolFor([[/FROM agent_turns/, [{
    changes: String(modelCosts.MIN_SESSIONS_FOR_PROFILE),
    input_tokens: '300000', output_tokens: '20000',
  }]]]);
  assert.deepEqual(await modelCosts.typicalChange(enough), {
    inputTokens: 300000, outputTokens: 20000, source: 'recorded_usage',
    changes: modelCosts.MIN_SESSIONS_FOR_PROFILE,
  });

  // Too few changes for a median to mean anything: the constant, and it
  // says so.
  const thin = poolFor([[/FROM agent_turns/, [{
    changes: '3', input_tokens: '9', output_tokens: '9',
  }]]]);
  const fallback = await modelCosts.typicalChange(thin);
  assert.equal(fallback.source, 'documented_constant');
  assert.equal(fallback.inputTokens, modelCosts.TYPICAL_CHANGE.inputTokens);

  // And a read that fails is the constant too, never a throw: this feeds a
  // picker, not a gate.
  const broken = { async query() { throw new Error('db down'); } };
  assert.equal((await modelCosts.typicalChange(broken)).source, 'documented_constant');
});

// ── 3. Observed spend is per CHANGE ─────────────────────────────────────

test('the observed aggregate reads both per-turn records, per change, over the window', async () => {
  const pool = poolFor([[/turn_costs/, [
    { model: 'z-ai/glm-5.3-flash', changes: '4', avg_cents: '12', median_cents: '10' },
    { model: 'openrouter/z-ai/glm-5.3-flash', changes: '1', avg_cents: '22', median_cents: '22' },
    { model: 'claude-opus-5', changes: '2', avg_cents: '150', median_cents: '140' },
  ]]]);
  const observed = await modelCosts.observedPerModel(pool, { days: 30 });
  const sql = pool.calls[0].sql;
  assert.match(sql, /FROM chat_session_messages/, 'the Mayor and direct-reply record');
  assert.match(sql, /FROM agent_turns/, 'the OpenRouter coding-turn record');
  assert.match(sql, /GROUP BY model, session_id/, 'per CHANGE, not per turn');
  assert.match(sql, /PERCENTILE_CONT\(0\.5\)/, 'a median, because a mean is the long session');
  assert.doesNotMatch(sql, /agent_cost_cents/,
    'the Claude coding ledger has no model dimension and must not be guessed at');
  assert.deepEqual(pool.calls[0].params, ['30']);

  // The two labels for GLM are one bucket, with a changes-weighted average.
  const glm = observed.get('z-ai/glm-5.3-flash');
  assert.equal(glm.changes, 5);
  assert.equal(Math.round(glm.avgCents * 100) / 100, 14);
  assert.equal(glm.medianCents, 10, 'the busier label’s median, not an average of two');
  assert.equal(observed.get('claude-opus-5').changes, 2);
});

// ── 4. Overrides ────────────────────────────────────────────────────────

test('an override replaces the shown estimate and clears back to the derived one', async () => {
  let stored = null;
  const pool = {
    async query(sql, params) {
      if (/SELECT value FROM platform_settings/.test(sql)) {
        return { rows: stored == null ? [] : [{ value: stored }] };
      }
      if (/INSERT INTO platform_settings/.test(sql)) {
        stored = params[1];
        return { rows: [] };
      }
      if (/FROM agent_turns/.test(sql)) return { rows: [{ changes: '0' }] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await modelCosts.readOverrides(pool), {});

  await modelCosts.writeOverride(pool, { modelId: 'claude-opus-5', cents: 250, actorId: 1 });
  assert.deepEqual(await modelCosts.readOverrides(pool), { 'claude-opus-5': 250 });

  const picker = await modelCosts.pickerPayload(pool);
  assert.equal(picker.models['claude-opus-5'].estimateCents, 250);
  assert.equal(picker.models['claude-opus-5'].estimateSource, 'override');
  assert.equal(picker.models['claude-sonnet-5'].estimateSource, 'pricing',
    'the models nobody overrode keep their derived figure');
  assert.equal(picker.typicalChange.source, 'documented_constant');

  await modelCosts.writeOverride(pool, { modelId: 'claude-opus-5', cents: null, actorId: 1 });
  assert.deepEqual(await modelCosts.readOverrides(pool), {});
  const cleared = await modelCosts.pickerPayload(pool);
  assert.equal(cleared.models['claude-opus-5'].estimateSource, 'pricing');

  // Garbage in the setting is ignored rather than rendered.
  stored = '{"good/model": 10, "bad/model": "nope", "": 5}';
  assert.deepEqual(await modelCosts.readOverrides(pool), { 'good/model': 10 });
  stored = 'not json at all';
  assert.deepEqual(await modelCosts.readOverrides(pool), {});
});

test('nothing turns an observed figure into an estimate on its own', () => {
  const src = read('src/services/model-costs.js');
  const admin = read('frontend/src/features/admin/admin-model-costs.tsx');
  // The only writer of the override setting is writeOverride, and its only
  // caller is the admin PUT — an admin typing a number.
  assert.match(src, /async function writeOverride/);
  assert.equal((src.match(/INSERT INTO platform_settings/g) || []).length, 1);
  const routes = read('src/routes/admin.js');
  assert.match(routes, /put\('\/api\/admin\/model-costs', requireAdminWrite/,
    'the write is admin-write gated like its neighbours');
  assert.match(routes, /get\('\/api\/admin\/model-costs'/);
  assert.doesNotMatch(admin, /observedAvgCents.*setDrafts|setDrafts.*observedAvgCents/,
    'the observed figure never prefills the override field');
});

// ── 5. The console section obeys the admin console’s own boundary ──────

test('the Model costs section is registered, routed and audited', () => {
  const console_ = read('frontend/src/features/admin/admin-console.js');
  assert.match(console_, /\{ key: 'model-costs', label: 'Model costs', group: 'Platform' \}/);
  assert.match(console_, /'model-costs': 'AdminModelCosts'/);
  assert.match(console_, /'model-costs': '<svg/, 'the nav entry has an icon like its neighbours');
  assert.match(read('frontend/src/features/admin/sections.ts'), /admin-model-costs\.tsx/);

  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/model-costs' \}/,
    'the section declares React ownership of the host it mounts into');
  assert.match(audit, /'#admin\/model-costs'/, 'and the sweep visits the route');

  const dapp = JSON.parse(read('dapp.json'));
  const declared = dapp.tests.filter((t) => t.path === '/#admin/model-costs');
  assert.ok(declared.length >= 1, 'the screen carries a declared check');
});
