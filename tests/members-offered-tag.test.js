'use strict';

// The Collaborators list of "Members & approvals", for someone who is already
// in the project but has not taken up building it (#7027).
//
// They joined through an invite link or the Join button while an invitation
// to build was still waiting. Nothing waits on them any more, so the tag says
// "offered to build" in muted grey instead of "invited" in amber, and the row
// is no longer faded. Accept and Revoke still work as before: the offer is
// real, and nobody gets build rights without accepting it.
//
// The module is the real frontend/src/features/dialogs/members-controller.js,
// evaluated in a vm with a one-element document, the way the shell's island
// runs it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const SRC = `(function () {\n${
  fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'members-controller.js'),
    'utf8',
  ).replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '')
}\nreturn { init, MembersDialog };\n})()`;

function renderCollaborators(rows) {
  const list = { innerHTML: '', querySelectorAll: () => [] };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    PlatformI18n: englishPlatformI18n(),
    document: {
      getElementById: (id) => (id === 'members-list' ? list : null),
      addEventListener() {},
    },
    window: { AppView: {}, App: { user: { id: 1 } }, PlatformUI: {}, Home: {} },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox).init();
  sandbox.window.AppView.appData = { slug: 'page-turners', can_manage: true };
  sandbox.window.AppView._renderCollaborators(rows);
  return list.innerHTML;
}

test('a pending invite for someone already in the project is tagged "offered to build"', () => {
  const html = renderCollaborators([
    { userId: 2, username: 'kampred', status: 'invited', inCommunity: true },
  ]);
  assert.match(html, />offered to build</);
  assert.equal(message('dialogs:members.collaborators.tag.offered'), 'offered to build');
  assert.doesNotMatch(html, />invited</, 'not a waiting invite');
  assert.doesNotMatch(html, /opacity-70/, 'nothing waits on them, so the row is not faded');
  assert.match(html, /Revoke/, 'the offer can still be revoked');
});

test('a pending invite for someone not in the project reads "invited" and stays faded', () => {
  const html = renderCollaborators([
    { userId: 2, username: 'kampred', status: 'invited', inCommunity: false },
  ]);
  assert.match(html, />invited</);
  assert.match(html, /opacity-70/);
  assert.doesNotMatch(html, /offered to build/);
});

test('a member takes no tag, and a creator keeps theirs', () => {
  const html = renderCollaborators([
    { userId: 1, username: 'alex_t', status: 'member', inCommunity: true, isCreator: true },
    { userId: 2, username: 'priya', status: 'member', inCommunity: true },
  ]);
  assert.match(html, />creator</);
  assert.doesNotMatch(html, /offered to build|>invited</);
});
