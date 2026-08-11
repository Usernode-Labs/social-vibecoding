'use strict';

// #1001 — the pill-resolution ladder (resolveTurnPills in
// src/routes/sessions.js). This is the heart of the change: the guarantee
// that the Mayor authors at least one suggestion ITSELF on every turn that
// renders the pill row, rather than the platform filling the row from a
// fixed list.
//
// Background the assertions encode. suggest_replies is an optional tool and
// production Mayor turns skipped it on roughly two thirds of assistant rows,
// so the fixed list was the NORMAL outcome, not the exception — half of all
// rendered pill sets were byte-identical to five canned strings. Forcing the
// tool on the first call isn't available (phase 1 shares its tools array
// with the dispatch tools; phase 2's forced tool_use would suppress the text
// that IS the wrap-up), so enforcement is a post-hoc forced continuation on
// a compact context.
//
// Four rungs, each falling through on failure:
//   'model'     the Mayor's own call            (free)
//   'enforced'  a forced pills-only retry       (~1-1.5¢, one attempt only)
//   'generated' a cheap Haiku backstop          (~0.2-0.3¢)
//   'static'    the deterministic RECOVERY_PILLS set
//
// Run with: node --test tests/quick-reply-enforcement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../src/services/llm.js');
const { resolveTurnPills, quickReplyMeta } = require('../src/routes/sessions.js');
const { RECOVERY_PILLS } = require('../src/services/recovery-pills.js');

const SESSION = { id: 4242, app_name: 'Leaderboard Demo', pr_number: 4243 };

// A recorded fake client. `plan` decides what each call returns: 'pills'
// (a forced tool_use), 'json' (a Haiku text reply), or an Error to throw.
// Distinguishing the two rungs by tool_choice is exactly how the real code
// differs, so the stub keys off the same thing.
async function withStub(plan, fn) {
  const calls = [];
  const prev = llm._setClientForTests({
    messages: {
      create: async (params) => {
        const kind = params.tool_choice ? 'forced' : 'generate';
        calls.push({ kind, params });
        const outcome = typeof plan === 'function' ? plan(kind, calls.length) : plan[kind];
        if (outcome instanceof Error) throw outcome;
        if (outcome === undefined) throw new Error(`stub had no plan for ${kind}`);
        if (kind === 'forced') {
          return {
            content: [{ type: 'tool_use', name: 'suggest_replies', input: { replies: outcome } }],
            usage: { input_tokens: 1800, output_tokens: 40 },
            model: params.model,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ replies: outcome }) }],
          usage: { input_tokens: 1600, output_tokens: 30 },
          model: 'claude-haiku-4-5',
        };
      },
    },
  });
  try {
    return await fn(calls);
  } finally {
    llm._setClientForTests(prev);
  }
}

// resolveTurnPills debits through limits.recordSpend when a pool + userId
// are present. Passing neither keeps these tests off the database while
// still exercising every branch; the spend path is covered separately by
// asserting the usage is returned (tests/quick-reply-generation.test.js).
function ladder(overrides = {}) {
  return resolveTurnPills({
    pool: null,
    session: SESSION,
    userId: null,
    apiKey: null,
    model: 'claude-opus-5',
    modelPills: null,
    outcome: 'build_done',
    hasPr: true,
    hasSpec: false,
    replyText: 'The leaderboard now defaults to the Season 1 event.',
    transcriptTail: [{ role: 'user', content: 'Default the leaderboard to Season 1.' }],
    state: 'PR #4243 is open',
    ...overrides,
  });
}

// ── rung 1: the Mayor's own set wins, and costs nothing ──────────────

test("the Mayor's own tailored set is used as-is, with no extra call", async () => {
  await withStub({}, async (calls) => {
    const out = await ladder({
      modelPills: ['Preview the Season 1 default', 'Propose it to the group'],
    });
    assert.equal(out.source, 'model');
    assert.deepEqual(out.replies, ['Preview the Season 1 default', 'Propose it to the group']);
    assert.equal(calls.length, 0, 'a good set must never trigger a retry');
  });
});

// ── rung 2: the forced pills-only continuation ───────────────────────

test('a missing set triggers exactly ONE forced continuation', async () => {
  await withStub({ forced: ['Preview the Season 1 default', 'Also fix the sub-event tabs'] },
    async (calls) => {
      const out = await ladder({ modelPills: null });
      assert.equal(out.source, 'enforced');
      assert.deepEqual(out.replies, ['Preview the Season 1 default', 'Also fix the sub-event tabs']);
      assert.equal(calls.length, 1, 'one attempt, never a loop');
      assert.equal(calls[0].kind, 'forced');
      assert.deepEqual(calls[0].params.tool_choice, { type: 'tool', name: 'suggest_replies' });
      assert.equal(calls[0].params.tools.length, 1,
        'only suggest_replies is exposed — the retry cannot dispatch');
      assert.equal(calls[0].params.model, 'claude-opus-5',
        "the turn's own model, so the pills are the Mayor's own voice");
    });
});

test('the forced request carries the reply but NOT the whole conversation', async () => {
  // The cost argument for enforcement lives or dies on this. A full replay
  // of a median turn (52.3k tokens) would cost ~26¢ — the price of the turn
  // itself — on two thirds of all turns.
  const bigTail = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i} ` + 'x'.repeat(4000),
  }));
  await withStub({ forced: ['Preview the Season 1 default'] }, async (calls) => {
    await ladder({ modelPills: null, transcriptTail: bigTail });
    const body = calls[0].params.messages.map((m) => m.content).join('\n');
    assert.match(body, /The leaderboard now defaults to the Season 1 event\./,
      'the reply the pills sit under is present');
    assert.match(body, /PR #4243 is open/, 'the state line is present');
    assert.ok(body.length < 8000,
      `the request must stay compact; got ${body.length} chars of context`);
    assert.ok(!body.includes('turn 0 '),
      'the oldest turns are dropped rather than replayed');
  });
});

test('an all-boilerplate model set is treated as missing and regenerated', async () => {
  // The other half of the reported symptom: the model DID call the tool, but
  // echoed the prompt's old example strings verbatim.
  await withStub({ forced: ['Preview the Season 1 default', 'Propose it to the group'] },
    async (calls) => {
      const out = await ladder({
        modelPills: ['Preview the change', 'Propose it to the group', 'Make another tweak'],
      });
      assert.equal(out.source, 'enforced');
      assert.equal(calls.length, 1);
      assert.deepEqual(out.replies, ['Preview the Season 1 default', 'Propose it to the group']);
    });
});

test('a mixed set is NOT regenerated — one generic pill is allowed', async () => {
  // "Propose it to the group" is genuinely the right pill after a build. The
  // detector must not fight the composition rule it exists to enforce.
  await withStub({}, async (calls) => {
    const out = await ladder({
      modelPills: ['Propose it to the group', 'Also fix the sub-event tabs'],
    });
    assert.equal(out.source, 'model');
    assert.equal(calls.length, 0);
  });
});

test('an all-boilerplate ENFORCED set is kept and flagged, not retried again', async () => {
  await withStub({ forced: ['Build it', 'Revise the spec'] }, async (calls) => {
    const out = await ladder({ modelPills: null });
    assert.equal(out.source, 'enforced_generic',
      'recorded honestly so telemetry blames the prompt, not the mechanism');
    assert.deepEqual(out.replies, ['Build it', 'Revise the spec'],
      'a freshly authored set beats a fixed list even when it is boilerplate');
    assert.equal(calls.length, 1, 'there is NO second retry');
  });
});

// ── rung 3 and 4: the backstops ──────────────────────────────────────

test('a failed forced call escalates to the Haiku backstop', async () => {
  await withStub({
    forced: new Error('overloaded_error'),
    generate: ['Retry the Season 1 push', 'Why did it fail?'],
  }, async (calls) => {
    const out = await ladder({ modelPills: null });
    assert.equal(out.source, 'generated');
    assert.deepEqual(out.replies, ['Retry the Season 1 push', 'Why did it fail?']);
    assert.equal(calls.length, 2, 'one forced attempt, then one backstop attempt');
    assert.equal(calls[1].params.model, 'claude-haiku-4-5',
      'a different model, so a model-specific failure cannot take both rungs down');
  });
});

test('both model rungs failing lands on the deterministic set', async () => {
  await withStub({
    forced: new Error('overloaded_error'),
    generate: new Error('overloaded_error'),
  }, async (calls) => {
    const out = await ladder({ modelPills: null, outcome: 'build_done' });
    assert.equal(out.source, 'static');
    assert.equal(out.kind, 'code_done', 'the kind is recorded so telemetry names the set');
    assert.deepEqual(out.replies, [...RECOVERY_PILLS.code_done]);
    assert.equal(calls.length, 2, 'still only one attempt per rung');
  });
});

test('the static rung picks its set from the turn outcome', async () => {
  const cases = [
    ['build_done', 'code_done'],
    ['spec_done', 'spec_done'],
    ['failed', 'turn_failed'],
    ['worker_busy', 'build_running'],
  ];
  for (const [outcome, kind] of cases) {
    await withStub({ forced: new Error('x'), generate: new Error('x') }, async () => {
      const out = await ladder({ modelPills: null, outcome, hasPr: false });
      assert.equal(out.kind, kind, `${outcome} → ${kind}`);
      assert.deepEqual(out.replies, [...RECOVERY_PILLS[kind]]);
    });
  }
});

test('a call site with its own fixed wording keeps it as the last rung', async () => {
  // The clone and fork follow-ups already shipped their own sets; degrading
  // to a state-derived approximation of them would be a regression.
  const own = ['Explain where this got to', 'Continue this work'];
  await withStub({ forced: new Error('x'), generate: new Error('x') }, async () => {
    const out = await ladder({ modelPills: null, staticFallback: own });
    assert.equal(out.source, 'static');
    assert.deepEqual(out.replies, own);
  });
});

// ── the exclusions ───────────────────────────────────────────────────

test('allowModelCalls:false skips the forced rung entirely', async () => {
  // Refusal turns and empty-reply substitutions: the visible text is
  // platform-authored and the model has already declined, so asking it again
  // is throwing money at a "no".
  await withStub({ forced: new Error('should not be called'), generate: new Error('x') },
    async (calls) => {
      const out = await ladder({
        modelPills: null, allowModelCalls: false, allowGenerate: false,
      });
      assert.equal(out.source, 'static');
      assert.equal(calls.length, 0, 'no model call at all on a declined turn');
    });
});

test('allowGenerate:false stops at the forced rung', async () => {
  await withStub({ forced: new Error('nope') }, async (calls) => {
    const out = await ladder({ modelPills: null, allowGenerate: false });
    assert.equal(out.source, 'static');
    assert.equal(calls.length, 1, 'the forced attempt ran; the backstop did not');
  });
});

test('a forced set that sanitizes to nothing falls through', async () => {
  await withStub({ forced: ['', '   '], generate: ['Preview the Season 1 default'] },
    async (calls) => {
      const out = await ladder({ modelPills: null });
      assert.equal(out.source, 'generated');
      assert.equal(calls.length, 2);
    });
});

test('the ladder never throws, whatever the provider does', async () => {
  const prev = llm._setClientForTests({
    messages: { create: async () => { throw new TypeError('malformed everything'); } },
  });
  try {
    const out = await ladder({ modelPills: null });
    assert.equal(out.source, 'static');
    assert.ok(Array.isArray(out.replies) && out.replies.length,
      'there is ALWAYS something to tap');
  } finally {
    llm._setClientForTests(prev);
  }
});

test('resolved pills are sanitized like any tool input', async () => {
  await withStub({ forced: ['a'.repeat(200), 'Keep it', 'keep IT', 'Fourth', 'Fifth'] },
    async () => {
      const out = await ladder({ modelPills: null });
      assert.equal(out.replies.length, 3, 'capped at 3');
      assert.equal(out.replies[0].length, 80, 'clamped to 80 chars');
      assert.deepEqual(out.replies.slice(1), ['Keep it', 'Fourth'],
        'case-insensitive dedupe drops "keep IT"');
    });
});

// ── telemetry ────────────────────────────────────────────────────────

test('quickReplyMeta records the source, and the kind only when static', async () => {
  assert.deepEqual(
    quickReplyMeta({ replies: ['Preview the Season 1 default'], source: 'model' }),
    { quickReplies: ['Preview the Season 1 default'], quickRepliesSource: 'model' });

  assert.deepEqual(
    quickReplyMeta({ replies: ['Build it'], source: 'static', kind: 'spec_done' }),
    { quickReplies: ['Build it'], quickRepliesSource: 'static', quickRepliesKind: 'spec_done' });

  // A kind on a non-static row would corrupt the acceptance query.
  assert.equal(
    quickReplyMeta({ replies: ['x'], source: 'enforced', kind: 'code_done' }).quickRepliesKind,
    undefined);

  // The preamble marker lets the acceptance query exclude rows that their
  // own turn's wrap-up supersedes.
  assert.equal(
    quickReplyMeta({ replies: ['x'], source: 'enforced' }, { preamble: true }).quickRepliesPreamble,
    true);
  assert.equal(
    quickReplyMeta({ replies: ['x'], source: 'enforced' }).quickRepliesPreamble,
    undefined);

  // No pills → no keys at all, so a chips-only row stays clean.
  assert.deepEqual(quickReplyMeta(null), {});
  assert.deepEqual(quickReplyMeta({ replies: [], source: 'static' }), {});
});

test('every source value the ladder can emit is a known one', async () => {
  const seen = new Set();
  const plans = [
    [{}, { modelPills: ['Also fix the sub-event tabs'] }],
    [{ forced: ['Preview the Season 1 default'] }, { modelPills: null }],
    [{ forced: ['Build it'] }, { modelPills: null }],
    [{ forced: new Error('x'), generate: ['Retry the push'] }, { modelPills: null }],
    [{ forced: new Error('x'), generate: new Error('x') }, { modelPills: null }],
  ];
  for (const [plan, opts] of plans) {
    await withStub(plan, async () => { seen.add((await ladder(opts)).source); });
  }
  assert.deepEqual([...seen].sort(),
    ['enforced', 'enforced_generic', 'generated', 'model', 'static'],
    'the five documented sources, and nothing else');
});
