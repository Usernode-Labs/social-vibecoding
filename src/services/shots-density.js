'use strict';

// Whether before/after shots are taken at the screen's own density: 3 device
// pixels to a CSS pixel on a phone, 2 on a desktop (worker/write-shots-mcp-
// config.js, worker/patch-playwright-mcp-screenshot.js), so a card can zoom
// into a change without drawing it soft.
//
// Experimental, and off until an admin switches it on: a run started while
// it is off takes every shot at 1x, exactly as before. The shots machine
// reads it once as a run starts (shots-orchestrator.js, the run's `agent`),
// so a run never changes density halfway, and the run's saves follow the
// run's own choice (shots-control.js). The stills of either kind say their
// density wherever they are shown (shots-view.js), so a run taken at 1x and
// one taken at device density sit side by side.
//
// One platform_settings row: 'on' switches it on, anything else or no row is
// off. Read through a short cache, as the other platform settings are.

const KEY = 'shots_device_density';
const CACHE_MS = 10_000;

let cached = null;

async function enabled(pool, { now = Date.now() } = {}) {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
  const value = rows[0]?.value === 'on';
  cached = { at: now, value };
  return value;
}

// Never fails a run: a setting that cannot be read is off, today's shots.
async function enabledOrOff(pool) {
  try { return await enabled(pool); } catch { return false; }
}

async function setEnabled(pool, on, userId = null) {
  if (on) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, 'on', NOW(), $2)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [KEY, userId]
    );
  } else {
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [KEY]);
  }
  invalidate();
  return on === true;
}

function invalidate() {
  cached = null;
}

module.exports = { KEY, CACHE_MS, enabled, enabledOrOff, setEnabled, invalidate };
