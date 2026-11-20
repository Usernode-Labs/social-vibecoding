'use strict';

// Artifacts (docs/plans/artifacts.md): ONE policy for every page the bot
// writes, held in one file (src/services/artifact-policy.json) that the
// server and the shell both read. This suite pins:
//
//   1. each mode's sandbox and policy, whole: run, static and helper;
//   2. the safety rules no mode may break: a frame never has both scripts
//      and allow-same-origin; no mode can fetch, post a form or hold a
//      frame; a static page runs nothing; the helper mode runs one script,
//      by its frame's nonce, and nothing without it;
//   3. that the server's module and the shell's build the same text;
//   4. the places that share the constant: a first look's drawn screen, and
//      the Preview of an attached HTML file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const server = require('../src/services/artifact-policy');
const client = loadTsx('frontend/src/features/artifact/policy.ts');

const SITE = 'https://app.onhomeroom.test';
const directivesOf = (csp) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
// What every mode shares: it loads nothing but what it holds (and, for a
// page drawn with this site's look, this site's stylesheets, pictures and
// fonts), and it sends nothing anywhere.
const REST = "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

test('three modes, each pinned whole: its sandbox and its policy', () => {
  assert.deepEqual(server.MODES, ['run', 'static', 'helper']);
  // run: the page's own inline scripts, an origin of its own, nothing else.
  assert.equal(server.sandboxFor('run'), 'allow-scripts', 'scripts and nothing else: no forms, popups, top navigation, modals or downloads');
  assert.equal(server.cspFor('run'),
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'; ${REST}`);
  assert.equal(server.cspFor('run', { site: SITE }),
    `default-src 'none'; style-src 'unsafe-inline' ${SITE}; img-src data: ${SITE}; font-src data: ${SITE}; script-src 'unsafe-inline'; ${REST}`,
    'the design pane\'s policy, as it was before it became everyone\'s');
  // static: nothing at all.
  assert.equal(server.sandboxFor('static'), '');
  assert.equal(server.cspFor('static'),
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; ${REST}`);
  assert.equal(server.cspFor('static', { site: SITE }),
    `default-src 'none'; style-src 'unsafe-inline' ${SITE}; img-src data: ${SITE}; font-src data: ${SITE}; script-src 'none'; ${REST}`);
  // helper: scripts on in the sandbox, and only Homeroom's helper may run, by this frame's nonce.
  assert.equal(server.sandboxFor('helper'), 'allow-scripts');
  assert.equal(server.cspFor('helper', { nonce: 'f00d' }),
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-f00d'; ${REST}`);
  assert.equal(server.cspFor('helper'),
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; ${REST}`,
    'with no nonce, no script runs');
  assert.throws(() => server.sandboxFor('publish'), /no mode publish/);
  assert.throws(() => server.cspFor('publish'), /no mode publish/);
});

test('no frame is ever same-origin with Homeroom, and none can fetch, post a form or hold a frame', () => {
  const sandboxes = [
    ...server.MODES.map((mode) => server.sandboxFor(mode)), server.ATTACHMENT_VIEW_CSP,
    ...server.MODES.map((mode) => server.cspFor(mode, { site: SITE, nonce: 'abc', header: true })),
  ];
  for (const sandbox of sandboxes) assert.doesNotMatch(sandbox, /allow-same-origin/, sandbox);
  // The whole file, so a mode added later is held to it too.
  assert.doesNotMatch(JSON.stringify(server.policy), /allow-same-origin/);
  for (const mode of server.MODES) {
    for (const site of [SITE, null]) {
      const policy = directivesOf(server.cspFor(mode, { site, nonce: 'abc' }));
      assert.deepEqual(policy.get('default-src'), ["'none'"], mode);
      assert.deepEqual(policy.get('connect-src'), ["'none'"], `${mode}: no fetch, socket or beacon`);
      assert.deepEqual(policy.get('form-action'), ["'none'"], `${mode}: no form`);
      assert.deepEqual(policy.get('frame-src'), ["'none'"], `${mode}: no nested frame`);
      assert.deepEqual(policy.get('base-uri'), ["'none'"], mode);
      // A script from an address, never.
      assert.doesNotMatch(policy.get('script-src').join(' '), /https?:|\*|data:|blob:/, mode);
    }
  }
  // A page that draws with this site's look may load it from this site, and
  // nothing from anywhere else; a page that needs none names no origin.
  assert.deepEqual([...new Set(server.cspFor('run', { site: SITE }).match(/https?:\/\/[^\s;]+/g))], [SITE]);
  for (const mode of server.MODES) assert.doesNotMatch(server.cspFor(mode, { nonce: 'abc' }), /https?:|\*|blob:|wss?:/, mode);
});

test('a nonce opens only the helper mode, and cannot widen it', () => {
  assert.equal(server.cspFor('run', { nonce: 'f00d' }), server.cspFor('run'), 'a running page takes no nonce');
  assert.equal(server.cspFor('static', { nonce: 'f00d' }), server.cspFor('static'), 'nor does a static one: nothing runs there');
  const helped = directivesOf(server.cspFor('helper', { nonce: 'f00d' }));
  assert.deepEqual(helped.get('script-src'), ["'nonce-f00d'"], 'no unsafe-inline: a script without the nonce does not run');
  assert.deepEqual(directivesOf(server.cspFor('helper', { nonce: "x' 'unsafe-inline' https://evil.test" })).get('script-src'),
    ["'nonce-xunsafe-inlinehttps//eviltest'"]);
  // An origin cannot smuggle a directive in.
  for (const mode of server.MODES) {
    assert.doesNotMatch(server.cspFor(mode, { site: "https://x.test; script-src 'unsafe-inline'" }), /script-src 'unsafe-inline' /, mode);
  }
  assert.doesNotMatch(server.cspFor('static', { site: "https://x.test; script-src 'unsafe-inline'" }), /'unsafe-inline'; connect/);
});

test('the server and the shell build the same text from the one file', () => {
  for (const mode of server.MODES) {
    for (const options of [{}, { site: SITE }, { nonce: 'abc123' }, { site: SITE, nonce: 'abc123' }]) {
      assert.equal(client.cspFor(mode, options), server.cspFor(mode, options), `${mode} ${JSON.stringify(options)}`);
    }
    assert.equal(client.sandboxFor(mode), server.sandboxFor(mode), mode);
  }
});

test('as a response header the policy carries its sandbox, and the routes share the constant', () => {
  assert.equal(server.cspFor('static', { header: true }),
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; "
    + "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  assert.match(server.cspFor('run', { site: SITE, header: true }), /^sandbox allow-scripts; default-src 'none';/);
  assert.match(server.cspFor('helper', { nonce: 'f00d', header: true }), /^sandbox allow-scripts; default-src 'none';.* script-src 'nonce-f00d';/);
  // A first look's drawn screen is served under it.
  assert.equal(require('../src/services/first-version-screens').DRAWN_CSP, server.cspFor('static', { header: true }));
  // An attached HTML file's Preview keeps its route and its header
  // (tests/chat-attachments-route.test.js and
  // tests/conversation-attachments-route.test.js read the header it sends).
  assert.equal(server.ATTACHMENT_VIEW_CSP, 'sandbox allow-scripts');
});

test('the last two surfaces take their sandbox and policy from the one file: the email viewer helper, the comparison static', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  // An email picture: its thumbnail static, its opened viewer measured by the
  // per-frame helper. Neither names a sandbox of its own.
  const gallery = read('frontend/src/features/messages/bot-cards/gallery.tsx');
  assert.doesNotMatch(gallery, /allow-same-origin|allow-scripts|<iframe|\bsrcDoc=/);
  assert.match(gallery, /<ArtifactFrame\b[\s\S]*?mode="static"/);
  assert.match(gallery, /mode="helper"/);
  // A comparison the bot laid out: drawn in the thread, static.
  const comparison = read('frontend/src/features/messages/bot-cards/thread-comparison.tsx');
  assert.doesNotMatch(comparison, /allow-same-origin|allow-scripts|<iframe|\bsrcDoc=|sandbox=/);
  assert.match(comparison, /<ArtifactFrame\b[\s\S]*?mode="static"/);
  // Their sandboxes and policies are the shared text, whole: the helper runs
  // one script by its nonce and the static frame none at all.
  assert.equal(client.sandboxFor('helper'), server.sandboxFor('helper'));
  assert.equal(client.sandboxFor('static'), server.sandboxFor('static'));
  assert.equal(client.sandboxFor('helper'), 'allow-scripts');
  assert.equal(client.sandboxFor('static'), '');
  assert.deepEqual(directivesOf(server.cspFor('helper', { nonce: 'f00d' })).get('script-src'), ["'nonce-f00d'"]);
  assert.deepEqual(directivesOf(server.cspFor('static')).get('script-src'), ["'none'"]);
  for (const mode of ['helper', 'static']) assert.doesNotMatch(server.cspFor(mode, { nonce: 'f00d' }), /allow-same-origin/);
});
