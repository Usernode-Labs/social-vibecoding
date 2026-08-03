'use strict';

// Browse-all-apps screen (#apps) — the directory half of the home-screen
// split. The home feed is "Your apps" only now (see public/js/home.js
// render()), so every OTHER app this viewer may see lives here: featured
// tiles first, then the platform's usual activity order, each with a
// per-tile add/remove badge.
//
// Deliberately thin: tiles, the added-state predicate, the search matcher
// and the add/remove write are all Home's (renderAppCard in 'browse' mode,
// isYours, matchesQuery, _wireDiscoveryCards / toggleAdded), so the two
// launcher grids cannot drift apart. What this file owns is the screen:
// its own fetch + cache, its always-visible search field, and the empty
// states.
//
// Mounted by App.navigateToBrowse (#apps hash route) into the static shell
// in index.html; PTR is wired once by App._wirePullToRefresh.

const Browse = {
  _open: false,
  _apps: [],
  _query: '',
  _searchWired: false,
  _searchDebounce: null,

  isOpen() { return Browse._open; },

  // Screen entry. First paint borrows Home's cache when it has one (the
  // user almost always arrives from the home feed, so the grid renders
  // instantly), then the refetch below reconciles.
  open() {
    Browse._open = true;
    if (!Browse._apps.length && Array.isArray(Home._apps) && Home._apps.length) {
      Browse._apps = Home._apps;
      Browse.render();
    }
    Browse._load();
  },

  close() {
    Browse._open = false;
  },

  // Same endpoint (and same ?demo=1 passthrough) as Home.load: one
  // visibility-filtered payload backs both screens, so a featured private
  // app is simply absent for a viewer who can't see it — no extra gating
  // here. Writes land in Home._apps too, so returning home shows the adds
  // made here even before its own reload.
  async _load() {
    const listEl = document.getElementById('browse-list');
    try {
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const res = await fetch(`/api/apps${demoQS}`);
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      Browse._apps = apps;
      Home._apps = apps;
      Browse.render();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = '<div class="col-span-full p-4 text-red-400 text-sm">Failed to load apps</div>';
      }
    }
  },

  // Featured first (by the admin's featured_order, ascending), then the
  // server's activity order untouched. Array.prototype.sort is stable, so
  // the non-featured tail keeps exactly the order /api/apps returned.
  // Pure — unit-tested in tests/browse-screen.test.js.
  sortApps(apps) {
    const rank = (a) => (a && a.featured
      ? (a.featured_order == null ? Number.MAX_SAFE_INTEGER - 1 : a.featured_order)
      : Number.MAX_SAFE_INTEGER);
    return (apps || []).slice().sort((x, y) => rank(x) - rank(y));
  },

  // The grid for the current query. Search covers EVERY visible app here
  // (home's own search is scoped to "Your apps"), reusing Home's matcher
  // so both fields behave identically.
  visibleApps() {
    const sorted = Browse.sortApps(Browse._apps);
    return sorted.filter((a) => Home.matchesQuery(a, Browse._query));
  },

  render() {
    const listEl = document.getElementById('browse-list');
    const emptyEl = document.getElementById('browse-empty');
    if (!listEl) return;
    Browse._wireSearch();
    const apps = Browse.visibleApps();
    const query = (Browse._query || '').trim();

    listEl.innerHTML = apps
      .map((a) => Home.renderAppCard(a, { mode: 'browse' }))
      .join('');
    // Re-rendering after every toggle is what flips the badge in place;
    // the listeners go with the markup, so they are re-attached here.
    Home._wireDiscoveryCards(listEl, () => Browse.render());

    if (emptyEl) {
      if (apps.length) {
        emptyEl.classList.add('hidden');
        emptyEl.textContent = '';
      } else {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = query
          ? `No apps match “${query}”.`
          : 'No apps to show yet.';
      }
    }
  },

  // Bound once, lazily — the input is static markup in index.html, so
  // there is no per-render listener churn and no focus loss (the same
  // discipline as Home._wireSearch).
  _wireSearch() {
    if (Browse._searchWired) return;
    const input = document.getElementById('browse-search-input');
    const clearBtn = document.getElementById('browse-search-clear');
    if (!input) return;
    Browse._searchWired = true;
    const apply = () => {
      Browse._query = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
      Browse.render();
    };
    input.addEventListener('input', () => {
      clearTimeout(Browse._searchDebounce);
      Browse._searchDebounce = setTimeout(apply, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        clearTimeout(Browse._searchDebounce);
        apply();
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearTimeout(Browse._searchDebounce);
        apply();
        input.focus();
      });
    }
  },
};

window.Browse = Browse;
