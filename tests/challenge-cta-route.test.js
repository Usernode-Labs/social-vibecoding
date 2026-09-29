// A challenge CTA that points INSIDE the shell is a route, not a new tab
// (#2893).
//
// WHAT THIS PINS. The "Help run the network" challenge's "Open block
// production settings" button landed on the Settings root. Its link was drawn
// as target="_blank": in a browser that cold-boots a second document, and in
// the Homeroom app the tap is handed to the system browser, which has no
// native bridge and so no Settings › Homeroom app (where block production is
// asked for) to land on. ctaView now turns an in-app destination into
// `kind: 'route'` — a bare fragment the pane renders without target — and
// aims a block-production challenge's bare-Settings link at the section that
// holds block production.
//
// Behavioural: the shipped topochain-challenges.js runs in a vm (the module is
// import-free on purpose, see tests/challenge-deep-link.test.js), and the
// pane's Cta is rendered through the real component.
//
// Run with: node --test tests/challenge-cta-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');

const ORIGIN = 'https://my.onhomeroom.com';

function loadModule(origin = ORIGIN) {
  const sandbox = {
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    URL,
    location: {
      hash: '#leaderboard/challenges/1/2', search: '', origin, hostname: new URL(origin).hostname,
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });
  return sandbox.window.TopochainChallenges;
}

const TC = loadModule();
// Plain objects: the vm's are from another realm, which deepEqual rejects.
const cta = (link, challenge) => {
  const v = TC.ctaView({ cta_label: 'Open block production settings', cta_link: link }, challenge);
  return v && JSON.parse(JSON.stringify(v));
};

const BLOCKS = {
  id: 7,
  metric: { kind: 'blocks_produced', target: 1, label: 'blocks' },
  card_preview: { goal: 'Help run the network' },
};
const SHARE = { id: 8, metric: null, card_preview: { goal: 'Share the post' } };

test('an in-app link is a same-document route to its fragment', () => {
  for (const link of [
    '#settings/usernode',
    '/#settings/usernode',
    `${ORIGIN}/#settings/usernode`,
    `${ORIGIN}/#settings/usernode/`,
  ]) {
    assert.deepEqual(cta(link, SHARE),
      { kind: 'route', href: '#settings/usernode', label: 'Open block production settings' },
      `${link} routes in place`);
  }
  assert.equal(cta('#settings/usernode?x=1', SHARE).href, '#settings/usernode?x=1',
    'a hash query rides along');
});

test('a block-production challenge aimed at bare Settings lands on its section', () => {
  for (const link of ['#settings', '#settings/', '/#settings', `${ORIGIN}/#settings`]) {
    assert.deepEqual(cta(link, BLOCKS),
      { kind: 'route', href: '#settings/usernode', label: 'Open block production settings' },
      `${link} on a blocks_produced challenge opens Settings › Homeroom app`);
  }
  assert.equal(TC.BLOCK_PRODUCTION_ROUTE, '#settings/usernode');
  // The template's metric and the artwork identify it too.
  assert.equal(cta('#settings', { activity_type: { metric_type: 'blocks_produced' } }).href,
    '#settings/usernode');
  assert.equal(cta('#settings', { card_preview: { illustration: 'block-production' } }).href,
    '#settings/usernode');
  // An organiser who named a section keeps it.
  assert.equal(cta('#settings/alerts', BLOCKS).href, '#settings/alerts');
  // Any other challenge's bare Settings link is left alone.
  assert.equal(cta('#settings', SHARE).href, '#settings');
  assert.equal(cta('#settings', undefined).href, '#settings');
});

test('everything else keeps the external-link and scheme-guard behaviour', () => {
  assert.deepEqual(cta('https://example.com/node', BLOCKS),
    { kind: 'link', href: 'https://example.com/node', label: 'Open block production settings' });
  // Another origin, even with a fragment, is external.
  assert.equal(cta('https://example.com/#settings', BLOCKS).kind, 'link');
  // Our origin but a path or query of its own is not a bare hash route.
  assert.equal(cta(`${ORIGIN}/app/foo#settings`, BLOCKS).kind, 'link');
  assert.equal(cta(`${ORIGIN}/?demo=1#settings`, BLOCKS).kind, 'link');
  // Nothing that is not a route shape becomes an href.
  for (const bad of ['javascript:alert(1)', '#settings"><img', '#Settings', '#', 'settings/usernode']) {
    assert.deepEqual(cta(bad, BLOCKS), { kind: 'text', label: 'Open block production settings' },
      `${bad} renders as plain text`);
  }
  assert.equal(TC.ctaView({ cta_label: 'Go' }, BLOCKS), null, 'no link, no CTA');
});

test('the pane renders a route in place and an external link in a new tab', () => {
  const Pane = loadTsx('frontend/src/features/leaderboard/challenges-pane.tsx');
  const base = {
    key: '7', eyebrow: null, goal: 'Help run the network', deadline: null, amount: null,
    task: null, illustration: null, illustrationTone: null, state: 'new', stateLabel: 'Not started',
    fill: 0, counted: false, description: null, requirements: null, scoring: null,
    participants: 'Participants', pointsTotal: null, moreLabel: 'Show more →',
    entries: { kind: 'empty' },
  };
  const render = (c) => renderToHtml(createElement(Pane.DetailPage, { view: { ...base, cta: c } }));

  const routeHtml = render({ kind: 'route', href: '#settings/usernode', label: 'Open block production settings' });
  const anchor = routeHtml.match(/<a [^>]*>Open block production settings<\/a>/);
  assert.ok(anchor, 'the route is a real anchor');
  assert.match(anchor[0], /^<a href="#settings\/usernode" class="flex h-12 w-full/);
  assert.doesNotMatch(anchor[0], /target=|rel=/, 'no new tab, no system browser');

  const linkHtml = render({ kind: 'link', href: 'https://example.com/node', label: 'Set up' });
  assert.match(linkHtml, /<a href="https:\/\/example\.com\/node" target="_blank" rel="noopener" class="flex h-12 w-full/);
});

test('CTA data written for my.onhomeroom.com still routes in place on app.onhomeroom.com', () => {
  const App = loadModule('https://app.onhomeroom.com');
  const ctaOn = (link, challenge) => {
    const v = App.ctaView({ cta_label: 'Go', cta_link: link }, challenge);
    return v && JSON.parse(JSON.stringify(v));
  };
  assert.deepEqual(ctaOn('https://my.onhomeroom.com/#settings', SHARE),
    { kind: 'route', href: '#settings', label: 'Go' }, 'the pre-move host is the shell');
  assert.deepEqual(ctaOn('https://my.onhomeroom.com/#settings', BLOCKS),
    { kind: 'route', href: '#settings/usernode', label: 'Go' },
    'and a block-production challenge still lands on its section');
  assert.equal(ctaOn('https://my.onhomeroom.com/#settings/connectors', SHARE).href, '#settings/connectors');
  assert.equal(ctaOn('https://app.onhomeroom.com/#apps', SHARE).href, '#apps', 'this host too');
  // The marketing site is not the shell, and a path is not a bare route.
  assert.equal(ctaOn('https://onhomeroom.com/#settings', BLOCKS).kind, 'link');
  assert.equal(ctaOn('https://my.onhomeroom.com/foo#x', BLOCKS).kind, 'link');
  assert.equal(ctaOn('https://my.onhomeroom.com/?a=1#settings', BLOCKS).kind, 'link');
  assert.equal(ctaOn('http://my.onhomeroom.com/#settings', BLOCKS).kind, 'link',
    'a listed host counts only over https');
});
