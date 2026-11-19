'use strict';

// Artifacts, stage 1 (docs/plans/artifacts.md): ONE policy for every page the
// bot writes, held in one file (src/services/artifact-policy.json) that the
// server and the shell both read. This suite pins:
//
//   1. the safety rules no mode may break: a frame never has both scripts
//      and allow-same-origin; a running page can fetch nothing, post no form
//      and hold no frame; a static page runs no script of its own;
//   2. that the server's module and the shell's build the same text;
//   3. the places that share the constant: a first look's drawn screen, and
//      the Preview of an attached HTML file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

const server = require('../src/services/artifact-policy');
const client = loadTsx('frontend/src/features/artifact/policy.ts');

const SITE = 'https://app.onhomeroom.test';
const directivesOf = (csp) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

test('there are two modes, and no frame is ever same-origin with Homeroom', () => {
  assert.deepEqual(server.MODES, ['run', 'static']);
  const sandboxes = [
    server.sandboxFor('run'), server.sandboxFor('static'), server.sandboxFor('static', { helper: true }),
    server.sandboxFor('run', { helper: true }), server.ATTACHMENT_VIEW_CSP,
    server.cspFor('run', { site: SITE, header: true }), server.cspFor('static', { header: true }),
    server.cspFor('static', { nonce: 'abc', header: true }),
  ];
  for (const sandbox of sandboxes) assert.doesNotMatch(sandbox, /allow-same-origin/, sandbox);
  // The whole file, so a mode added later is held to it too.
  assert.doesNotMatch(JSON.stringify(server.policy), /allow-same-origin/);
  assert.equal(server.sandboxFor('run'), 'allow-scripts', 'scripts and nothing else: no forms, popups, top navigation, modals or downloads');
  assert.equal(server.sandboxFor('static'), '', 'nothing at all');
  assert.equal(server.sandboxFor('static', { helper: true }), 'allow-scripts', 'the helper needs scripts on; the policy lets only it run');
  assert.throws(() => server.sandboxFor('publish'), /no mode publish/);
  assert.throws(() => server.cspFor('publish'), /no mode publish/);
});

test('a running page can fetch nothing, post no form and hold no frame', () => {
  for (const site of [SITE, null]) {
    const policy = directivesOf(server.cspFor('run', { site }));
    assert.deepEqual(policy.get('default-src'), ["'none'"]);
    assert.deepEqual(policy.get('connect-src'), ["'none'"], 'no fetch, socket or beacon');
    assert.deepEqual(policy.get('form-action'), ["'none'"], 'no form');
    assert.deepEqual(policy.get('frame-src'), ["'none'"], 'no nested frame');
    assert.deepEqual(policy.get('base-uri'), ["'none'"]);
    assert.deepEqual(policy.get('script-src'), ["'unsafe-inline'"], 'its own inline scripts, and none from any address');
  }
  // A page that draws with this site's stylesheets, pictures and fonts may
  // load those from this site, and nothing from anywhere else.
  const withSite = server.cspFor('run', { site: SITE });
  assert.deepEqual([...new Set(withSite.match(/https?:\/\/[^\s;]+/g))], [SITE]);
  assert.deepEqual(directivesOf(withSite).get('style-src'), ["'unsafe-inline'", SITE]);
  assert.deepEqual(directivesOf(withSite).get('img-src'), ['data:', SITE]);
  assert.deepEqual(directivesOf(withSite).get('font-src'), ['data:', SITE]);
  // A page that needs none of them names no origin: it can load nothing.
  const alone = server.cspFor('run');
  assert.doesNotMatch(alone, /https?:|\*|blob:|wss?:/, 'no address at all');
  assert.equal(alone, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; "
    + "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  // The design pane's policy, as it was before it became everyone's.
  assert.equal(withSite, [
    "default-src 'none'", `style-src 'unsafe-inline' ${SITE}`, `img-src data: ${SITE}`, `font-src data: ${SITE}`,
    "script-src 'unsafe-inline'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
  ].join('; '));
});

test('a static page runs no script of its own; with the helper, only a script carrying this frame\'s nonce', () => {
  const policy = directivesOf(server.cspFor('static', { site: SITE }));
  assert.deepEqual(policy.get('script-src'), ["'none'"]);
  for (const name of ['connect-src', 'frame-src', 'form-action', 'base-uri']) assert.deepEqual(policy.get(name), ["'none'"], name);
  const helped = directivesOf(server.cspFor('static', { nonce: 'f00d' }));
  assert.deepEqual(helped.get('script-src'), ["'nonce-f00d'"], 'no unsafe-inline: a script without the nonce does not run');
  // A nonce cannot widen the policy.
  assert.deepEqual(directivesOf(server.cspFor('static', { nonce: "x' 'unsafe-inline' https://evil.test" })).get('script-src'),
    ["'nonce-xunsafe-inlinehttps//eviltest'"]);
  // A running page takes no nonce: its policy is the run policy, whatever is passed.
  assert.equal(server.cspFor('run', { nonce: 'f00d' }), server.cspFor('run'));
  // An origin cannot smuggle a directive in.
  assert.doesNotMatch(server.cspFor('static', { site: "https://x.test; script-src 'unsafe-inline'" }), /script-src 'unsafe-inline'/);
});

test('the server and the shell build the same text from the one file', () => {
  for (const mode of ['run', 'static']) {
    for (const options of [{}, { site: SITE }, { nonce: 'abc123' }, { site: SITE, nonce: 'abc123' }]) {
      assert.equal(client.cspFor(mode, options), server.cspFor(mode, options), `${mode} ${JSON.stringify(options)}`);
    }
    for (const helper of [false, true]) assert.equal(client.sandboxFor(mode, { helper }), server.sandboxFor(mode, { helper }));
  }
});

test('as a response header the policy carries its sandbox, and the routes share the constant', () => {
  assert.equal(server.cspFor('static', { header: true }),
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; "
    + "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  assert.match(server.cspFor('run', { site: SITE, header: true }), /^sandbox allow-scripts; default-src 'none';/);
  // A first look's drawn screen is served under it.
  assert.equal(require('../src/services/first-version-screens').DRAWN_CSP, server.cspFor('static', { header: true }));
  // An attached HTML file's Preview keeps its route and its header
  // (tests/chat-attachments-route.test.js and
  // tests/conversation-attachments-route.test.js read the header it sends).
  assert.equal(server.ATTACHMENT_VIEW_CSP, 'sandbox allow-scripts');
});
