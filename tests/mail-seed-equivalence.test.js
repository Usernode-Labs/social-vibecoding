'use strict';

// src/db/email-template-seeds.js, src/services/mail/render.js: the seeded
// templates render what the hard-coded ones they replaced rendered, byte for
// byte, across every branch. Those templates are gone (src/services/mail/
// templates.js has none since the stored templates took over), so the proof is
// against a snapshot of their output taken just before they were deleted:
// tests/fixtures/mail-snapshot-english.json holds one hash per payload of
// tests/lib/mail-matrix.js, English and tracked, and mail-snapshot-samples.json
// whole messages for each action's sample payload and for a value with an
// apostrophe. A payload is never narrowed and the snapshot is never retaken: a
// difference is either a bug or an entry in the "accepted differences" tests.
//
// The seeds are what a fresh database starts from, and what a process with no
// database renders with (buildMessage without `payload.resolved`).

// The snapshot was taken with the production origin in its links.
delete process.env.USERNODE_DOMAIN;

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMessage, KINDS } = require('../src/services/mail/templates');
const tracking = require('../src/services/mail/tracking');
const { ACTIONS } = require('../src/services/mail/actions');
const { renderMessage } = require('../src/services/mail/render');
const { parse, placeholdersIn } = require('../src/services/mail/template-language');
const { SEEDS, englishTemplate, seededLayout } = require('../src/db/email-template-seeds');
const {
  MATRIX, WITH_APOSTROPHE, TRACKING_SECRET, TRACKED, URL_PLAIN, UNSUBSCRIBE, BROKEN, digest, matrixHash,
} = require('./lib/mail-matrix');

const SNAPSHOT = require('./fixtures/mail-snapshot-english.json');
const SAMPLES = require('./fixtures/mail-snapshot-samples.json');

test('the matrix is the one the snapshot was taken with, and names every kind', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...KINDS].sort());
  assert.equal(matrixHash(), SNAPSHOT.matrix, 'tests/lib/mail-matrix.js changed: the snapshot cannot be retaken');
  assert.ok(!JSON.stringify(MATRIX).includes("'"));
  const rows = Object.values(MATRIX).reduce((n, list) => n + list.length, 0);
  assert.equal(rows, SNAPSHOT.rows);
  assert.ok(rows > 1000);
});

test('the matrix takes every conditional of every seed both ways', () => {
  const on = (value) => !(value === undefined || value === null || value === false || value === '');
  for (const kind of KINDS) {
    const template = englishTemplate(kind);
    for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
      const seen = new Map();
      const walk = (nodes, values, path) => nodes.forEach((node, index) => {
        if (node.type !== 'if' && node.type !== 'unless') return;
        const where = `${path}/${index}:${node.name}`;
        const taken = on(values[node.name]) === (node.type === 'if');
        seen.set(where, (seen.get(where) || new Set()).add(taken));
        walk(taken ? node.then : node.else, values, where);
      });
      const { nodes } = parse(template[field]);
      for (const row of MATRIX[kind]) walk(nodes, ACTIONS[kind].values(row), '');
      for (const [where, ways] of seen) assert.equal(ways.size, 2, `${kind}.${field} ${where}`);
    }
  }
});

// ── What the seeds produce ───────────────────────────────────────────────

function viaSeeds(kind, payload) {
  const template = englishTemplate(kind);
  const layout = template.layout ? seededLayout(template.layout) : null;
  const attributed = tracking.attributedPayload(kind, payload);
  const { why, preheader, headers, ...message } = renderMessage(kind, { template, layout }, attributed); // eslint-disable-line no-unused-vars
  return tracking.decorate(kind, { ...message, ...(headers ? { headers } : {}) }, payload);
}

function assertMatrix(hashes, render, extra = {}) {
  let compared = 0;
  for (const kind of KINDS) {
    const want = hashes[kind];
    assert.equal(want.length, MATRIX[kind].length * 8, kind);
    MATRIX[kind].forEach((row, i) => {
      assert.equal(digest(render(kind, { ...row, ...extra })), want.slice(i * 8, i * 8 + 8), `${kind} row ${i} ${JSON.stringify(row)}`);
      compared += 1;
    });
  }
  return compared;
}

function tracked(t) {
  const before = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = TRACKING_SECRET;
  t.after(() => {
    if (before === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
    else process.env.PLATFORM_MAIL_TRACKING_SECRET = before;
  });
}

test('English: seeded mail is byte-identical to the snapshot', () => {
  assert.equal(assertMatrix(SNAPSHOT.english, viaSeeds), SNAPSHOT.rows);
});

test('tracking on: links, pixel, attributed unsubscribe and headers match the snapshot', (t) => {
  tracked(t);
  assertMatrix(SNAPSHOT.tracked, viaSeeds, TRACKED);
  const message = viaSeeds('build_ready', { appName: 'Run Club', unsubscribeUrl: UNSUBSCRIBE, ...TRACKED });
  assert.ok(message.trackingLinks.length > 0);
  assert.match(message.headers['List-Unsubscribe'], /[?&]m=a{48}/);
});

test('with no stored template in hand, buildMessage renders the seeds', (t) => {
  assertMatrix(SNAPSHOT.english, buildMessage);
  tracked(t);
  assertMatrix(SNAPSHOT.tracked, buildMessage, TRACKED);
});

test('each action\'s sample payload renders the snapshot\'s whole message', () => {
  for (const kind of KINDS) {
    assert.deepEqual(viaSeeds(kind, ACTIONS[kind].sample), SAMPLES.samples[kind], kind);
    assert.deepEqual(buildMessage(kind, ACTIONS[kind].sample), SAMPLES.samples[kind], kind);
  }
});

// ── The seeds themselves ─────────────────────────────────────────────────

test('every kind has a seed that uses only declared placeholders and carries what is required', () => {
  assert.deepEqual(Object.keys(SEEDS.templates).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    const action = ACTIONS[kind];
    const template = englishTemplate(kind);
    for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
      for (const name of placeholdersIn(template[field])) assert.ok(action.placeholders[name], `${kind}.${field}: ${name}`);
    }
    for (const form of ['html', 'text']) {
      const named = placeholdersIn(template[form]);
      for (const name of action.required[form]) assert.ok(named.has(name), `${kind}.${form} must use ${name}`);
    }
    assert.equal(template.name, action.label);
  }
});

test('wording with an apostrophe is source text, never escaped', () => {
  assert.match(englishTemplate('waitlist_joined').html, /We'll email you/);
  assert.match(englishTemplate('waitlist_released').preheader, /Here's how/);
  assert.match(englishTemplate('content_report').why, /Homeroom's compliance/);
  assert.match(viaSeeds('build_ready', { appName: 'Run Club', notWorking: true }).html, /isn't working yet/);
});

test('the seeds are plain words: no catalog reference is left in them', () => {
  assert.ok(!/\{\{t:/.test(JSON.stringify(SEEDS)), 'a {{t:}} reference in the seeds');
  for (const kind of KINDS) assert.ok(!/\{\{t:|email:/.test(JSON.stringify(englishTemplate(kind))), kind);
});

// ── Accepted differences ─────────────────────────────────────────────────

test('a value with an apostrophe: the html differs only by &#39;, and subject, text and headers not at all', () => {
  for (const kind of KINDS) {
    const today = SAMPLES.apostrophe[kind];
    const seeded = viaSeeds(kind, WITH_APOSTROPHE[kind]);
    assert.match(seeded.html, /&#39;/, kind);
    assert.equal(seeded.html.replaceAll('&#39;', "'"), today.html, kind);
    assert.deepEqual({ ...seeded, html: '' }, { ...today, html: '' }, kind);
  }
});

test('accepted: an English subject is not cleaned, as before', () => {
  const payload = { project: BROKEN, url: URL_PLAIN };
  assert.match(viaSeeds('project_invite', payload).subject, /A {2}B\nBcc/);
});

test('accepted: a link that is not plain http(s) is dropped rather than rendered', () => {
  assert.doesNotMatch(viaSeeds('waitlist_joined', { confirmUrl: 'javascript:alert(1)' }).html, /javascript:/);
});

test('accepted: a required value that is missing renders empty, not the word undefined', () => {
  assert.doesNotMatch(viaSeeds('otp', {}).text, /undefined/);
});
