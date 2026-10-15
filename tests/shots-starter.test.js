'use strict';

// A project's first version has no before to shoot: its before build is the
// starter template's placeholder (services/shots-starter.js). Before this,
// every before shot of such a proposal was the placeholder, and the shots
// agent spent half its turn taking it (proposals 7608, 7871 and 7610).
//
// Run with: node --test tests/shots-starter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const starter = require('../src/services/shots-starter');
const { getTemplateFiles } = require('../src/services/template');
const appTemplates = require('../src/services/app-templates');

function checkoutWith(t, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-starter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (html != null) {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'index.html'), html);
  }
  return dir;
}

function page(files) {
  return files.find((file) => file.path === 'public/index.html').content;
}

const placeholder = () => page(getTemplateFiles('My App', 'my-app-123', 'pg://x'));
const firstVersion = '<!doctype html><html><body><main><h1>Find a playmate</h1></main></body></html>';

test('the starter the platform scaffolds is recognised by its own sentinel', async (t) => {
  assert.equal(await starter.carriesStarter(checkoutWith(t, placeholder())), true);
  // Its words on the screen are not what is read: a first version that says
  // "Starter template" somewhere is still a first version.
  assert.equal(await starter.carriesStarter(checkoutWith(t,
    '<main><span>Starter template</span><p>Welcome to your new app!</p></main>')), false);
  assert.equal(await starter.carriesStarter(checkoutWith(t, firstVersion)), false);
});

test('a ready-made or game starter is a working app, so its first version keeps a real before', async (t) => {
  for (const id of appTemplates.TEMPLATE_IDS.filter((value) => value !== appTemplates.DEFAULT_TEMPLATE)) {
    const html = page(getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', null, { template: id }));
    assert.equal(await starter.carriesStarter(checkoutWith(t, html)), false, `${id} carries no placeholder sentinel`);
  }
});

test('the before is the starter only when the after replaces it', async (t) => {
  const pair = (before, after) => ({
    sides: { base: { checkout: checkoutWith(t, before) }, head: { checkout: checkoutWith(t, after) } },
  });
  assert.equal(await starter.beforeIsStarter(pair(placeholder(), firstVersion)), true);
  // A change to the starter screen itself (its name, say) has a real before.
  assert.equal(await starter.beforeIsStarter(pair(placeholder(), placeholder().replace('My App', 'Our App'))), false);
  // An ordinary later change.
  assert.equal(await starter.beforeIsStarter(pair(firstVersion, firstVersion)), false);
  // No page on either side, or no checkout at all, reads as no.
  assert.equal(await starter.beforeIsStarter(pair(null, firstVersion)), false);
  assert.equal(await starter.beforeIsStarter({ sides: { base: {}, head: {} } }), false);
  assert.equal(await starter.beforeIsStarter(null), false);
});

test('only a regular file is read, so a symlink in the repository under test leads nowhere', async (t) => {
  const elsewhere = checkoutWith(t, placeholder());
  const dir = checkoutWith(t, null);
  fs.mkdirSync(path.join(dir, 'public'));
  fs.symlinkSync(path.join(elsewhere, 'public', 'index.html'), path.join(dir, 'public', 'index.html'));
  assert.equal(await starter.carriesStarter(dir), false);
  assert.equal(await starter.carriesStarter(''), false);
  assert.equal(await starter.carriesStarter(path.join(dir, 'missing')), false);
});
