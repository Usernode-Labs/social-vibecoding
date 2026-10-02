'use strict';

// #3654: the benchmark's suite pieces that need no database: the stratified
// sampler, the hidden checks a merged pull request added, and the reference
// a task starts from.

const test = require('node:test');
const assert = require('node:assert/strict');

const suites = require('../src/services/bench/suites');

function candidates() {
  const out = [];
  let id = 1;
  // 60 ready verdicts, 40 of them on one busy app; 6 questions; 4 person;
  // a few on the platform's own repository; two with a merged outcome.
  for (let i = 0; i < 60; i += 1) {
    out.push({ id: id++, tags: { verdict: 'ready', repo_size: i < 5 ? 'large' : 'small', app_slug: i < 40 ? 'busy' : `app${i % 7}`, known_outcome: null } });
  }
  for (let i = 0; i < 6; i += 1) out.push({ id: id++, tags: { verdict: 'question', repo_size: 'small', app_slug: `q${i % 2}`, known_outcome: i === 3 ? 'merged' : null } });
  for (let i = 0; i < 4; i += 1) out.push({ id: id++, tags: { verdict: 'person', repo_size: 'small', app_slug: 'p', known_outcome: null } });
  return out;
}

test('the sampler spreads a sample across verdicts instead of mirroring the skew', () => {
  const picked = suites.stratifiedSample(candidates(), 12, { keys: ['verdict'], seed: 7 });
  assert.equal(picked.length, 12);
  const by = (v) => picked.filter((c) => c.tags.verdict === v).length;
  assert.deepEqual([by('person'), by('question'), by('ready')], [4, 4, 4], 'each verdict gets its turn');
});

test('the sampler takes a rare stratum whole and fills the rest from the others', () => {
  const picked = suites.stratifiedSample(candidates(), 30, { keys: ['verdict'], seed: 7 });
  const by = (v) => picked.filter((c) => c.tags.verdict === v).length;
  assert.equal(by('person'), 4, 'all four person verdicts');
  assert.equal(by('question'), 6, 'all six questions');
  assert.equal(by('ready'), 20, 'the rest from ready');
});

test('within a stratum the busy app does not fill the sample', () => {
  const picked = suites.stratifiedSample(candidates().filter((c) => c.tags.verdict === 'ready'), 8, { keys: ['verdict'], seed: 3 });
  const busy = picked.filter((c) => c.tags.app_slug === 'busy').length;
  assert.ok(busy <= 2, `at most two of eight from the app with 40 of 60 candidates (got ${busy})`);
});

test('a known outcome is preferred, and the same seed gives the same sample', () => {
  const picked = suites.stratifiedSample(candidates(), 3, { keys: ['verdict'], seed: 11 });
  const question = picked.find((c) => c.tags.verdict === 'question');
  assert.equal(question.tags.known_outcome, 'merged', 'the merged question goes first');
  const again = suites.stratifiedSample(candidates(), 20, { seed: 99 }).map((c) => c.id);
  assert.deepEqual(suites.stratifiedSample(candidates(), 20, { seed: 99 }).map((c) => c.id), again);
  assert.notDeepEqual(suites.stratifiedSample(candidates(), 20, { seed: 100 }).map((c) => c.id), again,
    'another seed draws another sample');
});

test('a build sample is balanced on the repository first', () => {
  const picked = suites.stratifiedSample(candidates().filter((c) => c.tags.verdict === 'ready'), 10, { keys: ['repo_size', 'verdict'], seed: 5 });
  assert.equal(picked.filter((c) => c.tags.repo_size === 'large').length, 5);
  assert.equal(picked.filter((c) => c.tags.repo_size === 'small').length, 5);
});

test('the sampler asks for no more than it has, and never more than its ceiling', () => {
  assert.equal(suites.stratifiedSample(candidates().slice(0, 3), 10).length, 3);
  assert.equal(suites.stratifiedSample(candidates(), 1000).length, 70);
  assert.deepEqual(suites.stratifiedSample([], 5), []);
});

test('hidden checks are the checks a pull request added or changed in dapp.json', () => {
  const base = JSON.stringify({ tests: [{ name: 'a', path: '/' }, { name: 'b', path: '/b' }] });
  const head = JSON.stringify({ tests: [{ name: 'a', path: '/' }, { name: 'b', path: '/b', expectText: 'B' }, { name: 'c', path: '/c' }] });
  assert.deepEqual(suites.addedChecks(base, head), [{ name: 'b', path: '/b', expectText: 'B' }, { name: 'c', path: '/c' }]);
  assert.deepEqual(suites.addedChecks(null, 'not json'), []);
});

test('a task never takes the bot\'s own verdict as its reference', () => {
  const facts = {
    verdict: 'ready', label_verdict: null, app_slug: 'todo', repo_url: 'https://github.com/o/todo',
    proposal_status: null, proposal_session_id: null, build_ok: null,
  };
  const snap = { thread: { issue: { title: 'The button is broken', body: '' } }, texts: { prompt: 'x'.repeat(10) } };
  const plain = suites.startingTask('triage', facts, snap);
  assert.deepEqual(plain.reference, {});
  assert.equal(plain.source, null, 'unlabelled until a labeller says');
  assert.equal(plain.tags.verdict, 'ready', 'the bot\'s verdict is a stratification tag only');
  assert.equal(plain.tags.request_type, 'bug');
  assert.equal(plain.tags.prompt_chars, 10);
  const labelled = suites.startingTask('triage', { ...facts, label_verdict: 'question' }, snap);
  assert.deepEqual(labelled.reference, { verdict: 'question' });
  assert.equal(labelled.source, 'human');
  const merged = suites.startingTask('build', { ...facts, proposal_status: 'merged', proposal_session_id: 5, proposal_pr: 41 }, snap);
  assert.deepEqual(merged.reference, { reference_pr: 41, proposal_session_id: 5 });
  assert.equal(merged.source, 'merged_pr');
  assert.equal(merged.tags.known_outcome, 'merged');
  const dm = suites.startingTask('dm', { ...facts, verdict: 'question', answer_text: 'Dark blue' }, snap);
  assert.equal(dm.reference.dm_script.true_answer, 'Dark blue');
  assert.equal(suites.startingTask('triage', { ...facts, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' }, snap).tags.repo_size, 'large');
});
