'use strict';

// #6598: a shots run that could not start because GitHub did not answer says
// so in plain words, never with GitHub's own error page. These evaluate the
// change page's real sentence builder (public/js/app-view.js `_shotsSentence`)
// against the English catalogs, so the words a person reads are what is
// checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const APP_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8');

function sentence(shots, state, opts = {}) {
  const start = APP_VIEW.indexOf('  _shotsSentence(shots, state, { notStarted, running }) {');
  const end = APP_VIEW.indexOf('\n  // The change page\'s reading of a proposal\'s before/after shots');
  assert.ok(start > 0 && end > start, '_shotsSentence is in app-view.js');
  const source = `AppView = { ${APP_VIEW.slice(start, end)} };`;
  const sandbox = { AppView: null, PlatformI18n: englishPlatformI18n() };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return vm.runInContext(`AppView._shotsSentence(${JSON.stringify(shots)}, ${JSON.stringify(state)}, ${JSON.stringify(opts)})`, sandbox);
}

const GITHUB = {
  state: 'failed',
  failureCode: 'github_unavailable',
  failureReason: 'Cannot bootstrap worker for owner/repo: No server is currently available to service your request.',
  automaticRetryPending: true,
};

test('a shots run GitHub did not answer says it tries again, not GitHub\'s error page', () => {
  const said = sentence(GITHUB, 'failed', { notStarted: false, running: false });
  assert.equal(said, message('changes:shots.sentence.retryingGithub'));
  assert.equal(said, 'Couldn’t take the screenshots: GitHub didn’t answer. Trying again in a few minutes.');
  assert.doesNotMatch(said, /No server is currently available|Cannot bootstrap worker/);
});

test('with no retry pending it asks the person to take them again in a few minutes', () => {
  const said = sentence({ ...GITHUB, automaticRetryPending: false }, 'failed', { notStarted: false, running: false });
  assert.equal(said, message('changes:shots.sentence.githubDown'));
  assert.match(said, /Take them again in a few minutes/);
  assert.doesNotMatch(said, /No server is currently available|Cannot bootstrap worker/);
});

test('every other failed run still quotes the reason it recorded', () => {
  const said = sentence({ state: 'failed', failureCode: 'shots_capture_incomplete', failureReason: 'A change could not be reached.' },
    'failed', { notStarted: false, running: false });
  assert.equal(said, 'Couldn’t take the screenshots. A change could not be reached.');
});
