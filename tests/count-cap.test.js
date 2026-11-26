// One cap for every count the shell spells out in a small space
// (frontend/src/lib/count-cap.ts): past 99 a badge or pill reads "99+". The
// rule used to be written out in eleven files; this holds that it is said
// once, and that the places that drew it read it from there.
//
// Run with: node --test tests/count-cap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('capCount: the number up to 99, then 99+', () => {
  const { capCount, COUNT_CAP } = loadTsx('frontend/src/lib/count-cap.ts');
  assert.equal(COUNT_CAP, 99);
  assert.equal(capCount(0), '0');
  assert.equal(capCount(7), '7');
  assert.equal(capCount(99), '99');
  assert.equal(capCount(100), '99+');
  assert.equal(capCount(4210), '99+');
});

test('the classic scripts read the same cap through PlatformI18n', () => {
  const runtime = read('frontend/src/lib/i18n/runtime.ts');
  assert.match(runtime, /^import \{ capCount \} from '\.\.\/count-cap';$/m);
  assert.match(runtime.slice(runtime.indexOf('PlatformI18n = {')), /^ {2}capCount,$/m);
  assert.equal(englishPlatformI18n().capCount(120), '99+');
  assert.match(read('frontend/src/features/notifications/notifications.js'),
    /_badgeText\(count\) \{\n {4}return PlatformI18n\.capCount\(count\);\n {2}\},/, 'the bell, its tab and the title');
});

test('no count in the shell writes its own 99+', () => {
  for (const file of [
    'frontend/src/features/dev-console/store.ts',
    'frontend/src/features/dev-board/workshop/project-places.tsx',
    'frontend/src/features/dev-board/workshop/hub-cards.tsx',
    'frontend/src/features/notifications/notifications-sheet.tsx',
    'frontend/src/features/notifications/notifications.js',
    'frontend/src/features/communities/card.tsx',
    'frontend/src/features/nav/tab-bar.tsx',
    'frontend/src/features/nav/rail-communities.tsx',
    'frontend/src/features/home/pinned-communities.tsx',
    'frontend/src/features/review-flow/vote-sheet.tsx',
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /> 99 \?/, `${file} caps through lib/count-cap.ts`);
    assert.doesNotMatch(src, /'99\+'/, `${file} spells no 99+ of its own`);
  }
});
