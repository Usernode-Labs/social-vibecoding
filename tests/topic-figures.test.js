'use strict';

// Topic figures: the numbers a topic's channel shows above its room
// (services/topic-figures.js, routes/topic-figures.js, topic-figures.tsx).
// Pinned here:
//
//   * the rounding that protects people: whole percent from 50, nearest 5%
//     from 20, "About N%" from 10, Not enough data under 10, never a 0% or a
//     100%, and times as bands for a small group;
//   * how a figure reads: its value, its line, off target in the attention
//     ink and on target grey, "None yet" for nothing to count, "Not recorded
//     yet" (never 0) for what the platform does not record;
//   * dapp.json: the four topics name their figures, every id is registered,
//     and an unknown id is an error that costs the topic nothing;
//   * against the full schema: every figure's query, each of the three
//     scopes, the reconcile that stores a topic's figures, the places record
//     that carries them, and the route;
//   * the strip as it renders, from the server's own payload.
//
// Run with: node --test tests/topic-figures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const figures = require('../src/services/topic-figures');
const appManifest = require('../src/services/app-manifest');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const TOPIC_IDS = {
  onboarding: ['onboarding.sign-up', 'onboarding.first-project', 'onboarding.first-change', 'onboarding.found-project'],
  'homeroom-bot': ['bot.answered', 'bot.reply-cost', 'bot.reply-time', 'bot.merged', 'bot.merged-cost', 'bot.request-to-proposal'],
  'proposal-pipeline': ['pipeline.checks-time', 'pipeline.couldnt-tell', 'pipeline.shots', 'pipeline.vote-to-merged'],
  infra: ['infra.merge-to-live', 'infra.deploys-failed', 'infra.apps-up', 'infra.limits-filled'],
};

const byId = (payload) => Object.fromEntries(payload.figures.map((f) => [f.id, f]));

// ── 1. Rounding and wording ──────────────────────────────────────────────

test('a rate about people is rounded more as the group gets smaller, and never reads as none or all', () => {
  assert.equal(figures.peopleRate(5, 9), null, 'under 10 people: not enough data');
  assert.deepEqual(figures.peopleRate(6, 15), { text: 'About 40%', small: true });
  assert.deepEqual(figures.peopleRate(9, 12), { text: 'About 80%', small: true });
  assert.deepEqual(figures.peopleRate(7, 20), { text: '35%', small: false }, 'nearest 5% from 20');
  assert.deepEqual(figures.peopleRate(13, 44), { text: '30%', small: false });
  assert.deepEqual(figures.peopleRate(53, 60), { text: '88%', small: false }, 'whole percent from 50');
  assert.deepEqual(figures.peopleRate(0, 15), { text: 'Under 10%', small: true });
  assert.deepEqual(figures.peopleRate(15, 15), { text: 'Over 90%', small: true });
  assert.deepEqual(figures.peopleRate(1, 45), { text: 'Under 5%', small: false }, 'a rate that rounds to none says so');
  assert.deepEqual(figures.peopleRate(1, 30), { text: '5%', small: false });
  assert.deepEqual(figures.peopleRate(59, 60), { text: '98%', small: false });
  assert.deepEqual(figures.peopleRate(60, 60), { text: 'Over 99%', small: false });
});

test('a time about people is exact from 50, whole minutes from 20, a band from 10', () => {
  assert.equal(figures.peopleDuration(230, 9), null);
  assert.deepEqual(figures.peopleDuration(230, 12), { text: '2 to 5 min', small: true });
  assert.deepEqual(figures.peopleDuration(45, 12), { text: 'Under 1 min', small: true });
  assert.deepEqual(figures.peopleDuration(2400, 12), { text: '30 min to 1 h', small: true });
  assert.deepEqual(figures.peopleDuration(90000, 12), { text: 'Over 1 d', small: true });
  assert.deepEqual(figures.peopleDuration(230, 34), { text: '4 min', small: false });
  assert.deepEqual(figures.peopleDuration(230, 80), { text: '4 min', small: false });
});

test('durations, dollars and shares read the way the strip shows them', () => {
  assert.equal(figures.formatDuration(14), '14 s');
  assert.equal(figures.formatDuration(540), '9 min');
  assert.equal(figures.formatDuration(4800), '1 h 20 min');
  assert.equal(figures.formatDuration(3600), '1 h');
  assert.equal(figures.formatUsd(0.0375), '$0.04');
  assert.equal(figures.formatUsd(3.8), '$3.80');
  assert.equal(figures.formatUsd(120.4), '$120');
  assert.equal(figures.formatPercent(13 / 412), '3.2%');
  assert.equal(figures.formatPercent(0.58), '58%');
  assert.equal(figures.formatPercent(0), '0%');
});

test('a figure off its target says so; on target it is grey; nothing to count and not recorded say those', () => {
  const off = figures.present('pipeline.couldnt-tell', { kind: 'rate', hits: 13, total: 412 });
  assert.deepEqual([off.state, off.value, off.sub], ['warn', '3.2%', '13 of 412 runs · over 1% target']);
  const on = figures.present('pipeline.checks-time', { kind: 'duration', secs: 540, n: 30 });
  assert.deepEqual([on.state, on.value, on.sub], ['ok', '9 min', 'median · target 10 min']);
  const slow = figures.present('bot.request-to-proposal', { kind: 'duration', secs: 4800, n: 20 });
  assert.deepEqual([slow.state, slow.value, slow.sub], ['warn', '1 h 20 min', 'median · over 1 h target']);
  const cost = figures.present('bot.reply-cost', { kind: 'usd', value: 0.04, n: 290 });
  assert.deepEqual([cost.state, cost.value, cost.sub], ['ok', '$0.04', 'target under $0.05']);
  const none = figures.present('pipeline.shots', { kind: 'rate', hits: 0, total: 0 });
  assert.deepEqual([none.state, none.value], ['empty', 'None yet'], 'nothing to count is never a 0%');
  const up = figures.present('infra.apps-up', null);
  assert.deepEqual([up.state, up.value, up.sub], ['missing', 'Not recorded yet', 'Needs restart records']);
  const homeroom = figures.present('infra.merge-to-live', { kind: 'duration', secs: 360, n: 4 }, { scope: 'homeroom' });
  assert.deepEqual([homeroom.state, homeroom.value], ['missing', 'Not recorded yet'], 'Homeroom\'s own release is not measured');
  const limits = figures.present('infra.limits-filled', { kind: 'count', n: 0 });
  assert.deepEqual([limits.state, limits.value], ['ok', 'None']);
  const failed = figures.present('pipeline.shots', null, { failed: true });
  assert.deepEqual([failed.state, failed.value], ['error', 'Couldn’t load']);
  const merged = figures.present('bot.merged', { kind: 'compare', rate: 0.58, n: 24, other: 0.64 });
  assert.deepEqual([merged.state, merged.value, merged.sub], ['calm', '58%', 'people’s rate 64%']);
});

test('a figure about people never sends a count, and a small group is rounded with no verdict', () => {
  const small = figures.present('onboarding.found-project', { kind: 'rate', hits: 6, total: 15 });
  assert.deepEqual([small.state, small.value, small.sub], ['calm', 'About 40%', 'rounded · small group']);
  const big = figures.present('onboarding.sign-up', { kind: 'rate', hits: 53, total: 60 });
  assert.deepEqual([big.state, big.value, big.sub], ['warn', '88%', 'below 95% target']);
  assert.doesNotMatch(JSON.stringify([small, big]), /\b(53|60|15)\b/, 'no group size or count leaves the server');
  const few = figures.present('onboarding.first-project', { kind: 'duration', secs: 200, n: 4 });
  assert.deepEqual([few.state, few.value], ['calm', 'Not enough data']);
});

test('the layout: tiles, the bot\'s grid, and no choice of projects for figures that belong to none', () => {
  const bot = figures.layoutFor(TOPIC_IDS['homeroom-bot']);
  assert.equal(bot.layout, 'grid');
  assert.deepEqual(bot.groups.map((g) => g.name), ['Answers', 'Builds']);
  assert.deepEqual(bot.columns.map((c) => c.name), ['Quality', 'Cost', 'Speed']);
  assert.deepEqual(bot.scopes, ['all', 'homeroom', 'others']);
  const onboarding = figures.layoutFor(TOPIC_IDS.onboarding);
  assert.deepEqual([onboarding.layout, onboarding.days, onboarding.scopes], ['tiles', 30, []]);
  assert.equal(onboarding.note, figures.NOTE_PEOPLE);
  assert.deepEqual([figures.layoutFor(TOPIC_IDS.infra).days, figures.layoutFor(TOPIC_IDS.infra).note], [7, null]);
  assert.deepEqual(figures.knownFigureIds(['infra.apps-up', 'nope', 'infra.apps-up']), ['infra.apps-up']);
});

test('a daily window ends at the start of today (UTC) and covers the days before it', () => {
  const now = Date.UTC(2026, 9, 10, 15, 30);
  const w = figures.windowFor({ days: 30, daily: true }, now);
  assert.equal(w.until.toISOString(), '2026-10-10T00:00:00.000Z');
  assert.equal(w.from.toISOString(), '2026-09-10T00:00:00.000Z');
  assert.equal(w.expiresAt, Date.UTC(2026, 9, 11));
  const r = figures.windowFor({ days: 7 }, Date.UTC(2026, 9, 10, 15, 37));
  assert.equal(r.until.toISOString(), '2026-10-10T15:30:00.000Z', 'a rolling window ends on a 10-minute step');
});

// ── 2. dapp.json ─────────────────────────────────────────────────────────

test('dapp.json: each of Homeroom\'s four topics names its figures, and every id is registered', () => {
  const manifest = JSON.parse(read('dapp.json'));
  for (const topic of manifest.topics) {
    if (TOPIC_IDS[topic.id]) assert.deepEqual(topic.figures, TOPIC_IDS[topic.id], topic.id);
    else assert.equal(topic.figures, undefined, `${topic.id} names no figures`);
  }
  for (const ids of Object.values(TOPIC_IDS)) for (const id of ids) assert.ok(figures.isFigureId(id), id);
  assert.deepEqual(appManifest.validateTopics(manifest.topics).errors, []);
});

test('an unknown figure is an error for the topics PR and costs the topic nothing in the reader', () => {
  const { topics, errors } = appManifest.validateTopics([
    { id: 'infra', handle: 'infra', name: 'Infra', figures: ['infra.apps-up', 'infra.uptime'] },
    { id: 'other', handle: 'other', name: 'Other', figures: 'infra.apps-up' },
    { id: 'many', handle: 'many', name: 'Many', figures: [...TOPIC_IDS['homeroom-bot'], 'infra.apps-up'] },
  ]);
  assert.deepEqual(errors, [
    'topics[0].figures names an unknown figure: infra.uptime',
    'topics[1].figures must be a list of figure ids',
    'topics[2].figures holds at most 6 figures',
  ]);
  assert.deepEqual(topics.map((t) => [t.id, t.figures]), [
    ['infra', ['infra.apps-up']],
    ['other', undefined],
    ['many', TOPIC_IDS['homeroom-bot']],
  ]);
});

test('the channel mounts the strip between the topic\'s line and its room, and the room\'s check still finds it', () => {
  const src = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  const head = src.indexOf('<TopicHead');
  const strip = src.indexOf('<TopicFigures slug={slug} topic={topic} />');
  const host = src.indexOf('className="dev-ws-discussion-host dev-ws-topic-host"');
  assert.ok(head > 0 && head < strip && strip < host);
  // The channel's declared check reads the strip too (folded into it rather
  // than a check of its own: the count is pinned).
  const manifest = JSON.parse(read('dapp.json'));
  const channel = manifest.tests.find((t) => t.path === '/?demo=1#app/usernode-2d5619/dev/c/onboarding');
  // The strip draws only on a live topic, so it stands for the topic's state.
  assert.match(channel.expectSelector, /\[data-ws-topic="onboarding"\]:has\(> \.dev-ws-topic-head \+ \[data-topic-figures\] \.dev-ws-fig-info\) > \.dev-ws-discussion-host \.gc-msg-more-action$/);
  assert.ok(channel.expectSelector.length <= 256, 'the runner clips a selector at 256 characters');
});

// ── 3. The strip, rendered ───────────────────────────────────────────────

const STRIP = 'frontend/src/features/dev-board/workshop/topic-figures.tsx';

function strip(topic, { scope = 'all', demo = true } = {}) {
  const { TopicFiguresView } = loadTsx(STRIP);
  const data = { topic, ...figures.demoFiguresFor(TOPIC_IDS[topic], { scope }), demo };
  return renderToHtml(createElement(TopicFiguresView, { handle: topic, data, scope, onScope: () => {} }));
}

test('the strip: its window, the choice of projects, a cell per figure with what it means, off target in the attention ink', () => {
  const html = strip('infra');
  assert.match(html, /^<section class="dev-ws-figs" data-topic-figures="infra" aria-label="This topic&#x27;s figures">/);
  assert.match(html, />Last 7 days</);
  assert.match(html, /<select class="dev-ws-figs-scope-select" data-topic-figures-scope="">/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]),
    [['all', 'All projects'], ['homeroom', 'Homeroom'], ['others', 'Other projects']]);
  assert.deepEqual([...html.matchAll(/data-topic-figure="([^"]+)"/g)].map((m) => m[1]), TOPIC_IDS.infra);
  assert.match(html, /data-topic-figure="infra.apps-up" data-fig-state="missing"[\s\S]*?class="dev-ws-fig-value dev-ws-fig-value-muted">Not recorded yet</);
  assert.match(html, /data-topic-figure="infra.limits-filled" data-fig-state="warn"[\s\S]*?class="dev-ws-fig-sub dev-ws-fig-sub-warn"><svg class="dev-ws-fig-warn"/);
  assert.match(html, /aria-label="What Merge → live means"/);
  // What each figure means is in the document, hidden until its ⓘ opens it.
  assert.match(html, /<span id="[^"]+" hidden="">How long from a change merging to it running in production\./);
  assert.match(html, /data-topic-figures-demo="">Staging demo figures, not real numbers\.</);
});

test('the onboarding strip: 30 days, no choice of projects, rounded figures and the line that says why', () => {
  const html = strip('onboarding', { demo: false });
  assert.match(html, />Last 30 days</);
  assert.doesNotMatch(html, /data-topic-figures-scope/);
  assert.match(html, />About 40%</);
  assert.match(html, />88%</);
  assert.match(html, /<p class="dev-ws-figs-note">Totals only\. Smaller groups are rounded more; under 10 people shows “Not enough data”\.<\/p>/);
  assert.doesNotMatch(html, /data-topic-figures-demo/);
});

test('the Homeroom bot\'s strip is a grid: a row each for Answers and Builds, a column each for Quality, Cost and Speed', () => {
  const html = strip('homeroom-bot');
  assert.match(html, /data-topic-figures-layout="grid"/);
  assert.deepEqual([...html.matchAll(/class="dev-ws-figs-colhead">([^<]+)</g)].map((m) => m[1]), ['Quality', 'Cost', 'Speed']);
  assert.deepEqual([...html.matchAll(/class="dev-ws-figs-rowname">([^<]+)</g)].map((m) => m[1]), ['Answers', 'Builds']);
  assert.deepEqual([...html.matchAll(/data-topic-figure="([^"]+)"/g)].map((m) => m[1]), TOPIC_IDS['homeroom-bot']);
});

test('a topic shows the strip only when it is live and names figures', () => {
  const { topicHasFigures, figuresUrl } = loadTsx(STRIP);
  assert.equal(topicHasFigures({ state: 'live', figures: ['infra.apps-up'] }), true);
  assert.equal(topicHasFigures({ state: 'live', figures: [] }), false);
  assert.equal(topicHasFigures({ state: 'archived', figures: ['infra.apps-up'] }), false);
  assert.equal(figuresUrl('usernode-2d5619', 'infra', 'others', true), '/api/apps/usernode-2d5619/topics/infra/figures?scope=others&demo=1');
});

test('the strip\'s own words are catalog entries', () => {
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const key of ['label', 'window_one', 'window_other', 'scopeLabel', 'scope.all', 'scope.homeroom', 'scope.others', 'whatItMeans', 'demo']) {
    const entry = catalog[`places.topicFigures.${key}`];
    assert.ok(entry && entry.text && entry.description, key);
  }
});

// ── 4. Against the full schema ───────────────────────────────────────────

test('topic figures against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `figures_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  figures._resetForTests();

  const user = async (username, extra = '') => (await pool.query(
    `INSERT INTO users (username, password${extra ? `, ${extra.split('=')[0]}` : ''}) VALUES ($1, 'x'${extra ? `, ${extra.split('=')[1]}` : ''}) RETURNING id`,
    [username],
  )).rows[0].id;
  const makeApp = async (slug, selfHosted) => (await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility, self_hosted)
     VALUES ($1, $1, 'running', 'public', 'public', $2) RETURNING id, slug`,
    [slug, selfHosted],
  )).rows[0];
  const ago = (mins) => new Date(Date.now() - mins * 60 * 1000);

  const platform = await makeApp('usernode-2d5619', true);
  const project = await makeApp('garden-club', false);
  const person = await user('maya');
  const bot = await user('homeroom_bot', 'is_synthetic=TRUE');
  const admins = [await user('ops1'), await user('ops2')];

  // Check runs: Homeroom's two slow ones and one that could not tell, a
  // project's three quick ones.
  async function checkRun(app, status, mins) {
    await pool.query(
      `INSERT INTO merge_debug_runs (app_id, kind, status, started_at, ended_at) VALUES ($1, 'checks', $2, $3, $4)`,
      [app.id, status, ago(120 + mins), ago(120)],
    );
  }
  await checkRun(platform, 'passing', 20);
  await checkRun(platform, 'failing', 20);
  await checkRun(platform, 'error', 3);
  for (let i = 0; i < 3; i += 1) await checkRun(project, 'passing', 5);

  // A project's merges: one live 6 minutes after GitHub merged it, one whose
  // deploy failed; and one that waited 10 minutes from its vote passing.
  async function mergeRun(app, sessionId, { status = 'merged', summary = null, startedMins, steps = [] }) {
    const run = (await pool.query(
      `INSERT INTO merge_debug_runs (app_id, session_id, kind, status, summary, started_at, ended_at)
       VALUES ($1, $2, 'merge', $3, $4, $5, $5) RETURNING id`,
      [app.id, sessionId, status, summary, ago(startedMins)],
    )).rows[0].id;
    let seq = 0;
    for (const s of steps) {
      seq += 1;
      await pool.query(
        `INSERT INTO merge_debug_steps (run_id, seq, phase, message, detail, created_at) VALUES ($1, $2, $3, 'x', $4, $5)`,
        [run, seq, s.phase, JSON.stringify(s.detail || {}), ago(s.mins)],
      );
    }
  }
  const session = (await pool.query(`INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id`, [project.id, person])).rows[0].id;
  await mergeRun(project, session, { status: 'blocked', startedMins: 200 });
  await mergeRun(project, session, {
    startedMins: 195,
    steps: [{ phase: 'github_merge', detail: { sha: 'abc' }, mins: 190 }, { phase: 'prod_rebuild', mins: 189 }, { phase: 'prod_rebuild', detail: { sha: 'abc' }, mins: 184 }],
  });
  await mergeRun(project, null, {
    startedMins: 150,
    summary: 'Merged on GitHub; production deploy failed (operator retry needed).',
    steps: [{ phase: 'github_merge', detail: { sha: 'def' }, mins: 149 }],
  });

  // One limit filled, notified to two admins; one only warned.
  for (const id of admins) {
    await pool.query(`INSERT INTO notifications (user_id, kind, detail, created_at) VALUES ($1, 'platform_limit', 'sessions_full:25:25', date_trunc('minute', NOW()) - interval '2 hours')`, [id]);
  }
  await pool.query(`INSERT INTO notifications (user_id, kind, detail, created_at) VALUES ($1, 'platform_limit', 'apps_warn:40:50', NOW() - interval '3 hours')`, [admins[0]]);

  // The bot's answers in the project's chat: three replied 12 seconds after
  // the message, one failed, one stayed quiet; and one DM answer.
  for (let i = 0; i < 5; i += 1) {
    const outcome = ['replied', 'replied', 'replied', 'failed', 'quiet'][i];
    const asked = (await pool.query(`INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'hi', $3) RETURNING id`, [project.id, person, ago(100)])).rows[0].id;
    const reply = outcome === 'replied'
      ? (await pool.query(`INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'hello', $3) RETURNING id`, [project.id, bot, new Date(ago(100).getTime() + 12000)])).rows[0].id
      : null;
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_key, outcome, cost_usd, through_message_id, reply_message_id, started_at, finished_at)
       VALUES ($1, 'chat', $2, $3, $4, $5, $6, $7, $7)`,
      [project.id, `k${i}`, outcome, outcome === 'replied' ? 0.03 : (outcome === 'failed' ? 0.01 : 0), asked, reply, ago(100)],
    );
  }
  await pool.query(`INSERT INTO homeroom_bot_dm_turns (user_id, cost_usd, created_at) VALUES ($1, 0.05, $2)`, [person, ago(90)]);

  // Sign-up: twelve new addresses asked for a code two days ago, nine went
  // on to have an account. Someone who already had one is not counted.
  for (let i = 0; i < 12; i += 1) {
    await pool.query(`INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ('otp', $1, 'sent', NOW() - interval '2 days')`, [`new${i}@example.com`]);
    if (i < 9) await pool.query(`INSERT INTO users (username, password, email, created_at) VALUES ($1, 'x', $2, NOW() - interval '2 days' + interval '5 minutes')`, [`new${i}`, `new${i}@example.com`]);
  }
  await pool.query(`UPDATE users SET email = 'maya@example.com', created_at = NOW() - interval '40 days' WHERE id = $1`, [person]);
  await pool.query(`INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ('otp', 'maya@example.com', 'sent', NOW() - interval '2 days')`);

  await t.test('the pipeline\'s figures, for every project, for Homeroom and for the others', async () => {
    const all = byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline'], { scope: 'all' }));
    assert.deepEqual([all['pipeline.couldnt-tell'].value, all['pipeline.couldnt-tell'].sub, all['pipeline.couldnt-tell'].state],
      ['17%', '1 of 6 runs · over 1% target', 'warn']);
    assert.deepEqual([all['pipeline.checks-time'].value, all['pipeline.checks-time'].state], ['5 min', 'ok']);
    assert.deepEqual([all['pipeline.vote-to-merged'].value, all['pipeline.vote-to-merged'].state], ['10 min', 'ok']);
    assert.equal(all['pipeline.shots'].state, 'empty');
    const homeroom = byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline'], { scope: 'homeroom' }));
    assert.deepEqual([homeroom['pipeline.checks-time'].value, homeroom['pipeline.checks-time'].state], ['20 min', 'warn']);
    assert.equal(homeroom['pipeline.couldnt-tell'].value, '33%');
    assert.equal(homeroom['pipeline.vote-to-merged'].state, 'empty');
    const others = byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline'], { scope: 'others' }));
    assert.deepEqual([others['pipeline.couldnt-tell'].value, others['pipeline.couldnt-tell'].state], ['0%', 'ok']);
  });

  await t.test('infra: merge to live and failed deploys for the projects, not recorded for Homeroom; a filled limit counted once', async () => {
    const all = byId(await figures.figuresFor(pool, TOPIC_IDS.infra, { scope: 'all' }));
    assert.deepEqual([all['infra.merge-to-live'].value, all['infra.merge-to-live'].state], ['6 min', 'ok']);
    assert.deepEqual([all['infra.deploys-failed'].value, all['infra.deploys-failed'].sub, all['infra.deploys-failed'].state],
      ['50%', '1 of 2 merges · over 5% target', 'warn']);
    assert.deepEqual([all['infra.apps-up'].state, all['infra.apps-up'].value], ['missing', 'Not recorded yet']);
    assert.deepEqual([all['infra.limits-filled'].value, all['infra.limits-filled'].state], ['1 time', 'warn']);
    const homeroom = byId(await figures.figuresFor(pool, TOPIC_IDS.infra, { scope: 'homeroom' }));
    assert.equal(homeroom['infra.merge-to-live'].value, 'Not recorded yet');
    assert.equal(homeroom['infra.limits-filled'].value, '1 time', 'a platform limit is the platform\'s, whichever projects are chosen');
  });

  await t.test('the bot\'s answers: replies that worked, what each cost, how long they took; DMs count only toward every project', async () => {
    const all = byId(await figures.figuresFor(pool, TOPIC_IDS['homeroom-bot'], { scope: 'all' }));
    assert.deepEqual([all['bot.answered'].value, all['bot.answered'].state], ['80%', 'warn']);
    assert.deepEqual([all['bot.reply-cost'].value, all['bot.reply-cost'].state], ['$0.04', 'ok']);
    assert.deepEqual([all['bot.reply-time'].value, all['bot.reply-time'].state], ['12 s', 'ok']);
    assert.equal(all['bot.merged'].state, 'empty');
    const homeroom = byId(await figures.figuresFor(pool, TOPIC_IDS['homeroom-bot'], { scope: 'homeroom' }));
    assert.equal(homeroom['bot.answered'].state, 'empty');
    const others = byId(await figures.figuresFor(pool, TOPIC_IDS['homeroom-bot'], { scope: 'others' }));
    assert.equal(others['bot.answered'].value, '75%', 'the project\'s three of four, without the DM');
  });

  await t.test('onboarding: a small group is rounded, an address that already had an account is not a sign-up', async () => {
    const all = byId(await figures.figuresFor(pool, TOPIC_IDS.onboarding, { scope: 'others' }));
    assert.deepEqual([all['onboarding.sign-up'].value, all['onboarding.sign-up'].sub], ['About 80%', 'rounded · small group']);
    assert.deepEqual([all['onboarding.first-project'].value, all['onboarding.found-project'].value], ['Not enough data', 'Not enough data']);
  });

  await t.test('the reconcile stores a topic\'s figures, the places record carries them, and the route reads them', async () => {
    require('../src/db/pool').getPool = () => pool;
    const reconcile = (topics) => appManifest.reconcileAppTopics(pool, platform, { topics: appManifest.validateTopics(topics).topics });
    await reconcile([
      { id: 'infra', handle: 'infra', name: 'Infra', figures: TOPIC_IDS.infra },
      { id: 'quiet', handle: 'quiet', name: 'Quiet' },
    ]);
    const places = require('../src/services/places');
    const listed = (await places.placesFor(pool, platform, null)).channels;
    assert.deepEqual(listed.map((c) => [c.key, c.figures]), [['infra', TOPIC_IDS.infra], ['quiet', []]]);
    await reconcile([{ id: 'infra', handle: 'infra', name: 'Infra', figures: ['infra.apps-up'] }, { id: 'quiet', handle: 'quiet', name: 'Quiet' }]);
    assert.deepEqual((await places.placesFor(pool, platform, null)).channels[0].figures, ['infra.apps-up'], 'a change to the list applies');

    const { topicFiguresRoutes } = require('../src/routes/topic-figures');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: person, username: 'maya' }; next(); });
    app.use(topicFiguresRoutes({}));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/apps/usernode-2d5619/topics`;
    const get = async (p) => { const res = await fetch(`${base}${p}`); return { status: res.status, body: await res.json() }; };
    const one = await get('/infra/figures?scope=homeroom&demo=1');
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.topic, one.body.scope, one.body.scopes, one.body.demo, one.body.figures.map((f) => f.id)],
      ['infra', 'all', [], undefined, ['infra.apps-up']],
      'a figure that belongs to no one project offers no choice of projects, and outside staging ?demo=1 changes nothing');
    assert.deepEqual((await get('/quiet/figures')).body, { topic: 'quiet', figures: [] });
    assert.equal((await get('/nowhere/figures')).status, 404);
    await reconcile([{ id: 'quiet', handle: 'quiet', name: 'Quiet' }]);
    assert.deepEqual((await get('/infra/figures')).body.figures, [], 'a retired topic shows none');
  });
});
