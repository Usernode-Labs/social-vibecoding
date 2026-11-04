// #6081: the Translate control on a request and in a message's ⋯ menu, and
// the line under translated words.
//
// What this pins:
//   1. THE ANSWER, as words: a translated text is shown, text already in the
//      reader's language says so, and a failure leaves the original.
//   2. THE WAY BACK: Show original and Show translation each flip the line,
//      and the button beside Show more exists only on someone else's request.
//   3. THE MENU: Translate is one row of the ⋯ menu, only on someone else's
//      message with words, and it becomes the way back once translated.
//   4. THE COPY: every id these screens ask for exists in English.
//
// Run with: node --test tests/translate-toggle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TRANSLATE = 'frontend/src/features/messages/translate.tsx';
const ROW = 'frontend/src/features/messages/message-row.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';

const mod = loadTsx(TRANSLATE);

test('the answer says what the words are doing', () => {
  assert.deepEqual(mod.viewOf(null, ['Hello']), { state: 'idle', texts: ['Hello'], from: null });

  const shown = mod.viewOf([{ state: 'translated', text: 'Bonjour', from: 'en' }], ['Hello']);
  assert.equal(shown.state, 'shown');
  assert.deepEqual(shown.texts, ['Bonjour']);
  assert.equal(shown.from, 'en');

  const same = mod.viewOf([{ state: 'same' }], ['Hello']);
  assert.equal(same.state, 'same');
  assert.deepEqual(same.texts, ['Hello']);

  const failed = mod.viewOf([{ state: 'failed' }], ['Hello']);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.texts, ['Hello']);

  // A title already in the language, the words translated: the pair reads
  // as one, each part as it should be.
  const mixed = mod.viewOf([{ state: 'same' }, { state: 'translated', text: 'Bonjour', from: 'en' }], ['Title', 'Hello']);
  assert.equal(mixed.state, 'shown');
  assert.deepEqual(mixed.texts, ['Title', 'Bonjour']);
});

test('the line under the words says how to go back, or why it stayed', () => {
  const note = (state, from = null) => renderToHtml(createElement(mod.TranslateNote, {
    view: { state, from, toggle() {} },
  }));

  assert.equal(note('idle'), '');
  assert.match(note('pending'), /Translating…/);
  assert.match(note('failed'), /Couldn&#x27;t translate this/);
  assert.match(note('limit'), /You&#x27;ve translated a lot today/);
  assert.match(note('same'), /Already in English/);
  assert.match(note('shown', 'zh-CN'), /Translated from Chinese/);
  assert.match(note('shown', 'zh-CN'), /Show original/);
  assert.match(note('original', 'zh-CN'), /Show translation/);
  // A source the model did not name still says the words were translated.
  assert.match(note('shown', null), /Translated/);
});

test('the request page offers Translate only on someone else’s request, beside Show more', () => {
  const src = read(HEAD);
  assert.match(src, /const canTranslate = !!myUsername && !!r\.asker && r\.asker !== myUsername && sources\.length > 0;/);
  assert.match(src, /const translation = useTranslate\(sources, \{ enabled: canTranslate \}\);/);
  assert.match(src, /translate=\{!canTranslate \|\| editing \|\| \(translation\.state !== 'idle' && translation\.state !== 'pending'\) \? null : \(/);
  assert.match(src, /className="dev-ws-reveal dev-ws-reveal-start touch-target-32 dev-request-more"/);
  // #6081: the note line is drawn in every state but idle, "Translating…"
  // included, so the words say what is happening while the model answers.
  assert.match(src, /note=\{!canTranslate \|\| translation\.state === 'idle' \? undefined : <TranslateNote view=\{translation\}/);
  // The translated title and words replace the originals, in the same places.
  assert.match(src, /const shownTitle = translation\.state === 'shown' && titleAt >= 0 \? translation\.texts\[titleAt\] : r\.title;/);
  assert.match(src, /const shownBody = translation\.state === 'shown' && bodyAt >= 0 \? translation\.texts\[bodyAt\] : null;/);
  assert.match(src, /const bodyHtml = useMemo\(\(\) => \(shownBody == null \? r\.bodyHtml : translatedWords\(shownBody\)\), \[shownBody, r\.bodyHtml\]\);/);
});

test('a message gets Translate in its ⋯ menu, only when someone else wrote it', () => {
  const src = read(ROW);
  assert.match(src, /const translation = useTranslate\(message\.content \? \[message\.content\] : \[\], \{\s*enabled: !mine && !!message\.content && !message\.deleted && !message\.moderated,/);
  assert.match(src, /if \(!mine && message\.content && !message\.deleted && !message\.moderated\) \{/);
  assert.match(src, /key: 'translate', label, icon: GlobeIcon, disabled: translation\.state === 'pending'/);
  assert.match(src, /translation\.state === 'shown' \? translation\.texts\[0\] : message\.content/);
  assert.match(src, /<TranslateNote view=\{translation\} className="mt-1" \/>/);
});

test('the request view carries the markdown its words were built from', () => {
  assert.match(read('public/js/app-view.js'), /bodyMarkdown: words\.text,/);
  assert.match(read('frontend/src/features/dev-board/topic/model.ts'), /bodyMarkdown: string;/);
});

test('every id these screens ask for exists in English', () => {
  const ids = [
    'messages:row.menu.translate',
    'messages:row.menu.showOriginal',
    'messages:row.menu.showTranslation',
    'messages:translate.from',
    'messages:translate.translated',
    'messages:translate.pending',
    'messages:translate.failed',
    'messages:translate.same',
    'messages:translate.showOriginal',
    'messages:translate.showTranslation',
    'messages:translate.limit',
    'project:topic.request.words.translate',
  ];
  for (const id of ids) assert.ok(message(id), id);
});
