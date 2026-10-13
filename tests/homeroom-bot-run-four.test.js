'use strict';

// Newcomer test "run four" (12-13 Oct 2026, app Club Votes, Homeroom bot run
// 1746): the build-it tap waited 43 s to be picked up, and the first
// version's 33-minute GLM build spent 31 of them waiting on the model over
// 156 calls. These pin what changed in the bot's own prompts and wakes:
//
//   - Build it, served by a Pod that is not the leader, wakes the leader
//     through the bus (goAhead), as an issue event does;
//   - the five-round look-and-fix loop is said only to a first version no
//     reviewer follows (design-skill.js stageGuidance), which its browser
//     lines already said (homeroom-bot-live.js browserLines);
//   - a build reads the clock and notes its progress on commands it runs
//     anyway, never as steps of their own, and makes independent reads and
//     edits together;
//   - a new app's CLAUDE.md tells a build inside Homeroom not to fetch the
//     184,651-character hosted conventions.
//
// Run with: node --test tests/homeroom-bot-run-four.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const designSkill = require('../src/services/design-skill');
const template = require('../src/services/template');

const ROOT = path.join(__dirname, '..');

// ── N16: Build it wakes the leader ───────────────────────────────────────

test('Build it wakes the loop where it runs, on whichever Pod the tap reached', async () => {
  bot._resetForTests();
  const wsBus = require('../src/services/ws-bus');
  const published = [];
  const realPublish = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { published.push({ kind, routing, data }); };
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(String(sql));
      if (/^\s*SELECT plan FROM homeroom_bot_runs/.test(String(sql))) return { rows: [{ plan: { bullets: ['Polls people vote in'], questions: [] } }] };
      if (/UPDATE homeroom_bot_runs/.test(String(sql))) return { rows: [{ app_id: 9, issue_number: 3 }] };
      throw new Error(`unexpected query: ${sql} ${params}`);
    },
  };
  try {
    // Not the leader: its local wake does nothing, and the leader must hear.
    const went = await bot.goAhead(pool, { runId: 1746 });
    assert.equal(went.ok, true);
    assert.deepEqual(published, [{ kind: bot.BUS_KIND, routing: null, data: { appId: 9, buildRunId: 1746 } }]);
    // The leader, hearing it, runs its pass now (and starts the build at
    // once: tests/homeroom-bot-run-five.test.js).
    bot._armForTests({}, { pool: { async query() { return { rows: [] }; } } });
    assert.equal(bot.onBusMessage(published[0].data), true);
    assert.deepEqual(bot._pendingForTests().apps, [9]);
  } finally {
    wsBus.publish = realPublish;
    bot._resetForTests();
  }
  // A plan already gone wakes nobody.
  const gone = { async query() { return { rows: [] }; } };
  published.length = 0;
  wsBus.publish = (kind, routing, data) => { published.push({ kind, routing, data }); };
  try {
    assert.deepEqual(await bot.goAhead(gone, { runId: 1 }), { ok: false, why: 'gone' });
    assert.deepEqual(published, []);
  } finally {
    wsBus.publish = realPublish;
  }
});

// ── L11: the look loop only when no reviewer follows ─────────────────────

test('a reviewed first version\'s build is not told the five-round look loop; an unreviewed one still is', () => {
  const { NUDGE, FIRST_VERSION_LOOP } = designSkill;
  assert.equal(designSkill.stageGuidance('build', { firstVersion: true, reviewed: true }), NUDGE);
  assert.equal(designSkill.stageGuidance('build', { firstVersion: true }), `${NUDGE}\n\n${FIRST_VERSION_LOOP}`);
  assert.equal(designSkill.stageGuidance('spec', { firstVersion: true, reviewed: true }), NUDGE);
  const reviewed = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, reviewed: true });
  assert.ok(reviewed.includes(NUDGE));
  assert.ok(!reviewed.includes(FIRST_VERSION_LOOP), 'the reviewer does the sweep');
  assert.match(reviewed, /a reviewer captures and checks every screen at\n {2}both widths and in both looks once your turn is over/, 'as its browser lines say');
  const alone = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true });
  assert.ok(alone.includes(FIRST_VERSION_LOOP));
});

// ── L14: fewer round trips ───────────────────────────────────────────────

test('a first version notes its progress on a command it runs anyway, and every build batches what does not depend', () => {
  const progress = live.FIRST_VERSION_PROGRESS_LINES.join('\n');
  assert.match(progress, /Never as a step of its own: chain it in front of the next command you run anyway/);
  assert.match(progress, /`usernode-progress "Adding the tier rows" && npm run build`/);
  assert.match(progress, /answers with the time/);
  // The App tab still reads the phrase off a chained command.
  assert.equal(require('../src/services/first-version-screens').captionOf('$ usernode-progress "Adding the tier rows" && npm run build'),
    'Adding the tier rows');
  for (const firstVersion of [false, true]) {
    const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion });
    assert.ok(p.includes(live.BATCH_STEPS_LINES.join('\n')), `firstVersion ${firstVersion}`);
  }
  assert.match(live.BATCH_STEPS_LINES.join(' '), /several tool calls in one message/);
  const clock = live.clockLines({ startedAt: Date.parse('2026-10-13T09:00:00Z'), budgetMs: 40 * 60 * 1000 }).join('\n');
  assert.match(clock, /never as a step of its own:\nput `date -u \+%H:%M;` in front of a command you are running anyway/);
  assert.doesNotMatch(clock, /Read the time with `date -u \+%H:%M` whenever/);
});

test('usernode-progress answers with the time, and never stops the command chained after it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-progress-'));
  const out = spawnSync('sh', ['-c', `sh "${path.join(ROOT, 'worker', 'usernode-progress')}" "Adding the tier rows" && echo built`], {
    encoding: 'utf8', cwd: dir,
  });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^Noted: Adding the tier rows \(it is \d\d:\d\d UTC\)\nbuilt\n$/);
  const bare = spawnSync('sh', [path.join(ROOT, 'worker', 'usernode-progress')], { encoding: 'utf8' });
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /^usage:/);
});

// ── L16: a new app's CLAUDE.md in the worker ─────────────────────────────

test('a new app\'s CLAUDE.md sends a build inside Homeroom to the conventions tool, not the hosted copy', () => {
  for (const tpl of [null, 'empty']) {
    const files = template.getTemplateFiles('Club Votes', 'club-votes', 'postgres://x/y', null, { template: tpl });
    const claude = files.find((f) => f.path === 'CLAUDE.md').content;
    assert.match(claude, /\*\*Inside Homeroom\*\* \(its dev chat, and Homeroom bot's builds\), do not\nfetch that URL/);
    assert.match(claude, /`get_platform_conventions` reads any one section of the conventions/);
    assert.match(claude, /\*\*Anywhere else\*\* \(Claude Code run against this repo locally, or another\nharness\), fetch it at the start of each session/);
    assert.doesNotMatch(claude, /the fetch is a no-op in\nthat path/, 'the claim that was untrue for the bot\'s builds is gone');
    // What only a local session needs is marked so, and kept short.
    assert.match(claude, /^## Connector permission prompts \(outside Homeroom\)$/m);
    const connector = claude.slice(claude.indexOf('## Connector permission prompts'), claude.indexOf('## Check that this checkout is current'));
    assert.ok(connector.split('\n').length <= 10, connector);
    assert.match(claude, /Inside Homeroom \(its dev\nchat, and Homeroom bot's builds\) the platform fixes the base commit/);
  }
});
