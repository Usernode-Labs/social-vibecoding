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
