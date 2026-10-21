// #4789: a demo link opened signed out keeps its demo after signing in.
//
// The sign-in screens keep the address's query (`/?demo=1#login`), but the
// remembered target was written back as `'/' + hash`, so `/?demo=1#app/x/board`
// came back as `/#app/x/board`: no demo flag, so demo-only rows answered not
// found and the screen fell back to Home. deepLinkUrl now builds a fragment
// target with the shell's own address serializer, App._rootUrl.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const AUTH = fs.readFileSync(path.join(ROOT, 'public/js/auth-screens.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

/** app.js's own _routeSearch and _rootUrl, read out of the source. */
function appMethod(name) {
  const start = APP.indexOf(`\n  ${name}(`);
  assert.ok(start > 0, `app.js still defines ${name}`);
  const end = APP.indexOf('\n  },\n', start);
  return APP.slice(start + 1, end + 4);
}

function harness({ search = '', withApp = true } = {}) {
  const location = { search, hash: '', pathname: '/', origin: 'https://homeroom.example' };
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const sandbox = {
    URL, URLSearchParams, console, location,
    setTimeout() { return 0; }, clearTimeout() {},
    history: { replaceState() {} },
    document: {
      addEventListener() {}, getElementById: () => element, querySelector: () => element,
      querySelectorAll: () => [], body: element, documentElement: element,
    },
    addEventListener() {}, localStorage: { getItem() { return null; } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (withApp) {
    vm.runInContext(`var App = { ${appMethod('_routeSearch')}, ${appMethod('_rootUrl')} };`, sandbox);
  }
  vm.runInContext(AUTH, sandbox);
  return sandbox.AuthScreens;
}

test('a fragment target keeps the demo link\'s whole query', () => {
  const auth = harness({ search: '?demo=1&cards=open' });
  assert.equal(auth.deepLinkUrl('#app/x/board'), '/?demo=1&cards=open#app/x/board');
  assert.equal(auth.deepLinkUrl(''), '/?demo=1&cards=open', 'the demo Home keeps it too');
  assert.equal(auth.deepLinkUrl('#login'), '/?demo=1&cards=open#login', 'and so does the password reset\'s Sign in');
});

test('a link without a query lands as it did', () => {
  const auth = harness();
  assert.equal(auth.deepLinkUrl('#app/x'), '/#app/x');
  assert.equal(auth.deepLinkUrl(''), '/');
});

test('app paths and invite links are returned as they are', () => {
  const auth = harness({ search: '?demo=1' });
  assert.equal(auth.deepLinkUrl('/app/x/full?path=%2Fa'), '/app/x/full?path=%2Fa');
  const invite = '/invite/' + 'a'.repeat(22);
  assert.equal(auth.deepLinkUrl(invite), invite);
});

test('the chromeless route\'s own `path` never rides along', () => {
  const auth = harness({ search: '?demo=1&path=%2Finner' });
  assert.equal(auth.deepLinkUrl('#app/x/board'), '/?demo=1#app/x/board');
});

test('with no App, the old addresses', () => {
  const auth = harness({ search: '?demo=1', withApp: false });
  assert.equal(auth.deepLinkUrl('#app/x'), '/#app/x');
  assert.equal(auth.deepLinkUrl(''), '/');
});
