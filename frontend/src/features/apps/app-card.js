// The shared app-card primitives — one source of truth for the parts every
// app-tile surface on the platform draws the same way (#1083 chunk F).
//
// Four surfaces render an app: the home launcher grid (Home.renderAppCard),
// the browse screen's list rows and detail hero (./browse-list.tsx /
// ./browse-detail.tsx), and the app view's header tile (app-view.js). They render at
// four different SIZES, so the tile BOX is each caller's own — what they must
// agree on is the tile's CONTENT (which of image / emoji / letter to draw, and
// the `data-icon` kind that goes with it) and the activity/visibility chip
// strip. Both used to live in home.js and be reached through `window.Home`
// from browse.js, which made the launcher grid's owner the de-facto owner of
// the browse screen's markup too.
//
// This module is deliberately the SMALL half of that split. It holds the two
// pure functions — app record in, HTML string out, no DOM reads, no module
// state — and nothing else. `isYours`, `matchesQuery`, `menuItemsFor` and
// `toggleAdded` stay on Home: each one reads or writes Home's loaded-app list
// and the viewer's permissions, so they are state, not markup.
//
// Home keeps `Home.iconTileFor` / `Home.renderAppPillsHtml` as delegating
// methods rather than dropping them: public/js/app-view.js calls the first for
// its header tile, and two declared checks plus tests/home-card-menu.test.js
// call them by those names. Same functions, one implementation.
//
// escapeHtml is duplicated here rather than imported, for the same reason each
// legacy module has its own copy: it is three lines, and a shared import would
// be a load-order dependency between classic scripts that don't have one.

import { openmojiSrcFor } from '../../lib/openmoji';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Icon-tile inner markup + kind. Priority: custom image (dapp.json
// icon.image, served via /app-icons/:id or a staging demo data-URI) > emoji
// (dapp.json icon.emoji) > the first-letter fallback every app always had.
// The kind lands on the tile as data-icon so tests, app.css's letter-glyph
// treatment and the rename handler (app.js) can tell a custom icon from the
// letter placeholder.
//
// The returned `html` carries NO sizing of its own — w-full/h-full on the
// image, a text-size class on the emoji — because the tile box differs per
// surface (w-14 on a launcher tile, w-11 on a browse row, w-16 on the detail
// hero) and the border box is what draws the hairline. The one exception is
// the emoji's `text-3xl`, which is the launcher tile's size; the two browse
// surfaces override it on the wrapper.
// The same decision as iconTileFor, as DATA rather than markup (#1191 slice 6
// conversion 3). The browse screen renders its tiles in React now, so it needs
// the choice without the string; iconTileFor below is built on top of this, so
// the priority order has one source and the two renderers cannot drift.
export function iconViewFor(app) {
  if (app.icon_url) return { kind: 'image', src: app.icon_url };
  if (app.icon_emoji) return { kind: 'emoji', emoji: app.icon_emoji };
  return { kind: 'letter', letter: (app.name || '?').charAt(0).toUpperCase() };
}

// The subtle-y2k v2 aura rotation: every app deterministically wears ONE of
// the brand kit's four radial gradients on its icon tile (soft, behind the
// glyph — `.app-icon-tile[data-aura]` in app.css draws it, and the canvas
// widget tile in features/home/home.js paints the same stops). Slug-hashed
// so the assignment is stable across surfaces and sessions.
//
// This knowingly reverses the retired six-pastel per-app tint (see the note
// in app.css beside .app-icon-tile): Lukas's call, on the grounds that four
// auras from one gradient family read as one shelf where six unrelated
// pastels did not. `data-tint` stays a forbidden name — the attribute is
// data-aura, and tests/home-card-icon.test.js still bans the old one.
const AURAS = ['sky', 'meadow', 'sunset', 'lemon'];
export function auraFor(appOrSlug) {
  const slug = typeof appOrSlug === 'string'
    ? appOrSlug
    : String((appOrSlug && (appOrSlug.slug || appOrSlug.name)) || '');
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) h = ((h * 31) + slug.charCodeAt(i)) | 0;
  return AURAS[Math.abs(h) % AURAS.length];
}

export function iconTileFor(app) {
  if (app.icon_url) {
    return {
      kind: 'image',
      // w-full/h-full (not w-14/h-14): the tile draws a 1px hairline border,
      // so the image fills the border box's *content* area and stays flush
      // inside the ring instead of being cropped.
      html: `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-full h-full rounded-xl object-cover">`,
    };
  }
  if (app.icon_emoji) {
    // The OpenMoji upgrade renders as an <img> like the custom-image kind
    // (object-contain, not cover: the artwork is a glyph, not a photo; p-1
    // gives it the air a text emoji's line box used to). The text span is
    // the fallback for emojis outside the curated slice — see
    // lib/openmoji.js on why a miss is a soft degrade.
    const illustrated = openmojiSrcFor(app.icon_emoji);
    return {
      kind: 'emoji',
      html: illustrated
        ? `<img src="${escapeHtml(illustrated)}" alt="" loading="lazy" draggable="false" aria-hidden="true" class="w-full h-full object-contain p-1">`
        : `<span class="text-3xl leading-none" aria-hidden="true">${escapeHtml(app.icon_emoji)}</span>`,
    };
  }
  return { kind: 'letter', html: escapeHtml((app.name || '?').charAt(0).toUpperCase()) };
}

// The activity + visibility chip strip. A quiet, fully-public app carries no
// chips. Order: missing secrets (most urgent), PRs awaiting votes, dev
// sessions in flight, open issues, privacy chip last. All display-only spans.
// Returns joined HTML, '' when there's nothing to flag.
//
// Development-activity counts (#57) come straight from /api/apps (DB-derived,
// no GitHub calls); zero-count chips are dropped. The missing-secrets chip
// deliberately omits the key NAMES — those live in the app view's Secrets
// panel.
//
// #1191 slice 6 conversion 3 split this in two: appPillsFor decides WHICH
// chips a record earns, renderAppPillsHtml turns that decision into the string
// the launcher grid and the app view still splice in. One decision, two
// renderers — the same shape the notifications rows landed in.
export function appPillsFor(app) {
  const openPrs = parseInt(app.open_prs || 0);
  const activeSessions = parseInt(app.active_sessions || 0);
  const openIssues = parseInt(app.open_issues || 0);
  const hasMissing = Array.isArray(app.missingSecrets) && app.missingSecrets.length;
  const chipDefs = [];
  if (hasMissing) {
    const n = app.missingSecrets.length;
    chipDefs.push({
      cls: 'bg-red-500/10 text-red-700 dark:text-red-200',
      label: 'Missing secrets',
      tip: `${n} required secret${n === 1 ? '' : 's'} unset. Set values in the app's Secrets panel`,
    });
  }
  if (openPrs > 0) {
    chipDefs.push({
      cls: 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
      label: `${openPrs} to vote`,
      tip: `${openPrs} change${openPrs === 1 ? '' : 's'} awaiting community votes`,
    });
  }
  if (activeSessions > 0) {
    chipDefs.push({
      // Green, not blue: this chip shares its row with VIS_CHIP_CLS, which is
      // azure — and an identity mark is what "blue speaks" is for, so activity
      // has to move off blue. Green is not a free pick either: app-view.js's
      // DEV_CARD_ICONS already gives a dev session in progress the meadow aura
      // and the green ink, so this makes the card agree with the product's own
      // semantic rather than inventing a third meaning.
      cls: 'bg-meadow-500/10 text-meadow-700 dark:text-meadow-200',
      label: `${activeSessions} in dev`,
      tip: `${activeSessions} build session${activeSessions === 1 ? '' : 's'} in progress`,
    });
  }
  if (openIssues > 0) {
    chipDefs.push({
      cls: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
      label: `${openIssues} issue${openIssues === 1 ? '' : 's'}`,
      tip: `${openIssues} open issue${openIssues === 1 ? '' : 's'}`,
    });
  }
  // Visibility chip for non-default settings. View-private dominates (it
  // implies collab-private); collab-private alone reads as "invite-only
  // build" since anyone can still see/use the app.
  const vis = app.view_visibility === 'private'
    ? {
      icon: 'lock',
      label: 'Private',
      tip: 'Only collaborators can see and use this app',
    }
    : (app.collab_visibility === 'private'
      ? {
        icon: 'mail',
        label: 'Invite-only build',
        tip: 'Anyone can use this app; only invited collaborators can build it',
      }
      : null);

  return { chips: chipDefs, vis };
}

// The chip classes, shared by both renderers so a restyle lands on all four
// app surfaces at once.
//
// The INK moves with the theme; the TINT does not — it is the same 10% wash
// in both, and the ink is what has to carry the difference. A single dark-shell
// -400/-500 used on the light page was the original bug here.
//
// The dark half is the 200 step now, on the four chips whose ramp is tuned.
// Measured with an APCA-W3 0.1.9 port written for this pass (three reference
// values 106.04 / -107.88 / 63.06), each ink on its own 10% wash over white and
// over the zinc-900 card:
//
//   missing secrets  red-700    71.1  /  red-200    -78.7   (was -400: -41.5)
//   to vote          amber-800  83.8  /  amber-200  -78.1   (was -400: -57.6)
//   in dev           meadow-700 76.3  /  meadow-200 -80.8   (was sky: -56.8)
//   issues           zinc-600   80.3  /  zinc-300   -74.3
//
// VIS_CHIP_CLS below used to spell azure-700 / azure-400 (60.5 / -50.2) and
// this note called that "the product-wide accent-ink backlog, not this file's
// to settle". The backlog IS this pass, and the note's own arithmetic named
// the answer: azure does NOT take the 200 step the way the status ramps do —
// azure-700's light value is 68.0, so its parity partner is azure-300, and
// 200 would overshoot. On this 10% wash the pair is now 60.5 / -64.9, 4.4
// apart, where -400 sat 10.3 apart and one full rung down.
//
//   visibility        azure-700  60.5  /  azure-300  -64.9   (was -400: -50.2)
//
// 700, not 800: a CHIP keeps the working brand hex. The 800/200 step is for
// LINK ink — a link is not a chip, and the two are deliberately different
// here (see the contributors toggle in ./browse-detail.tsx, which is a text
// button and therefore takes the link step).
export const CHIP_BASE_CLS = 'activity-chip inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium';
export const VIS_CHIP_CLS = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-azure-500/10 text-azure-700 dark:text-azure-300';
// lucide glyphs, drawn as inline currentColor SVGs (rather than emoji) so they
// tint with the chip in both themes.
//
// SHAPES, not paths: neither lucide/lock nor lucide/mail is path-only — the
// set draws a box as a <rect> rather than approximating one in path data — and
// this table has two readers, `renderAppPillsHtml` below and <Glyph> in
// app-card-view.tsx. One table, two renderers, no second copy to drift.
/**
 * Annotated so TypeScript reads each entry as a [tag, attrs] TUPLE. Without
 * it the inference is `(string | object)[]`, which <Glyph>'s GlyphShapes will
 * not accept — the array form loses the fact that position 0 is the tag.
 *
 * @type {Record<'lock' | 'mail', ReadonlyArray<readonly [string, Record<string, string>]>>}
 */
export const VIS_CHIP_SHAPES = {
  lock: [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
  mail: [['path', { d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' }], ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }]],
};

/** One glyph's shapes as SVG child markup — the string twin of <Glyph>. */
export function shapesToMarkup(shapes) {
  return shapes.map(([tag, attrs]) =>
    `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`
  ).join('');
}

export function renderAppPillsHtml(app) {
  const { chips, vis } = appPillsFor(app);
  const chipsHtml = chips.map((c) =>
    `<span class="${CHIP_BASE_CLS} ${c.cls}" title="${c.tip}">${c.label}</span>`
  ).join('');
  const visChipIcon = (shapes) => `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapesToMarkup(shapes)}</svg>`;
  const visChipHtml = vis
    ? `<span class="${VIS_CHIP_CLS}" title="${vis.tip}">${visChipIcon(VIS_CHIP_SHAPES[vis.icon])} ${vis.label}</span>`
    : '';
  return `${chipsHtml}${visChipHtml}`;
}

export const AppCard = {
  iconTileFor, renderAppPillsHtml, iconViewFor, appPillsFor, auraFor,
};

// Published for the legacy half of the split. Both in-bundle consumers
// (features/apps/browse.js and features/home/home.js, whose two card methods
// delegate here) `import` these instead, so as of chunk F step 4 nothing reads
// the global — it stays because the shell's classic scripts are a moving
// target during the migration and a card builder is exactly the kind of thing
// one of them would reach for next. Guarded because the SSG prerender pass
// evaluates this graph in Node.
if (typeof window !== 'undefined') window.AppCard = AppCard;
