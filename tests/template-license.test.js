// Every new app's repository is created with an MIT LICENSE (#5120,
// compliance plan X-07): every change merged into an app, by a person or a
// bot, comes in under MIT, and Usernode claims no ownership of app code, so
// the copyright line names the app's contributors. One template writes every
// create, the empty one, each starter and the repo heal alike, so each of
// them is asserted here.
//
// Run with: node --test tests/template-license.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');
const appTemplates = require('../src/services/app-templates');

function license(files) {
  const found = files.filter((f) => f.path === 'LICENSE');
  assert.equal(found.length, 1, 'the template writes exactly one LICENSE');
  return found[0].content;
}

test('a new app gets the MIT licence in the contributors\' name', () => {
  const text = license(getTemplateFiles('Potluck Club', 'potluck-club-1a2b', 'pg://x'));
  assert.match(text, /^MIT License\n\nCopyright \(c\) The Potluck Club contributors\n/);
  assert.match(text, /Permission is hereby granted, free of charge, to any person obtaining a copy/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.doesNotMatch(text, /Usernode/, 'Usernode claims no ownership of app code');
});

test('the licence carries no year, so the same create writes the same file', () => {
  const text = license(getTemplateFiles('Potluck Club', 'potluck-club-1a2b', 'pg://x'));
  assert.doesNotMatch(text, /\b(19|20)\d\d\b/);
});

test('every starter keeps the licence', () => {
  for (const id of appTemplates.TEMPLATE_IDS) {
    const text = license(getTemplateFiles('Starter App', 'starter-app-1a2b', 'pg://x', null, { template: id }));
    assert.match(text, /^MIT License\n\nCopyright \(c\) The Starter App contributors\n/, `${id} starter`);
  }
});
