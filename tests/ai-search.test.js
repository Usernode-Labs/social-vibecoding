'use strict';

// The Homeroom bot tab's search, in what was said (13 Nov 2026):
// src/services/ai-search.js, GET /api/ai/search (src/routes/ai-work.js) and
// frontend/src/features/ai/search.ts. A tester typed "improve" and was told
// no thread matched, although they had written "I want to improve my app."
// to the bot: message text was never searched.
//
// What this pins, without a database (tests/ai-search-postgres.test.js has
// the query against the full schema):
//   1. The query is data: cut to one line and a length, its LIKE wildcards
//      escaped, and too short a query asks the database nothing.
//   2. The snippet: plain text round the first match, cut at whole words,
//      with where every match is in it, and no markup in it.
//   3. The client marks the found words by splitting the text at those
//      places; an answer is checked before it is drawn.
//   4. The read is made once the person stops typing, an answer to an
//      earlier question is dropped, and nothing is asked before they type.
//   5. The route takes its conversation from who is signed in, never from
//      the request.
//
// Run with: node --test tests/ai-search.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const aiSearch = require('../src/services/ai-search');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SEARCH = 'frontend/src/features/ai/search.ts';

test('the query is data: one line, a length, and its LIKE wildcards escaped', () => {
  assert.equal(aiSearch.cleanQuery('  improve \n  my   app '), 'improve my app');
  assert.equal(aiSearch.cleanQuery(undefined), '');
  assert.equal(aiSearch.cleanQuery(['a', 'b']), '', 'a repeated parameter is not a query');
  assert.equal(aiSearch.cleanQuery('x'.repeat(500)).length, aiSearch.MAX_CHARS);
  assert.equal(aiSearch.MIN_CHARS, 2);
  assert.equal(aiSearch.MAX_HITS, 20);
  // % and _ would match anything, and \ would escape the pattern's own %.
  assert.equal(aiSearch.likePattern('100%_a\\b'), '%100\\%\\_a\\\\b%');
  assert.match(aiSearch.SEARCH_SQL, /m\.content ILIKE \$3 ESCAPE '\\'/, 'case does not matter, and the escape is named');
  // The client cleans what it asks the same way, so an answer's query is the one the box holds.
  const client = loadTsx(SEARCH);
  for (const raw of ['  improve \n  my   app ', '', ' z ', 'x'.repeat(500)]) {
    assert.equal(client.cleanQuery(raw), aiSearch.cleanQuery(raw), JSON.stringify(raw.slice(0, 20)));
  }
  assert.equal(client.SEARCH_MIN, aiSearch.MIN_CHARS);
  assert.equal(client.SEARCH_MAX, aiSearch.MAX_CHARS);
});

test('too short a query, nobody signed in or no bot account asks the database nothing', async () => {
  const asked = [];
  const pool = { query: async (sql, params) => { asked.push({ sql, params }); return { rows: [] }; } };
  const bot = { id: 9 };
  assert.deepEqual(await aiSearch.searchFor(pool, { user: { id: 4 }, q: 'i', deps: { bot } }), { q: 'i', rows: [], more: false });
  assert.deepEqual(await aiSearch.searchFor(pool, { user: null, q: 'improve', deps: { bot } }), { q: 'improve', rows: [], more: false });
  assert.deepEqual(await aiSearch.searchFor(pool, { user: { id: 9 }, q: 'improve', deps: { bot } }), { q: 'improve', rows: [], more: false }, 'the bot has no chat with itself');
  assert.equal(asked.length, 0);
  // A real search: the person, the bot, the pattern, and one row more than is sent.
  const rows = Array.from({ length: aiSearch.MAX_HITS + 1 }, (_, i) => ({
    id: 100 - i, thread_root_id: null, sender_id: 4, content: `I want to improve my app, take ${i}`, created_at: new Date('2026-11-03T12:00:00Z'),
  }));
  const full = { query: async (sql, params) => { asked.push({ sql, params }); return { rows }; } };
  const out = await aiSearch.searchFor(full, { user: { id: 4 }, q: '50%', deps: { bot } });
  assert.deepEqual(asked[0].params, [4, 9, '%50\\%%', aiSearch.MAX_HITS + 1]);
  assert.equal(asked[0].sql, aiSearch.SEARCH_SQL);
  assert.equal(out.rows.length, aiSearch.MAX_HITS, 'the newest twenty');
  assert.equal(out.more, true, 'and that there were more');
  assert.deepEqual(Object.keys(out.rows[0]), ['messageId', 'rootId', 'threadTitle', 'mine', 'snippet', 'ranges', 'at']);
  assert.equal(out.rows[0].mine, true);
  assert.equal(out.rows[0].at, '2026-11-03T12:00:00.000Z');
});

test('the snippet is plain text round the first match, cut at whole words, with where the words are', () => {
  const { snippetOf } = aiSearch;
  const marked = ({ snippet, ranges }) => ranges.map(([a, b]) => snippet.slice(a, b));

  // The report: the whole message fits, and the word is found in it.
  const short = snippetOf('I want to improve my app.', 'improve');
  assert.deepEqual(short, { snippet: 'I want to improve my app.', ranges: [[10, 17]] });

  // Either case, and every time it is said.
  const twice = snippetOf('Improve it, then IMPROVE it again', 'improve');
  assert.deepEqual(marked(twice), ['Improve', 'IMPROVE']);

  // A long message: a word or two before the match, the line after it, "…" where it was cut.
  const long = snippetOf(`${'Before we start, a long preamble about nothing. '.repeat(4)}I want to improve my app, and then ${'carry on at length '.repeat(10)}`, 'improve');
  assert.match(long.snippet, /^…/);
  assert.match(long.snippet, /…$/);
  assert.ok(long.snippet.length <= 100, `about eighty characters, was ${long.snippet.length}`);
  assert.deepEqual(marked(long), ['improve']);
  assert.ok(long.ranges[0][0] <= 24, 'the match is near the start of the line, so a narrow row still shows it');
  // A few words before the match are kept whole, not swapped for an "…".
  assert.equal(snippetOf('Happy to help you improve it. Which part first?', 'improve').snippet, 'Happy to help you improve it. Which part first?');
  assert.match(long.snippet, /^…(?:nothing\. )?I want to improve my app, and then carry on at length/);
  assert.doesNotMatch(long.snippet.slice(0, -1), /\s$/, 'no space before the closing …');

  // Markdown is not shown: the words are, and the places are in what is shown.
  const md = snippetOf('**Staging demo app** · request #12: sort the list\n\n> Should the `newest` items show first?', 'newest');
  assert.doesNotMatch(md.snippet, /[*`>]|\n/);
  assert.deepEqual(marked(md), ['newest']);

  // A phrase matches across the line break the message had.
  assert.deepEqual(marked(snippetOf('please improve\nmy app', 'improve my')), ['improve my']);

  // A query with characters a pattern would read is matched as written.
  assert.deepEqual(marked(snippetOf('Is it 100% (really) done? a.b', '100% (really)')), ['100% (really)']);
  assert.deepEqual(marked(snippetOf('a.b and axb', 'a.b')), ['a.b']);

  // The match is in the markup only (a link's address): its opening words, nothing marked.
  assert.deepEqual(snippetOf('see [the docs](https://example.com/improve) please', 'improve'), { snippet: 'see the docs please', ranges: [] });

  // Nothing to show: no snippet at all (the row is left out).
  assert.deepEqual(snippetOf('', 'improve'), { snippet: '', ranges: [] });
  assert.deepEqual(snippetOf('```\n```', 'improve'), { snippet: '', ranges: [] });

  // A character that takes two code units is never cut in half.
  const emoji = snippetOf(`${'😀'.repeat(60)}improve${'😀'.repeat(60)}`, 'improve');
  assert.deepEqual(marked(emoji), ['improve']);
  assert.doesNotMatch(emoji.snippet, /^…[\udc00-\udfff]|[\ud800-\udbff]…$/, 'no half of a pair at either cut');

  // The ranges are in order and inside the snippet, as the client requires.
  for (const s of [short, twice, long, md, emoji]) {
    let from = 0;
    for (const [a, b] of s.ranges) {
      assert.ok(a >= from && b > a && b <= s.snippet.length);
      from = b;
    }
  }
});

test('the server reads a message as plain text the way the tab\'s previews do', () => {
  const { plainText } = loadTsx('frontend/src/features/messages/plain-text.ts');
  for (const sample of [
    '**Flat 4B Chores** · request #7: Fix mark as done\n\nFiled.',
    '# A heading\n\n- [x] one\n- two\n\n1. three',
    'Use `npm test` or ``a `tick` inside`` here',
    'A [link](https://example.com/a_b) and ![an image](x.png) and <https://example.com>',
    '> quoted\n> again\n\n---\n\n~~gone~~ ++kept++ *soft* _soft_ snake_case 2 * 3',
    '```js\nconst a = 1;\n```\nafter',
    'escaped \\*stars\\* and \\_under\\_',
    '',
  ]) {
    assert.equal(aiSearch.plainText(sample), plainText(sample), JSON.stringify(sample));
  }
});

test('the client marks the found words by splitting the text, and checks an answer before drawing it', () => {
  const { markParts, cleanFound, searchPath, foundDay } = loadTsx(SEARCH);
  const plain = (v) => JSON.parse(JSON.stringify(v));

  assert.deepEqual(plain(markParts('I want to improve my app.', [[10, 17]])), [
    { text: 'I want to ', hit: false }, { text: 'improve', hit: true }, { text: ' my app.', hit: false },
  ]);
  assert.deepEqual(plain(markParts('improve improve', [[0, 7], [8, 15]])), [
    { text: 'improve', hit: true }, { text: ' ', hit: false }, { text: 'improve', hit: true },
  ]);
  assert.deepEqual(plain(markParts('plain', [])), [{ text: 'plain', hit: false }]);
  assert.deepEqual(plain(markParts('plain', null)), [{ text: 'plain', hit: false }]);
  assert.deepEqual(plain(markParts('', [[0, 3]])), []);
  // A place outside the text, backwards, or over the one before is left unmarked.
  assert.deepEqual(plain(markParts('abcdef', [[2, 4], [3, 5], [5, 99], [4, 4], ['0', 1], [5, 6]])), [
    { text: 'ab', hit: false }, { text: 'cd', hit: true }, { text: 'e', hit: false }, { text: 'f', hit: true },
  ]);
  // Markup in a message stays text: the parts are strings, drawn as text nodes.
  const parts = markParts('<b>improve</b> <img src=x onerror=alert(1)>', [[3, 10]]);
  assert.equal(parts.map((p) => p.text).join(''), '<b>improve</b> <img src=x onerror=alert(1)>');
  const found = read('frontend/src/features/ai/found.tsx');
  assert.match(found, /<mark key=\{i\} className=\{className\}>\{part\.text\}<\/mark>/);
  for (const file of ['frontend/src/features/ai/found.tsx', 'frontend/src/features/ai/lists.tsx', 'frontend/src/features/ai/frame-list.tsx', SEARCH]) {
    assert.doesNotMatch(read(file), /dangerouslySetInnerHTML|innerHTML/, `${file} never reads the answer as markup`);
  }

  // An answer: rows that are rows, ids that are ids, places that fit their snippet.
  const answer = cleanFound({
    q: 'something else',
    more: true,
    rows: [
      { messageId: 71, rootId: null, threadTitle: null, mine: true, snippet: 'I want to improve my app.', ranges: [[10, 17]], at: '2026-11-03T12:00:00.000Z' },
      { messageId: 88, rootId: 60, threadTitle: 'A calendar', mine: false, snippet: 'improve it', ranges: [[0, 7], [0, 99]], at: null },
      { messageId: '9', snippet: 'a string id' },
      { messageId: 12, snippet: '' },
      { messageId: 13, rootId: -4, threadTitle: 7, mine: 'yes', snippet: 'odd fields', ranges: 'no' },
      null,
    ],
  }, 'improve');
  assert.equal(answer.q, 'improve', 'the question asked, not what the answer claims');
  assert.equal(answer.state, 'answered');
  assert.equal(answer.more, true);
  assert.deepEqual(plain(answer.rows), [
    { messageId: 71, rootId: null, threadTitle: null, mine: true, snippet: 'I want to improve my app.', ranges: [[10, 17]], at: '2026-11-03T12:00:00.000Z' },
    { messageId: 88, rootId: 60, threadTitle: 'A calendar', mine: false, snippet: 'improve it', ranges: [[0, 7]], at: null },
    { messageId: 13, rootId: null, threadTitle: null, mine: false, snippet: 'odd fields', ranges: [], at: null },
  ]);
  assert.deepEqual(plain(cleanFound(null, 'q')), { q: 'q', rows: [], more: false, state: 'answered' });

  // The read: the query, and the staging demo's flag when the page has it.
  assert.equal(searchPath('improve my app'), '/api/ai/search?q=improve+my+app');
  assert.equal(searchPath('50% & more', true), '/api/ai/search?q=50%25+%26+more&demo=1');

  // The day, with its year when it is another one.
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(foundDay('2026-11-03T12:00:00Z', 'en-GB', now), '3 Nov');
  assert.equal(foundDay('2025-11-03T12:00:00Z', 'en-GB', now), '3 Nov 2025');
  assert.equal(foundDay(null, 'en-GB', now), '');
});

test('the read waits for the typing to stop, drops a stale answer, and asks nothing before anyone types', () => {
  const src = read(SEARCH);
  assert.match(src, /export const SEARCH_WAIT = 250;/);
  const hook = src.slice(src.indexOf('export function useBotSearch'));
  // Nothing in the first render: no answer, and the read is made in an effect.
  assert.match(hook, /const \[found, setFound\] = useState<Found \| null>\(null\);/);
  assert.match(hook, /if \(!q\) \{ setFound\(null\); return undefined; \}/, 'an empty box asks nothing and shows nothing');
  assert.match(hook, /if \(q\.length < SEARCH_MIN \|\| !signedIn\) \{\s*setFound\(\{ q, rows: \[\], more: false, state: 'unasked' \}\);\s*return undefined;/);
  // One read, SEARCH_WAIT after the last key; the next key cancels it.
  assert.match(hook, /const timer = setTimeout\(\(\) => \{\s*void fetch\(searchPath\(q, demo\), \{ credentials: 'same-origin', signal: stop\?\.signal \}\)/);
  assert.match(hook, /\}, SEARCH_WAIT\);\s*return \(\) => \{ asked = false; clearTimeout\(timer\); stop\?\.abort\(\); \};/);
  // An answer to a question no longer asked is dropped; a failed read says so.
  assert.match(hook, /if \(!asked\) return;\s*setFound\(body \? cleanFound\(body, q\) : \{ q, rows: \[\], more: false, state: 'failed' \}\);/);
  // The last answer is kept while the next is read: the effect does not clear it for a new query.
  assert.equal((hook.match(/setFound\(null\)/g) || []).length, 1, 'cleared only when the box is empty');
  assert.match(hook, /\}, \[q, signedIn, demo, again\]\);/);
});

test('the route reads the caller\'s own chat: no conversation, message or user is taken from the request', () => {
  const route = read('src/routes/ai-work.js');
  const start = route.indexOf("router.get('/api/ai/search'");
  assert.ok(start > 0);
  const body = route.slice(start, route.indexOf('\n  });', start));
  assert.match(body, /^router\.get\('\/api\/ai\/search', userDirectoryLimiter, sameOriginBrowserOnly, async \(req, res\) => \{/, 'limited by account, and a browser\'s read only');
  assert.match(body, /res\.set\('Cache-Control', 'private, no-store'\);/);
  assert.match(body, /if \(!req\.user\?\.id\) return res\.status\(401\)/);
  assert.deepEqual([...new Set([...body.matchAll(/req\.(?:query|params|body)\.?(\w*)/g)].map((m) => m[1]))].sort(), ['demo', 'q'], 'only the words, and the staging demo\'s flag');
  assert.match(body, /aiSearch\.searchFor\(pool, \{ user: req\.user, q \}\)/);
  assert.match(body, /if \(q\.length < aiSearch\.MIN_CHARS\) return res\.json\(\{ q, rows: \[\], more: false \}\);/);
  assert.match(body, /if \(IS_STAGING && req\.query\.demo === '1'\) \{\s*await require\('\.\.\/services\/staging-messages'\)\.ensureBotDmFixture\(pool, req\.user\)/, 'the staging demo searches its own fixture chat');
  // The query finds the chat from the pair (the person, the bot) and the person's own membership.
  const sql = aiSearch.SEARCH_SQL;
  assert.match(sql, /pair\.user_low_id = LEAST\(\$1::int, \$2::int\)\s+AND pair\.user_high_id = GREATEST\(\$1::int, \$2::int\)/);
  assert.match(sql, /mine\.user_id = \$1 AND mine\.status = 'member'/);
  assert.match(sql, /m\.deleted_at IS NULL\s+AND m\.moderation_hidden_at IS NULL/);
  assert.match(sql, /m\.msg_type = 'message'/);
  assert.match(sql, /LEFT\(COALESCE\(m\.metadata->'homeroomBot'->>'kind', ''\), 7\) <> 'opened_'/, 'the line that opens a thread is not something said in it');
  assert.match(sql, /ORDER BY m\.id DESC\s+LIMIT \$4/);
});
