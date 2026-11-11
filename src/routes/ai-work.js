'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const threadReads = require('../services/thread-reads');
const aiWork = require('../services/ai-work');
const aiHistory = require('../services/ai-history');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { appChatReadLimiter } = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// GET /api/ai/work (#6019 follow-up): what the AI tab's main view lists
// beside the Needs you feed, for the signed-in person (services/ai-work.js).
//   → { private: PrivateRow[], needs: Row[], next: Row[], waiting: Row[], live: Row[] }
//
// `?demo=1` on staging adds a few obviously fake rows of each kind, so the
// view's declared checks and its before & after shots have something to
// draw on a copy where the fixture account is in no thread. They are on the
// projects the Needs you feed's demo cards are on (routes/workshop-overview.js
// DEMO_NEEDS_FEED), so the page tells one story: two projects, grouped, and
// every kind of row, Decide, Try again and a claim among them. Four more
// demo projects have a row waiting or gone live, so the filter has more
// projects than chips and shows its More (30 Oct 2026). Like those cards'
// slugs, these are in no database. Each says where it stands as a stored
// work state does (services/work-state.js, 5 Nov 2026).
function demoWork() {
  const app = { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null };
  const game = { slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_url: null, icon_emoji: '🎮' };
  const album = { slug: 'staging-demo-long-name', name: 'Staging demo photo album and journal', icon_url: null, icon_emoji: '📔' };
  const picture = { slug: 'staging-demo-image-icon', name: 'Staging demo image icon', icon_url: null, icon_emoji: null };
  const dice = { slug: 'staging-demo-featured-2', name: 'Staging demo featured 2', icon_url: null, icon_emoji: '🎲' };
  const puzzle = { slug: 'staging-demo-featured-3', name: 'Staging demo featured 3', icon_url: null, icon_emoji: '🧩' };
  const now = Date.now();
  const at = (hours) => new Date(now - hours * 3600000).toISOString();
  // #6401 splits each project's card by the reader's day, and #6160's check
  // reads the main demo project's rows in order, in one container. Rows aged
  // by the hour cross midnight depending on when the page loads, so these
  // share one anchor instead: the most recent 12:00 UTC, always at least an
  // hour in the past. 11:10-11:50 UTC is one day from UTC-11 to UTC+11.
  const noon = new Date(now);
  const todayNoon = Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 12);
  const anchor = now >= todayNoon + 3600000 ? todayNoon : todayNoon - 86400000;
  const day = (minutes) => new Date(anchor - minutes * 60000).toISOString();
  const issue = (a, n) => `#app/${a.slug}/dev/issues/${n}`;
  return withWords({
    private: [
      { rootId: -9101, title: 'Staging demo idea: a calendar for the garden', kind: 'idea', app: null, at: at(2) },
      { rootId: -9102, title: 'Staging demo draft: sort by date', kind: 'draft_request', app, at: at(5) },
      // #6250: a private thread filed as a request keeps its row and says
      // where it went ("Only you · Staging demo app · Filed as #404"). #404 is
      // obviously fake and names no request the demo lists.
      { rootId: -9103, title: 'Staging demo: keep my private threads in the list', kind: 'ask', app, at: at(3), state: 'filed', resultRef: 404 },
      // #6271: a private thread marked done this week, which Live this week lists.
      { rootId: -9104, title: 'Staging demo: a private thread marked done this week', kind: 'idea', app, at: at(6), state: 'done', doneAt: at(6) },
    ],
    needs: [
      { threadId: -9210, number: 9210, kind: 'work', title: 'Staging demo: a reminder email', app, change: null, href: issue(app, 9210), group: 'needs', work: { stage: 'waiting_for_you', why: 'plan' }, at: at(4), unread: 1 },
      { threadId: -9214, number: 9214, kind: 'work', title: 'Staging demo: a points table for the season', app, change: null, href: issue(app, 9214), group: 'needs', work: { stage: 'waiting_for_you', why: 'decide' }, at: at(7) },
      { threadId: -9215, number: 9215, kind: 'work', title: 'Staging demo: a high score board', app: game, change: null, href: issue(game, 9215), group: 'needs', work: { stage: 'stopped', reason: 'build_failed' }, at: at(9) },
      // #6284: the bot stopped at its own limit on a change's failing checks.
      // The row's own words and Try again pill are what its shots show.
      { threadId: -9219, number: 9219, kind: 'work', title: 'Staging demo: a change the bot stopped fixing', app, change: { id: -9219, number: 9219 }, href: issue(app, 9219), group: 'needs', work: { stage: 'stopped', reason: 'fix_stopped' }, at: at(10) },
      // A change of the person's own whose checks failed: Fix it.
      { threadId: -9227, number: 9227, kind: 'work', title: 'Staging demo: your change whose checks failed', app, change: { id: -9227, number: 9228 }, href: issue(app, 9227), group: 'needs', work: { stage: 'checking', line: { code: 'checks_failing' } }, fixYours: true, at: at(12) },
    ],
    next: [
      { threadId: -9201, number: 9201, kind: 'work', title: 'Staging demo: dark mode', app, change: { id: -9201, number: 9202 }, href: issue(app, 9201), group: 'next', work: { stage: 'going_live' }, at: day(10), unread: 1 },
      { threadId: -9208, number: 9208, kind: 'work', title: 'Staging demo: tag filter', app, change: { id: -9208, number: 9209 }, href: issue(app, 9208), group: 'next', work: { stage: 'building' }, at: day(20), by: 'bot' },
      { threadId: -9216, number: 9216, kind: 'work', title: 'Staging demo: a sound toggle', app: game, change: null, href: issue(game, 9216), group: 'next', work: { stage: 'building', line: { code: 'claimed', by: 'staging-demo-partner' } }, at: at(5), by: 'someone' },
    ],
    waiting: [
      { threadId: -9203, number: 9203, kind: 'work', title: 'Staging demo: search the board', app, change: { id: -9203, number: 9204 }, href: issue(app, 9203), group: 'waiting', work: { stage: 'up_for_vote' }, at: day(30), myVote: 'yes' },
      { threadId: -9212, number: null, kind: 'decision', title: 'Staging demo: a new card picture', app, change: null, href: `#app/${app.slug}/dev/governance/9212`, group: 'waiting', work: { stage: 'up_for_vote' }, at: day(40), myVote: null },
      { threadId: -9211, number: 9211, kind: 'work', title: 'Staging demo: export to a spreadsheet', app, change: null, href: issue(app, 9211), group: 'waiting', work: { stage: 'building', line: { code: 'held_waiting' } }, at: day(50) },
      { threadId: -9217, number: 9217, kind: 'work', title: 'Staging demo: two-player mode', app: game, change: null, href: issue(game, 9217), group: 'waiting', work: { stage: 'building', line: { code: 'queued' } }, at: at(2) },
      { threadId: -9205, number: 9205, kind: 'work', title: 'Staging demo: print view', app, change: null, href: issue(app, 9205), group: 'waiting', work: { stage: 'reading', line: { code: 'waiting' } }, at: at(240), quietDays: 10 },
      { threadId: -9220, number: 9220, kind: 'work', title: 'Staging demo: a page for each month', app: album, change: null, href: issue(album, 9220), group: 'waiting', work: { stage: 'building', line: { code: 'queued' } }, at: at(4) },
    ],
    live: [
      { threadId: -9206, number: 9206, kind: 'work', title: 'Staging demo: weekly digest', app, change: { id: -9206, number: 9207 }, href: issue(app, 9206), group: 'live', work: { stage: 'live' }, at: at(30), unread: 1 },
      { threadId: -9218, number: 9218, kind: 'work', title: 'Staging demo: a pause button', app: game, change: { id: -9218, number: 9219 }, href: issue(game, 9218), group: 'live', work: { stage: 'live' }, at: at(50) },
      { threadId: -9221, number: 9221, kind: 'work', title: 'Staging demo: a bigger cover picture', app: picture, change: { id: -9221, number: 9222 }, href: issue(picture, 9221), group: 'live', work: { stage: 'live' }, at: at(26) },
      { threadId: -9223, number: 9223, kind: 'work', title: 'Staging demo: roll two dice', app: dice, change: { id: -9223, number: 9224 }, href: issue(dice, 9223), group: 'live', work: { stage: 'live' }, at: at(60) },
      { threadId: -9225, number: 9225, kind: 'work', title: 'Staging demo: a hint button', app: puzzle, change: { id: -9225, number: 9226 }, href: issue(puzzle, 9225), group: 'live', work: { stage: 'live' }, at: at(80) },
    ],
  });
}

// The demo rows' words, as every real row carries them (services/work-state.js
// phrasesOf), so the tab draws them the same way.
function withWords(lists) {
  const { phrasesOf } = require('../services/work-state');
  const out = { ...lists };
  for (const key of ['needs', 'next', 'waiting', 'live']) {
    out[key] = (lists[key] || []).map((row) => (row.work ? { ...row, work: { ...row.work, words: phrasesOf(row.work) } } : row));
  }
  return out;
}

// `?demo=1` on staging: the History card's rows (services/ai-history.js),
// obviously fake, on the same demo projects as demoWork, two months of them
// and a community the person left, so its months, its projects, its kinds
// and Earlier months all have something to show. Its second page is the
// `before` the first one names.
function demoHistory({ before = null, project = null, kind = null } = {}, now = Date.now()) {
  const app = { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null };
  const game = { slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_url: null, icon_emoji: '🎮' };
  const left = { slug: 'staging-demo-left', name: 'Staging demo community you left', icon_url: null, icon_emoji: '📚' };
  const day = (days) => new Date(now - days * 86400000).toISOString();
  const issue = (a, n) => `#app/${a.slug}/dev/issues/${n}`;
  const all = [
    { key: 'thread:-9301', threadId: -9301, number: 9301, title: 'Staging demo: a calendar sync, closed', app, href: issue(app, 9301), at: day(9), kind: 'change', outcome: 'closed', by: 'you' },
    { key: 'thread:-9302', threadId: -9302, number: null, title: 'Staging demo: a rename the group passed', app, href: `#app/${app.slug}/dev/governance/9302`, at: day(10), kind: 'vote', outcome: 'passed', decision: true, myVote: 'yes' },
    { key: 'thread:-9303', threadId: -9303, number: 9303, title: 'Staging demo: a change you voted no on', app: game, href: issue(game, 9303), at: day(11), kind: 'vote', outcome: 'merged', myVote: 'no' },
    { key: 'private:-9304', rootId: -9304, number: null, title: 'Staging demo: an idea you marked done', app: null, href: null, at: day(12), kind: 'solo', outcome: 'done' },
    { key: 'thread:-9305', threadId: -9305, number: 9305, title: 'Staging demo: watering reminders', app, href: issue(app, 9305), at: day(14), kind: 'change', outcome: 'live', by: 'bot' },
    { key: 'thread:-9306', threadId: -9306, number: 9306, title: 'Staging demo: a plot map', app, href: issue(app, 9306), at: day(18), kind: 'change', outcome: 'live', by: 'you' },
    { key: 'thread:-9307', threadId: -9307, number: 9307, title: 'Staging demo: export to a spreadsheet', app, href: issue(app, 9307), at: day(20), kind: 'request', outcome: 'shipped' },
    { key: 'thread:-9308', threadId: -9308, number: 9308, title: 'Staging demo: sign in with a code, closed', app, href: issue(app, 9308), at: day(22), kind: 'change', outcome: 'closed', by: 'you' },
    { key: 'private:-9309', rootId: -9309, number: null, title: 'Staging demo: a private thread filed as a request', app: game, href: null, at: day(24), kind: 'solo', outcome: 'filed_shipped', resultRef: 9310 },
    { key: 'thread:-9311', threadId: -9311, number: 9311, title: 'Staging demo: swap requests', app: left, href: issue(left, 9311), at: day(28), kind: 'change', outcome: 'live', by: 'you', left: true },
    { key: 'thread:-9312', threadId: -9312, number: 9312, title: 'Staging demo: a wish list, closed', app: left, href: issue(left, 9312), at: day(30), kind: 'request', outcome: 'closed', left: true },
    { key: 'thread:-9313', threadId: -9313, number: 9313, title: 'Staging demo: a route map', app: game, href: issue(game, 9313), at: day(45), kind: 'change', outcome: 'live', by: 'you' },
    { key: 'thread:-9314', threadId: -9314, number: null, title: 'Staging demo: club colours, passed', app: game, href: `#app/${game.slug}/dev/governance/9314`, at: day(50), kind: 'vote', outcome: 'passed', decision: true, myVote: 'yes' },
    { key: 'thread:-9315', threadId: -9315, number: 9315, title: 'Staging demo: a first version', app, href: issue(app, 9315), at: day(60), kind: 'change', outcome: 'live', by: 'bot' },
  ];
  const cut = aiHistory.parseBefore(before);
  const rows = all.filter((r) => (!cut || r.at < cut)
    && (!project || (r.app && r.app.slug === project))
    && (!kind || r.kind === kind));
  // Two pages: what finished in the last five weeks, then the rest.
  const page = cut ? rows : rows.filter((r) => r.at >= day(35));
  const rest = rows.length > page.length;
  return { rows: page, next: rest && page.length ? page[page.length - 1].at : null };
}

function aiWorkRoutes(config = {}) {
  const router = Router();
  const pool = getPool();

  router.get('/api/ai/work', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      if (IS_STAGING && req.query.demo === '1') return res.json(demoWork());
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      return res.json(await aiWork.workFor(pool, { user: req.user, showSelfHosted }));
    } catch (err) {
      log.error('ai-work', 'Failed to read the AI tab\'s work', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/ai/history: the Homeroom bot tab's History card, the person's
  // work once it has left the lists above (services/ai-history.js).
  //   ?before=<ISO time>  the page after the one whose `next` named it
  //   ?project=<slug>     one project's
  //   ?kind=change|request|vote|solo
  //   → { rows: Row[], next: ISO time | null }
  router.get('/api/ai/history', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const before = aiHistory.parseBefore(req.query.before);
      if (req.query.before && !before) return res.status(400).json({ error: 'Invalid before' });
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
      const kind = aiHistory.KINDS.has(req.query.kind) ? req.query.kind : null;
      if (IS_STAGING && req.query.demo === '1') return res.json(demoHistory({ before, project, kind }));
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      return res.json(await aiHistory.historyFor(pool, { user: req.user, showSelfHosted, before, project, kind }));
    } catch (err) {
      log.error('ai-work', 'Failed to read the AI tab\'s history', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/apps/:slug/threads/yours (5 Nov 2026): which of this project's
  // threads the viewer is in, by the Homeroom bot tab's own rule, for All
  // items' Yours filter (public/js/app-view.js _devCardIsYours).
  //   → { requests: number[], sessions: number[], decisions: number[] }
  // Reading is not taking part, so there is no join gate; who may see the
  // project at all is the app-access check's. ?demo=1 on staging: none (the
  // demo's mock rows are the viewer's by their author, which the filter
  // reads first).
  router.get('/api/apps/:slug/threads/yours', appChatReadLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING && req.query.demo === '1') return res.json({ requests: [], sessions: [], decisions: [] });
      return res.json(await aiWork.yoursOn(pool, { user: req.user, appId: app.id }));
    } catch (err) {
      log.error('ai-work', 'Failed to read the viewer\'s threads on a project', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 5 Nov 2026: the viewer's own requests, one track each: where each stands
  // (its stored work state) with what its card draws (services/ai-work.js
  // tracksFor). A request's thread, a private thread's bar and the chat with
  // the bot read it, again when a `work_state` push says a stage moved.
  router.get('/api/ai/tracks', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      if (IS_STAGING && req.query.demo === '1') return res.json({ tracks: [] });
      return res.json(await aiWork.tracksFor(pool, { user: req.user }));
    } catch (err) {
      log.error('ai-work', 'Failed to read the viewer\'s tracks', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6262: opening a request's, a change's or a decision's thread marks it
  // read, from its page (public/js/group-chat.js mountThread) or from the
  // Homeroom bot page's list. Body: { thread_id } or { thread_type,
  // thread_ref }, where the type is 'issue' (a request's number), 'session'
  // (a chat_sessions id) or 'governance' (an issues id). Reading is not
  // taking part, so there is no join gate; the thread must be this app's.
  router.post('/api/apps/:slug/threads/read', appChatReadLimiter, sameOriginBrowserOnly, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const body = req.body || {};
      const raw = body.thread_id == null ? NaN : Number(body.thread_id);
      // ?demo=1 on staging names mock rows with negative ids, which open no
      // real thread; the page's dot still clears without an error.
      if (IS_STAGING && req.query.demo === '1' && Number.isInteger(raw) && raw < 0) {
        return res.json({ ok: true, unread: 0 });
      }
      let threadId = Number.isInteger(raw) && raw > 0 ? raw : null;
      if (!threadId && body.thread_type != null && body.thread_ref != null) {
        threadId = await threadReads.threadOf(pool, app.id, String(body.thread_type), Number(body.thread_ref));
      }
      if (!threadId) {
        // A page asks about its own number on every open, and some have no
        // thread: a staging mock request, a row the backfill has not reached,
        // ?demo=1's fake threads. That is an answer, not an error — a 4xx
        // here is a console error on a page that is otherwise fine (the same
        // reason GET threads/:number answers `thread: null`).
        return res.json({ ok: true, unread: 0 });
      }
      const { rows } = await pool.query('SELECT id FROM threads WHERE id = $1 AND app_id = $2', [threadId, app.id]);
      if (!rows.length) {
        // A number whose thread moved away is still an answer; a thread_id
        // the caller named is a mistake, and 404s (and another app's thread
        // is not this app's).
        if (body.thread_id == null) return res.json({ ok: true, unread: 0 });
        return res.status(404).json({ error: 'Thread not found' });
      }
      const moved = await threadReads.markRead(pool, { userId: req.user.id, threadId });
      if (!moved) return res.status(404).json({ error: 'Thread not found' });
      return res.json({ ok: true, unread: moved.unread });
    } catch (err) {
      log.error('ai-work', 'Failed to mark a thread read', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { aiWorkRoutes, demoWork, demoHistory };
