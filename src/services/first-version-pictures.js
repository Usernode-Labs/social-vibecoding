'use strict';

// #7118: a new app's own card picture, set with its first version.
//
// The first version's build commits the app's pictures under `brand/` (its
// logo `brand/icon.png`, and the card picture `brand/card.png` with
// `brand/card-dark.png`; homeroom-bot-live.js FIRST_VERSION_PICTURES_LINES).
// The logo reaches the tile through dapp.json's `icon` block on every deploy
// (app-manifest.reconcileAppIcon). The card picture has no line in dapp.json:
// it is applied here, on the first production deploy after the first version
// merged, because the merges' own deploy order is not something the build can
// rely on.
//
// Set once and never again (homeroom_bot_first_versions.card_picture_at): a
// NEW app's first card picture is applied directly, without a vote, because
// there is no group yet; every later change goes to the vote as today
// (illustration-proposals.js). A picture its creator already chose, or one
// already waiting for a vote, is kept: the step only marks that it ran.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');
const { sniffImageType } = require('./attachments');

const CARD_LIGHT = 'brand/card.png';
const CARD_DARK = 'brand/card-dark.png';

// The icon style's eleven palette hues (src/prompts/app-conventions.md, "Icon
// style"), each mapped to the card colour closest to it. The values are the
// hue's From and To hex, the two a dapp.json icon block's `color` carries.
const HUE_TONES = Object.freeze({
  '#ffa552': 'orange', '#e05a12': 'orange', // food, making, building
  '#fbb43c': 'yellow', '#c9570a': 'yellow', // pets, notes, farming, time
  '#c98c5e': 'cream', '#6e3f22': 'cream', // coffee, crafts
  '#ff7163': 'coral', '#d1321f': 'coral', // sport, video, voting, places
  '#ff6ab8': 'pink', '#cf1f74': 'pink', // social, art, people, personal pages
  '#b574ff': 'purple', '#7327db': 'purple', // games, quests, rankings
  '#8577ff': 'indigo', '#4432d1': 'indigo', // lists, work, markets, security
  '#5b9bff': 'blue', '#1f57e6': 'blue', // tools, lists, language, weather
  '#34d3c3': 'teal', '#0b7d84': 'teal', // kids, drawing, surveys
  '#3dd68a': 'mint', '#0e8a4c': 'mint', // money, growth, luck
  '#6a7b93': 'gray', '#27313f': 'gray', // utilities, tests, diagnostics, spooky
});

/**
 * Pure: the card colour (one of the twelve `TONES`, routes/app-illustrations.js)
 * closest to an icon block's `color`, or null when it names none of the
 * palette's hues (the card then keeps the colour of its own slug's hash).
 */
function cardToneFor(color) {
  if (typeof color !== 'string') return null;
  return HUE_TONES[color.trim().toLowerCase()] || null;
}

/**
 * The bytes of one committed file inside the clone, under the same rules as
 * an icon (app-manifest.loadIconImage): relative, inside the clone, no
 * symlink escape. Null on any failure, always with a warn.
 */
async function readCommitted(cloneDir, relPath, appSlug) {
  try {
    const rootReal = await fs.promises.realpath(cloneDir);
    let real;
    try {
      real = await fs.promises.realpath(path.resolve(rootReal, relPath));
    } catch {
      return null;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      log.warn('first-version-pictures', 'Card picture path escapes the repo', { slug: appSlug, image: relPath });
      return null;
    }
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) return null;
    return await fs.promises.readFile(real);
  } catch (err) {
    log.warn('first-version-pictures', 'Card picture read failed', { slug: appSlug, image: relPath, err: err.message });
    return null;
  }
}

/**
 * The card picture a file makes, or null: shrunk under the card limit
 * (bot-pictures.fitForCard) and sniffed as the one card uploads accept
 * (routes/app-illustrations.js validateImage), never by its extension.
 */
function cardImageOf(data) {
  if (!Buffer.isBuffer(data) || !data.length) return null;
  const accepted = (buf) => ['image/png', 'image/jpeg', 'image/webp'].includes(sniffImageType(buf));
  if (!accepted(data)) return null;
  const { fitForCard } = require('./bot-pictures');
  const fitted = fitForCard(data, sniffImageType(data));
  if (!fitted || fitted.length > 1024 * 1024 || !accepted(fitted)) return null;
  return { data: fitted, contentType: sniffImageType(fitted) };
}

/**
 * Apply a first version's committed card picture to its app, once. `manifest`
 * is the tree's dapp.json and `cloneDir` the freshly-cloned working tree the
 * deploy is about. Resolves true when the app's card now wears a picture this
 * call set; everything else (already done, not merged, the creator's own
 * picture, no usable file) is false. Best-effort: callers log a throw.
 */
async function applyFirstCard(pool, app, manifest, cloneDir) {
  if (!app?.id) return false;
  const { rows } = await pool.query(
    `SELECT app_id, bot_builds, issue_number, card_picture_at
       FROM homeroom_bot_first_versions WHERE app_id = $1`,
    [app.id],
  );
  const fv = rows[0];
  if (!fv || fv.bot_builds !== true || !fv.issue_number || fv.card_picture_at) return false;
  // The starter's own first deploy comes before the version it was made for:
  // nothing applies until that version's session has merged.
  const merged = await pool.query(
    `SELECT 1 FROM chat_sessions cs
      WHERE cs.app_id = $1 AND $2 = ANY(cs.linked_issues) AND cs.merged_at IS NOT NULL
      LIMIT 1`,
    [app.id, Number(fv.issue_number)],
  );
  if (!merged.rowCount) return false;

  // Read and fit the two committed files BEFORE the transaction below: they
  // are what the step might apply, and reading them is filesystem I/O that
  // must not run while the first-version row is locked, or a slow disk would
  // hold the lock for every deploy racing this one.
  const lightImage = cardImageOf(await readCommitted(cloneDir, CARD_LIGHT, app.slug));
  const darkImage = lightImage ? cardImageOf(await readCommitted(cloneDir, CARD_DARK, app.slug)) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [locked] } = await client.query(
      'SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1 FOR UPDATE',
      [app.id],
    );
    if (!locked || locked.card_picture_at) {
      await client.query('ROLLBACK');
      return false;
    }
    const mark = () => client.query(
      `UPDATE homeroom_bot_first_versions SET card_picture_at = NOW() WHERE app_id = $1`, [app.id],
    );
    // Its creator's picture wins, and so does one already waiting for a vote.
    const { rows: [cur] } = await client.query(
      'SELECT featured_illustration FROM apps WHERE id = $1', [app.id],
    );
    const open = await client.query(
      `SELECT 1 FROM issues WHERE app_id = $1 AND kind = 'featured_illustration' AND status = 'open' LIMIT 1`,
      [app.id],
    );
    if (cur?.featured_illustration || open.rowCount) {
      await mark();
      await client.query('COMMIT');
      return false;
    }
    if (!lightImage) {
      // No usable light picture: the card keeps today's look, and this never
      // runs again.
      await mark();
      await client.query('COMMIT');
      return false;
    }
    const proposals = require('./illustration-proposals');
    const lightId = proposals.newImageId();
    const darkId = darkImage ? proposals.newImageId() : null;
    await client.query(
      `INSERT INTO app_illustrations (app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type,
         data = EXCLUDED.data, dark_id = EXCLUDED.dark_id, dark_content_type = EXCLUDED.dark_content_type,
         dark_data = EXCLUDED.dark_data, preview_id = NULL, preview_content_type = NULL, preview_data = NULL`,
      [app.id, lightId, lightImage.contentType, lightImage.data, darkId,
        darkImage ? darkImage.contentType : null, darkImage ? darkImage.data : null],
    );
    const tone = cardToneFor(manifest?.icon?.color);
    const featured = {
      url: proposals.imageUrl(lightId),
      darkUrl: darkId ? proposals.imageUrl(darkId) : null,
      zoom: 1, x: 0, y: 0,
      // Absent when the hue maps to no card colour, so the card keeps the
      // colour of its own slug's hash rather than a made-up one.
      ...(tone ? { tint: tone } : {}),
    };
    await client.query(
      'UPDATE apps SET featured_illustration = $2::jsonb WHERE id = $1',
      [app.id, JSON.stringify(featured)],
    );
    await mark();
    await client.query('COMMIT');
    log.info('first-version-pictures', 'Applied a first version\'s card picture', {
      appId: app.id, slug: app.slug, dark: Boolean(darkId), tint: tone || null,
    });
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  CARD_LIGHT,
  CARD_DARK,
  HUE_TONES,
  cardToneFor,
  cardImageOf,
  applyFirstCard,
};
