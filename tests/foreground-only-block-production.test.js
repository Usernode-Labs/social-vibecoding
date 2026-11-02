'use strict';

// A build reporting permissions.backgroundProduction === false produces blocks
// only while it is open, so nobody should be asked for what it no longer has.
// Older builds omit the field and keep the permission rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { message } = require('./lib/platform-i18n');

const settings = read('frontend/src/features/settings/settings.js');
const nativeChrome = read('public/js/native-chrome.js');

test('only a strict false counts, so older builds are unchanged', () => {
  assert.match(settings, /perms\.backgroundProduction === false/);
  assert.match(nativeChrome, /perms\.backgroundProduction === false\) return;/);
});

test('the first-run sheet stops before it reads or records anything else', () => {
  const stop = nativeChrome.indexOf('perms.backgroundProduction === false');
  const producerRead = nativeChrome.indexOf('await NativeChrome._producerStatus()', stop);
  const marked = nativeChrome.indexOf('NativeChrome._markFirstRunDone()', stop);
  assert.ok(stop !== -1 && producerRead > stop && marked > stop);
});

test('Settings hides only the Android rows', () => {
  assert.match(settings, /if \(isAndroid && this\._unForegroundOnly\(\)\) return null;/);
});

test('the note is in the catalog', () => {
  assert.equal(
    message('settings:usernode.blockProduction.foregroundOnly'),
    'For now, your phone produces blocks only while Homeroom is open.',
  );
});
