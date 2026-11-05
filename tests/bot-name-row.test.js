'use strict';

// #4942: the Bot's name row and its dialog, in the shell's own sources.
//
// Run with: node --test tests/bot-name-row.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MENU = read('frontend/src/features/dev-board/actions-row.tsx');
const DIALOG = read('frontend/src/features/dialogs/bot-name.tsx');

test('the row sits between the display name and Topics, and opens the dialog', () => {
  const rename = MENU.indexOf('data-plus="rename"');
  const row = MENU.indexOf('data-plus="bot-name"');
  const topics = MENU.indexOf('data-plus="topics"');
  assert.ok(rename !== -1 && rename < row && row < topics);
  const body = MENU.slice(row, topics);
  assert.match(body, /<SparklesIcon className=\{PLUS_ICON_CLS\}/);
  assert.match(body, /_closePlusMenu[\s\S]*dialogs\?\.botName\?\.open\(/);
  assert.equal(message('project:menu.botName.title'), "Bot's name");
  assert.equal(message('project:menu.botName.sub'), 'What Homeroom bot calls itself here');
});

test('the dialog posts the proposal, shows the server\'s sentence, and never says PR or dapp.json', () => {
  assert.match(DIALOG, /useDialog<\{ slug\?: string \}>\('botName'/);
  assert.match(DIALOG, /\/bot-name-pr`/);
  assert.match(DIALOG, /setError\(data\.error \|\| t\('dialogs:botName\.error\.failed'\)\)/);
  assert.match(DIALOG, /maxLength=\{MAX_BOT_NAME_LENGTH\}/);
  assert.doesNotMatch(DIALOG, /\bvalue=\{/, 'the field stays uncontrolled');
  assert.equal(message('dialogs:botName.submit'), 'Propose this name');
  for (const id of ['title', 'label', 'hint', 'submit']) {
    assert.doesNotMatch(message(`dialogs:botName.${id}`), /\bPR\b|dapp\.json/);
  }
  assert.match(message('dialogs:botName.hint'), /@homeroom_bot/);
});

test('the client\'s length is the server\'s', () => {
  const { MAX_BOT_NAME_LENGTH } = require('../src/services/app-manifest');
  assert.match(DIALOG, new RegExp(`const MAX_BOT_NAME_LENGTH = ${MAX_BOT_NAME_LENGTH};`));
});
