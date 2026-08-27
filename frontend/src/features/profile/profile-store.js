/**
 * The Profile screen's state, and the pure shaping that turns it into what
 * ./profile-view.tsx renders (#1191 slice 6, conversion 1).
 *
 * Plain JS, no React import, for the reason lib/plain-store.js documents: the
 * root test suite is `node --test` with no JSX transform, and
 * tests/topochain-profile-web.test.js and
 * tests/profile-completed-challenges.test.js read the real shipped source. Every
 * decision this screen makes about WHAT to show — which of the six load states
 * it is in, whether the token figure is gated or merely blurred, how a
 * completion row's meta line reads — is therefore in this file, where those
 * suites can still reach it. The .tsx beside it only turns the result into
 * elements.
 *
 * The initial state is `open: false`, which `buildProfileView` maps to a view of
 * kind `empty` and the component renders as no children at all. That is exactly
 * the empty `#profile-root` the hand-written shell shipped, which is what the
 * prerender pass emits and what hydration then has to match. Nothing here reads
 * `window`, `localStorage` or the clock at module scope for the same reason.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {Object} ProfileState
 * @property {boolean} open      — the #profile route is active
 * @property {any} data          — { ranking, breakdown, completed, season, … }
 * @property {any} user          — a snapshot of App.user, taken by the controller
 * @property {boolean} revealed  — the token figure has been unblurred once
 * @property {string|null} pendingAvatarUrl — object URL of a staged photo
 * @property {boolean} pendingRemove        — the staged change is a deletion
 * @property {boolean} sheetOpen
 * @property {string} publicStatus
 * @property {boolean} publishing
 * @property {boolean} previewOpen
 */

export const profileStore = createStore(/** @type {ProfileState} */ ({
  open: false,
  data: null,
  user: null,
  revealed: false,
  pendingAvatarUrl: null,
  pendingRemove: false,
  sheetOpen: false,
  publicStatus: '',
  publishing: false,
  previewOpen: false,
}));

/** Only ever render an http(s) URL as a real anchor. Escaping alone would not
 *  stop a `javascript:` href, which executes on click with no markup injection
 *  at all — the same discipline TopochainChallenges.safeHref applies. */
export function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** The name shown large on the card: the display name when set, else the
 *  @username. Never blank — a signed-in profile always has a username. */
export function displayNameOf(user) {
  const u = user || {};
  const name = u.displayName ? String(u.displayName).trim() : '';
  return name || (u.username ? `@${u.username}` : 'Your profile');
}

/**
 * The letter in the fallback circle. Takes the first LETTER OR DIGIT, not
 * simply the first character: a display name is free text, so it can easily
 * start with punctuation or an emoji ("[Staging demo] admin", "…hello") and a
 * circle reading "[" tells the viewer nothing. Falls back to the username,
 * then to '?'.
 */
export function initialOf(user) {
  const u = user || {};
  for (const src of [u.displayName, u.username]) {
    const match = String(src || '').match(/[\p{L}\p{N}]/u);
    if (match) return match[0].toUpperCase();
  }
  return '?';
}

/** A staged pick wins over the saved photo so the edit preview is live. */
export function avatarUrlOf(state) {
  const u = state.user || {};
  if (state.pendingAvatarUrl) return state.pendingAvatarUrl;
  if (state.pendingRemove) return null;
  return u.avatarUrl || null;
}

/** "today" / "3 days ago" / a plain date past a fortnight. Returns null for
 *  anything unparseable, so the caller just omits the segment. */
export function relativeDate(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch (_) {
    return null;
  }
}

/**
 * Flattens the /me/breakdown response (event | season | global scope) into
 * label/points rows: one per event, plus offchain points when present.
 */
export function breakdownRows(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return [];
  const rows = [];
  const pushEvent = (ev) => {
    if (!ev) return;
    const name = (ev.event && ev.event.name) || ev.event_name || 'Event';
    rows.push({ label: name, points: ev.total_points });
  };
  if (breakdown.scope === 'event') {
    pushEvent(breakdown);
  } else if (Array.isArray(breakdown.events)) {
    breakdown.events.forEach(pushEvent);
  } else if (Array.isArray(breakdown.seasons)) {
    for (const season of breakdown.seasons) {
      (season.events || []).forEach(pushEvent);
    }
  }
  if (Number(breakdown.offchain_points || 0) > 0) {
    rows.push({ label: 'Bonus points', points: breakdown.offchain_points });
  }
  return rows;
}

const CHIP_ZINC =
  'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
  'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 ' +
  'hover:bg-zinc-200 dark:hover:bg-zinc-700';
const CHIP_VIOLET =
  'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
  'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ' +
  'hover:bg-violet-100 dark:hover:bg-violet-900/50';

/** The identity card (#982) — who this profile belongs to. */
export function identityView(state) {
  const u = state.user || {};
  const chips = [];
  const links = u.links || {};
  const addChip = (key, label, href) => {
    const safe = safeHref(href);
    if (safe) chips.push({ key, label, href: safe, external: true, className: CHIP_ZINC });
  };
  if (links.github) {
    addChip('github', `GitHub · ${links.github}`,
      `https://github.com/${encodeURIComponent(links.github)}`);
  }
  if (links.x) {
    addChip('x', `X · @${links.x}`, `https://x.com/${encodeURIComponent(links.x)}`);
  }
  if (u.username) {
    // In-app link out: the viewer's kudos / proposed-PR history.
    chips.push({
      key: 'builder',
      label: 'Your builder profile',
      href: `#leaderboard/users/${encodeURIComponent(u.username)}`,
      external: false,
      className: CHIP_VIOLET,
    });
  }
  return {
    avatarUrl: avatarUrlOf(state),
    initial: initialOf(u),
    name: displayNameOf(u),
    // The @handle is only a SECOND line when a display name is set —
    // otherwise it is already the headline above.
    handle: (u.displayName && String(u.displayName).trim() && u.username)
      ? `@${u.username}` : null,
    bio: u.bio || null,
    chips,
  };
}

/** The opt-in public profile's owner controls (#582). */
export function publicControlsView(state) {
  const owner = state.data && state.data.ownerPublicProfile;
  if (!owner) return null;
  const profile = owner.profile || {};
  return {
    profile,
    published: !!owner.published,
    moderationDisabled: !!owner.moderationDisabled,
    visibility: owner.moderationDisabled
      ? 'Hidden by moderation'
      : owner.published ? 'Published' : 'Private',
    visibilityClass: owner.moderationDisabled
      ? 'text-red-700 dark:text-red-400'
      : owner.published
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-zinc-500 dark:text-zinc-400',
    openHref: profile.url || `#profile/${encodeURIComponent(profile.username || '')}`,
    publishLabel: owner.published ? 'Unpublish' : 'Publish profile',
  };
}

/** The avatar block on a PUBLIC profile card, which is a different shape: the
 *  initial sits behind an absolutely-positioned image so a failed load can drop
 *  the image and reveal the fallback without shifting layout. */
export function publicAvatarView(profile) {
  const source = String(profile.displayName || profile.username || '?');
  const match = source.match(/[\p{L}\p{N}]/u);
  const url = (typeof profile.avatarUrl === 'string'
    && /^\/avatars\/[a-f0-9]{32}$/.test(profile.avatarUrl))
    ? profile.avatarUrl : null;
  return { initial: match ? match[0].toUpperCase() : '?', url };
}

/**
 * The backend zeroes total_tokens until terms are accepted, so a gated
 * allocation must show the terms notice, never a fake 0 balance (mirrors the
 * native TokenAllocationGatedNotice).
 */
export function tokenView(ranking, revealed) {
  if (ranking.terms_accepted === false) return { gated: true };
  return {
    gated: false,
    amount: Number(ranking.total_tokens || 0).toLocaleString(),
    revealed: !!revealed,
  };
}

/** The viewer's OWN completions — see the note in ./profile.js about why this
 *  is not the season's challenge grid filtered on `completed`. */
export function completedView(payload, now = Date.now()) {
  const rows = (payload && Array.isArray(payload.completed)) ? payload.completed : [];
  const seasonName = payload && payload.season ? payload.season.name : null;
  return {
    title: seasonName ? `Completed challenges: ${seasonName}` : 'Completed challenges',
    count: (payload && Number(payload.total) > 0)
      ? `${Number(payload.done || 0)} of ${Number(payload.total)} done`
      : null,
    rows: rows.map((c) => {
      const meta = [];
      if (c.label) meta.push(c.label);
      if (Number(c.earned_points) > 0) {
        meta.push(`${Number(c.earned_points).toLocaleString()} pts earned`);
      }
      const when = relativeDate(c.last_activity_at, now);
      if (when) meta.push(when);
      return {
        id: String(c.id),
        // A real anchor, not a click handler: this is a navigation, so it gets
        // middle-click, long-press-to-copy and the back gesture for free. The
        // event id rides in the path because the Challenges pane fetches per
        // season event — see App._routeLeaderboard and
        // TopochainChallenges.openFromHash.
        href: '#leaderboard/challenges/'
          + `${encodeURIComponent(c.season_event_id)}/${encodeURIComponent(c.id)}`,
        title: c.goal || c.task || 'Challenge',
        meta: meta.length ? meta.join(' · ') : null,
      };
    }),
  };
}

/**
 * The whole screen, as one discriminated view. `empty` is the initial value and
 * the only one the prerender pass can produce.
 */
export function buildProfileView(state, now = Date.now()) {
  if (!state.open) return { kind: 'empty' };
  const d = state.data;
  if (!d) return { kind: 'loading' };
  if (d.signedOut) return { kind: 'signedOut' };
  if (d.error) return { kind: 'error' };
  if (d.publicNotFound) return { kind: 'publicNotFound' };
  if (d.publicProfile) {
    const viewer = state.user || {};
    return {
      kind: 'public',
      profile: d.publicProfile,
      // No self-report, no report from a signed-out or access-less visitor.
      allowReport: !!viewer.username
        && viewer.hasPlatformAccess !== false
        && viewer.username !== d.publicProfile.username,
    };
  }

  const r = d.ranking || {};
  const sub = [];
  if (r.rank) {
    sub.push(`Rank #${r.rank}` + (r.total_participants ? ` of ${r.total_participants}` : ''));
  }
  const seasonName = r.season_name || (d.season && d.season.name) || null;
  if (seasonName) sub.push(seasonName);

  return {
    kind: 'own',
    identity: identityView(state),
    publicControls: publicControlsView(state),
    points: Number(r.total_points || 0).toLocaleString(),
    sub: sub.length ? sub.join(' · ') : null,
    token: tokenView(r, state.revealed),
    breakdown: breakdownRows(d.breakdown),
    completed: completedView(d.completed, now),
  };
}
