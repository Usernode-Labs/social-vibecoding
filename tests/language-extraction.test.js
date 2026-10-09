'use strict';

// The shell's text comes from the catalogs (frontend/locales/README.md).
//
// tests/language-packs.test.js covers the catalog format and the packs, and
// tests/language-runtime.test.js the runtime. This suite covers the join
// between the two and the code: an id the code asks for exists, a screen
// renders what the catalog holds in the language on screen, and what has no
// translation yet renders in English.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkIds, literalsIn, looksLikeProse } = require('../scripts/language-inventory');
const { loadInSpanish } = require('./lib/language-fixture');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { renderToHtml, createElement } = require('./lib/render-tsx');

test('every message id the code asks for is in the English source', () => {
  const { used, unknown } = checkIds();
  assert.ok(used > 0, 'the client sources are read');
  assert.deepEqual(unknown.map(({ id, file, line }) => `${file}:${line} ${id}`), [],
    'an id with no catalog entry renders as the id itself');
});

test('the rail renders in the language on screen, and in English where there is no translation', async (t) => {
  const { module: rail } = await loadInSpanish(t, 'frontend/src/features/nav/recents-list.tsx', {
    'core:recents.day.today': 'Hoy',
    'core:recents.row.direct': 'Mensaje directo: {{name}}',
    'core:recents.row.unread': 'sin leer',
    'core:recents.showOlder_one': 'Mostrar {{count}} anterior',
    'core:recents.showOlder_many': 'Mostrar {{count}} de anteriores',
    'core:recents.showOlder_other': 'Mostrar {{count}} anteriores',
  });
  const now = Date.UTC(2026, 9, 8, 12);
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const row = (key, daysAgo, more = {}) => ({
    key, kind: 'direct', label: key, href: `#messages/${key}`, at: at(daysAgo), unread: false, ...more,
  });
  const html = renderToHtml(createElement(rail.RecentsByDay, {
    items: [row('ana', 0, { unread: true }), row('ben', 1), ...Array.from({ length: 9 }, (_, i) => row(`old${i}`, 30 + i))],
    live: [], showOlder: false, onToggleOlder() {}, now,
  }));
  assert.match(html, /<div class="platform-recents-day">Hoy<\/div>/, 'a translated heading');
  assert.match(html, /aria-label="Mensaje directo: ana, sin leer"/, 'a row named from two translated facts');
  assert.match(html, /<div class="platform-recents-day">Yesterday<\/div>/,
    'a heading with no Spanish yet is English, on its own');
  assert.match(html, /Mostrar \d+ anteriores/, 'a counted message takes the plural form of the language');
});

test('in English the same rows read exactly as they did before the text moved', () => {
  assert.equal(message('core:recents.day.daysAgo', { count: 3 }), '3 days ago');
  assert.equal(message('core:tabs.votesWaiting', { count: 1 }), '1 vote waiting on you');
  assert.equal(message('core:tabs.votesWaiting', { count: 4 }), '4 votes waiting on you');
  const { listText, t } = englishPlatformI18n();
  assert.equal(listText([t('core:recents.row.app', { name: 'Recipe Box' }), t('core:liveApp.stillOpen'), null, t('core:recents.row.unread')]),
    'App: Recipe Box, still open, unread');
});

test('a legacy owner gets markup from a whole message, with every word and value escaped', () => {
  const { htmlRich, htmlText } = englishPlatformI18n();
  assert.equal(htmlText('core:header.switchCommunity', { community: '<b>R&D</b>' }),
    '&lt;b&gt;R&amp;D&lt;/b&gt;, switch community');
  // No shipped message carries a tag yet, so this reads the id itself as the
  // text: what matters is the parsing, which is the same for any message.
  const link = (inner) => `<a href="/terms">${inner}</a>`;
  const { loadTsx } = require('./lib/render-tsx');
  const runtime = loadTsx('frontend/src/lib/i18n/core.ts').createLanguageRuntime({
    languages: { en: 'English' }, namespaces: ['core'], manifest: {},
    english: { core: { 'legal.terms': 'Read <0>the "terms"</0>, {{name}} & <1>more</1>.' } },
  });
  assert.equal(runtime.htmlRich('core:legal.terms', { name: '<i>Ana</i>' }, [link]),
    'Read <a href="/terms">the &quot;terms&quot;</a>, &lt;i&gt;Ana&lt;/i&gt; &amp; more.',
    'the wrapper supplies the element; a tag with no wrapper keeps only its text');
  assert.equal(htmlRich('core:tabs.home'), 'Home');
});

test('the remaining-literals report finds interface English and leaves identifiers alone', () => {
  // eslint-disable-next-line global-require
  const ts = require('typescript');
  const found = literalsIn('sample.tsx', [
    'import { x } from "./Some Module";',
    'const cls = "flex items-center gap-2";',
    'export function Sample({ open }: { open: boolean }) {',
    '  if (open === "Open now") console.log("Opened the sample");',
    '  return <button className="btn" aria-label="Close" title={open ? "Hide it" : undefined}>Save changes</button>;',
    '}',
    'export const html = `<p class="note">Nothing here yet</p>`;',
  ].join('\n'), ts).map((literal) => literal.text);
  assert.deepEqual(found, ['Close', 'Hide it', 'Save changes', 'Nothing here yet']);
  assert.equal(looksLikeProse('platform-tabs'), false);
  assert.equal(looksLikeProse('Could not load that language. Try again.'), true);
});

test('a game sentence keeps everything the catalog writes around the maker\'s words', async (t) => {
  const DIR = 'frontend/src/features/first-session';
  // English, as it reads today: the starter highlighted, then the mark.
  {
    // eslint-disable-next-line global-require
    const { loadTsx } = require('./lib/render-tsx');
    const { TEMPLATES, OWN, sentence } = loadTsx(`${DIR}/examples.ts`);
    const game = TEMPLATES.find((x) => x.key === 'game');
    const board = sentence(game, 'board', 'we roll dice');
    assert.deepEqual([board.head, board.fill, board.tail],
      ['A new game we build together. For the first version, ', 'a board game where', ' …']);
    assert.equal(board.text, 'A new game we build together. For the first version, a board game where we roll dice.');
    // Odd endings read exactly as they did before the text moved: only
    // `.`, `!` and `?` count as an ending in English.
    const said = (words) => sentence(game, 'board', words).text.replace('A new game we build together. For the first version, a board game where ', '');
    assert.deepEqual(['we take turns…', 'we roll dice。', 'really?', 'go!', 'stop.', 'two  spaces ', 'x'].map(said),
      ['we take turns….', 'we roll dice。.', 'really?', 'go!', 'stop.', 'two spaces.', 'x.']);
    assert.equal(sentence(game, 'board', '').text, 'A new game we build together. For the first version, a board game where ');
    const own = sentence(game, OWN, 'we draw and guess!');
    assert.deepEqual([own.head, own.fill, own.tail], ['A new game we build together. For the first version, ', '', '']);
    assert.equal(own.text, 'A new game we build together. For the first version, we draw and guess!');
  }
  // A language that puts words AFTER the blank, marks the blank its own way
  // and closes a sentence with its own full stop.
  const { module: examples } = await loadInSpanish(t, `${DIR}/examples.ts`, {
    'onboarding:firstSession.template.game.board.sentence': 'Intro <0>TABLERO</0> {{words}} FINAL OBLIGATORIO',
    'onboarding:firstSession.template.game.own.sentence': 'Propio {{words}} DESPUÉS',
    'onboarding:firstSession.make.wordsBlank': '___',
    'onboarding:firstSession.make.wordsWithStop': '{{words}}。',
    'onboarding:firstSession.make.sentenceEnders': '。！？',
  });
  const game = examples.TEMPLATES.find((x) => x.key === 'game');
  const board = examples.sentence(game, 'board', 'tiramos dados');
  assert.deepEqual([board.head, board.fill, board.tail], ['Intro ', 'TABLERO', ' ___ FINAL OBLIGATORIO'],
    'the text after the blank is drawn, with the language\'s own mark in the blank');
  assert.equal(board.text, 'Intro TABLERO tiramos dados。 FINAL OBLIGATORIO',
    'and sent, with the catalog\'s punctuation, not an English full stop');
  assert.equal(examples.sentence(game, 'board', 'tiramos dados！').text, 'Intro TABLERO tiramos dados！ FINAL OBLIGATORIO',
    'an ending the language itself lists is left alone');
  assert.equal(examples.sentence(game, 'board', 'tiramos dados.').text, 'Intro TABLERO tiramos dados.。 FINAL OBLIGATORIO',
    'and which endings count is the catalog\'s decision, not the code\'s');
  const own = examples.sentence(game, examples.OWN, 'dibujamos');
  assert.deepEqual([own.head, own.tail], ['Propio  DESPUÉS', '']);
  assert.equal(own.text, 'Propio dibujamos。 DESPUÉS');
});

test('a person with no known username gets a sentence of their own, never a pronoun as a name', () => {
  // eslint-disable-next-line global-require
  const { loadTsx } = require('./lib/render-tsx');
  const friends = loadTsx('frontend/src/features/friends/api.ts');
  assert.equal(friends.errorMessage({ status: 404 }, 'ada'), 'You can’t add @ada as a friend right now.');
  assert.equal(friends.errorMessage({ status: 404 }, null), 'You can’t add @them as a friend right now.',
    'English reads as it always has');
  assert.equal(message('messages:friends.error.cannotAddUnnamed'), 'You can’t add @them as a friend right now.');
  // eslint-disable-next-line global-require
  const profile = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/profile/profile.js'), 'utf8');
  assert.doesNotMatch(profile, /friendErrorMessage\(err, [^)]*'them'\)/);
});

test('the id check finds an id in a namespace nobody defined, and an unknown key in one that exists', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-ids-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  put('frontend/locales/en/core.json', JSON.stringify({
    'probe.label': { text: 'Probe', description: 'Fixture.' },
    'probe.count_one': { text: '{{count}} probe', description: 'Fixture.' },
    'probe.count_other': { text: '{{count}} probes', description: 'Fixture.' },
    'probe.unused': { text: 'Unused', description: 'Fixture.' },
  }));
  // A hyphenated namespace is valid for the pack builder, so it is checked too.
  put('frontend/locales/en/new-surface.json', JSON.stringify({
    'probe.label': { text: 'Probe', description: 'Fixture.' },
  }));
  put('frontend/src/b.ts', [
    "t('new-surface:probe.label');",
    "t('new-surface:probe.missing');",
    "t('other-surface:probe.label');",
    "el.addEventListener('usernode:friends-changed', () => {});",
  ].join('\n'));
  put('frontend/src/a.ts', [
    "t('core:probe.label');",
    "t('core:probe.count', { count: 2 });",
    "t('typo:probe.label');",
    "t('core:probe.missing');",
    "const TABLE = { a: 'core:probe.label', b: `core:probe.alsoMissing` };",
    "window.addEventListener('home:refresh', () => {});",
    "fetch('https://example.com/a.b');",
  ].join('\n'));
  const { used, unknown, unused } = checkIds(root);
  assert.equal(used, 9, 'every id-shaped literal is a candidate, whatever its namespace; an event name is not');
  assert.deepEqual(unknown.map(({ id, file, line }) => `${file.slice(-4)}:${line} ${id}`), [
    'a.ts:3 typo:probe.label', 'a.ts:4 core:probe.missing', 'a.ts:5 core:probe.alsoMissing',
    'b.ts:2 new-surface:probe.missing', 'b.ts:3 other-surface:probe.label',
  ]);
  assert.deepEqual(unused, ['core:probe.unused']);
});

test('a list of approvers words the reader and the unnamed rest for the place the list stands in', async (t) => {
  const FILE = 'frontend/src/features/messages/approval-words.ts';
  // English, as it reads today, in both places.
  {
    // eslint-disable-next-line global-require
    const { loadTsx } = require('./lib/render-tsx');
    const words = loadTsx(FILE);
    assert.equal(words.waitingWords({ you: true, names: ['ada'], more: 2 }), 'Waiting for approval from you, @ada and 2 more');
    assert.equal(words.waitingWords({ you: true, names: [] }), 'Waiting for approval from you');
    assert.equal(words.waitingWords({ you: true, names: [] }, 'sentence'), 'Waiting for approval from you.');
    assert.equal(words.waitingWords({ you: true, names: ['ada', 'ben'], more: 1, missing: 2 }), 'Needs 2 approvals from you, @ada, @ben or 1 other');
    assert.deepEqual(words.afterYesWords({ missing: 4, names: ['ada', 'cy'], more: 2 }),
      { who: 'people', values: { people: '@ada, @cy and 2 more' } });
    assert.equal(message('messages:bot.ready.approved.people.none', { people: '@ada, @cy and 2 more' }),
      'You approved it. It goes live when @ada, @cy and 2 more approve too.');
  }
  // A language whose words change with their place in the sentence, and
  // which has a plural form English lacks (`many`, for a million).
  const { module: words, runtime } = await loadInSpanish(t, FILE, {
    'messages:approval.waiting': 'Esperando la aprobación de {{people}}',
    'messages:approval.waitingYou': 'Esperando tu aprobación',
    'messages:approval.list.from.you': 'ti',
    'messages:approval.list.from.more_one': '{{count}} persona más',
    'messages:approval.list.from.more_many': '{{count}} de personas más',
    'messages:approval.list.from.more_other': '{{count}} personas más',
    'messages:approval.list.subject.more_one': 'otra persona ({{count}})',
    'messages:approval.list.subject.more_many': 'otro millón de personas ({{count}})',
    'messages:approval.list.subject.more_other': 'otras {{count}} personas',
    'messages:approval.list.and': '{{first}} y {{last}}',
    'messages:bot.ready.approved.people.none': 'Lo aprobaste. Se publica cuando {{people}} lo aprueben también.',
  });
  // After "de": the reader is "ti", the rest is "N personas más".
  assert.equal(words.waitingWords({ you: true, names: ['ada'], more: 2 }),
    'Esperando la aprobación de ti, @ada y 2 personas más');
  assert.equal(words.waitingWords({ you: false, names: ['ada'], more: 1000000 }),
    'Esperando la aprobación de @ada y 1000000 de personas más', 'the plural form of the language, not of English');
  // The reader alone: a sentence of its own, where "ti" would be wrong.
  assert.equal(words.waitingWords({ you: true, names: [] }), 'Esperando tu aprobación');
  // As the subject of "approve": a different form of the same rest.
  const after = words.afterYesWords({ missing: 4, names: ['ada', 'cy'], more: 2 });
  assert.equal(after.values.people, '@ada, @cy y otras 2 personas');
  assert.equal(runtime.t('messages:bot.ready.approved.people.none', after.values),
    'Lo aprobaste. Se publica cuando @ada, @cy y otras 2 personas lo aprueben también.');
  assert.equal(words.afterYesWords({ missing: 2, names: ['ada'], more: 1 }).values.people, '@ada y otra persona (1)');
});

test('an app or an owner with no name gets an unnamed sentence that reads as the named one did with its stand-in', () => {
  // English is unchanged: each unnamed message is the named one with the
  // stand-in the code used to pass as a name written into it.
  for (const [named, unnamed, values] of [
    ['changes:dialog.permission.title', 'changes:dialog.permission.titleUnnamed', { action: 'use your camera' }],
    ['changes:dialog.permission.titleCapability', 'changes:dialog.permission.titleCapabilityUnnamed', { capability: 'geolocation' }],
    ['changes:dialog.permission.note', 'changes:dialog.permission.noteUnnamed', {}],
    ['changes:dialog.permission.noteReopen', 'changes:dialog.permission.noteReopenUnnamed', {}],
    ['changes:dialog.llm.introOwnKey', 'changes:dialog.llm.introOwnKeyUnnamed', {}],
    ['changes:dialog.llm.introBudget', 'changes:dialog.llm.introBudgetUnnamed', {}],
  ]) {
    assert.equal(message(unnamed, values), message(named, { ...values, app: 'This app' }), unnamed);
  }
  assert.equal(message('changes:session.shared.workingSomeone'), message('changes:session.shared.working', { owner: 'someone' }));
  assert.equal(message('changes:session.shared.importedBySomeone', { author: 'ada' }),
    message('changes:session.shared.imported', { author: 'ada', owner: 'someone' }));
  // eslint-disable-next-line global-require
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app-view.js'), 'utf8');
  assert.doesNotMatch(src, /app: appName \}/, 'the AI dialog\'s sentences take a real name or their unnamed wording');
  assert.doesNotMatch(src, /username \|\| \(App\.user \? App\.user\.username : ''\) \|\| PlatformI18n/, 'no stand-in word becomes an owner\'s name');
  assert.match(src, /PlatformI18n\.t\('changes:dialog\.permission\.titleUnnamed', \{ action: view\.blurb \}\)/);
});
