// The scaffolded app must announce itself as a starter template (#1373).
//
// A freshly created app used to deploy as a bare "Press!" demo that looked
// like the finished product — nothing on screen said it was placeholder
// content or that tapping Improve is how you build the real app. The
// scaffold ships a template welcome screen: a "Starter template" hero that
// opens with the app's thumbnail tile and the plain-English note on how
// the app gets built — plus a repo README and a CLAUDE.md instruction so
// the coding agent removes the template wholesale when the first real
// feature is built. #4047 dropped the screen's technical sections (the
// "What's already working" list and the "Try the example" Press! counter
// and its demo endpoints): someone who just asked for an app wants its
// face and how it is built, not its plumbing.
//
// The template messaging is wrapped in sentinel comments
// (usernode-starter-notice@1), following the usernode-dev-console@1
// precedent, so agents/tooling can locate and excise the block.
//
// Run with: node --test tests/template-starter-notice.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');
const { message } = require('./lib/platform-i18n');

function files() {
  return getTemplateFiles('My App', 'my-app-123', 'pg://x');
}

function file(list, p) {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
}

test('index.html carries the starter-notice sentinel block around the hero card', () => {
  const html = file(files(), 'public/index.html');

  const open = html.indexOf('<!-- usernode-starter-notice@1');
  const close = html.indexOf('<!-- /usernode-starter-notice@1 -->');
  assert.ok(open !== -1, 'opening sentinel comment present');
  assert.ok(close !== -1, 'closing sentinel comment present');
  assert.ok(open < close, 'sentinels are ordered open → close');

  // Exactly one block: the sentinel name appears once per comment.
  const occurrences = html.match(/usernode-starter-notice@1/g) || [];
  assert.equal(occurrences.length, 2, 'exactly one sentinel pair');

  // The template messaging lives inside the block…
  const block = html.slice(open, close);
  assert.match(block, /Starter template/, 'hero badge names the starter template');
  // #3573: it named the Improve pill, which #2718 retired. It names the
  // Homeroom mark's menu and its row now, by the row's own label.
  // B8: changing it is asking Homeroom bot, through the menu's Suggest an improvement.
  assert.match(block, /To change this app, ask Homeroom bot: tap the <strong[^>]*>Homeroom icon<\/strong>, then <strong[^>]*>Suggest an improvement<\/strong>\./,
    'hero copy names the Homeroom icon and its Suggest an improvement button');
  assert.doesNotMatch(block, /Improve/, 'no Improve button to point at any more');
  // #4047: the technical explainer is gone.
  assert.doesNotMatch(block, /What's already working/, 'no "What\'s already working" list in the hero');
  // #1418: the welcome copy is product-focused — it describes the outcome,
  // never the AI that produces it.
  assert.ok(!block.includes('Claude'), 'welcome copy does not name Claude');

  // #4047: the whole example card and its demo script are gone with it.
  assert.doesNotMatch(html, /Try the example/, 'no example card any more');
  assert.doesNotMatch(html, /This example will be replaced/, 'no will-be-replaced tag any more');
  // The thumbnail tile opens the hero card, inside the sentinel block.
  assert.match(block, /<div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ground text-title">/,
    'the hero card opens with the thumbnail tile');
});

test('the Press! demo is gone from the scaffold entirely', () => {
  const html = file(files(), 'public/index.html');
  const server = file(files(), 'server.js');

  // #4047: the demo ids, its script and its endpoints no longer ship.
  for (const id of ['press-btn', 'count', 'leaderboard']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `no element with id="${id}"`);
  }
  assert.doesNotMatch(html, /<script>\s*\n\s*const params/, 'no inline demo script in the body');
  assert.ok(!html.includes('fetch('), 'the static screen fetches nothing');
  assert.doesNotMatch(server, /\/api\/press|\/api\/leaderboard|presses/, 'server.js carries no demo endpoints or table');
});

test('the thumbnail tile falls back to the name when no icon is known', () => {
  const html = file(files(), 'public/index.html');
  assert.match(html, /text-title"><span class="text-muted">M<\/span><\/div>/,
    'no emoji: the tile shows the first letter, muted, like the home tile');
  // No emoji to show, so dapp.json stays without an icon block, exactly as
  // it always was.
  assert.deepEqual(JSON.parse(file(files(), 'dapp.json')), { secrets: [] });

  // The repo heal's emoji (#4047): the tile shows it, and dapp.json's icon
  // block carries the same emoji, so the first deploy's icon reconcile
  // (app-manifest reconcileAppIcon) keeps the icon the app already had
  // instead of clearing it from a manifest without one.
  const withEmojiFiles = getTemplateFiles('My App', 'my-app-123', 'pg://x', null, { iconEmoji: '🏃' });
  const withEmoji = withEmojiFiles.find((f) => f.path === 'public/index.html').content;
  assert.match(withEmoji, /text-title">🏃<\/div>/, 'an emoji icon fills the tile itself');
  assert.deepEqual(JSON.parse(withEmojiFiles.find((f) => f.path === 'dapp.json').content),
    { icon: { emoji: '🏃' }, secrets: [] },
    'the caller emoji stands in dapp.json so the deploy keeps it');
});

test('the scaffold ships a README that names the app and the template state', () => {
  const readme = file(files(), 'README.md');
  assert.match(readme, /^# My App/m, 'README titled with the app name');
  assert.match(readme, /Starter template/, 'README states this is the starter template');
  // #3573: Start a new change in the Homeroom mark's menu, not the retired
  // Improve pill (#2718).
  assert.match(readme, /To change this app, ask Homeroom bot: open the app on Homeroom, tap the\nHomeroom icon in the header, then \*\*Suggest an improvement\*\*, and describe\nthe app you want/,
    'README says asking Homeroom bot is how to replace it');
  assert.doesNotMatch(readme, /Improve/);
  assert.match(readme, /rewrite this README/i,
    'README instructs its own rewrite once the real app exists');
  // #4047: the demo's presses table is not shipped, so it is not described.
  assert.doesNotMatch(readme, /presses|Live API/, 'README carries no Press! demo leftovers');
  // #1418: the product promise never names Claude as the actor. "Claude Code"
  // (the developer tool) and the CLAUDE.md filename are the only sanctioned
  // mentions, so a bare "Claude" not followed by " Code" is a regression.
  assert.ok(!/Claude(?! Code)/.test(readme),
    'README mentions Claude only as the "Claude Code" tool name');
});

// #3573: the starter page and README send a new app's creator to a control
// by name, so the names are the platform's own. If the row or the mark is
// renamed, the template's copy has to follow it (new repos only; existing
// apps keep the copy they were scaffolded with).
test('the starter copy names the row the Homeroom mark\'s menu really has', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // B8: the menu leads with Suggest an improvement. #4729 took the menu's
  // Build it now row to Messages (the Agents list, the "+" there), so the
  // copy's one named row is the one the menu still has.
  assert.match(read('frontend/src/features/improve/actions.tsx'), /id="improve-row-feedback"\s+label=\{t\('agent:menu\.suggestImprovement'\)\}/,
    'the menu still has Suggest an improvement');
  assert.doesNotMatch(sheet, /improve-row-new-session/, 'and no Build it now row any more');
  assert.match(read('frontend/src/features/header/platform-mark.tsx'), /aria-label=\{t\('core:header\.homeroomMenu'\)\}/);
  assert.equal(message('core:header.homeroomMenu'), 'Homeroom menu', 'the header control is still the Homeroom mark');
});

test('CLAUDE.md instructs the agent to remove the template wholesale', () => {
  const claude = file(files(), 'CLAUDE.md');
  assert.match(claude, /usernode-starter-notice@1/, 'names the sentinel');
  assert.match(claude, /REPLACE the template/i, 'instructs replacement, not accretion');
  assert.match(claude, /usernode-dev-console@1/,
    'reminds the agent to keep the dev-console forwarder');
});
