'use strict';

// #3654: the benchmark's graders and blinding, without a database. A
// deterministic fail is final and a right class waits for the judge; the
// diff-scope rule catches an edited pre-existing test or check; a trial's
// verdict follows person over judge over rule; a judge sees no model's name;
// and agreement is reported with TPR and TNR against people.

const test = require('node:test');
const assert = require('node:assert/strict');

const graders = require('../src/services/bench/graders');
const blinding = require('../src/services/bench/blinding');
const grading = require('../src/services/bench/grading');
const catalog = require('../src/services/bench/catalog');

test('triage: the verdict per class, a question with answers, and the judge for what a rule cannot see', () => {
  const wrong = graders.triageGrade({ parsed: { verdict: 'ready' }, reference: { verdict: 'question' } });
  assert.equal(wrong.pass, false);
  assert.equal(wrong.needsJudge, false, 'a wrong verdict is not rescued by a judge');
  assert.deepEqual(wrong.criteria, { verdict_match: false, question_present: false, suggested_answers: false });

  const asked = graders.triageGrade({
    parsed: { verdict: 'question', question: 'Which map?', questionAnswers: ['Route', 'City'] }, reference: { verdict: 'question' },
  });
  assert.deepEqual({ pass: asked.pass, needsJudge: asked.needsJudge }, { pass: null, needsJudge: true });
  assert.deepEqual(asked.criteria, { verdict_match: true, question_present: true, suggested_answers: true });

  assert.equal(graders.triageGrade({ parsed: { verdict: 'question', question: '' }, reference: { verdict: 'question' } }).pass, false);
  const person = graders.triageGrade({ parsed: { verdict: 'person' }, reference: { verdict: 'person' } });
  assert.deepEqual({ pass: person.pass, needsJudge: person.needsJudge }, { pass: true, needsJudge: false }, 'person: the class is the whole answer');
  const unlabelled = graders.triageGrade({ parsed: { verdict: 'ready' }, reference: {} });
  assert.equal(unlabelled.pass, null);
  assert.equal(unlabelled.needsJudge, false, 'nothing to grade against until the task is labelled');
});

test('the diff-scope rule: a pre-existing test or check may not be edited unless the task allows it', () => {
  const files = [
    { filename: 'public/app.js', status: 'modified' },
    { filename: 'tests/app.test.js', status: 'modified' },
    { filename: 'tests/new.test.js', status: 'added' },
    { filename: 'src/thing.spec.ts', status: 'removed' },
  ];
  const scope = graders.diffScope({ files, checksAltered: ['home renders'] });
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ['modified tests/app.test.js', 'removed src/thing.spec.ts', 'altered the check "home renders"']);
  assert.equal(graders.diffScope({ files, checksAltered: ['home renders'], allowed: ['tests/app.test.js', 'src/thing.spec.ts', 'home renders'] }).ok, true);
  assert.equal(graders.diffScope({ files: [{ filename: 'tests/new.test.js', status: 'added' }] }).ok, true, 'adding a test is fine');
  const base = JSON.stringify({ tests: [{ name: 'home', path: '/' }, { name: 'b', path: '/b' }] });
  const head = JSON.stringify({ tests: [{ name: 'home', path: '/', expectText: 'x' }, { name: 'b', path: '/b' }, { name: 'c', path: '/c' }] });
  assert.deepEqual(graders.checksChanged(base, head), ['home'], 'an altered check is caught; an added one is not');
});

test('builds: no commits, a scope violation or a failed hidden check fail; the rest go to the judge', () => {
  const t = (over) => ({ status: 'ok', build_commits: 2, checks: null, parsed: {}, ...over });
  assert.equal(graders.buildGrade({ trial: t({ build_commits: 0 }), reference: {} }).pass, false);
  assert.equal(graders.buildGrade({ trial: t({}), reference: {}, scope: { ok: false, violations: ['modified tests/a.test.js'] } }).pass, false);
  assert.equal(graders.buildGrade({ trial: t({ checks: { ran: true, failed: 1 } }), reference: {} }).pass, false);
  const ok = graders.buildGrade({ trial: t({ checks: { ran: false, reason: 'not run' } }), reference: {}, scope: { ok: true, violations: [] } });
  assert.deepEqual({ pass: ok.pass, needsJudge: ok.needsJudge }, { pass: null, needsJudge: true });
  assert.equal(ok.criteria.hidden_checks, null, 'not run is unknown, not passed');
  assert.ok(ok.notes.includes('not run'));
  assert.equal(graders.buildGrade({ trial: t({ parsed: { blocked: 'no API' } }), reference: {} }).pass, false, 'blocked is wrong unless the task says impossible');
});

test('a trial\'s verdict: a person over the judge over the rule; failures fail; infra is excluded', () => {
  const at = (s) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
  const judge = { grader: 'opus', verdict: 'pass', created_at: at(1), id: 1 };
  const person = { grader: 'human', verdict: 'fail', created_at: at(2), id: 2 };
  const det = { pass: null, needsJudge: true };
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: det, grades: [] }), 'pending');
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: det, grades: [judge] }), 'pass');
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: det, grades: [judge, person] }), 'fail', 'a person overrides');
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: { pass: false }, grades: [judge] }), 'fail', 'a rule\'s fail is final');
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: { pass: true } }), 'pass');
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: { pass: null, needsJudge: false } }), 'unlabelled');
  assert.equal(graders.finalVerdict({ status: 'model_fail' }), 'fail');
  assert.equal(graders.finalVerdict({ status: 'timeout' }), 'fail');
  for (const s of ['infra_fail', 'not_applicable', 'skipped_cap', 'cancelled']) assert.equal(graders.finalVerdict({ status: s }), 'excluded');
  const second = { grader: 'opus', verdict: 'fail', created_at: at(3), id: 3 };
  assert.equal(graders.finalVerdict({ status: 'ok', deterministic: det, grades: [judge, second] }), 'fail', 'the latest judge grade counts');
});

test('blinding: a candidate\'s text names no model, and ordinary code is left alone', () => {
  const ids = catalog.CANDIDATES.map((c) => c.id);
  const text = 'As Claude Sonnet 5.5 (anthropic/claude-sonnet-5.5) I built it. Signed, GLM-5.3 flash via z-ai/glm-5.3-flash. '
    + 'Kimi K2.7 and moonshotai/kimi-k2.7-code agree; so do DeepSeek, Qwen3.8, MiniMax M3, MiMo and gpt-5.6-luna.';
  const out = blinding.blindText(text, ids);
  for (const word of ['claude', 'sonnet', 'anthropic', 'glm', 'z-ai', 'kimi', 'moonshot', 'deepseek', 'qwen', 'minimax', 'mimo', 'gpt']) {
    assert.doesNotMatch(out.toLowerCase(), new RegExp(`(^|[^a-z0-9])${word}`), `${word} is masked: ${out}`);
  }
  assert.equal(blinding.leaks(out, ids), false);
  const code = 'const metaTag = document.querySelector("meta"); runCodex(opusCount); // glmx stays, codex_openrouter stays';
  assert.equal(blinding.blindText(code, ids), code, 'words inside identifiers, and code words, are not names');
  const deep = blinding.blindValue({ a: ['by xiaomi/mimo-v2.6-pro'], b: { c: 'qwen/qwen3.8-flash wrote this' }, n: 3 }, ids);
  assert.deepEqual(deep, { a: ['by [model]'], b: { c: '[model] wrote this' }, n: 3 });
  assert.equal(blinding.blindText('Claude Sonnet 5.5 says hi; GLM-5.3 too', ids), '[model] says hi; [model] too', 'a name and its version are one name');
  const custom = blinding.blindText('built by acme/rocket-9-pro', ['acme/rocket-9-pro']);
  assert.equal(custom, 'built by [model]', 'a model added to a run is scrubbed too');
});

test('judge agreement with people: agreement, TPR and TNR', () => {
  const pairs = [
    { opus: 'pass', human: 'pass' }, { opus: 'pass', human: 'pass' }, { opus: 'fail', human: 'pass' },
    { opus: 'fail', human: 'fail' }, { opus: 'pass', human: 'fail' },
  ];
  const a = grading.agreementOf(pairs);
  assert.equal(a.n, 5);
  assert.equal(a.agreement, 3 / 5);
  assert.equal(a.tpr, 2 / 3);
  assert.equal(a.tnr, 1 / 2);
  assert.deepEqual(grading.agreementOf([]), { n: 0, agreement: null, tpr: null, tnr: null, positives: 0, negatives: 0 });
});

test('every stage has a binary rubric with named criteria', () => {
  for (const stage of ['triage', 'spec', 'build', 'followup', 'checks_fix', 'dm']) {
    const r = grading.RUBRICS[stage];
    assert.ok(r && r.question && r.criteria.length >= 3, stage);
    assert.ok(r.criteria.every((c) => /^[a-z_]+$/.test(c.id) && c.text), stage);
  }
});
