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
  const deepseek = modelCosts.estimateCents(modelCosts.publishedPricing('deepseek/deepseek-v4.1-flash'));
  assert.ok(deepseek < glm && glm < sonnet && sonnet < opus && opus < fable,
    `expected deepseek < glm < sonnet < opus < fable, got ${deepseek} ${glm} ${sonnet} ${opus} ${fable}`);

  // And the figures themselves, in cents. The derivation above cannot
  // catch a wrong PROFILE, because it uses the same one; these are the
  // numbers a person actually reads, so a change to either the profile or
  // a published price has to be a deliberate edit here.
  // estimateCents keeps two decimals of a cent so that a sub-cent model is
  // not flattened to zero, so pin the figure as a PERSON reads it: rounded
  // to the cent, in dollars. A change to the profile or to a published
  // price has to be a deliberate edit here.
  const shown = (c) => `$${(c / 100).toFixed(2)}`;
  assert.deepEqual(
    { deepseek: shown(deepseek), glm: shown(glm), sonnet: shown(sonnet),
      opus: shown(opus), fable: shown(fable) },
    { deepseek: '$0.21', glm: '$0.30', sonnet: '$6.20',
      opus: '$15.50', fable: '$31.00' },
    'at 2.5M in / 120k out, these are the five figures the picker states',
  );
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
  // #2592: the change is summed WHOLE and attributed to one model, rather
  // than sliced per model and counted once per slice. `per_model` survives
  // as the intermediate that picks the attribution.
  assert.match(sql, /GROUP BY session_id, model/, 'each model\u2019s slice, as an intermediate');
  assert.match(sql, /per_change AS \(\s*SELECT session_id, SUM\(cents\) AS cents\s*FROM per_model\s*GROUP BY session_id/,
    'the change is summed whole, across every model it touched');
  assert.match(sql, /DISTINCT ON \(session_id\) session_id, model/,
    'and attributed to the model that spent the most in it');
  assert.match(sql, /ORDER BY session_id, cents DESC, model/, 'deterministic on a tie');
  assert.doesNotMatch(sql, /GROUP BY model, session_id\b/,
    'the old shape counted one change once per model, at part of its cost');
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
  assert.equal(picker.models['claude-opus-5'].estimateCents, 250,
    'the override the admin typed, not the derived 1550');
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

// ── 6. A cost is never shown as a bare dollar amount ───────────────────
//
// The figure is per TYPICAL CHANGE, not per message, per hour or per
// month, and "$1.55" beside a model name invites all three readings. The
// product decision for #2570 is that the amount only ever reaches a person
// inside the phrase "about $X for a typical change" — on the picker option,
// on the line under the picker, and in the admin console's save
// confirmation. The admin TABLE may hold bare numbers, because its column
// headers carry the unit instead.
//
// dev-chat.js is a plain browser script, so this loads it the way
// model-selector-ui.test.js does: into a vm, reading DevChat back out.

test('a cost only ever reaches a person as "about $X for a typical change"', () => {
  const vm = require('node:vm');
  const sandbox = { console, fetch: () => Promise.reject(new Error('no network')) };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // dev-chat.js wires a few listeners at load. None of them is what this
  // test reads, so the stubs only have to exist.
  sandbox.document = { addEventListener() {}, getElementById: () => null };
  sandbox.addEventListener = () => {};
  sandbox.navigator = {};
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('frontend/src/features/dev-chat/dev-chat.js')}\n;globalThis.__DevChat = DevChat;`,
    sandbox,
  );
  const DevChat = sandbox.__DevChat;

  // The one place the amount is formatted. A curated row carries its own
  // estimate; the client never re-derives one it was given.
  DevChat._modelNotes = {
    typicalChange: { inputTokens: 2_500_000, outputTokens: 120_000, source: 'documented_constant' },
    models: { 'z-ai/glm-5.3-flash': { note: 'quick, cheap changes', estimateCents: 40 } },
  };

  const cost = DevChat._modelCostNote('z-ai/glm-5.3-flash', null);
  assert.equal(cost.compact, 'quick, cheap changes · about $0.40 for a typical change');
  assert.equal(cost.full, 'quick, cheap changes · about $0.40 for a typical change (estimate)');
  // The prefixed picker value resolves to the same row, so an option and
  // the line beneath it cannot disagree.
  assert.equal(DevChat._modelCostNote('openrouter:z-ai/glm-5.3-flash', null).compact, cost.compact);

  // Neither display string may carry an amount that is not inside the
  // phrase. `estimate` holds the bare figure on purpose, for arithmetic.
  for (const text of [cost.compact, cost.full]) {
    for (const match of text.match(/\$[0-9.]+|<\$[0-9.]+/g) || []) {
      assert.match(text, new RegExp(`about ${match.replace(/[$.]/g, '\\$&')} for a typical change`),
        `"${text}" shows an amount outside the phrase`);
    }
  }
  assert.equal(cost.estimate, '$0.40');

  // A model nobody published a price for says what it is good for and
  // stops there, rather than reading as free.
  DevChat._modelNotes.models['no-price/model'] = { note: 'experimental', estimateCents: null };
  const priceless = DevChat._modelCostNote('no-price/model', null);
  assert.equal(priceless.compact, 'experimental');
  assert.doesNotMatch(priceless.full, /\$/);

  // Under a cent is "<$0.01", still inside the phrase.
  DevChat._modelNotes.models['tiny/model'] = { note: 'trivial edits', estimateCents: 0.4 };
  assert.equal(DevChat._modelCostNote('tiny/model', null).compact,
    'trivial edits · about <$0.01 for a typical change');

  // The admin table's cells are bare, so its headers carry the unit.
  const admin = read('frontend/src/features/admin/admin-model-costs.tsx');
  // And the profile it prints reads as millions: a typical change is 2.5M
  // input tokens, which "2500k" is a worse way to say.
  assert.match(admin, /n >= 1_000_000/,
    'the token formatter reaches for M before it reaches for k');
  for (const header of ['Shown estimate, per typical change',
    'Observed average, per typical change',
    'Observed median, per typical change']) {
    assert.ok(admin.includes(header), `the table header "${header}" states its unit`);
  }
  assert.match(admin, /the picker now says about \$\{money\(cents\)\} for a typical change/,
    'the save confirmation uses the phrase too');
});

// ── #2592: the observed columns are per CHANGE, like the estimate beside them

test('a change that used two models is counted once, at its whole cost', async () => {
  // The ordinary shape of a session: the conversation on one model, the
  // coding turns on another. Grouping by (model, session_id) reported that
  // as TWO changes, each carrying only its own model's slice — which is why
  // both observed columns read low against the estimate they sit beside.
  const pool = poolFor([[/turn_costs/, [
    // What the fixed query returns: one row per model, counting whole
    // changes attributed to it.
    { model: 'claude-opus-5', changes: '2', avg_cents: '210', median_cents: '205' },
  ]]]);
  const observed = await modelCosts.observedPerModel(pool, { days: 30 });
  const opus = observed.get('claude-opus-5');
  assert.equal(opus.changes, 2);
  assert.equal(opus.avgCents, 210);
  assert.equal(opus.medianCents, 205);
});

test('the observed unit matches the estimate’s unit', async () => {
  // typicalChange — which the estimate column is built from — groups
  // agent_turns by session_id ALONE. The observed query has to answer the
  // same question or the two columns cannot be read against each other.
  const pool = poolFor([[/per_change/, [{ changes: '40', input_tokens: '9', output_tokens: '3' }]]]);
  await modelCosts.typicalChange(pool, { days: 30 });
  assert.match(pool.calls[0].sql, /GROUP BY session_id\s*\)/,
    'the estimate profile is whole-change');
});
