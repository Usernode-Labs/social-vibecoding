'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const aiWork = require('../services/ai-work');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// GET /api/ai/work (#6019 follow-up): what the AI tab's main view lists
// beside Needs you, for the signed-in person (services/ai-work.js).
//   → { private: PrivateRow[], next: Row[], waiting: Row[], live: Row[] }
//
// `?demo=1` on staging adds a few obviously fake rows of each kind, so the
// view's declared checks and its before & after shots have something to
// draw on a copy where the fixture account is in no thread.
function demoWork() {
  const app = { slug: 'staging-demo-app', name: 'Staging demo app', iconEmoji: null, iconColor: null, iconUrl: null };
  const now = Date.now();
  const at = (hours) => new Date(now - hours * 3600000).toISOString();
  return {
    private: [
      { rootId: -9101, title: 'Staging demo idea: a calendar for the garden', kind: 'idea', app: null, at: at(2) },
      { rootId: -9102, title: 'Staging demo draft: sort by date', kind: 'draft_request', app, at: at(5) },
    ],
    next: [
      { threadId: -9201, number: 9201, kind: 'work', title: 'Staging demo: dark mode', app, change: { id: -9201, number: 9202 }, group: 'next', what: 'going_live', at: at(1) },
      { threadId: -9203, number: 9203, kind: 'work', title: 'Staging demo: search the board', app, change: { id: -9203, number: 9204 }, group: 'next', what: 'vote', at: at(20) },
    ],
    waiting: [
      { threadId: -9205, number: 9205, kind: 'work', title: 'Staging demo: print view', app, change: null, group: 'waiting', what: 'not_picked_up', at: at(240), quietDays: 10 },
    ],
    live: [
      { threadId: -9206, number: 9206, kind: 'work', title: 'Staging demo: weekly digest', app, change: { id: -9206, number: 9207 }, group: 'live', what: 'live', at: at(30) },
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
