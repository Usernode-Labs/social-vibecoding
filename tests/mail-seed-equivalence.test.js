'use strict';

// src/db/email-template-seeds.js, src/services/mail/render.js: the seeded
// templates render what the hard-coded ones they replaced rendered, byte for
// byte, across every branch. Those templates are gone (src/services/mail/
// templates.js has none since the stored templates took over), so the proof is
// against a snapshot of their output taken just before they were deleted:
// tests/fixtures/mail-snapshot-english.json holds one hash per payload of
// tests/lib/mail-matrix.js, English and tracked, and mail-snapshot-samples.json
// whole messages for each action's sample payload and for a value with an
// apostrophe. A payload is never narrowed: a difference is either a bug or an
// entry in the "accepted differences" tests.
//
// The snapshot covers the 13 kinds that existed when it was taken. A new action
// needs no entry here (the seed checks below still cover it), and may add rows
// to tests/lib/mail-matrix.js so its conditionals are taken both ways (the
// waitlist reminders do). A deliberate change
// to a historical kind's seed wording regenerates that kind's hashes from the new
// seeds in the same change, saying why in the commit:
//   node -e "const m=require('./tests/lib/mail-matrix'),{buildMessage}=require('./src/services/mail/templates');
//     console.log(m.MATRIX['otp'].map((row)=>m.digest(buildMessage('otp',row))).join(''))"
// (and with PLATFORM_MAIL_TRACKING_SECRET=only-for-tests and m.TRACKED in each row
// for the tracked hashes), with USERNODE_DOMAIN unset.
//
// To reproduce the snapshot itself: check out b7269a067, where templates.js still
// held the hard-coded mails, and digest the old buildMessage(kind, row) for every
// row of tests/lib/mail-matrix.js the same way.
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

// The kinds the snapshot was taken for. Each still exists and still has its rows.
const HISTORICAL = Object.keys(SNAPSHOT.english);

test('each historical kind\'s rows are the ones the snapshot was taken with', () => {
  assert.equal(HISTORICAL.length, 13);
  for (const kind of HISTORICAL) {
    assert.ok(KINDS.includes(kind), `${kind} is still an action`);
    assert.equal(matrixHash(kind), SNAPSHOT.matrix[kind], `tests/lib/mail-matrix.js changed ${kind}'s rows`);
  }
  assert.ok(!JSON.stringify(MATRIX).includes("'"));
  const rows = HISTORICAL.reduce((n, kind) => n + MATRIX[kind].length, 0);
  assert.equal(rows, SNAPSHOT.rows);
  assert.ok(rows > 1000);
});

test('the matrix takes every conditional of every seed both ways', () => {
  const on = (value) => !(value === undefined || value === null || value === false || value === '');
  for (const kind of Object.keys(MATRIX)) {
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
  for (const kind of HISTORICAL) {
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
  for (const kind of HISTORICAL) {
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
      // The html counts the why line too, as the validator does: the
      // standard layout prints it under every mail (the reminders' stop
      // link sits there).
      const named = new Set([...placeholdersIn(template[form]), ...(form === 'html' ? placeholdersIn(template.why) : [])]);
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
  for (const kind of HISTORICAL) {
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
