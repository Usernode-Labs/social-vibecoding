'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const aiWork = require('../services/ai-work');
const log = require('../services/logger');

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
// slugs, these are in no database.
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
    ],
    needs: [
      { threadId: -9210, number: 9210, kind: 'work', title: 'Staging demo: a reminder email', app, change: null, href: issue(app, 9210), group: 'needs', what: 'plan', at: at(4) },
      { threadId: -9214, number: 9214, kind: 'work', title: 'Staging demo: a points table for the season', app, change: null, href: issue(app, 9214), group: 'needs', what: 'decide', at: at(7) },
      { threadId: -9215, number: 9215, kind: 'work', title: 'Staging demo: a high score board', app: game, change: null, href: issue(game, 9215), group: 'needs', what: 'build_stopped', at: at(9) },
    ],
    next: [
      { threadId: -9201, number: 9201, kind: 'work', title: 'Staging demo: dark mode', app, change: { id: -9201, number: 9202 }, href: issue(app, 9201), group: 'next', what: 'going_live', at: at(1) },
      { threadId: -9208, number: 9208, kind: 'work', title: 'Staging demo: tag filter', app, change: { id: -9208, number: 9209 }, href: issue(app, 9208), group: 'next', what: 'building', at: at(3), by: 'bot' },
      { threadId: -9216, number: 9216, kind: 'work', title: 'Staging demo: a sound toggle', app: game, change: null, href: issue(game, 9216), group: 'next', what: 'building', at: at(5), by: 'someone', claimedBy: 'staging-demo-partner' },
    ],
    waiting: [
      { threadId: -9203, number: 9203, kind: 'work', title: 'Staging demo: search the board', app, change: { id: -9203, number: 9204 }, href: issue(app, 9203), group: 'waiting', what: 'vote', at: at(20), myVote: 'yes' },
      { threadId: -9212, number: null, kind: 'decision', title: 'Staging demo: a new card picture', app, change: null, href: `#app/${app.slug}/workshop`, group: 'waiting', what: 'decision', at: at(8), myVote: null },
      { threadId: -9211, number: 9211, kind: 'work', title: 'Staging demo: export to a spreadsheet', app, change: null, href: issue(app, 9211), group: 'waiting', what: 'held', heldBy: 'approvals', at: at(6) },
      { threadId: -9217, number: 9217, kind: 'work', title: 'Staging demo: two-player mode', app: game, change: null, href: issue(game, 9217), group: 'waiting', what: 'build_queued', at: at(2) },
      { threadId: -9205, number: 9205, kind: 'work', title: 'Staging demo: print view', app, change: null, href: issue(app, 9205), group: 'waiting', what: 'not_picked_up', at: at(240), quietDays: 10 },
      { threadId: -9220, number: 9220, kind: 'work', title: 'Staging demo: a page for each month', app: album, change: null, href: issue(album, 9220), group: 'waiting', what: 'build_queued', at: at(4) },
    ],
    live: [
      { threadId: -9206, number: 9206, kind: 'work', title: 'Staging demo: weekly digest', app, change: { id: -9206, number: 9207 }, href: issue(app, 9206), group: 'live', what: 'live', at: at(30) },
      { threadId: -9218, number: 9218, kind: 'work', title: 'Staging demo: a pause button', app: game, change: { id: -9218, number: 9219 }, href: issue(game, 9218), group: 'live', what: 'live', at: at(50) },
      { threadId: -9221, number: 9221, kind: 'work', title: 'Staging demo: a bigger cover picture', app: picture, change: { id: -9221, number: 9222 }, href: issue(picture, 9221), group: 'live', what: 'live', at: at(26) },
      { threadId: -9223, number: 9223, kind: 'work', title: 'Staging demo: roll two dice', app: dice, change: { id: -9223, number: 9224 }, href: issue(dice, 9223), group: 'live', what: 'live', at: at(60) },
      { threadId: -9225, number: 9225, kind: 'work', title: 'Staging demo: a hint button', app: puzzle, change: { id: -9225, number: 9226 }, href: issue(puzzle, 9225), group: 'live', what: 'live', at: at(80) },
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

  return router;
}

module.exports = { aiWorkRoutes, demoWork };
