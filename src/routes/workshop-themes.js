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
      if (IS_STAGING && req.query.demo === '1') themes.push(...stagingDemoThemes());
      res.json({
        themes,
        source: result.source,
        generatedAt: result.generatedAt,
        stale: result.stale,
        pending: result.pending,
      });
    } catch (err) {
      log.error('workshop-themes', 'GET failed', { message: err.message });
      res.status(500).json({ error: 'Failed to load workshop themes' });
    }
  });

  return router;
}

module.exports = { workshopThemesRoutes, stagingDemoThemes };
