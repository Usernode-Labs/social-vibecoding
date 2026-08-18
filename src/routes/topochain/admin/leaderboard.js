// Topochain admin API — the leaderboard snapshot builder's trigger.
//
// POST /api/v4/admin/leaderboard/aggregate runs
// src/services/topochain/snapshot-builder.js: with a `season_event_id`
// it aggregates that one event (`force: true` additionally bypasses the
// is_active guards for a final pass over a paused/ended event); with no
// body it sweeps every active regular event on an active season. This is
// the only trigger — there is deliberately no scheduler in this repo yet,
// so snapshot production stays an explicit operator action that cannot
// race the external ETL unprompted (each run writes a NEW snapshot_at
// and rewrites nothing; retention then keeps only the newest 10
// snapshot timestamps per event, so repeated triggers age out older
// history — ETL-imported rows included).
//
// Reads are covered by the router-wide adminReadGate in ../admin.js; the
// one route here is a mutation, so it carries `adminWriteGate` like every
// other admin write.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId } = require('./util');
const { ok, fail, iso } = require('../helpers');
const { buildSnapshots } = require('../../../services/topochain/snapshot-builder');

function leaderboardAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/v4/admin/leaderboard/aggregate', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};

      let seasonEventId = null;
      if (body.season_event_id !== undefined && body.season_event_id !== null) {
        seasonEventId = toIntId(body.season_event_id);
        if (!seasonEventId) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
      }

      const result = await buildSnapshots(pool, {
        seasonEventId,
        force: body.force === true,
      });

      if (seasonEventId && !result.events.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }

      const events = result.events.map((e) => (e.skipped
        ? { season_event_id: e.season_event_id, name: e.name, skipped: e.skipped }
        : {
          season_event_id: e.season_event_id,
          name: e.name,
          users: e.users,
          snapshot_at: iso(e.snapshot_at),
        }));
      const aggregated = events.filter((e) => !e.skipped).length;

      return ok(res, {
        data: { events },
        message: `Leaderboard aggregated for ${aggregated} event(s).`,
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/leaderboard/aggregate failed', { message: err.message });
      return fail(res, 500, 'Failed to aggregate the leaderboard.');
    }
  });

  return router;
}

module.exports = { leaderboardAdminRoutes };
