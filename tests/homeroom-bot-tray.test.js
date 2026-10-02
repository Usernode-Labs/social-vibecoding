'use strict';

// #3692: the activity tray at the top of the Homeroom bot's DM.
//
// tests/homeroom-bot-tray-postgres.test.js pins whose work the endpoint reads
// on the real schema. This file pins the rest without a database:
//
//   - the service's pure rules: how an in-flight entry of the bot's own
//     progress (homeroom-bot-progress.js) is drawn, what a run came to, where
//     a row opens;
//   - the live loop announcing, to the person it is for, when it starts and
//     finishes their work (the tray's realtime), and app.js turning that
//     announcement into the window event the tray listens for;
//   - the tray's render: a strip only while something is in flight, the
//     panel's now and history, its loading and failed states, and links that
//     only ever go to the platform's own addresses;
//   - where it is mounted: the bot's DM only, with the ⋯ menu's way in.
//
// Run with: node --test tests/homeroom-bot-tray.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const TRAY = 'frontend/src/features/messages/bot-work.tsx';
const API = 'frontend/src/features/messages/api.ts';

const tray = require('../src/services/homeroom-bot-tray');
const bot = require('../src/services/homeroom-bot');

// ── The service's rules ───────────────────────────────────────────────

test('#3734: Now is the bot\'s own progress, its in-flight entries drawn as steps', () => {
  const progress = require('../src/services/homeroom-bot-progress');
  // Every stage the bot calls in flight has a step the tray draws, and the
  // tray draws nothing the bot does not call in flight.
  assert.deepEqual(Object.keys(tray.PHASE_OF_STAGE).sort(), [...progress.IN_FLIGHT_STAGES].sort());
  const item = (extra) => ({
    project: 'ear trainer', projectName: 'Ear Trainer', number: 12, title: 'Sort by date', since: '2026-10-02T10:00:00.000Z', ...extra,
  });
  assert.deepEqual(tray.jobOfProgress(item({ stage: 'reading' })), {
    appSlug: 'ear trainer', appName: 'Ear Trainer', issueNumber: 12, title: 'Sort by date', firstVersion: false,
    phase: 'looking', since: '2026-10-02T10:00:00.000Z', href: '#app/ear%20trainer/dev/issues/12',
  });
  for (const stage of ['starting', 'planning', 'building', 'proposing']) {
    assert.equal(tray.jobOfProgress(item({ stage })).phase, 'building', stage);
  }
  assert.equal(tray.jobOfProgress(item({ stage: 'queued' })).phase, 'queued');
  // A follow-up on its proposal, waiting its turn or running, opens the proposal.
  const onProposal = { proposal: { proposal: 40, status: 'up for a vote' } };
  for (const [stage, phase] of [['followup_queued', 'follow_up_queued'], ['fix_queued', 'follow_up_queued'],
    ['revising', 'following_up'], ['fixing', 'following_up'], ['merging', 'merging']]) {
    const job = tray.jobOfProgress(item({ stage, ...onProposal }));
    assert.equal(job.phase, phase, stage);
    assert.equal(job.href, '#app/ear%20trainer/dev/proposals/40', stage);
  }
  const setup = tray.jobOfProgress({ project: 'ear-trainer', projectName: 'Ear Trainer', title: 'First version', firstVersion: true, stage: 'setting_up' });
  assert.deepEqual([setup.phase, setup.firstVersion, setup.title, setup.issueNumber, setup.href],
    ['setting_up', true, null, null, '#app/ear-trainer/app']);
  // What waits on the person or the group, or on the checks, is not in flight.
  for (const stage of ['question', 'vote', 'checks', 'checks_failed', 'held', 'stalled']) {
    assert.equal(tray.jobOfProgress(item({ stage })), null, stage);
  }
  assert.equal(tray.jobOfProgress(item({ stage: 'setting_up', waitingOn: 'them' })), null, 'a project waiting for its secrets');
});

test('what a run came to: a ready verdict is told by its build and its proposal', () => {
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'promoted' }), 'proposed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'merging' }), 'proposed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'merged' }), 'live');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'closed' }), 'closed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: false }), 'build_failed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: null }), 'ready');
  for (const verdict of ['question', 'person', 'empty', 'failed', 'answer', 'revise']) {
    assert.equal(tray.outcomeOf({ verdict }), verdict);
  }
  assert.equal(tray.outcomeOf({ verdict: 'something new' }), 'failed');
  for (const outcome of ['question', 'ready', 'proposed', 'live', 'closed', 'build_failed', 'person', 'empty', 'failed', 'answer', 'revise']) {
    assert.ok(tray.OUTCOMES.includes(outcome), outcome);
  }
});

test('a row opens its proposal once people can open it, else its request', () => {
  const row = { slug: 'ear trainer', issue_number: 12, proposal_session_id: 40 };
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'promoted' }), '#app/ear%20trainer/dev/proposals/40');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'merged' }), '#app/ear%20trainer/dev/proposals/40');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'open' }), '#app/ear%20trainer/dev/issues/12',
    'a proposal nobody else can open yet');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'closed' }), '#app/ear%20trainer/dev/issues/12');
  assert.equal(tray.hrefOf({ slug: 'x', issue_number: 3 }), '#app/x/dev/issues/3');
});

test('the staging demo draws a job in flight, a follow-up waiting its turn, and a history, and links nowhere', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const demo = tray.demoWork(now);
  assert.deepEqual(demo.now.map((job) => job.phase), ['building', 'follow_up_queued']);
  assert.ok(demo.now.every((job) => tray.PHASES.includes(job.phase)));
  assert.ok(demo.history.length >= 3);
  for (const job of [...demo.now, ...demo.history]) {
    assert.equal(job.href, null, 'no project stands behind the demo');
    assert.equal(job.appName, 'Staging demo app');
  }
  assert.ok(demo.history.every((job, i, all) => i === 0 || Date.parse(all[i - 1].at) > Date.parse(job.at)), 'newest first');
});

test('the route reads the signed-in person and nothing the request names', () => {
  const routes = read('src/routes/conversations.js');
  const start = routes.indexOf("router.get('/api/conversations/homeroom-bot/work'");
  assert.ok(start > -1, 'the route exists');
  assert.ok(start < routes.indexOf("router.get('/api/conversations/:id',"), 'and is declared before the id routes');
  const body = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(body, /tray\.workFor\(pool, \{ user: req\.user \}\)/);
  assert.doesNotMatch(body, /req\.(?:params|body)|req\.query\.(?!demo)/, 'no user, id or slug is read from the request');
  assert.match(read('src/services/homeroom-bot-tray.js'), /WHERE q\.user_id = \$1 AND r\.mode = 'live'/);
});

// ── The realtime: the live loop says when it starts and ends ──────────

/** A pool that answers the loop's queries, with live candidates to start (as homeroom-bot-at-once.test.js). */
function loopPool({ settings, candidates = [], apps = [] }) {
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/COALESCE\(r\.user_id, i\.created_by\) AS person_id/.test(s) && /WHERE q\.started_at IS NULL/.test(s)) {
        return { rows: candidates.filter((c) => !params[1].includes(c.app_id)) };
      }
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: apps.filter((a) => params[0].includes(a.id)) };
      if (/SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL RETURNING id/.test(s)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
}

test('the live loop tells the person a piece of work is for when it starts and when it ends', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(['a1', 'a2']) },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const row = (id, appId, personId) => ({ id, app_id: appId, issue_number: id, priority: 1, reason: 'new', person_id: personId });
  const apps = [101, 102].map((id, i) => ({ id, slug: `a${i + 1}`, name: `a${i + 1}`, repo_url: `https://github.com/o/a${i + 1}`, self_hosted: false }));
  const pool = loopPool({ settings, candidates: [row(1, 101, 7), row(2, 102, null)], apps });
  const pushes = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    ws: { pushToUser(userId, payload) { pushes.push([userId, payload.type]); return 1; } },
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true, reason: 'weekly_cap' }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 2);
  assert.deepEqual(pushes, [[7, 'homeroom_bot_work_changed']],
    'started: person 7 hears it; an issue nobody on Homeroom filed tells nobody');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pushes, [[7, 'homeroom_bot_work_changed'], [7, 'homeroom_bot_work_changed']], 'and ended');
  bot._resetForTests();
});

test('a failed announcement never costs the work', () => {
  const ws = { pushToUser() { throw new Error('socket gone'); } };
  assert.equal(tray.noteWorkChanged(7, { ws }), 0);
});

test('app.js turns the announcement into the tray\'s window event, and asks again after a reconnect', () => {
  const app = read('public/js/app.js');
  const { WORK_CHANGED_EVENT } = loadTsx(TRAY);
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed');
  assert.match(app, /case 'homeroom_bot_work_changed':\s*(?:\/\/[^\n]*\n\s*)*window\.dispatchEvent\(new CustomEvent\('homeroom-bot-work-changed'\)\);\s*break;/);
  const resync = app.slice(app.indexOf('  resyncCurrentView() {'), app.indexOf('// #1038:', app.indexOf('  resyncCurrentView() {')));
  assert.match(resync, /window\.dispatchEvent\?\.\(new CustomEvent\('homeroom-bot-work-changed'\)\)/);
});

// ── The tray, drawn ───────────────────────────────────────────────────

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const job = (extra) => ({
  appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: null, title: null, firstVersion: false, href: null, ...extra,
});

function draw(props) {
  const { BotWorkTrayView } = loadTsx(TRAY);
  return renderToHtml(createElement(BotWorkTrayView, { now: NOW, ...props }));
}

test('nothing in flight and the panel shut: the tray draws nothing at all', () => {
  assert.equal(draw({ work: null, open: false }), '');
  assert.equal(draw({ work: { now: [], history: [job({ id: 1, outcome: 'live', at: minutesAgo(60) })] }, open: false }), '');
});

test('the strip names what the bot is working on and the step it is at', () => {
  const html = draw({
    work: { now: [job({ firstVersion: true, phase: 'building', since: minutesAgo(4) })], history: [] },
    open: false,
  });
  assert.match(html, /data-bot-work-strip=""/);
  assert.match(html, /Working on: Ear Trainer first version · building/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="messages-bot-work-panel"/);
  assert.doesNotMatch(html, /data-bot-work-panel/, 'the panel opens on a tap');
  assert.doesNotMatch(html, /more/);

  const two = draw({
    work: {
      now: [
        job({ issueNumber: 12, title: 'Sort by date', phase: 'looking', since: minutesAgo(1) }),
        job({ appSlug: 'notes', appName: 'Notes', issueNumber: 3, phase: 'building', since: minutesAgo(9) }),
      ],
      history: [],
    },
    open: false,
  });
  assert.match(two, /Working on: Ear Trainer #12 · looking at it/);
  assert.match(two, /\+1 more/);
});

test('the panel lists what is in flight and the history, each a link to the platform\'s own page', () => {
  const html = draw({
    work: {
      now: [job({ issueNumber: 12, title: 'Sort by date', phase: 'building', since: minutesAgo(4), href: '#app/ear-trainer/dev/issues/12' })],
      history: [
        job({ id: 2, issueNumber: 9, title: 'Item counts', outcome: 'proposed', at: minutesAgo(90), href: '#app/ear-trainer/dev/proposals/40' }),
        job({ id: 1, firstVersion: true, outcome: 'live', at: minutesAgo(60 * 24 * 3), href: '#app/ear-trainer/dev/issues/1' }),
      ],
    },
    open: true,
  });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<section id="messages-bot-work-panel"[^>]*aria-label="Homeroom bot activity"/);
  assert.match(html, />Now</);
  assert.match(html, />History</);
  assert.match(html, /<a [^>]*data-bot-work-row="now" href="#app\/ear-trainer\/dev\/issues\/12"/);
  assert.match(html, /Ear Trainer #12: Sort by date/);
  assert.match(html, /Building · 4m ago/);
  assert.match(html, /<a [^>]*data-bot-work-row="history" href="#app\/ear-trainer\/dev\/proposals\/40"/);
  assert.match(html, /Built it and opened a proposal · 1h ago/);
  assert.match(html, /Ear Trainer first version/);
  assert.match(html, /Built it; approved and live/);
  assert.match(html, /<button type="button" aria-label="Close activity"/);
});

test('opened with nothing in flight (from the ⋯ menu): no strip, and the panel says so', () => {
  const html = draw({ work: { now: [], history: [] }, open: true });
  assert.doesNotMatch(html, /data-bot-work-strip/);
  assert.match(html, /data-bot-work-panel=""/);
  assert.match(html, /I’m not working on anything for you right now\./);
  assert.match(html, /Nothing yet\. When I work on a request of yours, it shows up here\./);
});

test('the panel before its first read, and when the read failed', () => {
  const loading = draw({ work: null, open: true });
  assert.match(loading, /role="status">Loading activity</);
  const failed = draw({ work: null, failed: true, open: true });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Couldn’t load what I’m working on\./);
  assert.match(failed, />Try again</);
  const stale = draw({ work: { now: [], history: [] }, failed: true, open: true });
  assert.match(stale, /may be out of date/, 'a failed refresh keeps what was read, and says so');
});

test('a row with nowhere to open is a plain row, not a link', () => {
  const html = draw({ work: tray.demoWork(NOW.getTime()), open: true });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /<div [^>]*data-bot-work-row="now"/);
  assert.match(html, /Staging demo app #14: Staging demo, show a total under the list/);
  assert.match(html, /Asked you a question · 35m ago/);
});

test('every phase and outcome has words', () => {
  const { PHASE_LABELS, OUTCOME_LABELS, trayLine, jobTitle, newestBotMessageId } = loadTsx(TRAY);
  assert.deepEqual(Object.keys(PHASE_LABELS).sort(), [...tray.PHASES].sort());
  assert.deepEqual(Object.keys(OUTCOME_LABELS).sort(), [...tray.OUTCOMES].sort());
  assert.equal(trayLine([]), '');
  assert.equal(trayLine([job({ issueNumber: 3, phase: 'following_up' })]), 'Working on: Ear Trainer #3 · following up on its proposal');
  assert.equal(trayLine([job({ issueNumber: 3, phase: 'follow_up_queued' })]),
    'Working on: Ear Trainer #3 · waiting its turn to follow up on its proposal');
  assert.equal(trayLine([job({ issueNumber: 4, phase: 'queued' })]), 'Working on: Ear Trainer #4 · waiting its turn in my queue');
  assert.equal(jobTitle(job({ firstVersion: true, title: 'ignored' })), 'Ear Trainer first version');
  const message = (id, isBot) => ({ id, sender: { id: isBot ? 1 : 2, username: isBot ? 'homeroom_bot' : 'ada', ...(isBot ? { bot: true } : {}) } });
  assert.equal(newestBotMessageId([message(4, true), message(7, true), message(9, false), message(-3, false)]), 7);
  assert.equal(newestBotMessageId([message(9, false)]), null);
});

test('the client keeps only the platform\'s own addresses as links, and known words', () => {
  const { normalizeBotWork } = loadTsx(API);
  const work = normalizeBotWork({
    now: [
      { appSlug: 'a', appName: 'A', issueNumber: 3, phase: 'building', since: 'x', href: 'javascript:alert(1)' },
      { appSlug: 'b', appName: 'B', phase: 'dancing', href: '#app/b/app', firstVersion: true },
      ...tray.PHASES.map((phase) => ({ appSlug: 'c', appName: 'C', issueNumber: 1, phase })),
    ],
    history: [
      { id: 2, appSlug: 'a', issueNumber: 3, outcome: 'live', href: 'https://example.test/x' },
      { id: 1, appSlug: 'a', issueNumber: 1, outcome: 'nonsense', href: '#app/a/dev/issues/1' },
      { appSlug: 'a', outcome: 'live' },
    ],
  });
  assert.equal(work.now[0].href, null);
  assert.equal(work.now[1].href, '#app/b/app');
  assert.equal(work.now[1].phase, 'looking');
  assert.equal(work.now[1].firstVersion, true);
  assert.deepEqual(work.now.slice(2).map((j) => j.phase), [...tray.PHASES], 'every step the server draws is kept');
  assert.equal(work.history.length, 2, 'a row without an id is dropped');
  assert.equal(work.history[0].href, null);
  assert.equal(work.history[0].appName, 'a', 'a missing name falls back to the slug');
  assert.equal(work.history[1].outcome, 'failed');
  assert.deepEqual(normalizeBotWork(null), { now: [], history: [] });
});

test('a conversation is the bot\'s DM only when the server says so, and only a direct one', () => {
  const { normalizeConversation } = loadTsx(API);
  const direct = { id: 5, kind: 'direct', membershipStatus: 'member' };
  assert.equal(normalizeConversation({ ...direct, homeroomBot: true }).homeroomBot, true);
  assert.equal(normalizeConversation({ ...direct, homeroomBot: 'yes' }).homeroomBot, undefined);
  assert.equal(normalizeConversation(direct).homeroomBot, undefined);
  assert.equal(normalizeConversation({ ...direct, kind: 'group', homeroomBot: true }).homeroomBot, undefined);
  const service = read('src/services/conversations.js');
  assert.match(service, /\(peer_user\.is_synthetic IS TRUE AND peer_user\.username = 'homeroom_bot'\) AS peer_is_homeroom_bot/);
  assert.match(service, /\.\.\.\(accepted && row\.kind === 'direct' && row\.peer_is_homeroom_bot \? \{ homeroomBot: true \} : \{\}\)/);
});

// ── Where it is mounted ───────────────────────────────────────────────

test('only a conversation with the Homeroom bot carries the tray, and its ⋯ menu opens it', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const botDm = !!snap\.active && snap\.active\.id === conversationId && snap\.active\.kind === 'direct'\s*&& snap\.active\.membershipStatus === 'member' && snap\.active\.homeroomBot === true;/);
  assert.match(screen, /\{botDm \? <BotWorkTray conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/);
  const header = screen.slice(screen.indexOf('function ThreadHeader()'), screen.indexOf('function isCardMessage('));
  assert.match(header, /active\.kind === 'direct' && active\.homeroomBot && active\.membershipStatus === 'member'[\s\S]{0,300}setBotWorkOpen\(true\)[\s\S]{0,40}Activity &amp; history/);
  // The tray sits between the header and the transcript, in the pane React owns.
  const pane = screen.slice(screen.indexOf('<InvitationBanner />'), screen.indexOf('className="messages-thread-scroll'));
  assert.match(pane, /<BotWorkTray /);
});
