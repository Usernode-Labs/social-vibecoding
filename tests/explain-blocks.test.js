// Structured blocks inside a change's explanation (#4098):
// src/services/explain-blocks.js and its browser mirror
// frontend/src/lib/explain-blocks.ts. The server is the authority; the
// mirror must give the same answer for every fixture here, the way the SVG
// allowlist mirror is pinned (tests/illustration-gallery.test.js).
//
// Run with: node --test tests/explain-blocks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const server = require('../src/services/explain-blocks');

const client = loadTsx('frontend/src/lib/explain-blocks.ts');

const COMPARISON = {
  kind: 'comparison',
  rows: [
    { who: 'Member from before', before: 'Vote counts', after: 'Vote counts' },
    { who: 'New member, unverified', before: 'Vote counts', after: 'Asked to verify first, then counts' },
  ],
  terms: [{ term: 'Verified', meaning: 'A phone number, GitHub and X both linked, or zkPassport' }],
};
const STEPS = { kind: 'steps', title: 'Steps for an unverified newcomer', steps: ['Votes', 'Asked for a phone', 'Verifies', 'The vote counts'] };
const TABLE = { kind: 'table', title: 'Budgets', columns: ['Who', 'Daily budget'], rows: [['Verified', 'Full'], ['Unverified', 'Smaller']] };

const long = (n) => 'x'.repeat(n);

// Every validation rule at its edges, as [name, input].
const VALIDATE_FIXTURES = [
  ['three valid blocks keep the first two', [COMPARISON, STEPS, TABLE]],
  ['not an array is no blocks', { kind: 'steps', steps: ['a', 'b'] }],
  ['null is no blocks', null],
  ['an unknown kind is dropped, the valid one kept', [{ kind: 'chart', rows: [] }, STEPS]],
  ['an invalid block does not take a slot', [{ kind: 'steps', steps: ['one'] }, COMPARISON, TABLE]],
  ['a step list of one is dropped', [{ kind: 'steps', steps: ['one'] }]],
  ['seven steps pass', [{ kind: 'steps', steps: ['1', '2', '3', '4', '5', '6', '7'] }]],
  ['eight steps are dropped', [{ kind: 'steps', steps: ['1', '2', '3', '4', '5', '6', '7', '8'] }]],
  ['a non-string step drops the block', [{ kind: 'steps', steps: ['a', 2] }]],
  ['a blank step drops the block', [{ kind: 'steps', steps: ['a', '  '] }]],
  ['a 120-char cell passes', [{ kind: 'steps', steps: [long(120), 'b'] }]],
  ['a 121-char cell drops the block', [{ kind: 'steps', steps: [long(121), 'b'] }]],
  ['a 60-char title passes', [{ kind: 'steps', title: long(60), steps: ['a', 'b'] }]],
  ['a 61-char title drops the block', [{ kind: 'steps', title: long(61), steps: ['a', 'b'] }]],
  ['a non-string title drops the block', [{ kind: 'steps', title: 4, steps: ['a', 'b'] }]],
  ['a blank title is no title', [{ kind: 'steps', title: '  ', steps: ['a', 'b'] }]],
  ['a null title is no title', [{ kind: 'steps', title: null, steps: ['a', 'b'] }]],
  ['whitespace in a cell collapses', [{ kind: 'steps', steps: ['  a \n b ', 'c\t\td'] }]],
  ['unknown fields are dropped', [{ kind: 'steps', steps: ['a', 'b'], colour: 'red', nested: { x: 1 } }]],
  ['a comparison with no rows is dropped', [{ kind: 'comparison', rows: [] }]],
  ['six comparison rows pass', [{ kind: 'comparison', rows: Array.from({ length: 6 }, (_, i) => ({ who: `w${i}`, before: 'b', after: 'a' })) }]],
  ['seven comparison rows are dropped', [{ kind: 'comparison', rows: Array.from({ length: 7 }, (_, i) => ({ who: `w${i}`, before: 'b', after: 'a' })) }]],
  ['a row missing after is dropped', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b' }] }]],
  ['a row that is an array is dropped', [{ kind: 'comparison', rows: [['w', 'b', 'a']] }]],
  ['no terms is no terms key', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }] }]],
  ['null terms is no terms key', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: null }]],
  ['empty terms is no terms key', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: [] }]],
  ['four terms pass', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: Array.from({ length: 4 }, (_, i) => ({ term: `t${i}`, meaning: 'm' })) }]],
  ['five terms drop the block', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: Array.from({ length: 5 }, (_, i) => ({ term: `t${i}`, meaning: 'm' })) }]],
  ['a term missing its meaning drops the block', [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: [{ term: 't' }] }]],
  ['a table with one column is dropped', [{ kind: 'table', columns: ['a'], rows: [['x']] }]],
  ['a table with five columns is dropped', [{ kind: 'table', columns: ['a', 'b', 'c', 'd', 'e'], rows: [['1', '2', '3', '4', '5']] }]],
  ['a table with four columns passes', [{ kind: 'table', columns: ['a', 'b', 'c', 'd'], rows: [['1', '2', '3', '4']] }]],
  ['a table with no rows is dropped', [{ kind: 'table', columns: ['a', 'b'], rows: [] }]],
  ['a table with seven rows is dropped', [{ kind: 'table', columns: ['a', 'b'], rows: Array.from({ length: 7 }, () => ['1', '2']) }]],
  ['a row of the wrong width drops the table', [{ kind: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['1']] }]],
  ['a row that is not an array drops the table', [{ kind: 'table', columns: ['a', 'b'], rows: ['1, 2'] }]],
  ['a block that is a string is dropped', ['steps', STEPS]],
];

const FENCE = (body) => `\`\`\`explain\n${body}\n\`\`\``;
const good = JSON.stringify({ v: 1, blocks: [COMPARISON, STEPS] });

// What split sees, as [name, markdown].
const SPLIT_FIXTURES = [
  ['no fence passes through', 'Just words.\n\nTwo paragraphs.'],
  ['a trailing fence comes off', `Words.\n\n${FENCE(good)}`],
  ['a fence between paragraphs comes off and the paragraphs meet', `Words.\n\n${FENCE(good)}\n\nAsked for by @maya`],
  ['a fence at the start leaves no leading blank', `${FENCE(good)}\n\nWords.`],
  ['a fence alone leaves empty text', FENCE(good)],
  ['unparseable JSON stays as text', `Words.\n\n${FENCE('{not json')}`],
  ['the wrong version stays as text', `Words.\n\n${FENCE(JSON.stringify({ v: 2, blocks: [STEPS] }))}`],
  ['blocks that is not an array stays as text', `Words.\n\n${FENCE(JSON.stringify({ v: 1, blocks: STEPS }))}`],
  ['a fence whose every block is invalid stays as text', `Words.\n\n${FENCE(JSON.stringify({ v: 1, blocks: [{ kind: 'steps', steps: ['one'] }] }))}`],
  ['a fence that never closes stays as text', `Words.\n\n\`\`\`explain\n${good}`],
  ['another language stays as text', `Words.\n\n\`\`\`js\n${good}\n\`\`\``],
  ['an explain fence inside another fence is that fence\'s text', `Words.\n\n\`\`\`md\n${FENCE(good)}\n\`\`\``],
  ['two explain fences: the first two blocks overall', `Words.\n\n${FENCE(JSON.stringify({ v: 1, blocks: [STEPS] }))}\n\nMore.\n\n${FENCE(JSON.stringify({ v: 1, blocks: [TABLE, COMPARISON] }))}`],
  ['a tilde fence works too', `Words.\n\n~~~explain\n${good}\n~~~`],
  ['a longer backtick fence closes only with as many', `Words.\n\n\`\`\`\`explain\n${good}\n\`\`\`\n\`\`\`\``],
  ['a fence under a Design heading comes off like any other', `Lead.\n\n### Design\n\nThe look.\n\n${FENCE(good)}`],
  ['a wide table fence', `Words.\n\n${FENCE(JSON.stringify({ v: 1, blocks: [TABLE] }))}`],
  ['not a string is empty text', 42],
];

test('the browser mirror validates exactly as the server', () => {
  for (const [name, input] of VALIDATE_FIXTURES) {
    assert.deepEqual(client.validate(input), server.validate(input), name);
  }
});

test('the browser mirror splits exactly as the server', () => {
  for (const [name, md] of SPLIT_FIXTURES) {
    assert.deepEqual(client.split(md), server.split(md), name);
  }
});

test('the browser mirror writes the same Markdown as the server', () => {
  for (const [name, input] of VALIDATE_FIXTURES) {
    assert.equal(client.toMarkdown(input), server.toMarkdown(input), name);
  }
  for (const [name, md] of SPLIT_FIXTURES) {
    const { blocks } = server.split(md);
    assert.equal(client.toMarkdown(blocks), server.toMarkdown(blocks), name);
  }
});

test('the mirror and the server pin the same limits', () => {
  assert.equal(client.VERSION, server.VERSION);
  assert.equal(client.MAX_BLOCKS, server.MAX_BLOCKS);
  assert.equal(client.MAX_TEXT, server.MAX_TEXT);
  assert.equal(client.MAX_TITLE, server.MAX_TITLE);
  assert.equal(client.FENCE_LANG, server.FENCE_LANG);
  assert.deepEqual(JSON.parse(JSON.stringify(client.LIMITS)), JSON.parse(JSON.stringify(server.LIMITS)));
});

// ── The rules themselves, on the server ───────────────────────────────

test('validate is all-or-nothing per block and keeps the first two valid ones', () => {
  assert.deepEqual(server.validate([COMPARISON, STEPS, TABLE]), [COMPARISON, STEPS]);
  assert.deepEqual(server.validate([{ kind: 'steps', steps: ['one'] }, COMPARISON, TABLE]), [COMPARISON, TABLE],
    'an invalid block takes no slot');
  assert.deepEqual(server.validate([{ kind: 'steps', steps: ['a', 'b'], colour: 'red' }]), [{ kind: 'steps', steps: ['a', 'b'] }],
    'unknown fields go');
  assert.deepEqual(server.validate([{ kind: 'steps', steps: ['  a \n b ', 'c'] }]), [{ kind: 'steps', steps: ['a b', 'c'] }],
    'a cell is one line');
  assert.deepEqual(server.validate([{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }], terms: [] }]),
    [{ kind: 'comparison', rows: [{ who: 'w', before: 'b', after: 'a' }] }], 'no terms, no key');
  assert.deepEqual(server.validate([{ kind: 'steps', steps: [long(121), 'b'] }]), [], 'a long cell drops the block whole');
  assert.deepEqual(server.validate('nope'), []);
  assert.doesNotThrow(() => server.validate([{ get kind() { throw new Error('x'); } }].map(() => undefined)));
});

test('embed and split round-trip, and no blocks leave the text byte for byte', () => {
  const text = 'Admins get a switch.\n\nEveryone keeps their vote.';
  assert.equal(server.embed(text, []), text);
  assert.equal(server.embed(text, [{ kind: 'steps', steps: ['one'] }]), text, 'invalid blocks embed nothing');
  const md = server.embed(text, [COMPARISON, STEPS]);
  assert.ok(md.startsWith(`${text}\n\n\`\`\`explain\n{"v":1,"blocks":[`));
  assert.ok(md.endsWith('\n```'));
  assert.deepEqual(server.split(md), { text, blocks: [COMPARISON, STEPS] });
  assert.equal(server.embed('', [STEPS]).startsWith('```explain'), true, 'no words: the fence alone');
  assert.equal(server.embed('Words.  \n\n', [STEPS]).startsWith('Words.\n\n```explain'), true, 'trailing space trimmed before the fence');
});

test('split leaves an invalid fence in the text, and a no-fence summary untouched', () => {
  const plain = 'Words.\n\n```js\nx()\n```';
  const out = server.split(plain);
  assert.equal(out.text, plain);
  assert.deepEqual(out.blocks, []);
  const bad = `Words.\n\n${FENCE('{not json')}`;
  assert.deepEqual(server.split(bad), { text: bad, blocks: [] });
  const open = `Words.\n\n\`\`\`explain\n${good}`;
  assert.deepEqual(server.split(open), { text: open, blocks: [] }, 'an unclosed fence is text');
  const mid = `Words.\n\n${FENCE(good)}\n\nAsked for by @maya`;
  assert.deepEqual(server.split(mid), { text: 'Words.\n\nAsked for by @maya', blocks: [COMPARISON, STEPS] });
  const two = `Words.\n\n${FENCE(JSON.stringify({ v: 1, blocks: [STEPS] }))}\n\n${FENCE(JSON.stringify({ v: 1, blocks: [TABLE, COMPARISON] }))}`;
  assert.deepEqual(server.split(two).blocks, [STEPS, TABLE], 'two overall, in order');
});

test('toMarkdown writes a GFM table, term bullets, a numbered list and a titled table', () => {
  assert.equal(server.toMarkdown([COMPARISON]), [
    '|   | Before | After |',
    '| --- | --- | --- |',
    '| Member from before | Vote counts | Vote counts |',
    '| New member, unverified | Vote counts | Asked to verify first, then counts |',
    '',
    '- **Verified**: A phone number, GitHub and X both linked, or zkPassport',
  ].join('\n'));
  assert.equal(server.toMarkdown([STEPS]), [
    '**Steps for an unverified newcomer**',
    '',
    '1. Votes',
    '2. Asked for a phone',
    '3. Verifies',
    '4. The vote counts',
  ].join('\n'));
  assert.equal(server.toMarkdown([TABLE]), [
    '**Budgets**',
    '',
    '| Who | Daily budget |',
    '| --- | --- |',
    '| Verified | Full |',
    '| Unverified | Smaller |',
  ].join('\n'));
  assert.equal(server.toMarkdown([{ kind: 'table', columns: ['a|b', 'c'], rows: [['1|2', '3']] }]),
    '| a\\|b | c |\n| --- | --- |\n| 1\\|2 | 3 |', 'a pipe in a cell is escaped');
  assert.equal(server.toMarkdown([]), '');
});

test('forGitHub leads with the words and ends with the blocks as Markdown', () => {
  const md = server.embed('Words.', [STEPS]);
  assert.equal(server.forGitHub(md), `Words.\n\n${server.toMarkdown([STEPS])}`);
  assert.equal(server.forGitHub('Words.'), 'Words.', 'no fence, unchanged');
  const bad = `Words.\n\n${FENCE('{not json')}`;
  assert.equal(server.forGitHub(bad), bad, 'an invalid fence stays the code block it is');
  assert.equal(server.forGitHub(server.embed('', [STEPS])), server.toMarkdown([STEPS]));
});

test('normalize re-serialises any writer\'s fence and leaves an invalid one as text', () => {
  const loose = `Words.\n\n\`\`\`explain\n${JSON.stringify({ v: 1, blocks: [{ ...STEPS, colour: 'red' }], extra: true }, null, 2)}\n\`\`\``;
  assert.equal(server.normalize(loose), server.embed('Words.', [STEPS]));
  const bad = `Words.\n\n${FENCE('{not json')}`;
  assert.equal(server.normalize(bad), bad);
  assert.equal(server.normalize('Words.'), 'Words.');
  assert.equal(server.normalize(null), null, 'a nullable summary passes through');
  assert.equal(server.normalize(''), '');
});
