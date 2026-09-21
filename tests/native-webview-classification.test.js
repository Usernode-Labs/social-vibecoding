const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const head = fs.readFileSync(path.join(__dirname, '../frontend/src/head.html'), 'utf8');
const script = [...head.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((code) => code.includes("classList.add('in-native-webview')"));
assert.ok(script, 'the native/browser classification script must exist');

function classify({ native, search = '', displayMode = 'browser', classes = [],
  mediaAvailable = true, urlAvailable = true } = {}) {
  const result = new Set(classes);
  const window = { location: { search } };
  if (native !== undefined) window.usernode = { isNative: native };
  if (mediaAvailable) {
    window.matchMedia = (query) => ({ matches: query.includes(`(display-mode: ${displayMode})`) });
  }
  vm.runInNewContext(script, {
    window,
    URLSearchParams: urlAvailable ? URLSearchParams : undefined,
    document: { documentElement: { classList: {
      contains: (name) => result.has(name),
      add: (name) => result.add(name),
    } } },
  });
  return [...result].sort();
}

for (const [name, input, expected] of [
  // Native WebViews report browser display mode too. Executing the whole
  // script catches the startup ordering bug that tagged them as both.
  ['native bridge', { native: true }, ['in-native-webview']],
  ['native URL override', { search: '?un-native-webview=1' }, ['in-native-webview']],
  ['existing native marker', { classes: ['in-native-webview'] }, ['in-native-webview']],
  ['browser without a bridge', {}, ['web-browser-chrome']],
  ['browser bridge', { native: false }, ['web-browser-chrome']],
  ['disabled URL override', { search: '?un-native-webview=0' }, ['web-browser-chrome']],
  ['empty URL override', { search: '?un-native-webview' }, ['web-browser-chrome']],
  ['standalone PWA', { displayMode: 'standalone' }, []],
  ['fullscreen', { displayMode: 'fullscreen' }, []],
  ['minimal UI', { displayMode: 'minimal-ui' }, []],
  ['missing matchMedia', { mediaAvailable: false }, []],
  ['native without matchMedia', { native: true, mediaAvailable: false }, ['in-native-webview']],
  ['native without URL API', { native: true, urlAvailable: false }, ['in-native-webview']],
  ['existing theme class', { native: true, classes: ['dark'] }, ['dark', 'in-native-webview']],
]) {
  test(`safe-area classification: ${name}`, () => {
    assert.deepEqual(classify(input), expected);
  });
}
