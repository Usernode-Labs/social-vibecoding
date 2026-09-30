// Where the native app can be installed, per OS.
//
// The URL is `app_version_configs.update_url`: already editable in the admin
// console (App version), and already the place the native update gate sends a
// user to. A store listing is the same destination whether you are updating
// or arriving, so every surface that offers the app reads it from here: the
// phone install banner (GET /api/public/mobile-app) and the waitlist release
// mail. One field, and both stop offering a platform the day it is cleared.
'use strict';

// Both keys are always present, so callers have one shape to read. Throws on
// a failed query; each caller decides how loudly to degrade.
async function loadMobileAppUrls(pool) {
  const urls = { ios: null, android: null };
  const { rows } = await pool.query(
    `SELECT os, update_url FROM app_version_configs
      WHERE is_active = TRUE AND os IN ('ios', 'android')`
  );
  for (const row of rows) {
    const url = String(row.update_url || '').trim();
    if (url && Object.prototype.hasOwnProperty.call(urls, row.os)) urls[row.os] = url;
  }
  return urls;
}

module.exports = { loadMobileAppUrls };
