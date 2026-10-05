'use strict';

// The app's tile on Homeroom's home screen, for each side of a shots pair.
//
// A hosted app's copies serve only the app, so a change to its icon (or its
// name or colour in dapp.json) had nothing to shoot: the tile lives on
// Homeroom's home screen. Admin export 2026-10-05: two icon-only proposals
// failed for that reason. Each address in a pair now also answers
// HOME_TILE_PATH (the shots proxy asks the platform for it), drawn from that
// side's own dapp.json the way the home screen draws it
// (features/home/app-grid.tsx, .app-icon-tile and .app-card-title in
// app.css): a committed image fills the tile, else the emoji, else the
// name's first letter.
//
// Everything here comes from the repository under test: the page escapes
// every text, carries an image only as the sniffed bytes app-manifest loads,
// and runs no script.

const appManifest = require('./app-manifest');

const HOME_TILE_PATH = '/__shots/home-tile';
const SIDES = Object.freeze(['base', 'head']);

// One side's tile, as the home screen would draw it once this revision's
// dapp.json is applied (app-manifest reconcileAppIcon / reconcileAppName).
async function tileFromCheckout(checkoutDir, { fallbackName = null, slug = null } = {}) {
  const manifest = appManifest.read(checkoutDir);
  const name = manifest.name || String(fallbackName || '').trim() || String(slug || '').trim() || '?';
  const icon = manifest.icon || {};
  let face = null;
  if (icon.image) {
    const loaded = await appManifest.loadIconImage(checkoutDir, icon.image, slug);
    if (loaded) {
      face = {
        kind: 'image',
        contentType: loaded.contentType,
        data: loaded.data.toString('base64'),
        sha256: loaded.sha256,
      };
    }
  }
  if (!face && icon.emoji) face = { kind: 'emoji', emoji: icon.emoji };
  // features/apps/app-card.js iconViewFor: the name's first character.
  if (!face) face = { kind: 'letter', letter: name.charAt(0).toUpperCase() };
  return { name, icon: face, color: icon.color || null };
}

// Both sides' tiles, or null when the pair has no checkouts to read.
async function tilesForPair(pair, app) {
  const base = pair?.sides?.base?.checkout;
  const head = pair?.sides?.head?.checkout;
  if (!base || !head) return null;
  const options = { fallbackName: app?.name, slug: app?.slug };
  const [before, after] = await Promise.all([
    tileFromCheckout(base, options),
    tileFromCheckout(head, options),
  ]);
  return { base: before, head: after };
}

function describe(tile) {
  return {
    name: tile.name,
    icon: tile.icon.kind === 'emoji' ? { kind: 'emoji', emoji: tile.icon.emoji } : { kind: tile.icon.kind },
    ...(tile.color ? { color: tile.color } : {}),
  };
}

function fingerprint(tile) {
  const { icon } = tile;
  return JSON.stringify([tile.name, icon.kind, icon.emoji || icon.sha256 || icon.letter, tile.color]);
}

// What the brief says about the tiles: where each address serves its own,
// what each shows, and whether they differ. Never the image bytes.
function briefEntry(tiles) {
  if (!tiles?.base || !tiles?.head) return null;
  return {
    path: HOME_TILE_PATH,
    before: describe(tiles.base),
    after: describe(tiles.head),
    differs: fingerprint(tiles.base) !== fingerprint(tiles.head),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function faceMarkup(icon) {
  if (icon.kind === 'image') {
    return `<img src="data:${icon.contentType};base64,${icon.data}" alt="">`;
  }
  if (icon.kind === 'emoji') return `<span class="emoji">${escapeHtml(icon.emoji)}</span>`;
  return escapeHtml(icon.letter);
}

function cardMarkup(tile, size) {
  return `<figure class="app-card" data-size="${size}">
        <div class="app-icon-tile" data-icon="${tile.icon.kind}">${faceMarkup(tile.icon)}</div>
        <figcaption class="app-card-title">${escapeHtml(tile.name)}</figcaption>
      </figure>`;
}

function paneMarkup(tile, theme, label) {
  return `<section class="pane ${theme}" data-theme="${theme}">
      <h2>${label}</h2>
      <div class="cards">
        ${cardMarkup(tile, 'actual')}
        ${cardMarkup(tile, 'enlarged')}
      </div>
      <p class="sizes"><span>Actual size</span><span>Three times larger</span></p>
    </section>`;
}

// The page an address serves at HOME_TILE_PATH. Light and dark, each at the
// home screen's size (a 56px tile) and three times larger, with the token
// values app.css gives .app-icon-tile in each mode.
function renderPage(tile, { side }) {
  const when = side === 'base' ? 'before the change' : 'after the change';
  const colour = tile.color ? `<p class="colour">Project colour <span class="swatch" style="background:${tile.color}"></span> ${tile.color}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Home screen tile</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f5f7; color: #0a0a0a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif,
      "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lede { margin: 0 0 20px; font-size: 14px; color: #3a3a3c; }
  #home-tile { display: flex; flex-wrap: wrap; gap: 16px; }
  .pane { flex: 1 1 300px; border-radius: 20px; padding: 16px; background: var(--page);
    box-shadow: inset 0 0 0 1px var(--hairline); color: var(--text); }
  .pane.light { --page: #ffffff; --face: #ffffff; --ring: #e3e3e6; --glyph: #3a3a3c; --faint: #8e8e93;
    --text: #0a0a0a; --hairline: #e3e3e6; }
  .pane.dark { --page: #0b0b0c; --face: #1c1c1e; --ring: #2c2c2e; --glyph: #e3e3e6; --faint: #8e8e93;
    --text: #f5f5f7; --hairline: #2c2c2e; }
  .pane h2 { margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--faint); }
  .cards { display: flex; align-items: flex-start; gap: 24px; }
  .app-card { margin: 0; width: 80px; padding: 12px 0; display: flex; flex-direction: column;
    align-items: center; gap: 6px; text-align: center; }
  .app-card[data-size="enlarged"] { zoom: 3; }
  .app-icon-tile { width: 56px; height: 56px; border-radius: 16px; overflow: hidden; display: flex;
    align-items: center; justify-content: center; font-weight: 700; font-size: 20px; line-height: 28px;
    background-color: var(--face); border: 1px solid var(--ring); color: var(--glyph); }
  .app-icon-tile[data-icon="letter"] { color: var(--faint); }
  .app-icon-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .app-icon-tile .emoji { font-size: 30px; line-height: 1; }
  .app-card-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    overflow: hidden; width: 100%; min-height: 26px; font-size: 11px; line-height: 1.18; font-weight: 500;
    text-align: center; overflow-wrap: anywhere; word-break: break-word; }
  .sizes { display: flex; gap: 24px; margin: 4px 0 0; font-size: 12px; color: var(--faint); }
  .sizes span:first-child { width: 80px; text-align: center; }
  .colour { display: flex; align-items: center; gap: 8px; margin: 16px 0 0; font-size: 14px; }
  .swatch { width: 24px; height: 24px; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12); }
</style>
</head>
<body>
<main>
  <h1>Home screen tile, ${when}</h1>
  <p class="lede">How this app's tile looks on Homeroom's home screen, drawn from this version of the app.</p>
  <div id="home-tile">
    ${paneMarkup(tile, 'light', 'Light')}
    ${paneMarkup(tile, 'dark', 'Dark')}
  </div>
  ${colour}
</main>
</body>
</html>
`;
}

module.exports = {
  HOME_TILE_PATH,
  SIDES,
  tileFromCheckout,
  tilesForPair,
  briefEntry,
  renderPage,
};
