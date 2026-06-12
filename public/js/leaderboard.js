// Kudos leaderboard screen.
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

const Leaderboard = {
  _open: false,
  sub: 'prs',           // 'prs' | 'users' | 'history'
  window: 'all',         // 'all' | 'week'
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
    Leaderboard._render();
    Leaderboard._load();
    // Header budget badge tells the user how many kudos they have
    // left; the leaderboard screen is exactly where they're most
    // likely to want to give kudos, so refresh just before render so
    // the badge tone is up-to-date.
    if (window.Kudos?.Budget?.refresh) Kudos.Budget.refresh();
  },

  close() {
    Leaderboard._open = false;
  },

  // Re-fetch every cached pane (or just the active one) and re-render.
  // Called on `kudos_update` WS events while the screen is open.
  refresh() {
    if (!Leaderboard._open) return;
    // My history only changes from the viewer's OWN actions (see
    // invalidateHistory below) — other people's kudos can't add rows,
    // so skip the re-fetch entirely while it's the active pane.
    if (Leaderboard.sub === 'history') return;
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
    Leaderboard._syncHash();
    // Called before open() during deep-link restore — just record the
    // state; open() does the first render.
    if (!Leaderboard._open) return;
    Leaderboard._render();
    Leaderboard._load();
  },

  // Keep the hash deep-linkable (#leaderboard/history etc.) without
  // polluting history — replaceState, and only while we're actually on
  // a leaderboard hash (never hijack an app route mid-navigation).
  _syncHash() {
    const target = `#leaderboard/${Leaderboard.sub}`;
    if (location.hash.startsWith('#leaderboard') && location.hash !== target) {
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
      if (Leaderboard.sub === 'history') {
        res = await fetch(`/api/me/history?type=${Leaderboard._historyType()}&limit=50`);
      } else {
        const path = Leaderboard.sub === 'prs' ? 'prs' : 'users';
        res = await fetch(`/api/leaderboard/${path}?window=${Leaderboard.window}&limit=20`);
      }
      if (!res.ok) {
        Leaderboard._cache.set(key, { error: true });
      } else {
        const data = await res.json();
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

  // Append-mode fetch of the next history page using the keyset cursor.
  async _loadMore() {
    if (Leaderboard.sub !== 'history' || Leaderboard._moreLoading) return;
    const key = Leaderboard._key('history');
    const data = Leaderboard._cache.get(key);
    if (!data || data.error || !data.nextBefore) return;
    Leaderboard._moreLoading = true;
    Leaderboard._renderBody();
    try {
      const res = await fetch(
        `/api/me/history?type=${Leaderboard._historyType()}&limit=50&before=${encodeURIComponent(data.nextBefore)}`
      );
      if (res.ok) {
        const page = await res.json();
        data.items = (data.items || []).concat(page.items || []);
        data.nextBefore = page.nextBefore;
      } else {
        // Leave the cursor in place so the button retries.
        console.warn('[leaderboard] history load-more failed', res.status);
      }
    } catch (err) {
      console.warn('[leaderboard] history load-more failed', err);
    } finally {
      Leaderboard._moreLoading = false;
      Leaderboard._renderBody();
    }
  },

  _render() {
    const root = document.getElementById('leaderboard-root');
    if (!root) return;
    const isHistory = Leaderboard.sub === 'history';
    const subTabs = ['prs', 'users', 'history'].map((s) => {
      const active = s === Leaderboard.sub;
      const label = s === 'prs' ? 'Top PRs' : s === 'users' ? 'Top users' : 'My history';
      const cls = active
        ? 'border-violet-500 text-violet-700 dark:text-violet-300'
        : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200';
      return `<button data-lb-sub="${s}" class="px-3 py-2 text-sm font-medium border-b-2 ${cls}">${label}</button>`;
    }).join('');
    // The All-time / This week pills only apply to the leaderboard
    // tabs — history is always everything, newest first.
    const winTabs = isHistory ? '' : ['all', 'week'].map((w) => {
      const active = w === Leaderboard.window;
      const label = w === 'all' ? 'All-time' : 'This week';
      const cls = active
        ? 'bg-violet-600 text-white'
        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700';
      return `<button data-lb-win="${w}" class="px-3 py-1 text-xs font-medium rounded-full ${cls}">${label}</button>`;
    }).join('');

    const subtitle = isHistory
      ? 'Everything you’ve given — kudos, bounty pledges, and votes — newest first. Only you can see this.'
      : '5 kudos per week, resets Monday 00:00 UTC. Give them to PRs you appreciate.';

    root.innerHTML = `
      <header class="mb-4">
        <h2 class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">Kudos leaderboard</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">${subtitle}</p>
      </header>
      <div class="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 mb-3">
        <div class="flex gap-4">${subTabs}</div>
        <div class="flex gap-2 pb-1">${winTabs}</div>
      </div>
      <div id="leaderboard-body" class="mt-2"></div>
    `;
    root.querySelectorAll('[data-lb-sub]').forEach((btn) => {
      btn.addEventListener('click', () => Leaderboard._setSub(btn.dataset.lbSub));
    });
    root.querySelectorAll('[data-lb-win]').forEach((btn) => {
      btn.addEventListener('click', () => Leaderboard._setWindow(btn.dataset.lbWin));
    });
    Leaderboard._renderBody();
  },

  _renderBody() {
    const body = document.getElementById('leaderboard-body');
    if (!body) return;
    if (Leaderboard.sub === 'history') {
      Leaderboard._renderHistoryBody(body);
      return;
    }
    const key = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    const data = Leaderboard._cache.get(key);

    if (!data) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-zinc-500">Loading…</div>`;
      return;
    }
    if (data.error) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-red-500">Couldn’t load leaderboard. Try again later.</div>`;
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-zinc-500">
        No kudos ${Leaderboard.window === 'week' ? 'this week ' : ''}yet.
        ${Leaderboard.sub === 'prs' ? 'When someone gives a PR kudos, it shows up here.' : 'When a user gets kudos on a PR they authored, they show up here.'}
      </div>`;
      return;
    }
    body.innerHTML = Leaderboard.sub === 'prs'
      ? Leaderboard._renderPrRows(items)
      : Leaderboard._renderUserRows(items);
    Leaderboard._wireRouteButtons(body);
  },

  _renderHistoryBody(body) {
    const key = Leaderboard._key('history');
    const data = Leaderboard._cache.get(key);

    const chip = (which, label, on) => {
      const cls = on
        ? 'bg-violet-600 text-white border-violet-600'
        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700';
      return `<button data-lb-hfilter="${which}" class="px-3 py-1 text-xs font-medium rounded-full border ${cls}">${label}</button>`;
    };
    const chips = `
      <div class="flex items-center gap-2 mb-3">
        ${chip('kudos', '\u{1F44F} Kudos', Leaderboard._histKudos)}
        ${chip('votes', '\u{1F5F3}️ Votes', Leaderboard._histVotes)}
      </div>`;

    let listHtml;
    if (!data) {
      listHtml = `<div class="py-8 text-center text-sm text-zinc-500">Loading…</div>`;
    } else if (data.error) {
      listHtml = `<div class="py-8 text-center text-sm text-red-500">Couldn’t load your history. Try again later.</div>`;
    } else {
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        listHtml = `<div class="py-8 text-center text-sm text-zinc-500">
          Nothing here yet. Kudos, bounty pledges, and votes you give will appear here.
        </div>`;
      } else {
        const more = data.nextBefore
          ? `<div class="mt-3 text-center">
               <button data-lb-more class="px-4 py-1.5 text-sm font-medium rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900" ${Leaderboard._moreLoading ? 'disabled' : ''}>
                 ${Leaderboard._moreLoading ? 'Loading…' : 'Load more'}
               </button>
             </div>`
          : '';
        listHtml = Leaderboard._renderHistoryRows(items) + more;
      }
    }

    body.innerHTML = chips + listHtml;
    body.querySelectorAll('[data-lb-hfilter]').forEach((btn) => {
      btn.addEventListener('click', () => Leaderboard._toggleHistoryFilter(btn.dataset.lbHfilter));
    });
    const moreBtn = body.querySelector('[data-lb-more]');
    if (moreBtn) moreBtn.addEventListener('click', () => Leaderboard._loadMore());
    Leaderboard._wireRouteButtons(body);
  },

  _renderHistoryRows(items) {
    const rows = items.map((it) => {
      // Absolute dates — the list is historical and relative times age
      // poorly in a permanent record.
      const when = Leaderboard._fmtDate(it.created_at);
      let marker = '';
      let title = '';
      let metaBits = [];
      const appName = it.app?.name || it.app?.slug || 'app';

      if (it.type === 'kudos') {
        marker = `<span class="text-base" aria-hidden="true">\u{1F44F}</span>`;
        title = it.pr?.title || `PR #${it.pr?.number ?? it.pr?.sessionId ?? '?'}`;
        metaBits.push(`by @${escapeHtml(it.pr?.author || 'deleted user')}`);
        metaBits.push(escapeHtml(appName));
      } else if (it.type === 'bounty') {
        marker = `<span class="inline-flex items-center gap-1"><span class="text-base" aria-hidden="true">\u{1F44F}</span><span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">bounty</span></span>`;
        title = `Pledged kudos on issue #${it.issue?.number ?? '?'}`;
        metaBits.push(escapeHtml(appName));
        if (it.status === 'awarded') {
          const to = it.awarded?.username ? `@${it.awarded.username}` : 'deleted user';
          const at = it.awarded?.at ? ` ${Leaderboard._fmtDate(it.awarded.at)}` : '';
          metaBits.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">awarded to ${escapeHtml(to)}${escapeHtml(at)}</span>`);
        } else if (it.status === 'voided') {
          metaBits.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title="Your own PR closed this issue, so the pledge was returned to your weekly allowance">voided</span>`);
        } else {
          metaBits.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">open</span>`);
        }
      } else if (it.type === 'pr_vote') {
        const yes = it.vote === 'yes';
        marker = yes
          ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">yes</span>`
          : `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">no</span>`;
        title = it.pr?.title || `PR #${it.pr?.number ?? it.pr?.sessionId ?? '?'}`;
        metaBits.push(`by @${escapeHtml(it.pr?.author || 'deleted user')}`);
        metaBits.push(escapeHtml(appName));
        // pr_votes keeps only the standing vote; the timestamp is the
        // last cast/flip, not the first.
        metaBits.push('<span class="italic">current vote</span>');
      } else if (it.type === 'proposal_vote') {
        const up = it.vote === 'up';
        marker = up
          ? `<span class="text-emerald-600 dark:text-emerald-400 font-bold" aria-hidden="true">▲</span>`
          : `<span class="text-red-600 dark:text-red-400 font-bold" aria-hidden="true">▼</span>`;
        title = it.issue?.title || `Proposal #${it.issue?.number ?? '?'}`;
        if (it.issue?.kind && it.issue.kind !== 'general') {
          metaBits.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">${escapeHtml(it.issue.kind)}</span>`);
        }
        metaBits.push(escapeHtml(appName));
        metaBits.push('<span class="italic">current vote</span>');
      } else {
        return '';
      }

      const meta = metaBits.join('<span class="text-zinc-400"> · </span>');
      const slug = it.app?.slug || '';
      return `
        <button data-lb-pr-route="${escapeAttr(slug)}"
                class="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">
          <div class="w-12 shrink-0 flex items-center justify-center">${marker}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">${escapeHtml(title)}</div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">${meta}</div>
          </div>
          <div class="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">${escapeHtml(when)}</div>
        </button>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  },

  _fmtDate(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  },

  // Buttons that carry data-lb-pr-route route to that app's group chat
  // — the PR card / Open Issues panel lives there. Wired lazily after
  // each body render so we don't fight with the rerender.
  _wireRouteButtons(body) {
    body.querySelectorAll('[data-lb-pr-route]').forEach((el) => {
      el.addEventListener('click', () => {
        const slug = el.dataset.lbPrRoute;
        if (!slug) return;
        // Land on the app's Proposals tab. The PR appears in the
        // open/merged list there; the user can hit kudos right
        // from the card. Deep-link to the session when we have it.
        const sid = el.dataset.lbPrSession || '';
        window.location.hash = sid
          ? `#app/${slug}/dev/proposals/${sid}`
          : `#app/${slug}/dev/proposals`;
      });
    });
  },

  _renderPrRows(items) {
    const rows = items.map((row, i) => {
      const rank = i + 1;
      const title = row.pr_title || `PR #${row.pr_number || row.session_id}`;
      const author = row.author_username || 'unknown';
      const appName = row.app_name || row.app_slug || 'app';
      const status = row.status || '';
      const statusBadge = status === 'merged'
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">merged</span>'
        : status === 'merging'
          ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">merging</span>'
          : '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">open</span>';
      return `
        <button data-lb-pr-route="${escapeAttr(row.app_slug)}" data-lb-pr-session="${row.session_id}"
                class="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">
          <div class="w-7 text-center text-sm font-mono text-zinc-500">${rank}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">${escapeHtml(title)}</div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              ${statusBadge}
              <span>by @${escapeHtml(author)}</span>
              <span class="text-zinc-400">·</span>
              <span>${escapeHtml(appName)}</span>
            </div>
          </div>
          <div class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-sm font-semibold">
            <span aria-hidden="true">\u{1F44F}</span>
            <span>${row.kudos_count}</span>
          </div>
        </button>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  },

  _renderUserRows(items) {
    const rows = items.map((row, i) => {
      const rank = i + 1;
      const who = row.username || 'unknown';
      const initial = (who[0] || '?').toUpperCase();
      const prsMerged = row.prs_merged || 0;
      const kudosOnUnmerged = row.kudos_received_prs_unmerged || 0;
      // Headline score = kudos earned on MERGED PRs. This is what the
      // leaderboard now ranks by (issue #59), so the big badge shows it
      // rather than total kudos across all PRs.
      const mergedKudos = row.kudos_received_prs_merged || 0;
      // prs_merged is all-time (no merge timestamp to window by), so only
      // show it in the all-time view to avoid implying a weekly figure.
      // Kept as a secondary detail now that ranking is by kudos, not
      // merge count.
      const mergedMeta = (Leaderboard.window === 'all' && prsMerged > 0)
        ? `<span class="text-zinc-400">·</span><span>${prsMerged} merged</span>`
        : '';
      // Footnote on the kudos badge: how many additional kudos sit on
      // PRs that haven't landed yet (and so don't count toward the
      // ranking score). Only meaningful when > 0.
      const unmergedKudosNote = kudosOnUnmerged > 0
        ? `<span class="shrink-0 text-[11px] text-amber-600 dark:text-amber-400" title="Kudos on PRs that haven’t merged yet — not counted toward ranking">+${kudosOnUnmerged} on unmerged</span>`
        : '';
      return `
        <div class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div class="w-7 text-center text-sm font-mono text-zinc-500">${rank}</div>
          <div class="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-sm">${escapeHtml(initial)}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">@${escapeHtml(who)}</div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>${row.prs_kudosed} PR${row.prs_kudosed === 1 ? '' : 's'} kudosed</span>
              ${mergedMeta}
            </div>
          </div>
          ${unmergedKudosNote}
          <div class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-sm font-semibold" title="Kudos earned on merged PRs">
            <span aria-hidden="true">\u{1F44F}</span>
            <span>${mergedKudos}</span>
          </div>
        </div>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

window.Leaderboard = Leaderboard;
