// Leaderboard screen — the one place the group's shared progress lives:
// the Topochain standings, the Kudos leaderboard, and the season's
// challenges, as three top-level sections of one screen.
//
// Two levels of tabs:
//   1. SECTION (Challenges | Kudos | Standings | History), rendered into
//      #standings-tabs by this module. 'challenges' — the one a fresh visit
//      opens on (#2374) — reveals #challenges-root and hands off to
//      TopochainChallenges; 'topochain', labelled "Standings" (it was
//      "Leaderboard" while that was also the screen's own heading),
//      reveals #topochain-leaderboard-root and hands off to the
//      TopochainLeaderboard module. Both are Topochain-domain
//      views of one EVENT, so they also share the screen-level event bar
//      (#leaderboard-event-bar, owned by TopochainEventContext) — hidden
//      on Kudos, which has no event dimension. 'seasons', labelled
//      "History", reveals #leaderboard-history-root: the seasons that have
//      ENDED, their winners and each event's winner (./history.js). It
//      spans seasons, so the one-event bar is hidden there too.
//      Everything below this point is the Kudos pane and is unchanged by
//      the merge.
//   2. Within Kudos: three sub-views (Top PRs, Top Users, My history)
//      and — for the two leaderboard tabs — two window tabs.
//
// Three sub-views (Top PRs, Top Users, My history) and — for the two
// leaderboard tabs — two window tabs (All-time, This week). Each
// sub+window (or history+filter) pane is cached; switching tabs is
// instant once the data is in. Live `kudos_update` events bump the
// count of any already-rendered row and (less precisely) re-fetch when
// the changed row isn't in the current top-N — cheap given the screen
// is rarely open.
//
// "My history" is the signed-in user's own give-side record (kudos,
// bounty pledges, PR votes, proposal votes) from GET /api/me/history —
// reverse-chronological, keyset-paginated via `nextBefore`, filterable
// with the Kudos / Votes chips. The window pills don't apply to it.
//
// Hosted in #leaderboard-root; mounted/unmounted by App.navigateToLeaderboard
// when the #leaderboard hash route is active.
//
// The screen around all of this is React's as of #1083 chunk F (see
// ./index.tsx), and one thing moved with it: the SECTION TAB STRIP. This module
// used to innerHTML three buttons into #standings-tabs; that host is rendered
// from the Tabs primitive now, so _renderSectionTabs() publishes the active
// section instead of writing DOM (see ./section-store.ts). Everything else is
// unchanged — the three panes are still innerHTML hosts this module and its two
// guest modules own, and a trigger's click still calls _setSection().
//
// #1191 slice 6 conversion 6 finished the KUDOS pane. #leaderboard-root is
// React-owned now: ./kudos-pane.tsx is its only writer, and this module builds
// DESCRIPTORS for it (chromeView / bodyView and the *RowViews helpers) instead
// of HTML strings. Everything that decides WHAT to show still lives here — the
// caches, the fetches, the tab state, the labels and the class strings — so
// this was a change of output type, not of behaviour. What genuinely retired
// is the four addEventListener sweeps that re-bound the pane after each render
// (their handlers are now named methods the renderer calls: _setSub,
// _setWindow, _toggleHistoryFilter, _openUser, _routeToPr, _loadMore) and the
// escapeHtml/escapeAttr pair at the foot of the file.
//
// The two remaining panes are unchanged by that: #topochain-leaderboard-root
// went stateful in conversion 5, #challenges-root is conversion 7, and pane
// VISIBILITY still belongs to _applySection's classList.toggle for all three.

// The section store's accessor, duplicated identically from
// ./section-store.ts — see that file's header for why this module publishes
// through `window` rather than importing it.
const LEADERBOARD_SECTION_STORE_KEY = '__usernodeLeaderboardSection';

function leaderboardSectionStore() {
  let store = window[LEADERBOARD_SECTION_STORE_KEY];
  if (!store) {
    store = { mounted: false, section: 'challenges', listeners: new Set() };
    window[LEADERBOARD_SECTION_STORE_KEY] = store;
  }
  return store;
}

const Leaderboard = {
  // ./kudos-pane-store.js, planted by ./mount.ts rather than imported — see
  // that store's header for why this file takes no import. Null during the
  // SSG prerender pass and until the bundle mounts, so every write goes
  // through `?.set(...)`.
  _store: null,
  _open: false,
  // Top-level section of the Leaderboard screen. 'kudos' is everything
  // this module renders itself; 'topochain' and 'challenges' defer to the
  // TopochainLeaderboard / TopochainChallenges modules in the sibling
  // panes. Remembered for the session (the object outlives close()), so
  // re-opening the screen lands where you left it; a fresh page load
  // starts on Challenges (#2374) — the first tab of the strip, what you
  // can do next ahead of the ranking it feeds.
  section: 'challenges',  // 'topochain' | 'kudos' | 'challenges' | 'seasons'
  // Whether TopochainLeaderboard.open() / TopochainChallenges.open() have
  // run for this screen mount — each Topochain-domain pane loads lazily,
  // only once its tab is first shown, and so does the shared event bar
  // they both read from.
  _topoMounted: false,
  _challengesMounted: false,
  _eventBarMounted: false,
  _historyMounted: false,
  sub: 'prs',           // 'prs' | 'users' | 'history'
  window: 'all',         // 'all' | 'week'
  // (#60) Profile drill-in from the Top-users tab. Non-null = the
  // profile view for that username replaces the tab strip. Set via
  // openProfile() (hash #leaderboard/users/<name>), cleared by any
  // _setSub() (i.e. returning to a plain tab hash).
  profileUser: null,
  // History filter chips. Both on (the default) or both off = show
  // everything; exactly one on = narrow to that half.
  _histKudos: true,
  _histVotes: true,
  // sub+window (or history|<type>) => last fetched payload. Invalidated
  // by refresh() / invalidateHistory().
  _cache: new Map(),
  _loadingKey: null,
  _moreLoading: false,

  isOpen() { return Leaderboard._open; },

  async open() {
    Leaderboard._open = true;
    Leaderboard._renderSectionTabs();
    Leaderboard._applySection();
    Leaderboard._syncTitle();
    if (Leaderboard.section === 'kudos') {
      Leaderboard._render();
      Leaderboard._load();
    }
    // The drawer's kudos badge tells the user how many kudos they have
    // left; the Leaderboard screen is exactly where they're most likely to
    // want to give kudos, so refresh on mount so the badge tone is
    // up-to-date next time they open the menu.
    if (window.Kudos?.Budget?.refresh) Kudos.Budget.refresh();
  },

  close() {
    Leaderboard._open = false;
    // The two Topochain panes and the event bar are guests in this screen —
    // tear them down with us so their `_open` guards stop in-flight fetches
    // from painting into a hidden pane, and re-mount on the next visit to
    // that tab. Panes before the bar: each pane unsubscribes in its own
    // close(), and the bar drops any stragglers.
    if (Leaderboard._topoMounted && window.TopochainLeaderboard?.close) {
      TopochainLeaderboard.close();
    }
    if (Leaderboard._challengesMounted && window.TopochainChallenges?.close) {
      TopochainChallenges.close();
    }
    if (Leaderboard._eventBarMounted && window.TopochainEventContext?.close) {
      TopochainEventContext.close();
    }
    if (Leaderboard._historyMounted && window.LeaderboardHistory?.close) {
      LeaderboardHistory.close();
    }
    Leaderboard._topoMounted = false;
    Leaderboard._challengesMounted = false;
    Leaderboard._eventBarMounted = false;
    Leaderboard._historyMounted = false;
  },

  // ── Section (Kudos | Topochain | Challenges) ─────────────────────

  // Every section. The strip's ORDER lives in the island's SECTION_TABS
  // (./index.tsx), Challenges first since #1917. The two that live in the Topochain event domain (i.e. the ones the shared
  // event bar applies to) are declared separately below.
  SECTIONS: ['topochain', 'kudos', 'challenges', 'seasons'],
  EVENT_SECTIONS: ['topochain', 'challenges'],

  // Switch the screen's top-level section. Mirrors _setSub's contract:
  // validate, record, sync the hash, and only render/load when the
  // screen is already mounted (deep-link restore calls this before
  // open()).
  _setSection(section) {
    if (!Leaderboard.SECTIONS.includes(section)) return;
    if (Leaderboard.section === section && Leaderboard._open) return;
    Leaderboard.section = section;
    // Leaving Kudos abandons the profile drill-in — otherwise coming
    // back would land on a stale @user view whose hash we just replaced.
    if (section !== 'kudos') Leaderboard.profileUser = null;
    Leaderboard._syncHash();
    if (!Leaderboard._open) return;
    Leaderboard._renderSectionTabs();
    Leaderboard._applySection();
    Leaderboard._syncTitle();
    if (section === 'kudos') {
      Leaderboard._render();
      Leaderboard._load();
    }
  },

  // Show the active pane, hide the others, and mount each guest module the
  // first time its tab is shown (they fetch on open, so mounting them
  // eagerly would cost several /api/v4 round-trips for people who never
  // leave the Kudos tab). The shared event bar mounts with whichever
  // Topochain-domain tab is shown first, so the panes always find a
  // resolved (or resolving) event id when they open.
  _applySection() {
    const onEventSection = Leaderboard.EVENT_SECTIONS.includes(Leaderboard.section);
    const panes = {
      'leaderboard-root': Leaderboard.section === 'kudos',
      'topochain-leaderboard-root': Leaderboard.section === 'topochain',
      'challenges-root': Leaderboard.section === 'challenges',
      'leaderboard-history-root': Leaderboard.section === 'seasons',
    };
    for (const [id, visible] of Object.entries(panes)) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !visible);
    }
    const bar = document.getElementById('leaderboard-event-bar');
    if (bar) bar.classList.toggle('hidden', !onEventSection);

    if (onEventSection && !Leaderboard._eventBarMounted
        && window.TopochainEventContext?.open) {
      Leaderboard._eventBarMounted = true;
      TopochainEventContext.open();
    }
    if (Leaderboard.section === 'topochain' && !Leaderboard._topoMounted
        && window.TopochainLeaderboard?.open) {
      Leaderboard._topoMounted = true;
      TopochainLeaderboard.open();
    }
    if (Leaderboard.section === 'challenges' && !Leaderboard._challengesMounted
        && window.TopochainChallenges?.open) {
      Leaderboard._challengesMounted = true;
      TopochainChallenges.open();
    }
    if (Leaderboard.section === 'seasons' && !Leaderboard._historyMounted
        && window.LeaderboardHistory?.open) {
      Leaderboard._historyMounted = true;
      LeaderboardHistory.open();
    }
  },

  // THE BAR SAYS WHICH TAB IS SHOWING (bug f of the navigation audit).
  //
  // App._routeLeaderboard titles the screen on the way IN, but a tab press
  // never goes back through the router: _syncHash rewrites the address with
  // replaceState, which fires no hashchange, so the bar went on saying
  // "Challenges" over Kudos or Standings. Every point where the section, the
  // Kudos sub-view or the profile drill-in changes while the screen is open
  // calls this, and the WORDS stay App's (App._leaderboardTitle), so the
  // cold load and the tab press can never name one section two ways.
  _syncTitle() {
    if (!Leaderboard._open) return;
    // A challenge's detail page is a level of the Challenges tab with its own
    // bar ("Challenge", TopochainChallenges._syncChrome); it restores the
    // section's name itself when the page closes.
    if (Leaderboard.section === 'challenges' && window.TopochainChallenges?._detailChallenge) return;
    const app = window.App;
    if (!app || typeof app.setHeaderTitle !== 'function'
        || typeof app._leaderboardTitle !== 'function') return;
    app.setHeaderTitle(app._leaderboardTitle(Leaderboard.section, Leaderboard.profileUser));
  },

  // Publish the active section; <LeaderboardScreen/> renders the strip from
  // it. The tab LABELS and the active/inactive class tables moved with the
  // markup — labels into the island's SECTION_TABS list, classes into the Tabs
  // primitive (frontend/@/components/ui/tabs.tsx) — and the standings tab is
  // labelled "Standings" there, the navigation prototype's word, rather than
  // "Topochain". The `data-standings-tab` KEYS stay as they are — every hash
  // alias in app.js and
  // every dapp.json check speaks in them, and this method's SECTIONS list still
  // validates against them in _setSection.
  _renderSectionTabs() {
    const store = leaderboardSectionStore();
    if (store.mounted && store.section === Leaderboard.section) return;
    store.mounted = true;
    store.section = Leaderboard.section;
    for (const listener of [...store.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error('[leaderboard] section listener failed', err);
      }
    }
  },

  // Re-fetch every cached pane (or just the active one) and re-render.
  // Called on `kudos_update` WS events while the screen is open.
  refresh() {
    if (!Leaderboard._open) return;
    // Kudos events can't change Topochain standings or the challenge grid.
    if (Leaderboard.section !== 'kudos') return;
    // My history only changes from the viewer's OWN actions (see
    // invalidateHistory below) — other people's kudos can't add rows,
    // so skip the re-fetch entirely while it's the active pane.
    if (Leaderboard.sub === 'history' && !Leaderboard.profileUser) return;
    // Profile panes show per-PR kudos counts, so any kudos_update can
    // change them — drop them all; inactive ones re-fetch on next open.
    for (const k of [...Leaderboard._cache.keys()]) {
      if (k.startsWith('user|')) Leaderboard._cache.delete(k);
    }
    // Just invalidate the active pane; the others stay cached and
    // re-fetch on next tab click. Refresh is cheap (one query each),
    // but spamming every pane on every kudos give would be wasteful.
    const k = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    Leaderboard._cache.delete(k);
    Leaderboard._load();
  },

  // Drop the cached history panes so the next look at the tab reflects
  // a kudos/pledge/vote the viewer just made. Called from the post-give
  // path in kudos.js; re-fetches in place when the tab is active.
  invalidateHistory() {
    for (const k of [...Leaderboard._cache.keys()]) {
      if (k.startsWith('history|')) Leaderboard._cache.delete(k);
    }
    if (Leaderboard._open && Leaderboard.sub === 'history') Leaderboard._load();
  },

  _key(sub, win) {
    // Profile view supersedes the tab panes while it's open.
    if (Leaderboard.profileUser) return `user|${Leaderboard.profileUser}`;
    if (sub === 'history') return `history|${Leaderboard._historyType()}`;
    return `${sub}|${win}`;
  },

  // Map the two chips onto the endpoint's type param. Both on (default)
  // or both off = no narrowing.
  _historyType() {
    if (Leaderboard._histKudos === Leaderboard._histVotes) return 'all';
    return Leaderboard._histKudos ? 'kudos' : 'votes';
  },

  _setSub(sub) {
    if (sub !== 'prs' && sub !== 'users' && sub !== 'history') return;
    Leaderboard.sub = sub;
    // A Kudos sub-tab implies the Kudos section — a deep link straight to
    // #leaderboard/history must not land on a Topochain tab left over
    // from earlier in the session.
    Leaderboard.section = 'kudos';
    // Any plain tab navigation leaves the profile drill-in.
    Leaderboard.profileUser = null;
    Leaderboard._syncHash();
    // Called before open() during deep-link restore — just record the
    // state; open() does the first render.
    if (!Leaderboard._open) return;
    Leaderboard._renderSectionTabs();
    Leaderboard._applySection();
    Leaderboard._syncTitle();
    Leaderboard._render();
    Leaderboard._load();
  },

  // (#60) Open the per-user profile view (all of <username>'s proposed
  // PRs). Mirrors _setSub's contract: record state + sync the hash;
  // render/load only when the screen is already mounted (deep-link
  // restore calls this before open()).
  openProfile(username) {
    if (!username) return;
    Leaderboard.profileUser = username;
    // The profile is users-tab territory — back lands on Top users.
    Leaderboard.sub = globalThis.PlatformI18n.t("apps:users_7dfb4cf6");
    Leaderboard.section = 'kudos';
    Leaderboard._syncHash();
    if (!Leaderboard._open) return;
    Leaderboard._renderSectionTabs();
    Leaderboard._applySection();
    Leaderboard._syncTitle();
    Leaderboard._render();
    Leaderboard._load();
  },

  // Keep the hash deep-linkable (#leaderboard/history, /challenges etc.),
  // and only while we're actually on a leaderboard hash (never hijack an app
  // route mid-navigation).
  //
  // #3620: A PRESS IS A PAGE, A ROUTER PASS IS NOT. A tab press on the open
  // screen (the strip, Kudos' own Top changes | Top users | History, the
  // event bar's way to History) PUSHES, so Back from Kudos is Challenges
  // again rather than the Profile screen the leaderboard was opened from.
  // Everything the router does — a deep link healing to its canonical tab,
  // Back or Forward arriving on one — runs inside restoreFromHash
  // (App._isRestoring) or before open(), and keeps REPLACING: Back and
  // Forward are not doors, and an alias is not somewhere to go back to. The
  // legacy #topochain/leaderboard, #topochain/seasons and #challenges hashes
  // have already been rewritten to their #leaderboard/… form by the router
  // before we get here, so the startsWith guard holds for those entry paths
  // too.
  //
  // Both Topochain-domain sections address by NAME, the default one
  // included: a bare '#leaderboard' opens Challenges (#2374) and self-heals
  // here to '#leaderboard/challenges', and the standings — the bare address
  // until then — are '#leaderboard/topochain'.
  _syncHash() {
    const target = Leaderboard.section === 'topochain'
      ? '#leaderboard/topochain'
      : Leaderboard.section === 'challenges'
        ? '#leaderboard/challenges'
        : Leaderboard.section === 'seasons'
          ? '#leaderboard/seasons'
          : Leaderboard.profileUser
            ? `#leaderboard/users/${encodeURIComponent(Leaderboard.profileUser)}`
            : `#leaderboard/${Leaderboard.sub}`;
    if (location.hash.startsWith('#leaderboard') && location.hash !== target) {
      const pressed = Leaderboard._open
        && !(typeof App !== 'undefined' && App && App._isRestoring);
      if (pressed) {
        try { history.pushState(null, '', target); return; } catch (_) { /* replace, below */ }
      }
      history.replaceState(null, '', target);
    }
  },

  _setWindow(win) {
    if (win !== 'all' && win !== 'week') return;
    Leaderboard.window = win;
    Leaderboard._render();
    Leaderboard._load();
  },

  _toggleHistoryFilter(which) {
    if (which === 'kudos') Leaderboard._histKudos = !Leaderboard._histKudos;
    else if (which === 'votes') Leaderboard._histVotes = !Leaderboard._histVotes;
    else return;
    Leaderboard._render();
    Leaderboard._load();
  },

  async _load() {
    // Pull-to-refresh lands here for every section it does not name itself
    // (App._refreshLeaderboard); on History that is the past seasons, which
    // ./history.js loads, not a Kudos pane nobody is looking at.
    if (Leaderboard.section === 'seasons') {
      return window.LeaderboardHistory?.refresh?.();
    }
    const key = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    if (Leaderboard._cache.has(key)) {
      Leaderboard._renderBody();
      return;
    }
    // Same pane already being fetched (e.g. deep-link restore calling
    // _setSub + open back to back) — let the in-flight load finish.
    if (Leaderboard._loadingKey === key) return;
    Leaderboard._loadingKey = key;
    try {
      let res;
      if (Leaderboard.profileUser) {
        res = await fetch(
          `/api/leaderboard/users/${encodeURIComponent(Leaderboard.profileUser)}/prs?limit=50`
        );
      } else if (Leaderboard.sub === 'history') {
        res = await fetch(`/api/me/history?type=${Leaderboard._historyType()}&limit=50`);
      } else {
        const path = Leaderboard.sub === 'prs' ? 'prs' : 'users';
        res = await fetch(`/api/leaderboard/${path}?window=${Leaderboard.window}&limit=20`);
      }
      if (!res.ok) {
        // notFound drives the profile pane's "User not found" copy.
        Leaderboard._cache.set(key, { error: true, notFound: res.status === 404 });
      } else {
        const data = await res.json();
        // The handle was retired and resolved through the ledger —
        // a link shared before its owner renamed. Correct the address so
        // the pane, the back stack and anything the reader copies out of
        // the URL bar all carry the name they actually hold now. Cached
        // under the key that is loading, so the repaint below finds it.
        if (data.moved && Leaderboard.profileUser === data.moved.from) {
          Leaderboard.profileUser = data.moved.to;
          if (typeof location !== 'undefined') {
            location.replace(
              `#leaderboard/users/${encodeURIComponent(data.moved.to)}`
            );
          }
        }
        Leaderboard._cache.set(key, data);
      }
    } catch (err) {
      console.warn('[leaderboard] load failed', err);
      Leaderboard._cache.set(key, { error: true });
    } finally {
      if (Leaderboard._loadingKey === key) {
        Leaderboard._loadingKey = null;
        Leaderboard._renderBody();
      }
    }
  },

  // Append-mode fetch of the next page (profile PR list or history)
  // using the keyset cursor.
  async _loadMore() {
    if (Leaderboard._moreLoading) return;
    if (!Leaderboard.profileUser && Leaderboard.sub !== 'history') return;
    const key = Leaderboard._key('history');
    const data = Leaderboard._cache.get(key);
    if (!data || data.error || !data.nextBefore) return;
    const url = Leaderboard.profileUser
      ? `/api/leaderboard/users/${encodeURIComponent(Leaderboard.profileUser)}/prs?limit=50&before=${encodeURIComponent(data.nextBefore)}`
      : `/api/me/history?type=${Leaderboard._historyType()}&limit=50&before=${encodeURIComponent(data.nextBefore)}`;
    Leaderboard._moreLoading = true;
    Leaderboard._renderBody();
    try {
      const res = await fetch(url);
      if (res.ok) {
        const page = await res.json();
        data.items = (data.items || []).concat(page.items || []);
        data.nextBefore = page.nextBefore;
      } else {
        // Leave the cursor in place so the button retries.
        console.warn('[leaderboard] load-more failed', res.status);
      }
    } catch (err) {
      console.warn('[leaderboard] load-more failed', err);
    } finally {
      Leaderboard._moreLoading = false;
      Leaderboard._renderBody();
    }
  },

  // Publish the pane's CHROME — the profile header, or the sub-tab strip and
  // window pills. ./kudos-pane.tsx renders it. #1191 slice 6 conversion 6 took
  // the innerHTML and the three addEventListener sweeps; the branching, the
  // labels and the class strings are unchanged, they just travel as data now.
  _render() {
    Leaderboard._store?.set({ mounted: true, chrome: Leaderboard.chromeView() });
    Leaderboard._renderBody();
  },

  chromeView() {
    // Profile drill-in replaces the whole tab chrome while open; the
    // body (stats + PR list) renders via _renderBody once data lands.
    if (Leaderboard.profileUser) {
      const who = Leaderboard.profileUser;
      return {
        kind: 'profile',
        who,
        initial: (who[0] || '?').toUpperCase(),
        canMessage: Leaderboard._canMessage(who),
      };
    }
    const isHistory = Leaderboard.sub === 'history';
    const subTabs = ['prs', 'users', 'history'].map((s) => ({
      key: s,
      active: s === Leaderboard.sub,
      label: s === 'prs' ? globalThis.PlatformI18n.t("apps:top_changes_0af147a3") : s === 'users' ? globalThis.PlatformI18n.t("apps:top_users_60541946") : globalThis.PlatformI18n.t("apps:my_history_ca28b082"),
    }));
    // The All-time / This week pills only apply to the leaderboard
    // tabs — history is always everything, newest first.
    const winTabs = isHistory ? [] : ['all', 'week'].map((w) => ({
      key: w,
      active: w === Leaderboard.window,
      label: w === 'all' ? globalThis.PlatformI18n.t("apps:all_time_074daba2") : globalThis.PlatformI18n.t("apps:this_week_8c4eef5a"),
    }));

    const subtitle = isHistory
      ? globalThis.PlatformI18n.t("apps:everything_you_ve_given_kudos_bounty_pledges_and_2cb5f0f9")
      // #964: read the cap from the budget the badge already fetched rather
      // than hardcoding it here, so raising WEEKLY_KUDOS_LIMIT server-side
      // can never leave this subtitle quoting a stale number again. The
      // fallback matches the server constant for the brief window before
      // /api/me/kudos-budget lands (or when it failed).
      // #3230: the weekly reset is named in the viewer's own clock.
      : globalThis.PlatformI18n.t("apps:value1_kudos_per_week_resets_value2_give_them_to_a9768348", { value1: window.Kudos?.Budget?.state?.limit || 20, value2: window.ResetTime ? window.ResetTime.resetWhen('weekly') : globalThis.PlatformI18n.t("apps:message_c5ae7b248fc4") });

    // No <h2> of our own: the Leaderboard screen shell already titles the
    // page and the section tab above says "Kudos". The subtitle stays —
    // it's the one line explaining the weekly kudos budget.
    return { kind: 'tabs', subtitle, subTabs, winTabs };
  },

  // Publish the pane's BODY. Separate from the chrome for the reason
  // ./kudos-pane-store.js's header gives: this runs on every load, cache hit
  // and load-more toggle, and must not re-key the tab strip.
  _renderBody() {
    Leaderboard._store?.set({ body: Leaderboard.bodyView() });
  },

  bodyView() {
    if (Leaderboard.profileUser) return Leaderboard.profileBodyView();
    if (Leaderboard.sub === 'history') return Leaderboard.historyBodyView();

    const key = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    const data = Leaderboard._cache.get(key);

    if (!data) return { kind: 'loading' };
    if (data.error) {
      return { kind: 'error', get message() { return globalThis.PlatformI18n.t("apps:couldn_t_load_leaderboard_try_again_later_7bc1236d"); } };
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      // Assembled here rather than in the renderer so the two variable bits
      // stay next to the sentence they belong to.
      return {
        kind: 'empty',
        message: globalThis.PlatformI18n.t("apps:no_kudos_value1_yet_bb85e124", { value1: Leaderboard.window === 'week' ? globalThis.PlatformI18n.t("apps:this_week_a9bcfba0") : '' })
          + (Leaderboard.sub === 'prs'
            ? globalThis.PlatformI18n.t("apps:when_someone_gives_a_change_kudos_it_shows_up_he_2f483424")
            : globalThis.PlatformI18n.t("apps:when_someone_gets_kudos_on_a_change_they_made_th_79233c2b")),
      };
    }
    return Leaderboard.sub === 'prs'
      ? { kind: 'prs', rows: Leaderboard.prRowViews(items) }
      : { kind: 'users', rows: Leaderboard.userRowViews(items) };
  },

  // (#60) Profile pane body: stat chips + the user's proposed-PR list,
  // with the same Load-more keyset flow as My history.
  profileBodyView() {
    const key = Leaderboard._key();
    const data = Leaderboard._cache.get(key);

    if (!data) return { kind: 'loading' };
    if (data.error) {
      return data.notFound
        ? { kind: 'empty', get message() { return globalThis.PlatformI18n.t("apps:user_not_found_f412be43"); } }
        : { kind: 'error', get message() { return globalThis.PlatformI18n.t("apps:couldn_t_load_this_profile_try_again_later_b7d988f8"); } };
    }

    const s = data.stats || {};
    const prsTotal = s.prs_total || 0;
    const stats = {
      kudosMerged: globalThis.PlatformI18n.t("apps:value1_on_live_changes_97f02fa8", { value1: s.kudos_merged || 0 }),
      chips: [
        { get label() { return globalThis.PlatformI18n.t("apps:value1_live_2c4bcb92", { value1: s.prs_merged || 0 }); }, get title() { return globalThis.PlatformI18n.t("apps:their_changes_that_went_live_bbfb1b32"); } },
        {
          get label() { return globalThis.PlatformI18n.t("apps:message_ff2b4b6c6147", { value1: prsTotal, count: prsTotal }); },
          get title() { return globalThis.PlatformI18n.t("apps:everything_they_put_up_for_the_group_including_o_4df8f313"); },
        },
      ],
    };

    const items = Array.isArray(data.items) ? data.items : [];
    return {
      kind: 'profile',
      stats,
      rows: items.length ? Leaderboard.profilePrRowViews(items) : null,
      // Load-more belongs to the list, so an empty profile doesn't grow one.
      more: items.length ? Leaderboard.moreView(data) : null,
    };
  },

  // The Load-more control, shared by the profile and history panes: present
  // only while the keyset cursor has somewhere left to go, disabled (and
  // relabelled) while a page is in flight.
  moreView(data) {
    if (!data || !data.nextBefore) return null;
    return { loading: !!Leaderboard._moreLoading };
  },

  profilePrRowViews(items) {
    return items.map((row, i) => ({
      key: `${row.app_slug}|${row.session_id}|${i}`,
      title: row.pr_title || globalThis.PlatformI18n.t("apps:untitled_change_63cb7c2e"),
      appName: row.app_name || row.app_slug || 'app',
      badge: Leaderboard._statusBadge(row.status),
      when: Leaderboard._fmtDate(row.created_at),
      // External GitHub link, when the PR has one. The row itself is a
      // div[role=button] (not <button>) because an <a> may not nest
      // inside a <button>.
      extUrl: row.pr_url || null,
      slug: row.app_slug,
      sessionId: row.session_id,
      kudos: row.kudos_count,
    }));
  },

  // Status → badge for the profile PR list. Same palette as the Top PRs
  // badges, plus 'closed' (archived-after-promotion) in the zinc tone
  // the voided-bounty chip uses. A {tone,label} pair now; ./kudos-pane.tsx
  // holds the one class table both this and the Top-PRs badge read from.
  _statusBadge(status) {
    if (status === 'merged') return { tone: 'emerald', get label() { return globalThis.PlatformI18n.t("apps:live_247610f4"); } };
    if (status === 'merging') return { tone: 'amber', get label() { return globalThis.PlatformI18n.t("apps:going_live_9a87940f"); } };
    if (status === 'archived') return { tone: 'zinc', get label() { return globalThis.PlatformI18n.t("apps:closed_c3eefb58"); } };
    return { tone: 'violet', get label() { return globalThis.PlatformI18n.t("apps:open_2348f998"); } };
  },

  // Whether this person page draws the prototype's "Message" button: someone
  // ELSE's page, seen by a signed-in viewer who can use Messages. The same
  // gate the public profile page applies (features/profile/profile-store.js);
  // blocking and message requests are the Messages path's own rules
  // (features/profile/message-person.ts).
  _canMessage(who) {
    const viewer = (typeof window !== 'undefined' && window.App && window.App.user) || null;
    if (!viewer || !viewer.username || viewer.hasPlatformAccess === false) return false;
    return String(viewer.username).toLowerCase() !== String(who || '').toLowerCase();
  },

  // Top-users rows route to the user's profile via a real hash change
  // (pushes a history entry, so back returns to the tab).
  _openUser(who) {
    if (!who) return;
    window.location.hash = `#leaderboard/users/${encodeURIComponent(who)}`;
  },

  historyBodyView() {
    const key = Leaderboard._key('history');
    const data = Leaderboard._cache.get(key);

    // The chips render in every state — they are how you get OUT of a filter
    // that returned nothing, so a load failure must not take them with it.
    const view = {
      kind: 'history',
      chips: [
        { key: 'kudos', get label() { return globalThis.PlatformI18n.t("apps:kudos_b17818b9"); }, on: Leaderboard._histKudos },
        { key: 'votes', get label() { return globalThis.PlatformI18n.t("apps:votes_c77d8b2d"); }, on: Leaderboard._histVotes },
      ],
      list: null,
      more: null,
    };

    if (!data) {
      view.list = { kind: 'loading' };
    } else if (data.error) {
      view.list = { kind: 'error', get message() { return globalThis.PlatformI18n.t("apps:couldn_t_load_your_history_try_again_later_fb29df29"); } };
    } else {
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        view.list = {
          kind: 'empty',
          get message() { return globalThis.PlatformI18n.t("apps:nothing_here_yet_kudos_bounty_pledges_and_votes__86124e94"); },
        };
      } else {
        view.list = { kind: 'rows', rows: Leaderboard.historyRowViews(items) };
        view.more = Leaderboard.moreView(data);
      }
    }
    return view;
  },

  historyRowViews(items) {
    return items.map((it, i) => {
      // Absolute dates — the list is historical and relative times age
      // poorly in a permanent record.
      const when = Leaderboard._fmtDate(it.created_at);
      let marker = null;
      let title = '';
      const metaBits = [];
      const appName = it.app?.name || it.app?.slug || 'app';

      if (it.type === 'kudos') {
        marker = { kind: 'kudos' };
        title = it.pr?.title || globalThis.PlatformI18n.t("apps:untitled_change_63cb7c2e");
        metaBits.push({ kind: 'text', get text() { return globalThis.PlatformI18n.t("apps:by_value1_363778f7", { value1: it.pr?.author || globalThis.PlatformI18n.t("apps:deleted_user_c9cc0c29") }); } });
        metaBits.push({ kind: 'text', text: appName });
      } else if (it.type === 'bounty') {
        marker = { kind: 'bounty' };
        title = globalThis.PlatformI18n.t("apps:pledged_kudos_on_issue_value1_47c4b926", { value1: it.issue?.number ?? '?' });
        metaBits.push({ kind: 'text', text: appName });
        if (it.status === 'awarded') {
          const to = it.awarded?.username ? `@${it.awarded.username}` : globalThis.PlatformI18n.t("apps:deleted_user_c9cc0c29");
          const at = it.awarded?.at ? ` ${Leaderboard._fmtDate(it.awarded.at)}` : '';
          metaBits.push({ kind: 'badge', tone: 'emerald', get text() { return globalThis.PlatformI18n.t("apps:awarded_to_value1_value2_592c52b4", { value1: to, value2: at }); } });
        } else if (it.status === 'voided') {
          metaBits.push({
            kind: 'badge', tone: 'zinc', get text() { return globalThis.PlatformI18n.t("apps:voided_df6a068a"); },
            get title() { return globalThis.PlatformI18n.t("apps:your_own_change_closed_this_request_so_the_pledg_b15a274e"); },
          });
        } else {
          metaBits.push({ kind: 'badge', tone: 'violet', get text() { return globalThis.PlatformI18n.t("apps:open_2348f998"); } });
        }
      } else if (it.type === 'pr_vote') {
        marker = { kind: 'pr_vote', yes: it.vote === 'yes' };
        title = it.pr?.title || globalThis.PlatformI18n.t("apps:untitled_change_63cb7c2e");
        metaBits.push({ kind: 'text', get text() { return globalThis.PlatformI18n.t("apps:by_value1_363778f7", { value1: it.pr?.author || globalThis.PlatformI18n.t("apps:deleted_user_c9cc0c29") }); } });
        metaBits.push({ kind: 'text', text: appName });
        // pr_votes keeps only the standing vote; the timestamp is the
        // last cast/flip, not the first.
        metaBits.push({ kind: 'italic', get text() { return globalThis.PlatformI18n.t("apps:current_vote_03c73be0"); } });
      } else if (it.type === 'proposal_vote') {
        marker = { kind: 'proposal_vote', up: it.vote === 'up' };
        title = it.issue?.title || globalThis.PlatformI18n.t("apps:request_value1_8051e8ec", { value1: it.issue?.number ?? '?' });
        if (it.issue?.kind && it.issue.kind !== 'general') {
          metaBits.push({ kind: 'badge', tone: 'sky', text: Leaderboard._kindLabel(it.issue.kind) });
        }
        metaBits.push({ kind: 'text', text: appName });
        metaBits.push({ kind: 'italic', get text() { return globalThis.PlatformI18n.t("apps:current_vote_03c73be0"); } });
      } else {
        // An unknown row type rendered as the empty string before, i.e. it
        // took up no space in the list. null is the descriptor spelling of
        // that, and the renderer drops it.
        return null;
      }

      return { key: `${it.type}|${it.created_at}|${i}`, marker, title, meta: metaBits, when, slug: it.app?.slug || '' };
    }).filter(Boolean);
  },

  // A proposal's kind as a person would say it (QA 2026-09-24 Q32c). The
  // chip printed the column value, so a secret proposal read "secret_change".
  // The five governance kinds (src/services/governance-kinds.js) have words
  // of their own; anything newer falls back to the value with its
  // underscores spaced out and the first letter raised, never the raw token.
  _KIND_LABELS: Object.freeze({
    get secret_change() { return globalThis.PlatformI18n.t("apps:secret_change_c4d94bb1"); },
    get rename() { return globalThis.PlatformI18n.t("apps:rename_3064d79a"); },
    get close_issue() { return globalThis.PlatformI18n.t("apps:close_issue_ae84bc5f"); },
    get maintenance_campaign() { return globalThis.PlatformI18n.t("apps:maintenance_campaign_88540564"); },
    get featured_illustration() { return globalThis.PlatformI18n.t("apps:featured_illustration_2ad772c7"); },
  }),

  _kindLabel(kind) {
    const key = String(kind || '');
    if (Object.prototype.hasOwnProperty.call(Leaderboard._KIND_LABELS, key)) {
      return Leaderboard._KIND_LABELS[key];
    }
    const words = key.replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
  },

  _fmtDate(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(globalThis.PlatformI18n.getLanguage(), { year: 'numeric', month: 'short', day: 'numeric' });
  },

  // Rows that carry a slug route to that app's group chat — the PR card /
  // Open Issues panel lives there. This was three DOM sweeps
  // (_wireRouteButtons' click + keydown, and _wireUserRows' click) re-run
  // after every body render; the renderer calls it by name now, so the
  // behaviour stays here and only the wiring moved.
  _routeToPr(slug, sessionId) {
    if (!slug) return;
    // Land on the app's Proposals tab. The PR appears in the
    // open/merged list there; the user can hit kudos right
    // from the card. Deep-link to the session when we have it.
    const sid = sessionId || '';
    window.location.hash = sid
      ? `#app/${slug}/dev/proposals/${sid}`
      : `#app/${slug}/dev/proposals`;
  },

  prRowViews(items) {
    return items.map((row, i) => ({
      key: `${row.app_slug}|${row.session_id}|${i}`,
      rank: i + 1,
      title: row.pr_title || globalThis.PlatformI18n.t("apps:untitled_change_63cb7c2e"),
      author: row.author_username || 'unknown',
      appName: row.app_name || row.app_slug || 'app',
      // The Top-PRs strip has no 'archived' case — an archived PR is not on
      // this board at all — so it reads the same table minus that row.
      badge: Leaderboard._statusBadge(row.status === 'merged' || row.status === 'merging'
        ? row.status : ''),
      slug: row.app_slug,
      sessionId: row.session_id,
      kudos: row.kudos_count,
    }));
  },

  userRowViews(items) {
    return items.map((row, i) => {
      const who = row.username || 'unknown';
      const prsMerged = row.prs_merged || 0;
      const kudosOnUnmerged = row.kudos_received_prs_unmerged || 0;
      // The detail line is a list of bits with a "·" between them, so the
      // separators can't drift out of step with the bits they separate.
      // First bit is unconditional; each later one carries its own.
      const meta = [{ get text() { return globalThis.PlatformI18n.t("apps:message_18cc59f1fb77", { value1: row.prs_kudosed, count: row.prs_kudosed }); } }];
      // prs_merged is all-time (no merge timestamp to window by), so only
      // show it in the all-time view to avoid implying a weekly figure.
      // Kept as a secondary detail now that ranking is by kudos, not
      // merge count.
      if (Leaderboard.window === 'all' && prsMerged > 0) {
        meta.push({ get text() { return globalThis.PlatformI18n.t("apps:value1_live_2c4bcb92", { value1: prsMerged }); } });
      }
      // Issues this user filed (issues.created_by). Correctly windowed by
      // created_at, so — unlike prs_merged — it's shown in both windows.
      // Hidden at 0 to match the other optional detail chips.
      const issuesCreated = row.issues_created || 0;
      if (issuesCreated > 0) {
        meta.push({ get text() { return globalThis.PlatformI18n.t("apps:message_a207671c678a", { value1: issuesCreated, count: issuesCreated }); } });
      }
      // Apps this user is currently active on (active_apps: [{slug, name}]).
      // Show a count chip with the app names on hover; hidden at 0 to match
      // the other optional detail chips. This is the same 10-day "active"
      // window used for voting and the group-chat active-users tile.
      const activeApps = Array.isArray(row.active_apps) ? row.active_apps : [];
      if (activeApps.length > 0) {
        meta.push({
          get text() { return globalThis.PlatformI18n.t("apps:message_0578756e9eff", { value1: activeApps.length, count: activeApps.length }); },
          title: globalThis.PlatformI18n.t("apps:active_on_020de972") + activeApps
            .map((a) => (a && a.name) ? a.name : (a && a.slug) || '')
            .filter(Boolean)
            .join(', '),
        });
      }
      return {
        key: `${who}|${i}`,
        rank: i + 1,
        who,
        initial: (who[0] || '?').toUpperCase(),
        meta,
        // Footnote on the kudos badge: how many additional kudos sit on
        // PRs that haven't landed yet (and so don't count toward the
        // ranking score). Only meaningful when > 0.
        unmergedNote: kudosOnUnmerged > 0 ? globalThis.PlatformI18n.t("apps:value1_not_live_yet_851229a1", { value1: kudosOnUnmerged }) : null,
        // Headline score = kudos earned on MERGED PRs. This is what the
        // leaderboard now ranks by (issue #59), so the big badge shows it
        // rather than total kudos across all PRs.
        mergedKudos: row.kudos_received_prs_merged || 0,
      };
    });
  },
};

// The file's escapeHtml/escapeAttr pair retired with the strings in #1191
// slice 6 conversion 6. There is no markup left here to escape: every method
// above returns a descriptor and React escapes the text when it renders it.
// Nothing else read them — they were ambient window properties while this was
// a classic script, but chunk F moved the file into the bundle, where a
// module's identifiers are its own; the four scripts that still read
// escapeHtml/escapeAttr ambiently (app-secrets.js, dev-chat.js,
// home-panels.js, streaming-markdown.js) have been resolving to app-view.js's
// and home.js's copies since then.

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but app.js's #leaderboard hash branch,
// App.navigateToLeaderboard / _routeLeaderboard, its pull-to-refresh handler
// and the three guest modules in this folder
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.Leaderboard = Leaderboard;

// Recompute translated view models from cached data without resetting forms.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => { if (Leaderboard._open) { Leaderboard._render(); Leaderboard._syncTitle(); } });
}
