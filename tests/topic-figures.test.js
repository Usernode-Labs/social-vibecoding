'use strict';

// Topic figures: the numbers a topic's channel shows above its room
// (services/topic-figures.js, routes/topic-figures.js, topic-figures.tsx).
// Pinned here:
//
//   * the rounding that protects people: whole percent from 50, nearest 5%
//     from 20, "About N%" from 10, Not enough data under 10, never a 0% or a
//     100%, and times as bands for a small group;
//   * how a figure reads: its value, its line, off target in the attention
//     ink and on target grey, "None yet" for nothing to count;
//   * a split figure: Homeroom beside the other projects, each side with its
//     own number and verdict, the target once;
//   * dapp.json: the four topics name their figures, every id is registered,
//     and an unknown id is an error that costs the topic nothing;
//   * the records the Infra figures need: when a merge into Homeroom went
//     live (platform-release.js) and the minutes a project's app was down
//     (app-outages.js);
//   * against the full schema: every figure's query, both sides of the split
//     ones, the reconcile that stores a topic's figures, the places record
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
  'homeroom-bot': [
    'bot.answered', 'bot.reply-cost', 'bot.reply-time', 'bot.merged', 'bot.merged-cost', 'bot.request-to-proposal',
    'bot.builds-proposed', 'bot.first-versions', 'bot.failed-spend',
  ],
  'proposal-pipeline': ['pipeline.checks-time', 'pipeline.checks-couldnt-run', 'pipeline.shots', 'pipeline.vote-to-merged', 'pipeline.main-paused', 'pipeline.reds-rerun'],
  infra: [
    'infra.merge-to-live', 'infra.deploys-failed', 'infra.apps-up', 'infra.restarts', 'infra.limits-filled', 'infra.turned-away',
    'infra.homeroom-stalls', 'infra.homeroom-crashes',
  ],
};

const byId = (payload) => Object.fromEntries(payload.figures.map((f) => [f.id, f]));
// A split figure's sides as [key, state, value, detail].
const sidesOf = (f) => f.sides.map((side) => [side.key, side.state, side.value, side.detail]);
// The day a record began, as a figure's line says it: "10 Oct" (UTC).
const utcDay = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

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
  assert.equal(figures.formatPercent(1204 / 1213), '99.2%', 'short of all is never rounded up to it');
  assert.equal(figures.formatPercent(0.9999), '99.9%');
  assert.equal(figures.formatPercent(1), '100%');
});

test('a figure off its target says so; on target it is grey; nothing to count says so', () => {
  const failed = figures.present('infra.deploys-failed', { hits: 3, total: 74 });
  assert.deepEqual([failed.state, failed.value, failed.sub], ['ok', '4.1%', '3 of 74 project merges · target under 5%']);
  const up = figures.present('infra.apps-up', { hits: 1204, total: 1213 });
  assert.deepEqual([up.state, up.value, up.sub], ['ok', '99.2%', '1,204 of 1,213 opens · target 99%']);
  const down = figures.present('infra.apps-up', { hits: 95, total: 100 });
  assert.deepEqual([down.state, down.value, down.sub], ['warn', '95%', '95 of 100 opens · below 99% target']);
  const restarts = figures.present('infra.restarts', { n: 4, apps: 3 });
  assert.deepEqual([restarts.state, restarts.value, restarts.sub], ['calm', '4 times', 'in 3 projects']);
  assert.deepEqual(figures.present('infra.restarts', { n: 1, apps: 1 }).sub, 'in 1 project');
  assert.deepEqual([figures.present('infra.restarts', { n: 0, apps: 0 }).value, figures.present('infra.restarts', { n: 0, apps: 0 }).sub], ['None', '']);
  const limits = figures.present('infra.limits-filled', { n: 0 });
  assert.deepEqual([limits.state, limits.value, limits.sub], ['ok', 'None', 'across the platform']);
  const full = figures.present('infra.limits-filled', { n: 2 });
  assert.deepEqual([full.state, full.value, full.sub], ['warn', '2 times', 'across the platform · target none']);
  // A refusal is counted when it happens; the alert above only samples.
  const away = figures.present('infra.turned-away', { n: 3 });
  assert.deepEqual([away.state, away.value, away.sub], ['warn', '3 times', 'across the platform · target none']);
  assert.deepEqual(figures.present('infra.turned-away', { n: 0 }).value, 'None');
  // Pauses of a project's merges: how many and how long in all, per side.
  const paused = figures.present('pipeline.main-paused', { homeroom: { n: 2, secs: 9000 }, others: { n: 0, secs: 0 } });
  assert.deepEqual([paused.state, paused.value, paused.sub], ['warn', 'Homeroom 2 times · Other projects None', 'target none']);
  assert.deepEqual(sidesOf(paused), [['homeroom', 'warn', '2 times', '2 h 30 min in all'], ['others', 'ok', 'None', '']]);
  // Reds the same code passed when it ran again: a share of every red, per side.
  const reruns = figures.present('pipeline.reds-rerun', { homeroom: { hits: 6, total: 41 }, others: { hits: 0, total: 0 } });
  assert.deepEqual(sidesOf(reruns), [['homeroom', 'warn', '15%', '6 of 41 reds'], ['others', 'empty', 'None yet', '']]);
  // Homeroom's own releases and processes.
  const stalls = figures.present('infra.homeroom-stalls', { n: 1 });
  assert.deepEqual([stalls.state, stalls.value, stalls.sub], ['warn', '1 time', 'across the platform · target none']);
  assert.deepEqual(figures.present('infra.homeroom-crashes', { n: 0 }).value, 'None');
  const none = figures.present('infra.apps-up', { hits: 0, total: 0 });
  assert.deepEqual([none.state, none.value, none.sub], ['empty', 'None yet', 'No opens yet'], 'nothing to count is never a 0%');
  const unread = figures.present('infra.deploys-failed', null);
  assert.deepEqual([unread.state, unread.value], ['error', 'Couldn’t load']);
  const merged = figures.present('bot.merged', { rate: 0.58, n: 24, other: 0.64 });
  assert.deepEqual([merged.state, merged.value, merged.sub], ['calm', '58%', 'people’s rate 64%']);
});

test('the bot\'s failed builds: a share of builds, of first versions, and of dollars, Homeroom beside the other projects', () => {
  const proposed = figures.present('bot.builds-proposed', { homeroom: { hits: 113, total: 140 }, others: { hits: 9, total: 10 } });
  assert.deepEqual(sidesOf(proposed), [['homeroom', 'warn', '81%', '113 of 140 builds'], ['others', 'ok', '90%', '9 of 10 builds']]);
  assert.equal(proposed.sub, 'target 90%');
  const firsts = figures.present('bot.first-versions', { homeroom: { hits: 0, total: 0 }, others: { hits: 9, total: 17 } });
  assert.deepEqual(sidesOf(firsts), [['homeroom', 'empty', 'None yet', ''], ['others', 'warn', '53%', '9 of 17 first versions']]);
  const spend = figures.present('bot.failed-spend', { homeroom: { hits: 12.4, total: 310 }, others: { hits: 0.75, total: 10 } });
  assert.deepEqual(sidesOf(spend), [['homeroom', 'ok', '4%', '$12.40 of $310'], ['others', 'ok', '7.5%', '$0.75 of $10.00']],
    'a share of dollars keeps its cents');
  assert.equal(spend.sub, 'target under 10%');
  const over = figures.present('bot.failed-spend', { homeroom: { hits: 10.01, total: 100 }, others: { hits: 0, total: 0 } });
  assert.deepEqual(sidesOf(over)[0].slice(0, 3), ['homeroom', 'warn', '10.1%'], 'off target never reads as the target');
  assert.deepEqual(sidesOf(over)[1].slice(0, 3), ['others', 'empty', 'None yet']);
  for (const id of ['bot.builds-proposed', 'bot.first-versions', 'bot.failed-spend']) {
    assert.match(figures.FIGURES[id].tip, /^The share of /, id);
    assert.deepEqual([figures.FIGURES[id].group, figures.FIGURES[id].covers], ['builds', 'split'], id);
  }
  assert.deepEqual(figures.readsFor(figures.FIGURES['bot.failed-spend']).map((r) => [r.side, r.name, r.scope]),
    [['homeroom', 'botBuilds', 'homeroom'], ['others', 'botBuilds', 'others']]);
  assert.equal(figures.present('bot.merged', { rate: 0.99, n: 114, other: 0.6 }).label, 'Proposals merged', 'kept as it was');
});

test('a record that began inside the window says when, so a new one never reads as none (#4697)', () => {
  const since = '2026-10-10T16:55:00Z';
  const fresh = figures.present('infra.merge-to-live', { homeroom: { secs: null, n: 0, since }, others: { secs: 20, n: 50 } });
  assert.deepEqual(sidesOf(fresh), [['homeroom', 'empty', 'None yet', 'Counting since 10 Oct'], ['others', 'ok', '20 s', '']]);
  const timed = figures.present('infra.merge-to-live', { homeroom: { secs: 100, n: 3, since: new Date(since) }, others: { secs: 20, n: 50 } });
  assert.deepEqual(sidesOf(timed)[0], ['homeroom', 'ok', '2 min', 'since 10 Oct'], 'a median of less than the week says so');
  assert.equal(timed.sub, 'median · target 2 min', 'the target line is unchanged');
  const opens = figures.present('infra.apps-up', { hits: 0, total: 0, since });
  assert.deepEqual([opens.state, opens.value, opens.sub], ['empty', 'None yet', 'Counting since 10 Oct']);
  const some = figures.present('infra.apps-up', { hits: 95, total: 100, since });
  assert.equal(some.sub, '95 of 100 opens since 10 Oct · below 99% target');
  // A record older than the window (the query sends no `since`) reads as before.
  assert.deepEqual(sidesOf(figures.present('infra.merge-to-live', { homeroom: { secs: null, n: 0 }, others: { secs: 20, n: 50 } }))[0],
    ['homeroom', 'empty', 'None yet', '']);
  const src = read('src/services/topic-figures.js');
  assert.match(src, /WHERE s\.key = 'platform_live_tracked_since' AND s\.value::timestamptz > \$1::timestamptz\) AS since/);
  assert.match(src, /WHERE s\.key = 'app_outages_tracked_since' AND s\.value::timestamptz > \$1::timestamptz\) AS since/);
});

test('a split figure shows Homeroom beside the other projects, each with its verdict, and the target once', () => {
  const checks = figures.present('pipeline.checks-time', { homeroom: { secs: 310, n: 30 }, others: { secs: 95, n: 60 } });
  assert.deepEqual(sidesOf(checks), [['homeroom', 'warn', '5 min', ''], ['others', 'ok', '2 min', '']]);
  assert.deepEqual([checks.state, checks.sub], ['warn', 'median · target 2 min'], 'the target line is the target alone, for both');
  assert.equal(checks.value, 'Homeroom 5 min · Other projects 2 min', 'one line for a client that draws no sides');
  assert.deepEqual(checks.sides.map((side) => side.name), ['Homeroom', 'Other projects']);

  const couldnt = figures.present('pipeline.checks-couldnt-run', { homeroom: { hits: 3, total: 143 }, others: { hits: 0, total: 262 } });
  assert.equal(couldnt.label, 'Checks that couldn’t run');
  assert.deepEqual(sidesOf(couldnt), [['homeroom', 'warn', '2.1%', '3 of 143 runs'], ['others', 'ok', '0%', '0 of 262 runs']]);
  assert.equal(couldnt.sub, 'target under 1%');

  const cost = figures.present('bot.reply-cost', { homeroom: { value: 3.1, n: 210 }, others: { value: 6.4, n: 80 } });
  assert.equal(cost.label, 'Cost per 100 replies');
  assert.deepEqual(sidesOf(cost), [['homeroom', 'ok', '$3.10', ''], ['others', 'warn', '$6.40', '']]);
  assert.equal(cost.sub, 'target under $5');
  // Per 100 replies: thread and chat turns and DMs, everything they cost.
  const per100 = figures.FIGURES['bot.reply-cost'].measure({ voice_posted: 3, dm_posted: 1, voice_cost: 0.1, dm_cost: 0.06 });
  assert.deepEqual(per100, { value: 4, n: 4 });

  const half = figures.present('pipeline.shots', { homeroom: { hits: 0, total: 0 }, others: null });
  assert.deepEqual(sidesOf(half), [['homeroom', 'empty', 'None yet', ''], ['others', 'error', 'Couldn’t load', '']]);
  assert.equal(half.state, 'empty');
  const calm = figures.present('infra.merge-to-live', { homeroom: { secs: 110, n: 3 }, others: { secs: 45, n: 9 } });
  assert.equal(calm.state, 'ok');
  assert.equal(figures.FIGURES['infra.merge-to-live'].target.atMost, 120, 'live within 2 minutes of merging');
});

test('a number off its target never reads as the target itself', () => {
  const shots = figures.present('pipeline.shots', { homeroom: { hits: 30, total: 32 }, others: { hits: 26, total: 29 } });
  assert.deepEqual(sidesOf(shots)[1], ['others', 'warn', '89.6%', '26 of 29 runs'], '89.7% is below 90%, so it is not "90%"');
  const late = figures.present('infra.merge-to-live', { homeroom: { secs: 125, n: 4 }, others: { secs: 60, n: 4 } });
  assert.equal(late.sides[0].value, '2 min 5 s');
  const dear = figures.present('bot.merged-cost', { homeroom: { value: 5.003, n: 4 }, others: { value: 2, n: 4 } });
  assert.equal(dear.sides[0].value, '$5.01');
  const failing = figures.present('infra.deploys-failed', { hits: 1008, total: 20000 });
  assert.deepEqual([failing.state, failing.value], ['warn', '5.1%']);
  assert.equal(figures.present('infra.deploys-failed', { hits: 3, total: 74 }).value, '4.1%', 'on target it is the plain reading');
});

test('a figure about people never sends a count, and a small group is rounded with no verdict', () => {
  const small = figures.present('onboarding.found-project', { hits: 6, total: 15 });
  assert.deepEqual([small.state, small.value, small.sub], ['calm', 'About 40%', 'rounded · small group']);
  const big = figures.present('onboarding.sign-up', { hits: 53, total: 60 });
  assert.deepEqual([big.label, big.state, big.value, big.sub], ['Let in → signed up', 'ok', '88%', 'target 70%']);
  const low = figures.present('onboarding.sign-up', { hits: 20, total: 60 });
  assert.deepEqual([low.state, low.value, low.sub], ['warn', '33%', 'below 70% target']);
  assert.doesNotMatch(JSON.stringify([small, big]), /\b(53|60|15)\b/, 'no group size or count leaves the server');
  const few = figures.present('onboarding.first-project', { secs: 200, n: 4 });
  assert.deepEqual([few.state, few.value, few.sub], ['calm', 'Not enough data', 'Fewer than 10 people so far']);
  const nine = figures.present('onboarding.sign-up', { hits: 2, total: 9 });
  assert.deepEqual([nine.value, nine.sub], ['Not enough data', 'Fewer than 10 people so far']);
});

test('the layout: tiles and the bot\'s grid, with no choice of projects', () => {
  const bot = figures.layoutFor(TOPIC_IDS['homeroom-bot']);
  assert.equal(bot.layout, 'grid');
  assert.deepEqual(bot.groups.map((g) => g.name), ['Answers', 'Builds']);
  assert.deepEqual(bot.columns.map((c) => c.name), ['Quality', 'Cost', 'Speed']);
  assert.equal('scopes' in bot, false);
  const onboarding = figures.layoutFor(TOPIC_IDS.onboarding);
  assert.deepEqual([onboarding.layout, onboarding.days], ['tiles', 30]);
  assert.equal(onboarding.note, figures.NOTE_PEOPLE);
  assert.deepEqual([figures.layoutFor(TOPIC_IDS.infra).days, figures.layoutFor(TOPIC_IDS.infra).note], [7, null]);
  assert.deepEqual(figures.knownFigureIds(['infra.apps-up', 'nope', 'infra.apps-up']), ['infra.apps-up']);
});

test('which figures split: the bot\'s cost and speed, the whole pipeline, merge to live', () => {
  const split = figures.FIGURE_IDS.filter((id) => figures.FIGURES[id].covers === 'split');
  assert.deepEqual(split, [
    'bot.reply-cost', 'bot.reply-time', 'bot.merged-cost', 'bot.request-to-proposal',
    'bot.builds-proposed', 'bot.first-versions', 'bot.failed-spend', 'pipeline.checks-time', 'pipeline.checks-couldnt-run', 'pipeline.shots', 'pipeline.vote-to-merged',
    'pipeline.main-paused', 'pipeline.reds-rerun', 'infra.merge-to-live',
  ]);
  for (const id of figures.FIGURE_IDS) assert.ok(figures.COVERS.includes(figures.FIGURES[id].covers || 'all'), id);
  const reads = (id) => figures.readsFor(figures.FIGURES[id]).map((r) => [r.side, r.name, r.scope]);
  assert.deepEqual(reads('pipeline.checks-time'), [['homeroom', 'checks', 'homeroom'], ['others', 'checks', 'others']]);
  assert.deepEqual(reads('infra.merge-to-live'), [['homeroom', 'homeroomLive', 'all'], ['others', 'mergeLive', 'all']],
    'Homeroom\'s release is recorded apart from the projects\' deploys');
  assert.deepEqual(reads('bot.answered'), [[null, 'botAnswers', 'all']]);
  assert.deepEqual(reads('infra.deploys-failed'), [[null, 'mergeLive', 'all']]);
  assert.equal(figures.FIGURES['pipeline.checks-time'].target.atMost, 120, 'a checks verdict in 2 minutes');
});

test('Time to a checks verdict counts the preview build a run followed (#4696)', () => {
  assert.match(figures.FIGURES['pipeline.checks-time'].tip, /including the build/);
  // The build records when it began, and the checks run that follows opens
  // its trace there, so ended_at - started_at spans the build too.
  assert.match(read('src/services/staging.js'), /const timings = \{ startedAt: buildStartedAt \};/);
  const capture = read('src/services/visuals.js');
  assert.match(capture, /const builtFrom = Number\(stagingResult\?\.timings\?\.startedAt\);/);
  assert.match(capture, /startedAt: Number\.isFinite\(builtFrom\) && builtFrom <= runStartedAt \? new Date\(builtFrom\) : null,/,
    'a run on a live preview, with no build, starts when it is opened');
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
    'topics[2].figures holds at most 9 figures',
  ]);
  assert.deepEqual(topics.map((t) => [t.id, t.figures]), [
    ['infra', ['infra.apps-up']],
    ['other', undefined],
    ['many', TOPIC_IDS['homeroom-bot']],
  ]);
});

test('the channel draws the strip on its Numbers tab, after its line and its tabs, and the channel\'s check reads the tab (#5304)', () => {
  const src = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  const head = src.indexOf('<TopicHead');
  const tabs = src.indexOf('data-topic-tabs={topic.handle}');
  const strip = src.indexOf("{view === 'numbers' ? (\n        <div className=\"dev-ws-topic-pane\"><TopicFigures slug={slug} topic={topic} /></div>");
  const host = src.indexOf('className="dev-ws-discussion-host dev-ws-topic-host"');
  assert.ok(head > 0 && head < tabs && tabs < strip && strip < host);
  // The channel's declared check reads the tab strip, Numbers included
  // (folded into it rather than a check of its own: the count is pinned).
  const manifest = JSON.parse(read('dapp.json'));
  const channel = manifest.tests.find((t) => t.path === '/?demo=1#app/usernode-2d5619/dev/c/onboarding');
  // The Numbers tab is there only on a live topic that names figures.
  assert.match(channel.expectSelector, /\[data-ws-topic-tab=requests\] > \.dev-ws-topic-head \+ \[data-topic-tabs=onboarding\] > \[aria-current=page\]\[data-topic-tab=requests\] \+ \[data-topic-tab=chat\] \+ \[data-topic-tab=numbers\]$/);
  assert.ok(channel.expectSelector.length <= 256, 'the runner clips a selector at 256 characters');
});

// ── 3. The strip, rendered ───────────────────────────────────────────────

const STRIP = 'frontend/src/features/dev-board/workshop/topic-figures.tsx';

function strip(topic, { demo = true } = {}) {
  const { TopicFiguresView } = loadTsx(STRIP);
  const data = { topic, ...figures.demoFiguresFor(TOPIC_IDS[topic]), demo };
  return renderToHtml(createElement(TopicFiguresView, { handle: topic, data }));
}

test('the strip: its window, a cell per figure with what it means, off target in the attention ink', () => {
  const html = strip('infra');
  assert.match(html, /^<section class="dev-ws-figs" data-topic-figures="infra" aria-label="This topic&#x27;s figures">/);
  assert.match(html, />Last 7 days</);
  assert.doesNotMatch(html, /<select|data-topic-figures-scope/, 'no choice of projects: the split figures show both');
  assert.deepEqual([...html.matchAll(/data-topic-figure="([^"]+)"/g)].map((m) => m[1]), TOPIC_IDS.infra);
  assert.match(html, /data-topic-figure="infra.limits-filled" data-fig-state="warn"[\s\S]*?class="dev-ws-fig-sub dev-ws-fig-sub-warn"><svg class="dev-ws-fig-warn"/);
  assert.match(html, /data-topic-figure="infra.apps-up" data-fig-state="ok"[\s\S]*?class="dev-ws-fig-value">99\.2%</);
  assert.match(html, /aria-label="What Merge → live means"/);
  // What each figure means is in the document, hidden until its ⓘ opens it.
  assert.match(html, /<span id="[^"]+" hidden="">How long from a change merging to it running in production\./);
  assert.match(html, /data-topic-figures-demo="">Staging demo figures, not real numbers\.</);
});

test('a split cell: Homeroom over Other projects, the side off target marked, the target line plain', () => {
  const html = strip('infra');
  const cell = html.slice(html.indexOf('data-topic-figure="infra.merge-to-live"'), html.indexOf('data-topic-figure="infra.deploys-failed"'));
  assert.match(cell, /^data-topic-figure="infra.merge-to-live" data-fig-state="warn"/);
  assert.deepEqual([...cell.matchAll(/data-fig-side="([^"]+)" data-fig-state="([^"]+)"><span class="dev-ws-fig-side-name">([^<]+)</g)].map((m) => [m[1], m[2], m[3]]),
    [['homeroom', 'warn', 'Homeroom'], ['others', 'ok', 'Other projects']]);
  assert.match(cell, /class="dev-ws-fig-side-value dev-ws-fig-side-value-warn"><svg class="dev-ws-fig-warn"[^>]*>[\s\S]*?<\/svg>19 min</);
  assert.match(cell, /class="dev-ws-fig-side-value">1 min</);
  assert.match(cell, /class="dev-ws-fig-sub">median · target 2 min</, 'the line is not the warning: the side is');
  assert.doesNotMatch(cell, /class="dev-ws-fig-value/, 'the sides stand in for the one number');
  const pipeline = strip('proposal-pipeline');
  assert.match(pipeline, /data-fig-side="homeroom" data-fig-state="warn">[\s\S]*?2\.1%<\/span><span class="dev-ws-fig-side-detail">3 of 143 runs</);
});

test('the onboarding strip: 30 days, rounded figures and the line that says why', () => {
  const html = strip('onboarding', { demo: false });
  assert.match(html, />Last 30 days</);
  assert.match(html, />About 40%</);
  assert.match(html, />68%</);
  assert.match(html, /<p class="dev-ws-figs-note">Totals only\. Smaller groups are rounded more; under 10 people shows “Not enough data”\.<\/p>/);
  assert.doesNotMatch(html, /data-topic-figures-demo/);
});

test('the Homeroom bot\'s strip is a grid: a row each for Answers and Builds, a column each for Quality, Cost and Speed', () => {
  const html = strip('homeroom-bot');
  assert.match(html, /data-topic-figures-layout="grid"/);
  assert.deepEqual([...html.matchAll(/class="dev-ws-figs-colhead">([^<]+)</g)].map((m) => m[1]), ['Quality', 'Cost', 'Speed']);
  assert.deepEqual([...html.matchAll(/class="dev-ws-figs-rowname">([^<]+)</g)].map((m) => m[1]), ['Answers', 'Builds']);
  // Builds runs on into two rows under its first: its failures under its
  // merges, a column at a time, in the order the topic names them.
  assert.deepEqual([...html.matchAll(/data-topic-figure="([^"]+)"/g)].map((m) => m[1]), [
    'bot.answered', 'bot.reply-cost', 'bot.reply-time',
    'bot.merged', 'bot.merged-cost', 'bot.request-to-proposal',
    'bot.builds-proposed', 'bot.failed-spend',
    'bot.first-versions',
  ]);
  assert.deepEqual([...html.matchAll(/class="dev-ws-figs-row" data-fig-group="([^"]+)"/g)].map((m) => m[1]),
    ['answers', 'builds', 'builds', 'builds']);
  assert.equal([...html.matchAll(/class="dev-ws-figs-rowhead dev-ws-figs-rowhead-more" aria-hidden="true"/g)].length, 2);
  assert.equal([...html.matchAll(/class="dev-ws-fig-sides"/g)].length, 7, 'cost and speed split, and the builds\' failures; the rest of quality does not');
  assert.match(html, /data-fig-side="homeroom" data-fig-state="warn">[\s\S]*?81%<\/span><span class="dev-ws-fig-side-detail">21 of 26 builds</);
  assert.match(html, /data-fig-side="homeroom" data-fig-state="warn">[\s\S]*?19%<\/span><span class="dev-ws-fig-side-detail">\$18\.40 of \$96\.20</);
  // On a phone the row's name spans the grid; a row it runs on into has none.
  assert.match(read('public/css/app.css'), /\.dev-ws-figs-rowhead-more \{ display: none; \}/);
});

test('a topic shows the strip only when it is live and names figures', () => {
  const { topicHasFigures, figuresUrl } = loadTsx(STRIP);
  assert.equal(topicHasFigures({ state: 'live', figures: ['infra.apps-up'] }), true);
  assert.equal(topicHasFigures({ state: 'live', figures: [] }), false);
  assert.equal(topicHasFigures({ state: 'archived', figures: ['infra.apps-up'] }), false);
  assert.equal(figuresUrl('usernode-2d5619', 'infra', true), '/api/apps/usernode-2d5619/topics/infra/figures?demo=1');
  assert.equal(figuresUrl('usernode-2d5619', 'infra'), '/api/apps/usernode-2d5619/topics/infra/figures');
});

test('the strip\'s own words are catalog entries', () => {
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const key of ['label', 'window_one', 'window_other', 'whatItMeans', 'demo']) {
    const entry = catalog[`places.topicFigures.${key}`];
    assert.ok(entry && entry.text && entry.description, key);
  }
  assert.equal(catalog['places.topicFigures.scopeLabel'], undefined, 'the choice of projects is gone');
});

// ── 4. The records the Infra figures read ────────────────────────────────

test('a production build stamps the merges it carries; staging and an unknown build stamp nothing', async () => {
  const release = require('../src/services/platform-release');
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push(params); return { rows: [{ id: 1 }, { id: 2 }] }; } };
  assert.equal(await release.recordRunning(pool, { sha: 'a'.repeat(40), env: 'staging' }), 0);
  assert.equal(await release.recordRunning(pool, { sha: 'not-a-sha', env: 'production' }), 0);
  assert.equal(calls.length, 0);
  assert.equal(await release.recordRunning(pool, { sha: 'A'.repeat(40), env: 'production' }), 2);
  assert.deepEqual(calls, [['a'.repeat(40)]]);
  const broken = { query: async () => { throw new Error('down'); } };
  assert.equal(await release.recordRunning(broken, { sha: 'b'.repeat(40), env: 'production' }), 0, 'never throws');
  // Every process records it once it serves, and that it came up.
  assert.match(read('server.js'), /app\.listen\(config\.port, \(\) => \{[\s\S]{0,400}platformRelease\.recordRunning\(getPool\(config\)\);\s*platformRelease\.recordBoot\(getPool\(config\)\);/);
});

test('a process on Kubernetes says it came up and in which pod; staging and anything off Kubernetes say nothing', async () => {
  const release = require('../src/services/platform-release');
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push(params); return { rows: [] }; } };
  await release.recordBoot(pool, { sha: 'a'.repeat(40), env: 'production', onKubernetes: false, pod: 'web-1' });
  await release.recordBoot(pool, { sha: 'a'.repeat(40), env: 'staging', onKubernetes: true, pod: 'preview-1' });
  assert.equal(calls.length, 0);
  await release.recordBoot(pool, { sha: 'A'.repeat(40), env: 'production', onKubernetes: true, pod: 'social-platform-7d9f-x2' });
  await release.recordBoot(pool, { sha: 'unknown', env: 'production', onKubernetes: true, pod: 'social-platform-7d9f-x2' });
  assert.deepEqual(calls.map((p) => [p[3], JSON.parse(p[4])]), [
    ['platform_booted', { sha: 'a'.repeat(40), pod: 'social-platform-7d9f-x2' }],
    ['platform_booted', { sha: null, pod: 'social-platform-7d9f-x2' }],
  ]);
  const broken = { query: async () => { throw new Error('down'); } };
  await release.recordBoot(broken, { env: 'production', onKubernetes: true, pod: 'web-1' });
});

test('the triggers counted as the same code again are check triggers, and none of them moves the code', () => {
  const declared = [...read('src/workflow/rules/check-store.ts').match(/const CHECK_TRIGGERS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  for (const trigger of figures.SAME_CODE_TRIGGERS) assert.ok(declared.includes(trigger), trigger);
  for (const moves of ['proposal-open', 'commit-push', 'sync-main', 'pr-import', 'conflict-resolved', 'fleet-maintenance']) {
    assert.ok(!figures.SAME_CODE_TRIGGERS.includes(moves), moves);
  }
});

test('a down app is kept once per app per minute; only a heal that brought it back is a restart', async () => {
  const outages = require('../src/services/app-outages');
  outages._resetForTests();
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push([sql.includes("'app_restarted'") ? 'restarted' : 'unavailable', params]); return { rows: [] }; } };
  const minute = Date.UTC(2026, 9, 10, 12, 0, 5);
  await outages.recordUnavailable(pool, 'garden-club', minute);
  await outages.recordUnavailable(pool, 'garden-club', minute + 30000);
  await outages.recordUnavailable(pool, 'garden-club', minute + 60000);
  assert.deepEqual(calls.map((c) => c[1]), [['garden-club', String(Math.floor(minute / 60000))], ['garden-club', String(Math.floor(minute / 60000) + 1)]],
    'the page\'s storm of hits in one minute is one write');
  calls.length = 0;
  const app = { id: 7, slug: 'garden-club' };
  for (const status of ['healthy', 'cooldown', 'in_flight', 'deploying', 'heal_failed', 'restart_grace']) await outages.recordHealed(pool, app, { status }, 'sweep', minute);
  assert.equal(calls.length, 0);
  for (const status of outages.RESTART_OUTCOMES) await outages.recordHealed(pool, app, { status }, 'visit', minute);
  assert.deepEqual(calls.map((c) => c[1][2]), ['started', 'restarted', 'deploy_requested', 'respawned']);
  await outages.recordHealed(pool, { ...app, self_hosted: true }, { status: 'restarted' }, 'sweep', minute);
  assert.equal(calls.length, 4, 'Homeroom itself is never recorded');
  // The watchdog records both of its paths; the page records a document load.
  const heal = read('src/services/app-heal.js');
  assert.match(heal, /checkAndHealOne\(config, pool, app, \{ background: true \}\);\n\s*appOutages\.recordHealed\(pool, app, result, 'sweep'\);/);
  assert.match(heal, /checkAndHealOne\(config, pool, rows\[0\], \{ probeRunning: true \}\);\n\s*appOutages\.recordHealed\(pool, rows\[0\], result, 'visit'\);/);
  const page = read('src/routes/app-error.js');
  assert.ok(page.indexOf('if (!isDocument)') < page.indexOf('appOutages.recordUnavailable(pool, productionSlug)'), 'a fetch from a half-loaded app is not an open');
});

// ── 5. Against the full schema ───────────────────────────────────────────

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

  // Records began a day ago (the schema stamps them as it runs).
  await pool.query(`UPDATE platform_settings SET value = to_char((NOW() - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                     WHERE key IN ('platform_live_tracked_since', 'app_outages_tracked_since')`);

  // Check runs: Homeroom's two slow ones and one that couldn't run, a
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
  for (let i = 0; i < 3; i += 1) await checkRun(project, 'passing', 1.5);

  // A project's merge runs: one that waited 10 minutes from its vote passing
  // to GitHub merging it, and one more merged on GitHub.
  async function mergeRun(app, sessionId, { status = 'merged', startedMins, steps = [] }) {
    const run = (await pool.query(
      `INSERT INTO merge_debug_runs (app_id, session_id, kind, status, started_at, ended_at)
       VALUES ($1, $2, 'merge', $3, $4, $4) RETURNING id`,
      [app.id, sessionId, status, ago(startedMins)],
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
    steps: [{ phase: 'github_merge', detail: { sha: 'abc' }, mins: 190 }],
  });
  await mergeRun(project, null, {
    startedMins: 150,
    steps: [{ phase: 'github_merge', detail: { sha: 'def' }, mins: 149 }],
  });
  // The same merges on the merge-followups machine, one instance each,
  // written as the kernel writes them (only the transition pipeline may):
  // the first live 6 minutes after GitHub merged it, the second's deploy
  // failed. A change another merge carried in, and Homeroom's own merge, are
  // not counted.
  async function mergeFollowups(key, appId, state, data) {
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version)
        VALUES ('merge-followups', '${key}', ${Number(appId)}, '${state}', '${JSON.stringify(data)}'::jsonb, 5);
      COMMIT`);
  }
  await mergeFollowups(`session:${session}`, project.id, 'live',
    { role: 'merge', selfHosted: false, mergedAt: ago(190).toISOString(), liveAt: ago(184).toISOString() });
  await mergeFollowups('session:900001', project.id, 'deploy_failed',
    { role: 'merge', selfHosted: false, mergedAt: ago(149).toISOString(), liveAt: null });
  await mergeFollowups('session:900002', project.id, 'live',
    { role: 'included', selfHosted: false, mergedAt: ago(149).toISOString(), liveAt: ago(140).toISOString() });
  await mergeFollowups('session:900003', platform.id, 'live',
    { role: 'merge', selfHosted: true, mergedAt: ago(100).toISOString(), liveAt: ago(99).toISOString() });

  // Merges into Homeroom: one from before records began, two that the
  // build at the second carries, and one after it.
  const sha = (c) => c.repeat(40);
  const homeroomMerge = async (c, mins) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, merged_at, merge_commit_sha) VALUES ($1, $2, 'merged', $3, $4) RETURNING id`,
    [platform.id, person, ago(mins), sha(c)],
  )).rows[0].id;
  const before = await homeroomMerge('a', 60 * 30);
  const first = await homeroomMerge('b', 300);
  const second = await homeroomMerge('c', 200);
  const pending = await homeroomMerge('d', 50);

  // One limit filled, notified to two admins; one only warned.
  for (const id of admins) {
    await pool.query(`INSERT INTO notifications (user_id, kind, detail, created_at) VALUES ($1, 'platform_limit', 'sessions_full:25:25', date_trunc('minute', NOW()) - interval '2 hours')`, [id]);
  }
  await pool.query(`INSERT INTO notifications (user_id, kind, detail, created_at) VALUES ($1, 'platform_limit', 'apps_warn:40:50', NOW() - interval '3 hours')`, [admins[0]]);
  // Homeroom's merges paused twice: one an hour long that ended, one that
  // began 30 minutes ago and is still on. The project's once, for 10
  // minutes, three days ago. A pause that ended before the week is not
  // counted; one that began a day before it is counted from its start.
  const mark = (app, type, when) => pool.query(`INSERT INTO events (app_id, event_type, metadata, created_at)
    VALUES ($1, $2, '{}'::jsonb, NOW() - $3::interval)`, [app.id, type, when]);
  await mark(platform, 'main_paused', '2 hours');
  await mark(platform, 'main_resumed', '1 hour');
  await mark(platform, 'main_paused', '30 minutes');
  await mark(project, 'main_paused', '3 days');
  await mark(project, 'main_resumed', '3 days - 10 minutes');
  await mark(project, 'main_paused', '9 days');
  await mark(project, 'main_resumed', '8 days 23 hours');
  // Two people turned away at a session cap this week, one a fortnight ago.
  for (const [cap, when] of [['global', '1 hour'], ['user', '30 minutes'], ['global', '14 days']]) {
    await pool.query(`INSERT INTO events (user_id, event_type, metadata, created_at)
      VALUES ($1, 'session_capacity_refused', $2::jsonb, NOW() - $3::interval)`, [person, JSON.stringify({ cap, path: 'start' }), when]);
  }

  // Homeroom's releases: one commit stalled running then failed (one stall),
  // one never came up, and one stalled before the week began.
  for (const [s, kind, when] of [[sha('a'), 'workflow_running', '3 hours'], [sha('a'), 'workflow_failed', '2 hours'],
    [sha('b'), 'rollout_missing', '1 day'], [sha('c'), 'workflow_failed', '9 days']]) {
    await pool.query(`INSERT INTO events (app_id, event_type, metadata, created_at) VALUES ($1, 'release_stalled', $2::jsonb, NOW() - $3::interval)`,
      [platform.id, JSON.stringify({ sha: s, kind }), when]);
  }
  // Its processes: one pod came up three times (two crashes), one once (a
  // rollout's new pod), and one came up again after its first boot had left
  // the week behind, still within the week's look back.
  for (const [pod, when] of [['web-a', '3 days'], ['web-a', '2 days'], ['web-a', '1 day'], ['web-b', '5 hours'],
    ['web-c', '8 days'], ['web-c', '6 days 23 hours']]) {
    await pool.query(`INSERT INTO events (event_type, metadata, created_at) VALUES ('platform_booted', $1::jsonb, NOW() - $2::interval)`,
      [JSON.stringify({ sha: sha('d'), pod }), when]);
  }

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
  await pool.query(`INSERT INTO homeroom_bot_dm_turns (user_id, cost_usd, created_at) VALUES ($1, 0.04, $2)`, [person, ago(90)]);

  // The bot's builds for the project: a live one that cost $1.20 and became
  // its one merged proposal, and a shadow one ($5) that could never merge.
  const botRun = (mode, issue, read, build) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd, created_at)
     VALUES ($1, $2, $3, 'ready', $4, $5, $6)`,
    [project.id, issue, mode, read, build, ago(300)],
  );
  await botRun('live', 11, 0.02, 1.18);
  await botRun('shadow', 12, 0.03, 4.97);
  await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, merged_at) VALUES ($1, $2, 'merged', $3)`, [project.id, bot, ago(60)]);

  // Let in from the waitlist two days ago: ten people, three of whom made
  // an account. Not counted: an admin's three test releases, a team
  // address, a test account, and an account left out of the Journey; any
  // one of them counted would move the figure off "About 30%".
  const release = async (email, userId = null) => (await pool.query(
    `INSERT INTO waitlist_signups (email, submitted_at, released_at, linked_user_id, confirmed_at)
     VALUES ($1, NOW() - interval '9 days', NOW() - interval '2 days', $2, NOW() - interval '9 days') RETURNING id`,
    [email, userId],
  )).rows[0].id;
  const joined = async (name, email, extra = '') => (await pool.query(
    `INSERT INTO users (username, password, email, has_platform_access, platform_access_granted_at${extra ? ', test_account_created_at' : ''})
     VALUES ($1, 'x', $2, TRUE, NOW() - interval '2 days' + interval '5 minutes'${extra ? ', NOW()' : ''}) RETURNING id`,
    [name, email],
  )).rows[0].id;
  for (let i = 0; i < 10; i += 1) {
    const email = `new${i}@example.com`;
    await release(email, i < 3 ? await joined(`new${i}`, email) : null);
  }
  for (let i = 0; i < 3; i += 1) {
    const tested = await release(`trying${i}@example.com`);
    await pool.query('INSERT INTO test_waitlist_releases (signup_id) VALUES ($1)', [tested]);
  }
  await release('ops@usernodelabs.com', await joined('opsmember', 'ops@usernodelabs.com'));
  await release('tester@example.com', await joined('tester', 'tester@example.com', 'test'));
  const leftOut = await joined('leftout', 'leftout@example.com');
  await release('leftout@example.com', leftOut);
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('journey_left_out', $1)`,
    [JSON.stringify([{ userId: leftOut, reason: 'test', note: 'qa' }])]);

  const outages = require('../src/services/app-outages');
  outages._resetForTests();

  await t.test('the pipeline\'s figures, Homeroom beside the other projects', async () => {
    const got = byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline']));
    assert.deepEqual(sidesOf(got['pipeline.checks-time']), [['homeroom', 'warn', '20 min', ''], ['others', 'ok', '2 min', '']]);
    assert.deepEqual(sidesOf(got['pipeline.checks-couldnt-run']), [['homeroom', 'warn', '33%', '1 of 3 runs'], ['others', 'ok', '0%', '0 of 3 runs']]);
    assert.deepEqual(sidesOf(got['pipeline.vote-to-merged']), [['homeroom', 'empty', 'None yet', ''], ['others', 'ok', '10 min', '']]);
    assert.equal(got['pipeline.shots'].state, 'empty');
    const paused = sidesOf(got['pipeline.main-paused']);
    assert.deepEqual(paused.map(([key, state, value]) => [key, state, value]), [['homeroom', 'warn', '2 times'], ['others', 'warn', '1 time']]);
    // The window ends on a 10-minute step, so the pause still running counts
    // 20 to 30 of its minutes.
    assert.match(paused[0][3], /^1 h [23]\d min in all$/, 'the hour that ended and the half hour still running');
    assert.equal(paused[1][3], '10 min in all');
  });

  await t.test('a production build stamps the merges into Homeroom it carries, once', async () => {
    const release = require('../src/services/platform-release');
    assert.equal(await release.recordRunning(pool, { sha: sha('e'), env: 'production' }), 0, 'a build that is no merge\'s stamps nothing');
    assert.equal(await release.recordRunning(pool, { sha: sha('c'), env: 'production' }), 2);
    assert.equal(await release.recordRunning(pool, { sha: sha('c'), env: 'production' }), 0, 'a restart or a second process changes nothing');
    const { rows } = await pool.query('SELECT id, platform_live_at IS NOT NULL AS live FROM chat_sessions WHERE app_id = $1 ORDER BY id', [platform.id]);
    assert.deepEqual(rows.map((r) => [r.id, r.live]), [[before, false], [first, true], [second, true], [pending, false]],
      'not a merge from before records began, nor one the build does not carry');
    // Live 18 and 22 minutes after merging.
    await pool.query(`UPDATE chat_sessions SET platform_live_at = merged_at + interval '18 minutes' WHERE id = $1`, [first]);
    await pool.query(`UPDATE chat_sessions SET platform_live_at = merged_at + interval '22 minutes' WHERE id = $1`, [second]);
  });

  await t.test('infra: merge to live for both, deploys and app opens for the projects, restarts, a filled limit counted once', async () => {
    // The project's app was down in one minute: an open then failed, two
    // later ones worked; Homeroom's opens are not counted. The watchdog
    // brought it back twice in that minute and once ten minutes later.
    // The page at 55 seconds past a minute, its row stamped at the minute's
    // start; the open it belonged to stamped 10 seconds later (a browser
    // clock a little fast), 65 seconds after the row, still reads as failed.
    const downAt = Math.floor(ago(40).getTime() / 60000) * 60000 + 55000;
    await outages.recordUnavailable(pool, project.slug, downAt);
    await outages.recordUnavailable(pool, platform.slug, downAt);
    await outages.recordHealed(pool, project, { status: 'restarted' }, 'sweep', downAt);
    await outages.recordHealed(pool, project, { status: 'deploy_requested' }, 'visit', downAt + 1000);
    await outages.recordHealed(pool, project, { status: 'started' }, 'sweep', downAt + 10 * 60 * 1000);
    await outages.recordHealed(pool, project, { status: 'healthy' }, 'sweep', downAt);
    await outages.recordHealed(pool, platform, { status: 'restarted' }, 'sweep', downAt);
    const open = (app, at) => pool.query(
      `INSERT INTO events (user_id, app_id, event_type, metadata, created_at) VALUES ($1, $2, 'dapp_opened', $3::jsonb, $4)`,
      [person, app.id, JSON.stringify({ openingId: crypto.randomUUID() }), new Date(at)],
    );
    await open(project, downAt + 10000);
    await open(project, downAt + 15 * 60 * 1000);
    await open(project, downAt + 16 * 60 * 1000);
    await open(platform, downAt + 10000);
    await open(project, Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(`SELECT event_type, metadata->>'count' AS count FROM events WHERE event_type IN ('app_unavailable', 'app_restarted') ORDER BY id`);
    assert.deepEqual(rows.map((r) => [r.event_type, r.count]), [['app_unavailable', null], ['app_restarted', '2'], ['app_restarted', '1']]);

    const got = byId(await figures.figuresFor(pool, TOPIC_IDS.infra));
    // Both records began a day ago, inside the week, so their lines say so
    // (#4697); the projects' deploys were always recorded.
    const { rows: [began] } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'platform_live_tracked_since'`);
    const day = utcDay(began.value);
    assert.deepEqual(sidesOf(got['infra.merge-to-live']), [['homeroom', 'warn', '20 min', `since ${day}`], ['others', 'warn', '6 min', '']]);
    assert.deepEqual([got['infra.deploys-failed'].value, got['infra.deploys-failed'].sub, got['infra.deploys-failed'].state],
      ['50%', '1 of 2 project merges · over 5% target', 'warn']);
    assert.deepEqual([got['infra.apps-up'].value, got['infra.apps-up'].sub, got['infra.apps-up'].state],
      ['67%', `2 of 3 opens since ${day} · below 99% target`, 'warn'], 'an open from before the records began is not counted');
    assert.deepEqual([got['infra.restarts'].value, got['infra.restarts'].sub], ['3 times', 'in 1 project']);
    assert.deepEqual([got['infra.limits-filled'].value, got['infra.limits-filled'].state], ['1 time', 'warn']);
    assert.deepEqual([got['infra.turned-away'].value, got['infra.turned-away'].state], ['2 times', 'warn'],
      'each refusal in the week, whichever cap; not the one a fortnight ago');
    assert.deepEqual([got['infra.homeroom-stalls'].value, got['infra.homeroom-stalls'].state], ['2 times', 'warn'],
      'one commit is one stall, whatever its kinds; not the one before the week');
    assert.deepEqual([got['infra.homeroom-crashes'].value, got['infra.homeroom-crashes'].state], ['3 times', 'warn'],
      'a pod coming up again is a crash; a new pod is a rollout');
  });

  await t.test('the bot: quality for everyone, cost and speed for Homeroom beside the other projects; a DM is Homeroom\'s', async () => {
    const got = byId(await figures.figuresFor(pool, TOPIC_IDS['homeroom-bot']));
    assert.deepEqual([got['bot.answered'].value, got['bot.answered'].state], ['80%', 'warn'], 'three of four in the chat and the DM');
    assert.equal(got['bot.answered'].sides, undefined);
    assert.deepEqual(sidesOf(got['bot.reply-cost']), [['homeroom', 'ok', '$4.00', ''], ['others', 'ok', '$3.33', '']],
      'per 100 replies: the DM for Homeroom; the project\'s 10 cents over three replies');
    assert.deepEqual(sidesOf(got['bot.reply-time']), [['homeroom', 'empty', 'None yet', ''], ['others', 'ok', '12 s', '']]);
    assert.equal(got['bot.merged'].state, 'empty');
    assert.deepEqual(sidesOf(got['bot.merged-cost']), [['homeroom', 'empty', 'None yet', ''], ['others', 'ok', '$1.20', '']],
      'a shadow build could never become a proposal, so no merge pays for it');
  });

  await t.test('the bot\'s builds: those that reached a vote, first versions, and the spend that bought no proposal', async () => {
    // A build session each; the one that became a proposal points at it.
    const buildSession = async (app, status = 'paused') => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, $3) RETURNING id`, [app.id, bot, status],
    )).rows[0].id;
    const build = async (app, issue, { mode = 'live', ok = null, error = null, cost = 0, proposed = false, session = true }) => {
      const sid = session ? await buildSession(app, proposed ? 'promoted' : 'paused') : null;
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error, build_cost_usd,
                                        build_session_id, proposal_session_id, created_at)
         VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8, $9)`,
        [app.id, issue, mode, ok, error, cost, sid, proposed ? sid : null, ago(240)],
      );
    };
    // The project: a first version proposed; a first version a restart cut
    // short (a failure); a build stopped because its request was closed (not
    // a failure, but its spend is spend); one still under way; a shadow build
    // and a run never built, neither counted.
    await pool.query(`INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, first_version) VALUES ($1, 21, $2, TRUE)`, [project.id, person]);
    await pool.query(`INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number) VALUES ($1, $2, 'a garden log', 'filed', 22)`, [project.id, person]);
    await build(project, 21, { ok: true, cost: 2, proposed: true });
    await build(project, 22, { ok: false, cost: 1, error: 'interrupted: the build turn was cut short by a restart; the issue was sent back to be triaged again' });
    await build(project, 23, { ok: false, cost: 0.5, error: 'skipped: the request was closed before it was proposed' });
    await build(project, 24, { cost: 0.25 });
    await build(project, 25, { mode: 'shadow', ok: false, cost: 9, error: 'the build did not succeed' });
    await build(project, 26, { ok: false, cost: 7, error: 'skipped: nobody tapped Build it within a week', session: false });
    // Homeroom: one build that failed.
    await build(platform, 31, { ok: false, cost: 3, error: 'the build did not succeed' });

    figures._resetForTests();
    const got = byId(await figures.figuresFor(pool, TOPIC_IDS['homeroom-bot']));
    assert.deepEqual(sidesOf(got['bot.builds-proposed']), [['homeroom', 'warn', '0%', '0 of 1 builds'], ['others', 'warn', '50%', '1 of 2 builds']],
      'the skipped, the unfinished, the shadow and the never-built are not counted');
    assert.deepEqual(sidesOf(got['bot.first-versions']), [['homeroom', 'empty', 'None yet', ''], ['others', 'warn', '50%', '1 of 2 first versions']],
      'a first version is one the requester record or the first-version record names');
    assert.deepEqual(sidesOf(got['bot.failed-spend']), [['homeroom', 'warn', '100%', '$3.00 of $3.00'], ['others', 'warn', '27%', '$1.00 of $3.75']],
      'the restart\'s dollar of every live build\'s spend, the skipped and the unfinished included');
    assert.equal(got['bot.merged'].label, 'Proposals merged');
  });

  await t.test('onboarding: people let in from the waitlist who made an account, real people only, rounded', async () => {
    const got = byId(await figures.figuresFor(pool, TOPIC_IDS.onboarding, { now: Date.now() + 24 * 60 * 60 * 1000 }));
    assert.deepEqual([got['onboarding.sign-up'].value, got['onboarding.sign-up'].sub], ['About 30%', 'rounded · small group'],
      'three of the ten; the test releases, the team, the test account and the left-out account are not counted');
    assert.deepEqual([got['onboarding.first-project'].value, got['onboarding.found-project'].value], ['Not enough data', 'Not enough data']);
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
    await reconcile([{ id: 'infra', handle: 'infra', name: 'Infra', figures: ['infra.merge-to-live'] }, { id: 'quiet', handle: 'quiet', name: 'Quiet' }]);
    assert.deepEqual((await places.placesFor(pool, platform, null)).channels[0].figures, ['infra.merge-to-live'], 'a change to the list applies');

    const { topicFiguresRoutes } = require('../src/routes/topic-figures');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: person, username: 'maya' }; next(); });
    app.use(topicFiguresRoutes({}));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/apps/usernode-2d5619/topics`;
    const get = async (p) => { const res = await fetch(`${base}${p}`); return { status: res.status, body: await res.json() }; };
    const one = await get('/infra/figures?demo=1');
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.topic, one.body.demo, one.body.figures.map((f) => f.id)], ['infra', undefined, ['infra.merge-to-live']],
      'outside staging ?demo=1 changes nothing');
    const { rows: [began] } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'platform_live_tracked_since'`);
    assert.deepEqual(sidesOf(one.body.figures[0]), [['homeroom', 'warn', '20 min', `since ${utcDay(began.value)}`], ['others', 'warn', '6 min', '']]);
    assert.equal('scope' in one.body, false);
    assert.deepEqual((await get('/quiet/figures')).body, { topic: 'quiet', figures: [] });
    assert.equal((await get('/nowhere/figures')).status, 404);
    await reconcile([{ id: 'quiet', handle: 'quiet', name: 'Quiet' }]);
    assert.deepEqual((await get('/infra/figures')).body.figures, [], 'a retired topic shows none');
  });

  await t.test('reds the same code passed when it ran again, on proposals and on main', async () => {
    // Nothing yet: the one red above belongs to no proposal.
    assert.deepEqual(sidesOf(byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline']))['pipeline.reds-rerun']),
      [['homeroom', 'empty', 'None yet', ''], ['others', 'empty', 'None yet', '']]);
    const proposal = async (app) => (await pool.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, person])).rows[0].id;
    // A proposal's check runs in order, `mins` ago, each [status, trigger].
    const runs = async (app, list) => {
      const id = await proposal(app);
      for (const [status, trigger, mins] of list) {
        await pool.query(
          `INSERT INTO merge_debug_runs (app_id, session_id, kind, trigger, status, started_at, ended_at)
           VALUES ($1, $2, 'checks', $3, $4, $5, $5)`, [app.id, id, trigger, status, ago(mins)]);
      }
    };
    // Homeroom: green on a person's re-run; green on a sweep after a re-drive
    // that never reached a verdict; green only after a new commit.
    await runs(platform, [['failing', 'commit-push', 50], ['passing', 'manual-recheck', 45]]);
    await runs(platform, [['failing', 'proposal-open', 50], ['error', 'stuck-sweep', 48], ['passing', 'stuck-sweep', 40]]);
    await runs(platform, [['failing', 'commit-push', 50], ['passing', 'commit-push', 30]]);
    // The project: a red nobody ran again, and one whose sync with main came
    // between it and the green (different code).
    await runs(project, [['failing', 'commit-push', 50]]);
    await runs(project, [['failing', 'commit-push', 50], ['error', 'sync-main', 45], ['passing', 'manual-recheck', 40]]);
    // Main: Homeroom's one merge cleared on its confirm run and one red
    // twice; the project's one cleared, one plain green, one red before the
    // week.
    const verdict = (app, c, state, flake, when) => pool.query(
      `INSERT INTO main_watch_verdicts (app_id, sha, state, confirmed, flake, created_at) VALUES ($1, $2, $3, $4, $5, NOW() - $6::interval)`,
      [app.id, sha(c), state, state === 'failing' ? true : null, flake, when]);
    await verdict(platform, '1', 'passing', true, '2 hours');
    await verdict(platform, '2', 'failing', false, '1 hour');
    await verdict(project, '3', 'passing', true, '3 hours');
    await verdict(project, '4', 'passing', false, '2 hours');
    await verdict(project, '5', 'failing', false, '9 days');

    figures._resetForTests();
    const got = byId(await figures.figuresFor(pool, TOPIC_IDS['proposal-pipeline']));
    assert.deepEqual(sidesOf(got['pipeline.reds-rerun']), [['homeroom', 'warn', '60%', '3 of 5 reds'], ['others', 'warn', '33%', '1 of 3 reds']]);
  });
});
