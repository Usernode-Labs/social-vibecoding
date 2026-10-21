'use strict';

// #3654: the benchmark's graders and blinding, without a database. A
// deterministic fail is final and a right class waits for the judge; the
// diff-scope rule names an edited pre-existing test or check for the judge,
// with its hunks, and fails nothing by itself; a run can be graded again; a
// trial's verdict follows person over judge over rule; a judge sees no
// model's name; and agreement is reported with TPR and TNR against people.

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

test('the diff-scope rule: an edited, renamed or removed pre-existing test or an altered check is named, unless the task allows it', () => {
  const files = [
    { filename: 'public/app.js', status: 'modified', additions: 4, deletions: 2 },
    { filename: 'tests/app.test.js', status: 'modified', additions: 3, deletions: 1 },
    { filename: 'tests/new.test.js', status: 'added', additions: 20, deletions: 0 },
    { filename: 'src/thing.spec.ts', status: 'removed', additions: 0, deletions: 9 },
  ];
  const scope = graders.diffScope({ files, checksAltered: ['home renders'] });
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ['modified tests/app.test.js', 'removed src/thing.spec.ts', 'altered the check "home renders"']);
  assert.deepEqual([scope.files, scope.checks], [['tests/app.test.js', 'src/thing.spec.ts'], ['home renders']], 'what the judge is shown the hunks of');
  assert.equal(graders.diffScope({ files, checksAltered: ['home renders'], allowed: ['tests/app.test.js', 'src/thing.spec.ts', 'home renders'] }).ok, true);
  assert.equal(graders.diffScope({ files: [{ filename: 'tests/new.test.js', status: 'added' }] }).ok, true, 'adding a test is fine');
  // Run 206's trial 2215: 90 lines added to tests/browser-scroll.test.js and
  // none removed is a new test in an old file, not an edit to one; the judge
  // still sees its hunk, since an added line can skip what follows it.
  const added = graders.diffScope({ files: [{ filename: 'tests/browser-scroll.test.js', status: 'modified', additions: 90, deletions: 0 }] });
  assert.deepEqual([added.ok, added.violations, added.files], [true, [], ['tests/browser-scroll.test.js']]);
  assert.equal(graders.diffScope({ files: [{ filename: 'tests/a.test.js', status: 'modified' }] }).ok, false,
    'a file whose line counts are unknown is still an edit');
  const renamed = graders.diffScope({ files: [{ filename: 'tests/b.test.js', previous: 'tests/a.test.js', status: 'renamed', additions: 0, deletions: 0 }] });
  assert.deepEqual([renamed.violations, renamed.files], [['renamed tests/b.test.js', 'renamed tests/a.test.js'], ['tests/b.test.js']]);
  const base = JSON.stringify({ tests: [{ name: 'home', path: '/' }, { name: 'b', path: '/b' }] });
  const head = JSON.stringify({ tests: [{ name: 'home', path: '/', expectText: 'x' }, { name: 'b', path: '/b' }, { name: 'c', path: '/c' }] });
  assert.deepEqual(graders.checksChanged(base, head), ['home'], 'an altered check is caught; an added one is not');
});

test('builds: no commits or a failed hidden check fail; a scope violation and the rest go to the judge', () => {
  const t = (over) => ({ status: 'ok', build_commits: 2, checks: null, parsed: {}, ...over });
  assert.equal(graders.buildGrade({ trial: t({ build_commits: 0 }), reference: {} }).pass, false);
  // An edited test or check is the judge's call (rubric keeps_checks), never
  // a fail by itself: the rule failed 8 of the 9 merged pull requests Core's
  // platform builds came from.
  const scoped = graders.buildGrade({ trial: t({}), reference: {}, scope: { ok: false, violations: ['modified tests/a.test.js'] } });
  assert.deepEqual({ pass: scoped.pass, needsJudge: scoped.needsJudge }, { pass: null, needsJudge: true });
  assert.equal(scoped.criteria.diff_scope, false, 'still recorded as a criterion');
  assert.ok(scoped.notes.includes('modified tests/a.test.js'), 'and named in the notes');
  assert.equal(graders.buildGrade({ trial: t({ checks: { ran: true, failed: 1 } }), reference: {} }).pass, false);
  assert.equal(graders.buildGrade({
    trial: t({ checks: { ran: true, failed: 1 } }), reference: {}, scope: { ok: false, violations: ['modified tests/a.test.js'] },
  }).pass, false, 'a failing hidden check still fails');
  const ok = graders.buildGrade({ trial: t({ checks: { ran: false, reason: 'not run' } }), reference: {}, scope: { ok: true, violations: [] } });
  assert.deepEqual({ pass: ok.pass, needsJudge: ok.needsJudge }, { pass: null, needsJudge: true });
  assert.equal(ok.criteria.hidden_checks, null, 'not run is unknown, not passed');
  assert.ok(ok.notes.includes('not run'));
  assert.equal(graders.buildGrade({ trial: t({ parsed: { blocked: 'no API' } }), reference: {} }).pass, false, 'blocked is wrong unless the task says impossible');
});

test('the judge sees the hunks of the pre-existing tests and checks a build touched, apart from its clipped diff', () => {
  const diff = [
    'diff --git a/public/app.js b/public/app.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/tests/app.test.js b/tests/app.test.js\n@@ -3 +3 @@\n-assert.equal(x, 1);\n+assert.equal(x, 2);\n',
    'diff --git a/dapp.json b/dapp.json\n@@ -9 +9 @@\n-"expectText": "Home"\n+"expectText": "Hub"\n',
  ].join('');
  const edits = grading.testEditsOf(diff, { files: ['tests/app.test.js', 'tests/gone.test.js'], checks: ['home renders'] });
  assert.match(edits.hunks, /^diff --git a\/tests\/app\.test\.js b\/tests\/app\.test\.js\n@@ -3 \+3 @@/);
  assert.match(edits.hunks, /"expectText": "Hub"/, 'an altered check brings dapp.json');
  assert.doesNotMatch(edits.hunks, /public\/app\.js/, 'only the tests and checks');
  assert.deepEqual(edits.missing, ['tests/gone.test.js'], 'a hunk the stored diff does not hold is named');
  assert.equal(grading.testEditsOf(diff, { files: [], checks: [] }), null);
  assert.equal(grading.testEditsOf(diff, { ok: false, violations: ['modified tests/app.test.js'] }), null, 'a scope stored before it named its files');
  const keeps = grading.RUBRICS.build.criteria.find((c) => c.id === 'keeps_checks');
  assert.match(keeps.text, /to make it pass/);
  assert.match(keeps.text, /Updating or extending one the requested change makes out of date is fine/);
});

// Run 208: about 10 of 33 judged builds were graded from a diff cut inside a
// file, at the item's 40,000 characters or the runner's 60,000.
test('a judge reads a large diff in parts: whole files where they fit, a long file at its lines, every line once', () => {
  const file = (name, lines) => `diff --git a/${name} b/${name}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+${name} line ${i}\n`).join('')}`;
  const diff = file('a.js', 3) + file('b.js', 2) + file('long.js', 40) + file('c.js', 1);
  const size = 200;
  const parts = grading.diffParts(diff, size);
  assert.ok(parts.length > 3, 'more than one part');
  assert.equal(parts[0], file('a.js', 3) + file('b.js', 2), 'files that fit together share a part, whole');
  for (const part of parts) {
    assert.match(part, /^diff --git a\/\S+ b\/\S+( \(continued\))?\n/, 'every part opens on a file\'s own line');
    assert.ok(part.endsWith('\n'), 'and ends at a line\'s end');
    assert.ok(part.length <= size + 'diff --git a/long.js b/long.js (continued)\n'.length);
  }
  const continued = parts.filter((p) => p.startsWith('diff --git a/long.js b/long.js (continued)\n'));
  assert.ok(continued.length >= 2, 'the long file is cut at its lines, each piece named');
  const rejoined = parts.map((p) => p.replace(/^diff --git a\/(\S+) b\/\1 \(continued\)\n/, '')).join('');
  assert.equal(rejoined, diff, 'nothing lost, nothing twice');
  assert.deepEqual(grading.diffParts(''), []);
  assert.deepEqual(grading.diffParts(file('a.js', 1)), [file('a.js', 1)], 'a small diff is one part');

  // The candidate carries the first part, how many there are, and the
  // changed files the stored diff never held, and no clip marker.
  const big = file('x.js', 3000) + file('y.js', 10);
  assert.ok(big.length > grading.DIFF_PART_CHARS);
  const candidate = grading.candidateView('build', {
    parsed: { built: true }, diff: big,
    changed_files: { files: [{ filename: 'x.js', status: 'modified' }, { filename: 'y.js', status: 'added' }, { filename: 'z.js', status: 'added' }] },
  });
  assert.equal(candidate.diff, grading.diffParts(big)[0]);
  assert.equal(candidate.diffParts, grading.diffParts(big).length);
  assert.deepEqual(candidate.diffLeftOut, ['z.js']);
  assert.doesNotMatch(candidate.diff, /\[truncated\]/);
  const small = grading.candidateView('build', { parsed: {}, diff: file('y.js', 1), changed_files: { files: [{ filename: 'y.js', status: 'added' }] } });
  assert.ok(!('diffParts' in small) && !('diffLeftOut' in small), 'nothing said when the whole diff is there');
  assert.deepEqual(grading.filesLeftOut(file('a b.js', 1), { files: [{ filename: 'a b.js' }] }), [], 'a name with a space is still found');
});

test('a run graded again: every finished trial under the rules as they stand, and what now waits for the judge', async () => {
  // Trial 1 failed on the old diff-scope rule; trial 2 a judge already had.
  const old = { pass: false, needsJudge: false, criteria: { produced_commits: true, diff_scope: false, hidden_checks: null } };
  const trials = {
    1: { id: 1, status: 'ok', stage: 'build', build_commits: 2, checks: null, parsed: {}, reference: {}, deterministic: old,
      changed_files: { files: [{ filename: 'tests/a.test.js', status: 'modified', additions: 5, deletions: 2 }] } },
    2: { id: 2, status: 'ok', stage: 'triage', parsed: { verdict: 'person' }, reference: { verdict: 'person' },
      deterministic: { pass: true, needsJudge: false } },
  };
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT id, deterministic FROM bench_trials WHERE run_id/.test(sql)) {
        assert.equal(params[0], 206);
        return { rows: Object.values(trials).map((t) => ({ id: t.id, deterministic: t.deterministic })) };
      }
      if (/SELECT tr\.\*, tk\.stage/.test(sql)) return { rows: [trials[params[0]]] };
      if (/UPDATE bench_trials SET deterministic/.test(sql)) { updates.push([params[0], JSON.parse(params[1])]); return { rows: [] }; }
      if (/SELECT COUNT\(\*\)::int AS n FROM bench_trials/.test(sql)) return { rows: [{ n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const out = await graders.regradeRun(pool, 206, {});
  assert.deepEqual(out, { trials: 2, changed: 1, waitingForJudge: 1 });
  const first = updates.find(([id]) => id === 1)[1];
  assert.deepEqual({ pass: first.pass, needsJudge: first.needsJudge, diffScope: first.criteria.diff_scope }, { pass: null, needsJudge: true, diffScope: false });
  assert.deepEqual(first.scope.files, ['tests/a.test.js']);
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

test('a reference is one accepted answer, not a template: the judge, the build rubric and the charter all say so', () => {
  // The merged PR attached to a build task is one way people accepted, not
  // the only right one, and it can be flawed: a judge told to match it
  // anchors on it, passing copies of its flaws and failing sound
  // alternatives. Judge against the request.
  assert.match(grading.INSTRUCTIONS, /REFERENCE is one accepted answer, not the only right one/);
  assert.match(grading.INSTRUCTIONS, /Never fail a candidate only for differing from the reference/);
  const implementsRequest = grading.RUBRICS.build.criteria.find((c) => c.id === 'implements_request');
  assert.doesNotMatch(implementsRequest.text, /and the reference.*asks/, 'the reference is not part of what the diff must do');
  assert.match(implementsRequest.text, /not a template to match/);
  const charter = require('../src/services/mcp-charter');
  const section = JSON.stringify(charter).includes('benchmark-grading') ? JSON.stringify(charter) : '';
  assert.match(section, /A reference is one accepted answer, not the only right one/);
});

test('a DM task nobody answered: the label item and the charter ask for the requester\'s reply, in their voice', () => {
  for (const text of [grading.SCRIPTED_ANSWER_INSTRUCTIONS, require('../src/services/mcp-charter').CHARTER_FULL]) {
    assert.match(text, /dmAnswer/);
    assert.match(text, /first person, short, in (the requester's|their) voice/i);
    assert.match(text, /not a hedge|rather than a hedge/);
    assert.match(text, /written for them or simulated/);
    assert.match(text, /later comments/);
  }
  // The charter's rules stay four; the scripted answer is part of labelling.
  const section = require('../src/services/mcp-charter').CHARTER_SECTIONS.find((x) => x.id === 'benchmark-grading').text;
  assert.match(section, /Four rules\./);
  assert.ok(section.indexOf('dmAnswer') < section.indexOf('Four rules.'), 'with the labelling steps, before the rules');
  assert.equal(grading.MAX_DM_ANSWER_CHARS, 2000);
});
