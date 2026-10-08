// Tests for src/services/llm.parsePrMetadataText — the pure parser that
// turns the Haiku PR-metadata response into {title, body, summary}. Covers
// the plain-language `summary` extension: present, missing (optional),
// fenced/chatty wrapping, and the defensive length cap. `title` stays
// required (throws when empty).
//
// Run with: node --test tests/llm-pr-metadata-parse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePrMetadataText } = require('../src/services/llm');

test('parses a valid {title, body, summary} object', () => {
  const out = parsePrMetadataText(JSON.stringify({
    title: 'Add dark mode toggle',
    body: '- Adds toggle\n- Persists choice',
    summary: 'Adds a dark-mode toggle to settings so people can switch the app to a dark colour scheme.',
  }));
  assert.equal(out.title, 'Add dark mode toggle');
  assert.equal(out.body, '- Adds toggle\n- Persists choice');
  assert.equal(out.summary, 'Adds a dark-mode toggle to settings so people can switch the app to a dark colour scheme.');
});

test('missing summary is optional -> empty string, never throws', () => {
  const out = parsePrMetadataText(JSON.stringify({ title: 'Fix bug', body: 'Fixes it' }));
  assert.equal(out.title, 'Fix bug');
  assert.equal(out.summary, '');
});

test('non-string summary coerces to empty string', () => {
  const out = parsePrMetadataText(JSON.stringify({ title: 'T', body: 'B', summary: 42 }));
  assert.equal(out.summary, '');
});

test('tolerates ```json fences and surrounding chatter around the JSON', () => {
  const text = 'Sure, here you go:\n```json\n'
    + JSON.stringify({ title: 'Tidy copy', body: 'b', summary: 'Cleans up the wording shown to users.' })
    + '\n```\nHope that helps!';
  const out = parsePrMetadataText(text);
  assert.equal(out.title, 'Tidy copy');
  assert.equal(out.summary, 'Cleans up the wording shown to users.');
});

test('summary is trimmed and hard-capped so a verbose response cannot dominate the view', () => {
  const long = 'x'.repeat(900);
  const out = parsePrMetadataText(JSON.stringify({ title: 'T', body: 'B', summary: `  ${long}  ` }));
  assert.ok(out.summary.length <= 600, 'summary capped at 600 chars');
  assert.equal(out.summary, 'x'.repeat(600));
});

test('empty title still throws (title stays required)', () => {
  assert.throws(
    () => parsePrMetadataText(JSON.stringify({ title: '   ', body: 'b', summary: 's' })),
    /Empty PR title/
  );
});

test('no JSON object in the text throws', () => {
  assert.throws(() => parsePrMetadataText('not json at all'), /No JSON object/);
});

// ── #4098: the explanation's structured blocks ────────────────────────

test('valid blocks come back canonical, with unknown fields dropped', () => {
  const out = parsePrMetadataText(JSON.stringify({
    title: 'T', body: 'B', summary: 'S',
    blocks: [
      { kind: 'steps', title: 'Path', steps: ['One', 'Two'], colour: 'red' },
      { kind: 'comparison', rows: [{ who: 'W', before: 'B', after: 'A', extra: 1 }], terms: [] },
    ],
  }));
  assert.deepEqual(out.blocks, [
    { kind: 'steps', title: 'Path', steps: ['One', 'Two'] },
    { kind: 'comparison', rows: [{ who: 'W', before: 'B', after: 'A' }] },
  ]);
});

test('absent or malformed blocks are no blocks, never a throw', () => {
  assert.deepEqual(parsePrMetadataText(JSON.stringify({ title: 'T', body: 'B', summary: 'S' })).blocks, []);
  assert.deepEqual(parsePrMetadataText(JSON.stringify({ title: 'T', blocks: 'steps' })).blocks, []);
  assert.deepEqual(parsePrMetadataText(JSON.stringify({ title: 'T', blocks: [{ kind: 'steps', steps: ['only one'] }] })).blocks, []);
  assert.deepEqual(parsePrMetadataText(JSON.stringify({ title: 'T', blocks: [{ kind: 'chart', data: [1, 2] }] })).blocks, []);
});

test('a third block is dropped', () => {
  const steps = (t) => ({ kind: 'steps', title: t, steps: ['a', 'b'] });
  const out = parsePrMetadataText(JSON.stringify({ title: 'T', blocks: [steps('1'), steps('2'), steps('3')] }));
  assert.deepEqual(out.blocks.map((b) => b.title), ['1', '2']);
});
