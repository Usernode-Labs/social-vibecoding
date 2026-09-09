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
    return {
      kind: 'emoji',
      html: `<span class="text-3xl leading-none" aria-hidden="true">${escapeHtml(app.icon_emoji)}</span>`,
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
      cls: 'bg-red-500/10 text-red-700 dark:text-red-400',
      label: 'Missing secrets',
      tip: `${n} required secret${n === 1 ? '' : 's'} unset. Set values in the app's Secrets panel`,
    });
  }
  if (openPrs > 0) {
    chipDefs.push({
      cls: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
      label: `${openPrs} to vote`,
      tip: `${openPrs} change${openPrs === 1 ? '' : 's'} awaiting community votes`,
    });
  }
  if (activeSessions > 0) {
    chipDefs.push({
      cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
      label: `${activeSessions} in dev`,
      tip: `${activeSessions} build session${activeSessions === 1 ? '' : 's'} in progress`,
    });
  }
  if (openIssues > 0) {
    chipDefs.push({
      cls: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
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
// The INK is a -700 in light and a -400 in dark. A single -400/-500 was a
// dark-shell value: on the light page a `text-sky-700 dark:text-sky-400` label over a 10% sky
// tint measured 2.3:1, which is a colour you can see but not read. The tint
// behind it is unchanged — it is the same 10% wash in both themes, and it is
// the ink that has to move.
export const CHIP_BASE_CLS = 'activity-chip inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium';
export const VIS_CHIP_CLS = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-violet-500/10 text-violet-700 dark:text-violet-400';
// Heroicons v1 outline paths, drawn as inline currentColor SVGs (rather than
// emoji) so the glyphs tint violet with the chip in both themes.
export const VIS_CHIP_PATHS = {
  lock: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  mail: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
};

export function renderAppPillsHtml(app) {
  const { chips, vis } = appPillsFor(app);
  const chipsHtml = chips.map((c) =>
    `<span class="${CHIP_BASE_CLS} ${c.cls}" title="${c.tip}">${c.label}</span>`
  ).join('');
  const visChipIcon = (d) => `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
  const visChipHtml = vis
    ? `<span class="${VIS_CHIP_CLS}" title="${vis.tip}">${visChipIcon(VIS_CHIP_PATHS[vis.icon])} ${vis.label}</span>`
    : '';
  return `${chipsHtml}${visChipHtml}`;
}

export const AppCard = {
  iconTileFor, renderAppPillsHtml, iconViewFor, appPillsFor,
};

// Published for the legacy half of the split. Both in-bundle consumers
// (features/apps/browse.js and features/home/home.js, whose two card methods
// delegate here) `import` these instead, so as of chunk F step 4 nothing reads
// the global — it stays because the shell's classic scripts are a moving
// target during the migration and a card builder is exactly the kind of thing
// one of them would reach for next. Guarded because the SSG prerender pass
// evaluates this graph in Node.
if (typeof window !== 'undefined') window.AppCard = AppCard;
