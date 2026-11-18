'use strict';

// worker/sync-parse-check.js: a JSON file the merge touched must not define a
// key twice, and a merge that touched the language catalogs must leave them
// valid (#6829). JSON.parse accepts both keys, keeping the last, which is how
// a conflict resolution that kept both sides of en/home.json was pushed and
// broke every preview build.
//
// Each test runs a copy of the script from its own workspace, as
// sync-parse-check-binary.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT_SOURCE = fs.readFileSync(path.join(ROOT, 'worker', 'sync-parse-check.js'), 'utf8');
const LANGUAGE_PACKS_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'language-packs.js'), 'utf8');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-parse-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'worker'));
  fs.writeFileSync(path.join(dir, 'worker', 'sync-parse-check.js'), SCRIPT_SOURCE);
  return dir;
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function run(cwd, files) {
  const out = spawnSync(process.execPath, [path.join(cwd, 'worker', 'sync-parse-check.js'), ...files], {
    cwd,
    encoding: 'utf8',
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test('a key defined twice at the top level fails at its second definition', (t) => {
  const dir = workspace(t);
  write(dir, 'dup.json', '{\n  "a": 1,\n  "b": 2,\n  "a": 3\n}\n');
  const out = run(dir, ['dup.json']);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'dup.json:4:3: key "a" defined more than once\n');
});

test('a duplicate inside a nested object fails at its own line', (t) => {
  const dir = workspace(t);
  write(dir, 'nested.json', '{\n  "outer": {\n    "x": 1,\n    "x": 2\n  }\n}\n');
  const out = run(dir, ['nested.json']);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'nested.json:4:5: key "x" defined more than once\n');
});

test('the same key in two sibling objects, and in objects inside an array, passes', (t) => {
  const dir = workspace(t);
  write(dir, 'siblings.json', '{\n  "one": { "k": 1 },\n  "two": { "k": 2 },\n  "list": [ { "k": 3 }, { "k": 4 } ]\n}\n');
  const out = run(dir, ['siblings.json']);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('an escaped key equal to another key is a duplicate', (t) => {
  const dir = workspace(t);
  write(dir, 'escaped.json', '{\n  "a": 1,\n  "\\u0061": 2\n}\n');
  const out = run(dir, ['escaped.json']);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'escaped.json:3:3: key "a" defined more than once\n');
});

test('invalid JSON still reports its syntax error', (t) => {
  const dir = workspace(t);
  write(dir, 'broken.json', '{\n  "a": },\n}\n');
  const out = run(dir, ['broken.json']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^broken\.json:\d+:\d+: /);
  assert.doesNotMatch(out.stdout, /defined more than once/);
});

test('a catalog error is reported against the file it names', (t) => {
  const dir = workspace(t);
  write(dir, 'frontend/locales/en/home.json', '{"k":"v"}\n');
  write(dir, 'scripts/language-packs.js', `module.exports = { collectCatalogs() {
  throw new Error('The English source catalogs need fixing:\\n'
    + 'en/home:communities.members_one: defined more than once in en/home.json; only the last would show');
} };\n`);
  const out = run(dir, ['frontend/locales/en/home.json']);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'frontend/locales/en/home.json:1:1: en/home:communities.members_one: '
    + 'defined more than once in en/home.json; only the last would show\n');
});

test('the catalog pass does not run when nothing under frontend/locales/ was touched', (t) => {
  const dir = workspace(t);
  write(dir, 'plain.json', '{"k":"v"}\n');
  write(dir, 'scripts/language-packs.js', `const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(__dirname, '..', 'called.txt'), 'yes');
module.exports = { collectCatalogs() { throw new Error('should not run'); } };\n`);
  const out = run(dir, ['plain.json']);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  assert.equal(fs.existsSync(path.join(dir, 'called.txt')), false);
});

test('without scripts/language-packs.js a locales file is checked for JSON alone', (t) => {
  const dir = workspace(t);
  write(dir, 'frontend/locales/en/home.json', '{"k":"v"}\n');
  const out = run(dir, ['frontend/locales/en/home.json']);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('the real collectCatalogs catches a duplicated catalog key', (t) => {
  const dir = workspace(t);
  write(dir, 'scripts/language-packs.js', LANGUAGE_PACKS_SOURCE);
  write(dir, 'frontend/locales/config.json', JSON.stringify({ sourceLanguage: 'en', languages: { en: 'English' } }) + '\n');
  write(dir, 'frontend/locales/en/home.json', `{
  "home.one": { "text": "One", "description": "Home's first row" },
  "home.one": { "text": "Two", "description": "Home's first row" }
}
`);
  const out = run(dir, ['frontend/locales/en/home.json']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^frontend\/locales\/en\/home\.json:3:3: key "home\.one" defined more than once$/m);
  assert.match(out.stdout, /^frontend\/locales\/en\/home\.json:1:1: en\/home:home\.one: defined more than once in en\/home\.json; only the last would show$/m);
});
