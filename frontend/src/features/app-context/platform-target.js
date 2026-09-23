/**
 * Homeroom as the mark menu's subject, found without Home — window.PlatformTarget.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 *
 * On every platform tab the menu behind the mark is Homeroom's own: feedback
 * on the platform, its workshop, its discussion, About Homeroom. Its subject
 * is the platform's self-hosted `apps` row, and the only thing that published
 * it was Home — Home.publishImproveTarget reads the row out of the GET
 * /api/apps list that Home loads, or out of a copy remembered from an earlier
 * visit. A device whose first visit landed anywhere else (#messages from a
 * notification, #workshop from a bookmark, #profile, #settings) had neither,
 * so the menu said "THIS APP", its Go to workshop pointed at `#` and landed on
 * Home, and About opened empty. It fixed itself once Home had been visited;
 * for a viewer who is not served the row at all (SELF_APP_PUBLIC_VOTING off,
 * not an admin) it never did.
 *
 * ── What this does instead ─────────────────────────────────────────────
 *
 * Finds the platform by itself, in at most two reads:
 *
 *   1. GET /api/platform/about — the About Homeroom pane's own read
 *      (src/routes/platform-about.js), which also says, for this viewer, the
 *      platform's slug and whether GET /api/apps/<slug> will answer them
 *      (`served`: an admin, or SELF_APP_PUBLIC_VOTING on);
 *   2. when it will, GET /api/apps/<slug> — the same route and the same
 *      visibility gate an app's own page uses — for the row.
 *
 * A row makes the ordinary platform target; a viewer who is not served one
 * gets the RESTRICTED target: Homeroom, with the workshop and discussion rows
 * hidden (Home._restrictedPlatformTarget says why). The row is never probed
 * for a viewer the answer says it would refuse: a 404 is a red "Failed to
 * load resource" line in their console on every cold load, and the platform's
 * checks count console errors. Either way the target is handed back to
 * Home.publishImproveTarget rather than published from here, so its two
 * gates — no app open, not mid-way out of one — still decide whether the
 * platform may be the subject right now.
 *
 * If the about read fails, the slug still comes from GET /api/version (public,
 * tiny, usually already in hand as App._lastVersionInfo) and the row is asked
 * for directly, as the fallback.
 *
 * ── What it does not do ────────────────────────────────────────────────
 *
 * It never overrides the list. Once Home has loaded GET /api/apps that list
 * is the truth, and Home publishes from it directly; this only answers while
 * the list is absent, and for the slug a not-served viewer's target needs.
 *
 * NOTHING HERE RUNS DURING A RENDER. Every call is from a publish path that
 * App.init reaches after hydration, or from an effect of the About pane, so
 * the prerendered menu and the first client render still agree.
 */

/** A failed lookup is not retried on every screen change — once a while. */
const RETRY_MS = 30 * 1000;

/** How long the about payload is reused: the server caches it for a minute too. */
const ABOUT_TTL_MS = 60 * 1000;

function selfSlugFromVersion(info) {
  const slug = info && typeof info.selfAppSlug === 'string' ? info.selfAppSlug.trim() : '';
  return slug || null;
}

function demoQS() {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

export const PlatformTarget = {
  /** The platform's slug, once a read has said it. */
  _slug: null,
  /** The target the last lookup found, served row or restricted. */
  _known: null,
  /** The served self-hosted row itself (About reads it). Null when not served. */
  _row: null,
  /** The lookup in flight, so a burst of screen changes asks once. */
  _pending: null,
  /** When the last lookup failed, for RETRY_MS. */
  _failedAt: 0,
  /** GET /api/platform/about's last answer, when, and the read in flight. */
  _about: null,
  _aboutAt: 0,
  _aboutPending: null,

  /** The resolved target, or null. */
  known() {
    return PlatformTarget._known;
  },

  /** The served self-hosted row, or null — the detail payload About reads. */
  row() {
    return PlatformTarget._row;
  },

  /** The platform's slug, from our own reads or the version pill's. */
  slug() {
    return PlatformTarget._slug
      || selfSlugFromVersion(PlatformTarget._about)
      || selfSlugFromVersion(typeof window !== 'undefined' ? window.App?._lastVersionInfo : null);
  },

  /** The last about payload, or null — for a first render that has one. */
  cachedAbout() {
    return PlatformTarget._about;
  },

  /**
   * GET /api/platform/about, reused for a minute and asked once at a time.
   * Resolves null when it cannot be read; the caller says what it can
   * without it.
   */
  about() {
    if (PlatformTarget._about && Date.now() - PlatformTarget._aboutAt < ABOUT_TTL_MS) {
      return Promise.resolve(PlatformTarget._about);
    }
    if (PlatformTarget._aboutPending) return PlatformTarget._aboutPending;
    PlatformTarget._aboutPending = (async () => {
      try {
        const res = await fetch(`/api/platform/about${demoQS()}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || typeof data !== 'object' || !data.stats) return null;
        PlatformTarget._about = data;
        PlatformTarget._aboutAt = Date.now();
        return data;
      } catch {
        return null;
      } finally {
        PlatformTarget._aboutPending = null;
      }
    })();
    return PlatformTarget._aboutPending;
  },

  async _versionSlug() {
    const known = selfSlugFromVersion(typeof window !== 'undefined' ? window.App?._lastVersionInfo : null);
    if (known) return known;
    const res = await fetch('/api/version');
    if (!res.ok) return null;
    return selfSlugFromVersion(await res.json());
  },

  /**
   * Look the platform up, then ask Home to publish what was found.
   *
   * `served: false` when a loaded GET /api/apps has already answered that the
   * row is not served — then only the slug is needed. Returns the lookup's
   * promise (the one in flight, when there is one).
   */
  resolve({ served = null } = {}) {
    if (PlatformTarget._pending) return PlatformTarget._pending;
    if (PlatformTarget._failedAt && Date.now() - PlatformTarget._failedAt < RETRY_MS) {
      return Promise.resolve(PlatformTarget._known);
    }
    const Home = () => (typeof window !== 'undefined' ? window.Home : null);
    const restricted = (slug) => {
      PlatformTarget._row = null;
      PlatformTarget._known = Home()?._restrictedPlatformTarget?.(slug) || null;
    };
    PlatformTarget._pending = (async () => {
      try {
        const about = await PlatformTarget.about();
        const slug = selfSlugFromVersion(about) || await PlatformTarget._versionSlug();
        // Home's list is the first authority, the about read the second; with
        // neither, ask for the row and let its answer say.
        const rowServed = served === false ? false : (about ? about.served !== false : true);
        if (!slug) {
          PlatformTarget._failedAt = Date.now();
        } else if (!rowServed) {
          PlatformTarget._slug = slug;
          restricted(slug);
        } else {
          PlatformTarget._slug = slug;
          const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
          if (res.ok) {
            const data = await res.json();
            const row = data && data.app;
            if (row && row.slug && row.self_hosted) {
              PlatformTarget._row = row;
              PlatformTarget._known = Home()?._platformTargetFrom?.(row) || null;
            }
          } else if (res.status === 404 || res.status === 403) {
            // The route answers 404 rather than 403 so the row's existence
            // is not disclosed: not served, which is what the restricted
            // target is for.
            restricted(slug);
          } else {
            PlatformTarget._failedAt = Date.now();
          }
        }
      } catch {
        // Offline is a state, not an error: the menu keeps whatever it had,
        // and a later screen change asks again after RETRY_MS.
        PlatformTarget._failedAt = Date.now();
      } finally {
        PlatformTarget._pending = null;
      }
      if (PlatformTarget._known) Home()?.publishImproveTarget?.();
      return PlatformTarget._known;
    })();
    return PlatformTarget._pending;
  },
};

if (typeof window !== 'undefined') {
  window.PlatformTarget = PlatformTarget;
}
