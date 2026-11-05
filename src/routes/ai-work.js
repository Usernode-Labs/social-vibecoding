'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const threadReads = require('../services/thread-reads');
const aiWork = require('../services/ai-work');
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
  const issue = (a, n) => `#app/${a.slug}/dev/issues/${n}`;
  return {
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
    ],
    next: [
      { threadId: -9201, number: 9201, kind: 'work', title: 'Staging demo: dark mode', app, change: { id: -9201, number: 9202 }, href: issue(app, 9201), group: 'next', work: { stage: 'going_live' }, at: at(1), unread: 1 },
      { threadId: -9208, number: 9208, kind: 'work', title: 'Staging demo: tag filter', app, change: { id: -9208, number: 9209 }, href: issue(app, 9208), group: 'next', work: { stage: 'building' }, at: at(3), by: 'bot' },
      { threadId: -9216, number: 9216, kind: 'work', title: 'Staging demo: a sound toggle', app: game, change: null, href: issue(game, 9216), group: 'next', work: { stage: 'building', line: { code: 'claimed', by: 'staging-demo-partner' } }, at: at(5), by: 'someone' },
    ],
    waiting: [
      { threadId: -9203, number: 9203, kind: 'work', title: 'Staging demo: search the board', app, change: { id: -9203, number: 9204 }, href: issue(app, 9203), group: 'waiting', work: { stage: 'up_for_vote' }, at: at(20), myVote: 'yes' },
      { threadId: -9212, number: null, kind: 'decision', title: 'Staging demo: a new card picture', app, change: null, href: `#app/${app.slug}/dev/governance/9212`, group: 'waiting', work: { stage: 'up_for_vote' }, at: at(8), myVote: null },
      { threadId: -9211, number: 9211, kind: 'work', title: 'Staging demo: export to a spreadsheet', app, change: null, href: issue(app, 9211), group: 'waiting', work: { stage: 'building', line: { code: 'held_waiting' } }, at: at(6) },
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
  };
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

module.exports = { aiWorkRoutes, demoWork };
