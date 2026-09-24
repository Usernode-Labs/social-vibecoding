const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const frontend = path.join(__dirname, '..', 'frontend');
const react = require(require.resolve('react', { paths: [frontend] }));
const server = require(require.resolve('react-dom/server', { paths: [frontend] }));
const jsx = require(require.resolve('react/jsx-runtime', { paths: [frontend] }));
const source = fs.readFileSync(
  path.join(frontend, 'src/features/auth/native-login-details.tsx'), 'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const moduleForTest = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleForTest,
  exports: moduleForTest.exports,
  require(specifier) {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsx;
    if (specifier === '@/components/ui/button' ||
        specifier === '@/components/ui/dialog') return {};
    throw new Error(`Unexpected import: ${specifier}`);
  },
});
const { NativeLoginDetailsLink, nativeLoginDetailsText } = moduleForTest.exports;

const details = {
  stage: 'prepare-login',
  code: null,
  kind: 'privileged-unavailable',
  nativeMessage: 'Privileged bridge is unavailable for this main frame',
  bridgeState: 'blocked-frame',
  pageOrigin: 'https://app.onhomeroom.com',
  appVersion: '1.0.0',
  buildNumber: '1223',
  bridgeVersion: 5,
};

test('a native login failure offers details without opening a dialog on first paint', () => {
  const empty = server.renderToStaticMarkup(
    react.createElement(NativeLoginDetailsLink, { details: null })
  );
  assert.equal(empty, '');

  const ready = server.renderToStaticMarkup(
    react.createElement(NativeLoginDetailsLink, { details })
  );
  assert.match(ready, /More details/);
  assert.doesNotMatch(ready, /<dialog/);
  assert.doesNotMatch(ready, /Privileged bridge is unavailable/);
});

test('copyable report contains the native refusal and only the page origin', () => {
  const text = nativeLoginDetailsText(details);
  assert.match(text, /Bridge kind: privileged-unavailable/);
  assert.match(text, /Native message: Privileged bridge is unavailable for this main frame/);
  assert.match(text, /Page origin: https:\/\/app.onhomeroom.com/);
  assert.doesNotMatch(text, /password|username|cookie|capability/i);
});
