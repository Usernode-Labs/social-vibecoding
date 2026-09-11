const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const workshopThemes = require('../services/workshop-themes');
const log = require('../services/logger');

// Workshop themes (the Dev screen's lander). GET serves the per-app cache
// — or, with no model, the category grouping — and never waits on a
// generation: a stale cache answers at once and regenerates behind the
// request (services/workshop-themes.js). Access level is 'view', as for
// every other board read: the input is built from data every viewer of the
// app can already see, and the deny is a 404 like every app route.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Staging-only demo themes (?demo=1): the mock issues and proposals that
// routes/issues.js and routes/votes.js append in demo mode are not in any
// real cache, so a demo preview of the Workshop would show them all under
// "Not yet grouped". These name the mock keys so a reviewer sees themed
// rows. Appended AFTER the real themes; a no-op in production.
function stagingDemoThemes() {
  return [
    {
      id: 'demo-appearance',
      name: '[Mock] Appearance & theming',
      description: 'How the app looks: dark mode, colours, the settings panel.',
      saying: 'Dark mode should survive a refresh, and the settings panel should stop re-expanding on its own.',
      items: ['issue:900001', 'issue:900004', 'issue:900008'],
    },
    {
      id: 'demo-voting',
      name: '[Mock] Voting',
      description: 'Casting and reading votes on proposals.',
      saying: 'A keyboard shortcut for voting, and a clearer disabled state on the vote buttons.',
      items: ['issue:900002', 'issue:900006', 'session:9000001', 'session:9000013'],
    },
    {
      id: 'demo-mobile',
      name: '[Mock] Narrow screens',
      description: 'Layout on phones: overflow, scrolling, long titles.',
      saying: 'Topic cards overflow on narrow phones and the leaderboard scrolls badly on small screens.',
      items: ['issue:900003', 'issue:900005', 'issue:900007', 'session:9000014'],
    },
  ];
}

// Staging-only demo cards (?demo=1), for the same reason as the themes
// above: the three lines are written by the model on a reconcile, and a
// staging preview has neither a model nor a drafted row, so the Workshop's
// cards would simply not be drawn and the declared check for them would gate
// on whether staging happened to have a key. Substituted only when the row
// has none — a real card set always wins. A no-op in production.
function stagingDemoCards() {
  return {
    lastWeek: 'Staging demo: one line on what landed in the completed week just gone.',
    thisWeek: 'Staging demo: one line on what has landed so far this week.',
    open: 'Staging demo: one line on what the open issues and waiting proposals are about.',
  };
}

function workshopThemesRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name, repo_url`;

  router.get('/api/apps/:slug/workshop-themes', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const result = await workshopThemes.getThemes({ pool, app });
      const themes = result.themes.slice();
      const demo = IS_STAGING && req.query.demo === '1';
      if (demo) themes.push(...stagingDemoThemes());
      const digestCards = result.digestCards || (demo ? stagingDemoCards() : null);
      res.json({
        themes,
        source: result.source,
        generatedAt: result.generatedAt,
        // When the theme definitions were last drafted (the placements
        // move on their own between drafts).
        discoveredAt: result.discoveredAt || null,
        stale: result.stale,
        pending: result.pending,
        // Which stage is running or was just started: 'discovery' (the
        // definitions) or 'placement' (new cards into them).
        pendingStage: result.pendingStage || null,
        // The last failed stage's message, so the page can say so.
        lastError: result.lastError || null,
        // How much of the board the themes hold: placed, declined by the
        // placer (`unplaced`, also named by key), and not yet placed.
        coverage: result.coverage || null,
        unplaced: Array.isArray(result.unplaced) ? result.unplaced : [],
        // The three windowed lines the lander draws as cards — what landed
        // last week, what has landed this week, what the open work is about
        // — written by the model on the same reconcile that drafted the
        // themes. A field is an empty string when that window was genuinely
        // empty, and its card is then not drawn.
        digestCards,
        // The same answer flattened to prose. A row last written under the
        // previous digest prompt has only this, so serving both is what lets
        // such a row keep saying something until its next pass re-asks for
        // the fields. Null on all three counts — no model, no draft yet, a
        // failed call — and the client derives a sentence from the counts.
        digest: result.digest || null,
        digestError: result.digestError || null,
      });
    } catch (err) {
      log.error('workshop-themes', 'GET failed', { message: err.message });
      res.status(500).json({ error: 'Failed to load workshop themes' });
    }
  });

  return router;
}

module.exports = { workshopThemesRoutes, stagingDemoThemes, stagingDemoCards };
