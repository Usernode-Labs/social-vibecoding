// Profile screen — the mobile app's native Profile screen absorbed into SV
// (profile-and-settings-to-web migration, NATIVE-BRIDGE.md), extended into
// an EDITABLE profile by issue #982. Renders the user's identity card
// (picture / display name / bio / links), rank + points, token allocation
// (with reveal), points breakdown, and the challenges THEY completed.
//
// It deliberately does NOT list completed challenges (#981). It used to,
// from /challenges-api/challenges?season_id=…, and that section was wrong
// on two counts: `challenges.completed` is an ORGANISER flag about the
// challenge ("this one is over"), not "you finished it", so every user saw
// the same list — and season-scoped it ran to ~32 cards, burying the rank,
// token and breakdown blocks this screen actually exists for. That list now
// lives on the Leaderboard screen's Challenges tab, grouped and counted
// per event (features/leaderboard/topochain-challenges.js), which is where the
// rest of the challenge UI already was.
//
// Identity comes from the platform session: since the topochain merge,
// leaderboard participants ARE platform users, so the /me/* routes scope
// to the signed-in session server-side. The bridge's getProfileInfo()
// participant id (bridge v3) is no longer consulted for data.
//
// THE COMPLETED LIST IS THE VIEWER'S OWN. It used to filter the season's
// challenge grid on `c.completed`, which is an ORGANISER flag about the
// challenge ("this one is over") — so every signed-in person saw 28 of
// production's 34 live challenges listed as their own completions, whether
// or not they had ever earned a point. The list now comes from
// GET /api/me/challenges/completed (src/routes/profile.js), which applies
// the same per-user done rule the home Challenges widget uses.
//
// The USERNAME is deliberately not editable here (or anywhere): it is the
// sign-in identifier, the address of the public builder page, and is
// denormalized into apps.admin_usernames from repo dapp.json files. The
// display name is the supported way to change how your name appears.
//
// Hosted in #profile-root; mounted/unmounted by App.navigateToProfile /
// App._exitProfile when the #profile hash route is active. The host and the
// screen around it are React's as of #1083 chunk F (see ./index.tsx); this
// module still owns everything inside it, and builds that subtree with
// createElement + textContent rather than innerHTML, which is why it needs no
// escaping helper of its own.

const Profile = {
  _open: false,
  _loading: false,
  // { ranking, breakdown, completed, season } — kept across open/close so
  // re-entering the screen paints instantly, then refreshes.
  _data: null,

  // The token figure stays blurred until the user taps "Reveal" once;
  // mirrors the native TokenAllocationReveal acknowledgement.
  _REVEAL_KEY: 'sv:profile_tokens_revealed',

  // Edit-sheet handle from PlatformUI.sheet(), plus the avatar change
  // staged by the photo picker. `_pendingAvatar` is a Blob to upload, the
  // string 'remove' to delete, or null for "leave it alone" — nothing
  // reaches the server until Save.
  _sheet: null,
  _sheetPanel: null,
  _pendingAvatar: null,
  _pendingAvatarUrl: null,

  // Field limits, kept in step with src/routes/profile.js. The server is
  // the authority; these exist so the sheet can show a counter and stop an
  // over-long value before a round trip.
  MAX_DISPLAY_NAME: 40,
  MAX_BIO: 280,
  // Client-side downscale budget. The server caps the upload at 1 MB and
  // does no image processing of its own (the platform ships no image
  // decoder), so the shrink has to happen here — the same canvas/toBlob
  // loop screenshot-select.js uses for issue screenshots.
  AVATAR_MAX_PX: 512,
  AVATAR_MAX_BYTES: 500 * 1024,

  // True once the ?shot=profile-edit deep link has opened the sheet, so a
  // later refresh landing doesn't reopen it.
  _shotFired: false,

  isOpen() { return Profile._open; },

  async open() {
    Profile._open = true;
    Profile._render();
    await Profile._load();
    Profile._maybeOpenShot();
  },

  close() {
    Profile._open = false;
    Profile._dismissSheet();
  },

  async _fetchJson(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) {
      // Carry the status on the Error so _load() can tell "you are not
      // signed in" (401 from requireSessionUser) apart from a genuine
      // failure. The /challenges-api/me/* routes are session-scoped
      // (src/routes/topochain/mobile.js), so an anonymous visitor hits
      // 401 on every one of them — that is a state to render, not an
      // error to apologise for.
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    // The leaderboard API wraps every response in { success, data }.
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success === false) throw new Error('API error');
      return body.data;
    }
    return body;
  },

  async _load() {
    if (Profile._loading) return;
    Profile._loading = true;
    try {
      // Cheap pre-check: the SPA boots anonymously now (auth-screens.js),
      // so skip the round-trip entirely when there is no session at all.
      // The 401 branch below still covers a session that expired while
      // the screen was open.
      if (window.App && !App.user) {
        Profile._data = { signedOut: true };
        return;
      }
      // Scope the score header to the active season, like the challenges
      // screen. (The completed list resolves its own season SERVER-side —
      // see fetchProfileSeason — because the strict "running right now"
      // rule would return nothing between seasons.)
      const seasonsRaw = await Profile._fetchJson('/challenges-api/seasons');
      const seasons = Array.isArray(seasonsRaw)
        ? seasonsRaw
        : (seasonsRaw && seasonsRaw.seasons) || [];
      const active = seasons.find((s) => s.is_active) ||
        seasons[seasons.length - 1] || null;
      const seasonId = active ? (active.season_id ?? active.id) : null;
      const seasonQS = seasonId != null ? `?season_id=${seasonId}` : '';

      const [ranking, breakdown, completed] = await Promise.all([
        Profile._fetchJson(`/challenges-api/me/ranking${seasonQS}`),
        Profile._fetchJson(
          '/challenges-api/me/breakdown?include_activity=1' +
          (seasonId != null ? `&season_id=${seasonId}` : ''))
          .catch(() => null),
        // The viewer's OWN completions. Non-fatal: a failure leaves the
        // rest of the screen intact and the section shows its empty state.
        Profile._fetchJson('/api/me/challenges/completed').catch(() => null),
      ]);

      Profile._data = { season: active, ranking, breakdown, completed };
    } catch (err) {
      if (err && err.status === 401) {
        // Not signed in (or the session lapsed) — a normal state, not a
        // fault. Replace any stale data so we never show one user's
        // profile after their session ends.
        Profile._data = { signedOut: true };
      } else {
        console.warn('[profile] load failed:', err);
        if (!Profile._data) Profile._data = { error: true };
      }
    } finally {
      Profile._loading = false;
    }
    if (Profile._open) Profile._render();
  },

  // ── rendering ─────────────────────────────────────────────────────────

  _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  },

  // Only ever render an http(s) URL as a real anchor. Handles are
  // validated server-side, but this is the same discipline
  // TopochainChallenges.safeHref applies — escaping alone would not stop a
  // `javascript:` href, which executes on click with no markup injection.
  _safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  _render() {
    const root = document.getElementById('profile-root');
    if (!root) return;
    root.textContent = '';

    const d = Profile._data;
    if (!d) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-8 text-center', 'Loading profile…'));
      return;
    }
    if (d.signedOut) {
      const wrap = Profile._el('div', 'py-12 text-center');
      wrap.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mb-4',
        'Sign in to see your profile.'));
      const link = Profile._el('a',
        'inline-flex items-center justify-center px-4 min-h-[44px] rounded-lg ' +
        'bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium',
        'Sign in');
      link.href = '#login';
      wrap.appendChild(link);
      root.appendChild(wrap);
      return;
    }
    if (d.error) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-8 text-center',
        'Could not load your profile — check your connection and try again.'));
      return;
    }
    const r = d.ranking || {};

    // Identity card (#982) — who this profile belongs to, and the way in
    // to editing it. Sits above the score header so the screen leads with
    // the person rather than the number.
    root.appendChild(Profile._renderIdentityCard());

    // Rank + points header (native ScoreHeader equivalent).
    const head = Profile._el('div', 'text-center mb-5');
    head.appendChild(Profile._el('div',
      'text-4xl font-extrabold tracking-tight',
      Number(r.total_points || 0).toLocaleString()));
    head.appendChild(Profile._el('div',
      'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mt-1',
      'points'));
    const sub = [];
    if (r.rank) {
      sub.push(`Rank #${r.rank}` +
        (r.total_participants ? ` of ${r.total_participants}` : ''));
    }
    const seasonName = r.season_name ||
      (d.season && d.season.name) || null;
    if (seasonName) sub.push(seasonName);
    if (sub.length) {
      head.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mt-2', sub.join(' · ')));
    }
    root.appendChild(head);

    // Token allocation card.
    root.appendChild(Profile._renderTokenCard(r));

    // Points breakdown.
    const bkRows = Profile._breakdownRows(d.breakdown);
    if (bkRows.length > 0) {
      root.appendChild(Profile._el('div',
        'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2',
        'Points breakdown'));
      const box = Profile._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 ' +
        'divide-y divide-zinc-100 dark:divide-zinc-800');
      for (const rowDef of bkRows) {
        const row = Profile._el('div',
          'flex items-center gap-3 px-3 py-2 text-sm');
        row.appendChild(Profile._el('span', 'flex-1 min-w-0 truncate',
          rowDef.label));
        row.appendChild(Profile._el('span',
          'shrink-0 font-semibold text-violet-600 dark:text-violet-400',
          `${Number(rowDef.points || 0).toLocaleString()} pts`));
        box.appendChild(row);
      }
      root.appendChild(box);
    }

    // Completed challenges — the viewer's OWN, and each one links out.
    Profile._renderCompleted(root, d.completed);
  },

  // ── identity card ─────────────────────────────────────────────────────

  // The name shown large on the card: the display name when set, else the
  // @username. Never blank — a signed-in profile always has a username.
  _displayName() {
    const u = (window.App && App.user) || {};
    const name = u.displayName ? String(u.displayName).trim() : '';
    return name || (u.username ? `@${u.username}` : 'Your profile');
  },

  // The letter in the fallback circle. Takes the first LETTER OR DIGIT,
  // not simply the first character: a display name is free text, so it can
  // easily start with punctuation or an emoji ("[Staging demo] admin",
  // "…hello") and a circle reading "[" tells the viewer nothing. Falls
  // back to the username, then to '?'.
  _initial() {
    const u = (window.App && App.user) || {};
    for (const src of [u.displayName, u.username]) {
      const match = String(src || '').match(/[\p{L}\p{N}]/u);
      if (match) return match[0].toUpperCase();
    }
    return '?';
  },

  // The round picture, or the initial-in-a-circle fallback (the idiom the
  // rest of the app already uses for people). `sizeClass`/`textClass` let
  // the same builder serve the card and the edit sheet's smaller preview.
  // A staged pick wins over the saved one so the preview is live.
  _avatarEl(sizeClass, textClass) {
    const u = (window.App && App.user) || {};
    const url = Profile._pendingAvatarUrl
      || (Profile._pendingAvatar === 'remove' ? null : u.avatarUrl);
    if (url) {
      const img = document.createElement('img');
      img.className =
        `${sizeClass} rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0`;
      img.src = url;
      img.alt = '';
      return img;
    }
    const circle = Profile._el('div',
      `${sizeClass} ${textClass} rounded-full shrink-0 flex items-center ` +
      'justify-center font-bold bg-violet-100 text-violet-700 ' +
      'dark:bg-violet-900/40 dark:text-violet-300',
      Profile._initial());
    circle.setAttribute('aria-hidden', 'true');
    return circle;
  },

  _renderIdentityCard() {
    const u = (window.App && App.user) || {};
    const card = Profile._el('div',
      'rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 mb-5');
    card.id = 'profile-identity-card';

    const top = Profile._el('div', 'flex items-center gap-4');
    top.appendChild(Profile._avatarEl('w-20 h-20', 'text-2xl'));

    const who = Profile._el('div', 'flex-1 min-w-0');
    who.appendChild(Profile._el('div',
      'text-xl font-bold truncate', Profile._displayName()));
    // The @handle is only a SECOND line when a display name is set —
    // otherwise it is already the headline above.
    if (u.displayName && String(u.displayName).trim() && u.username) {
      who.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 truncate', `@${u.username}`));
    }
    top.appendChild(who);

    const editBtn = Profile._el('button',
      'shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border ' +
      'border-violet-500 text-violet-600 dark:text-violet-400 ' +
      'hover:bg-violet-50 dark:hover:bg-violet-950', 'Edit profile');
    editBtn.id = 'profile-edit-btn';
    editBtn.addEventListener('click', () => Profile.showEditSheet());
    top.appendChild(editBtn);
    card.appendChild(top);

    if (u.bio) {
      // Plain text, inserted as a TEXT NODE — the bio is deliberately not
      // markdown, so nothing here ever touches innerHTML.
      card.appendChild(Profile._el('p',
        'text-sm text-zinc-600 dark:text-zinc-300 mt-3 whitespace-pre-line',
        u.bio));
    }

    const links = u.links || {};
    const chips = Profile._el('div', 'flex flex-wrap items-center gap-2 mt-3');
    const addChip = (label, href) => {
      const safe = Profile._safeHref(href);
      if (!safe) return;
      const a = Profile._el('a',
        'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
        'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 ' +
        'hover:bg-zinc-200 dark:hover:bg-zinc-700', label);
      a.href = safe;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      chips.appendChild(a);
    };
    if (links.github) {
      addChip(`GitHub · ${links.github}`,
        `https://github.com/${encodeURIComponent(links.github)}`);
    }
    if (links.x) {
      addChip(`X · @${links.x}`, `https://x.com/${encodeURIComponent(links.x)}`);
    }
    if (u.username) {
      // In-app link out: the viewer's kudos / proposed-PR history.
      const a = Profile._el('a',
        'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
        'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ' +
        'hover:bg-violet-100 dark:hover:bg-violet-900/50', 'Your builder profile');
      a.href = `#leaderboard/users/${encodeURIComponent(u.username)}`;
      chips.appendChild(a);
    }
    if (chips.childNodes.length) card.appendChild(chips);

    return card;
  },

  // ── completed challenges ──────────────────────────────────────────────

  _renderCompleted(root, payload) {
    const rows = (payload && Array.isArray(payload.completed))
      ? payload.completed : [];
    const seasonName = payload && payload.season ? payload.season.name : null;

    const header = Profile._el('div', 'flex items-baseline gap-2 mt-6 mb-2');
    header.appendChild(Profile._el('div',
      'text-sm font-semibold text-zinc-500 dark:text-zinc-400 flex-1 min-w-0 truncate',
      seasonName ? `Completed challenges — ${seasonName}` : 'Completed challenges'));
    if (payload && Number(payload.total) > 0) {
      header.appendChild(Profile._el('div',
        'shrink-0 text-xs text-zinc-400',
        `${Number(payload.done || 0)} of ${Number(payload.total)} done`));
    }
    root.appendChild(header);

    if (!rows.length) {
      const empty = Profile._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 text-center');
      empty.id = 'profile-completed-empty';
      empty.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mb-3',
        'No completed challenges yet.'));
      const browse = Profile._el('a',
        'inline-flex items-center justify-center px-3 min-h-[36px] rounded-lg ' +
        'text-sm font-medium border border-violet-500 text-violet-600 ' +
        'dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950',
        'Browse challenges');
      browse.href = '#leaderboard/challenges';
      empty.appendChild(browse);
      root.appendChild(empty);
      return;
    }

    for (const c of rows) {
      // A real anchor, not a click handler: this is a navigation, so it
      // gets middle-click, long-press-to-copy and the back gesture for
      // free. The event id rides in the path because the Challenges pane
      // fetches per season event — see App._routeLeaderboard and
      // TopochainChallenges.openFromHash, which select that event and then
      // open this challenge's detail overlay once its grid paints.
      const card = Profile._el('a',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 mb-2 ' +
        'flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 ' +
        'transition-colors');
      card.href = '#leaderboard/challenges/' +
        `${encodeURIComponent(c.season_event_id)}/${encodeURIComponent(c.id)}`;
      card.setAttribute('data-completed-challenge', String(c.id));

      const body = Profile._el('div', 'flex-1 min-w-0');
      body.appendChild(Profile._el('div', 'font-medium text-sm truncate',
        c.goal || c.task || 'Challenge'));
      const meta = [];
      if (c.label) meta.push(c.label);
      if (Number(c.earned_points) > 0) {
        meta.push(`${Number(c.earned_points).toLocaleString()} pts earned`);
      }
      const when = Profile._relativeDate(c.last_activity_at);
      if (when) meta.push(when);
      if (meta.length) {
        body.appendChild(Profile._el('div',
          'text-xs text-zinc-500 dark:text-zinc-400 mt-0.5', meta.join(' · ')));
      }
      card.appendChild(body);
      card.appendChild(Profile._el('span',
        'shrink-0 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold ' +
        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        'Completed'));
      root.appendChild(card);
    }

    const footer = Profile._el('div', 'mt-1 mb-2');
    const all = Profile._el('a',
      'text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline',
      'See all challenges');
    all.href = '#leaderboard/challenges';
    footer.appendChild(all);
    root.appendChild(footer);
  },

  // "today" / "3 days ago" / a plain date past a fortnight. Returns null
  // for anything unparseable, so the caller just omits the segment.
  _relativeDate(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 0) return null;
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    try {
      return new Date(t).toLocaleDateString();
    } catch (_) {
      return null;
    }
  },

  // ── edit sheet ────────────────────────────────────────────────────────

  _dismissSheet() {
    if (Profile._sheet && Profile._sheet.dismiss) Profile._sheet.dismiss();
    // Inline fallback (no native kit): the panel is a child of
    // #profile-root, so remove it by hand.
    if (!Profile._sheet && Profile._sheetPanel && Profile._sheetPanel.remove) {
      Profile._sheetPanel.remove();
    }
    Profile._sheet = null;
    Profile._sheetPanel = null;
    Profile._clearPendingAvatar();
  },

  _clearPendingAvatar() {
    if (Profile._pendingAvatarUrl) {
      try { URL.revokeObjectURL(Profile._pendingAvatarUrl); } catch (_) {}
    }
    Profile._pendingAvatar = null;
    Profile._pendingAvatarUrl = null;
  },

  // ?shot=profile-edit — a screenshot-state deep link, so the before/after
  // capture and the declared dapp.json test can reach a sheet that plain
  // navigation never opens. Pure UI state with no writes, so deliberately
  // NOT staging-gated: the "before" side is shot against production and an
  // env-gated link would starve it forever.
  _maybeOpenShot() {
    if (Profile._shotFired) return;
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    if (shot !== 'profile-edit') return;
    const d = Profile._data;
    if (!d || d.signedOut || d.error) return;
    Profile._shotFired = true;
    Profile.showEditSheet();
  },

  showEditSheet() {
    // Re-entering replaces any open sheet rather than stacking two.
    Profile._dismissSheet();
    const u = (window.App && App.user) || {};
    const el = Profile._el;

    const panel = el('div', 'px-4 pb-5');
    panel.id = 'profile-edit-sheet';
    panel.appendChild(el('div', 'text-lg font-bold py-3', 'Edit profile'));

    // ── picture ──
    const picRow = el('div', 'flex items-center gap-4 mb-3');
    const preview = el('div', 'shrink-0');
    preview.id = 'profile-edit-preview';
    preview.appendChild(Profile._avatarEl('w-16 h-16', 'text-xl'));
    picRow.appendChild(preview);

    const picBtns = el('div', 'flex flex-wrap gap-2');
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.className = 'hidden';
    file.id = 'profile-edit-file';
    picBtns.appendChild(file);

    const chooseBtn = el('button',
      'px-3 py-1.5 rounded-lg text-sm font-medium border ' +
      'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800',
      'Choose photo');
    chooseBtn.id = 'profile-edit-choose';
    chooseBtn.addEventListener('click', () => file.click());
    picBtns.appendChild(chooseBtn);

    const removeBtn = el('button',
      'px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 ' +
      'border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950',
      'Remove photo');
    removeBtn.id = 'profile-edit-remove';
    if (!u.avatarUrl) removeBtn.classList.add('hidden');
    removeBtn.addEventListener('click', () => {
      Profile._clearPendingAvatar();
      Profile._pendingAvatar = 'remove';
      removeBtn.classList.add('hidden');
      Profile._repaintPreview(preview);
    });
    picBtns.appendChild(removeBtn);
    picRow.appendChild(picBtns);
    panel.appendChild(picRow);

    const picError = el('p', 'text-xs text-red-500 mb-3 hidden');
    picError.id = 'profile-edit-photo-error';
    panel.appendChild(picError);

    file.addEventListener('change', async () => {
      const chosen = file.files && file.files[0];
      file.value = '';
      if (!chosen) return;
      picError.classList.add('hidden');
      try {
        const blob = await Profile._prepareAvatar(chosen);
        Profile._clearPendingAvatar();
        Profile._pendingAvatar = blob;
        Profile._pendingAvatarUrl = URL.createObjectURL(blob);
        removeBtn.classList.remove('hidden');
        Profile._repaintPreview(preview);
      } catch (err) {
        picError.textContent = (err && err.message)
          || 'That image could not be used — try a PNG, JPEG or WebP.';
        picError.classList.remove('hidden');
      }
    });

    // ── text fields ──
    const nameField = Profile._field(panel, 'Display name', 'profile-edit-name',
      'input', u.displayName || '', Profile.MAX_DISPLAY_NAME,
      'The name other people see. Leave it empty to show your @handle.');
    const bioField = Profile._field(panel, 'Bio', 'profile-edit-bio',
      'textarea', u.bio || '', Profile.MAX_BIO, null);
    const links = u.links || {};
    const ghField = Profile._field(panel, 'GitHub', 'profile-edit-github',
      'input', links.github || '', 39, null, 'handle, without the @');
    const xField = Profile._field(panel, 'X', 'profile-edit-x',
      'input', links.x || '', 39, null, 'handle, without the @');

    // ── username (read-only) ──
    const userWrap = el('div', 'mb-4');
    userWrap.appendChild(el('label',
      'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1',
      'Username'));
    const userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.id = 'profile-edit-username';
    userInput.value = u.username ? `@${u.username}` : '';
    userInput.readOnly = true;
    userInput.disabled = true;
    userInput.className =
      'w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 ' +
      'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-500 text-sm ' +
      'cursor-not-allowed';
    userWrap.appendChild(userInput);
    userWrap.appendChild(el('p',
      'text-xs text-zinc-500 dark:text-zinc-400 mt-1',
      'Your @handle is your sign-in name and the address of your public ' +
      'builder page, so it can’t be changed. Set a display name above to ' +
      'change how your name appears.'));
    panel.appendChild(userWrap);

    // ── actions ──
    const formError = el('p', 'text-sm text-red-500 mb-2 hidden');
    formError.id = 'profile-edit-error';
    panel.appendChild(formError);

    const saveBtn = el('button',
      'w-full px-4 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-700 ' +
      'text-white text-sm font-medium disabled:opacity-60', 'Save');
    saveBtn.id = 'profile-edit-save';
    saveBtn.addEventListener('click', () => Profile._save({
      saveBtn, formError, nameField, bioField, ghField, xField,
    }));
    panel.appendChild(saveBtn);

    const closeBtn = el('button',
      'w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400', 'Cancel');
    closeBtn.addEventListener('click', () => Profile._dismissSheet());
    panel.appendChild(closeBtn);

    Profile._sheetPanel = panel;
    Profile._sheet = (window.PlatformUI && PlatformUI.sheet)
      ? PlatformUI.sheet({ contentEl: panel })
      : null;
    // No native kit (the sheet helper returns null when the kit isn't
    // loaded — same fallback shape Settings.showTermsSheet handles): render
    // the panel inline at the top of the screen so the editor is never
    // unreachable.
    if (!Profile._sheet) {
      const root = document.getElementById('profile-root');
      if (root) {
        panel.classList.add('rounded-xl', 'border',
          'border-zinc-200', 'dark:border-zinc-800', 'mb-5');
        root.insertBefore(panel, root.firstChild);
      }
    }
  },

  _repaintPreview(preview) {
    preview.textContent = '';
    preview.appendChild(Profile._avatarEl('w-16 h-16', 'text-xl'));
  },

  // One labelled field plus a live counter. Returns { input, error } so the
  // save path can read the value and pin a server-side message to it.
  _field(panel, label, id, tag, value, maxLength, hint, placeholder) {
    const el = Profile._el;
    const wrap = el('div', 'mb-4');
    const head = el('div', 'flex items-baseline gap-2 mb-1');
    head.appendChild(el('label',
      'block text-sm font-medium text-zinc-500 dark:text-zinc-400 flex-1', label));
    const counter = el('span', 'text-xs text-zinc-400',
      `${String(value || '').length}/${maxLength}`);
    head.appendChild(counter);
    wrap.appendChild(head);

    const input = document.createElement(tag);
    if (tag === 'input') input.type = 'text';
    if (tag === 'textarea') input.rows = 3;
    input.id = id;
    input.value = value || '';
    input.maxLength = maxLength;
    if (placeholder) input.placeholder = placeholder;
    input.className =
      'w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 ' +
      'bg-white dark:bg-zinc-900 text-sm';
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length}/${maxLength}`;
    });
    wrap.appendChild(input);

    if (hint) {
      wrap.appendChild(el('p',
        'text-xs text-zinc-500 dark:text-zinc-400 mt-1', hint));
    }
    const error = el('p', 'text-xs text-red-500 mt-1 hidden');
    wrap.appendChild(error);
    panel.appendChild(wrap);
    return { input, error };
  },

  // Centre-crop to a square, downscale to AVATAR_MAX_PX, then re-encode
  // until it fits the byte budget — the same loop screenshot-select.js
  // uses. This is not an optimisation: the server ships no image decoder,
  // so an un-shrunk 12 MP phone photo would simply be refused.
  async _prepareAvatar(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) {
      throw new Error('Choose a PNG, JPEG or WebP image.');
    }
    const bitmap = await Profile._decodeImage(file);
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('That image could not be read.');
    const target = Math.min(side, Profile.AVATAR_MAX_PX);

    let canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('That image could not be processed here.');
    ctx.drawImage(
      bitmap,
      Math.floor((bitmap.width - side) / 2), Math.floor((bitmap.height - side) / 2),
      side, side, 0, 0, target, target
    );
    if (bitmap.close) bitmap.close();

    const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
    // PNG first (crisp for the flat-colour avatars people actually pick);
    // fall back to JPEG, then halve the square until it fits. The server
    // accepts PNG, JPEG and WebP.
    let blob = await toBlob(canvas, 'image/png');
    if (!blob || blob.size > Profile.AVATAR_MAX_BYTES) {
      blob = await toBlob(canvas, 'image/jpeg', 0.85);
    }
    while (blob && blob.size > Profile.AVATAR_MAX_BYTES && canvas.width > 64) {
      const next = document.createElement('canvas');
      next.width = Math.round(canvas.width / 2);
      next.height = Math.round(canvas.height / 2);
      next.getContext('2d').drawImage(canvas, 0, 0, next.width, next.height);
      canvas = next;
      blob = await toBlob(canvas, 'image/jpeg', 0.85);
    }
    if (!blob) throw new Error('That image could not be processed here.');
    return blob;
  },

  async _decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be read.'));
      };
      img.src = url;
    });
  },

  // Save order matters: the avatar write first (it is the one that can
  // fail on bytes), then the text PATCH, then one /api/auth/me refresh so
  // App.user — which every other surface reads — is the post-write truth
  // rather than a locally-patched guess.
  async _save({ saveBtn, formError, nameField, bioField, ghField, xField }) {
    saveBtn.disabled = true;
    formError.classList.add('hidden');
    for (const f of [nameField, bioField, ghField, xField]) {
      f.error.classList.add('hidden');
      f.error.textContent = '';
    }
    try {
      if (Profile._pendingAvatar === 'remove') {
        const res = await fetch('/api/me/avatar', {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!res.ok) {
          throw new Error((await Profile._errText(res)) || 'Could not remove the photo.');
        }
      } else if (Profile._pendingAvatar) {
        const res = await fetch('/api/me/avatar', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: Profile._pendingAvatar,
        });
        if (!res.ok) {
          throw new Error((await Profile._errText(res)) || 'Could not upload the photo.');
        }
      }

      const res = await fetch('/api/me/profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: nameField.input.value,
          bio: bioField.input.value,
          github: ghField.input.value,
          x: xField.input.value,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const details = body && body.details;
        if (details && typeof details === 'object') {
          const map = {
            displayName: nameField, bio: bioField, github: ghField, x: xField,
          };
          let pinned = false;
          for (const [key, msgs] of Object.entries(details)) {
            const target = map[key];
            if (!target) continue;
            target.error.textContent = Array.isArray(msgs) ? msgs[0] : String(msgs);
            target.error.classList.remove('hidden');
            pinned = true;
          }
          // Field-level messages are the whole feedback — keep the sheet
          // open with the user's other edits intact.
          if (pinned) { saveBtn.disabled = false; return; }
        }
        throw new Error((body && body.error) || 'Could not save your profile.');
      }

      await Profile._refreshUser();
      Profile._dismissSheet();
      Profile._render();
      if (window.PlatformUI) PlatformUI.toast('Profile saved');
    } catch (err) {
      formError.textContent = (err && err.message) || 'Could not save your profile.';
      formError.classList.remove('hidden');
      saveBtn.disabled = false;
    }
  },

  async _errText(res) {
    try {
      const body = await res.json();
      return body && body.error;
    } catch (_) {
      return null;
    }
  },

  // Re-read the session user so App.user (and therefore the identity card
  // and the drawer row) reflects what was actually stored.
  async _refreshUser() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.user && window.App) {
        App.user = body.user;
        if (typeof App.applyUserAvatar === 'function') App.applyUserAvatar();
      }
    } catch (_) { /* keep the stale copy — the next load corrects it */ }
  },

  // The backend zeroes total_tokens until terms are accepted, so a gated
  // allocation must show the terms notice, never a fake 0 balance
  // (mirrors the native TokenAllocationGatedNotice).
  _renderTokenCard(ranking) {
    const card = Profile._el('div',
      'rounded-xl border border-zinc-200 dark:border-zinc-800 p-4');

    if (ranking.terms_accepted === false) {
      card.appendChild(Profile._el('div', 'font-semibold mb-1',
        'Token allocation withheld'));
      card.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mb-3',
        'Review and accept the terms to see your token allocation.'));
      const btn = Profile._el('button',
        'px-3 py-1.5 rounded-lg text-sm font-medium border ' +
        'border-violet-500 text-violet-600 dark:text-violet-400 ' +
        'hover:bg-violet-50 dark:hover:bg-violet-950', 'Review terms');
      btn.addEventListener('click', () => {
        // Web terms sheet (thin-shell migration) — the native terms
        // screen is gone. Refresh the profile after an accept so the
        // token allocation un-gates immediately.
        if (window.Settings && typeof Settings.showTermsSheet === 'function') {
          Settings.showTermsSheet(() => Profile._load());
        }
      });
      card.appendChild(btn);
      return card;
    }

    const amount = Number(ranking.total_tokens || 0);
    const revealed = localStorage.getItem(Profile._REVEAL_KEY) === '1';

    card.appendChild(Profile._el('div',
      'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1',
      'Token allocation'));
    const value = Profile._el('div',
      'text-2xl font-bold' + (revealed ? '' : ' blur-md select-none'),
      amount.toLocaleString());
    value.setAttribute('aria-hidden', revealed ? 'false' : 'true');
    card.appendChild(value);
    card.appendChild(Profile._el('div',
      'text-xs text-zinc-500 dark:text-zinc-400 mt-2',
      'Allocations are provisional and subject to the program terms.'));

    if (!revealed) {
      const btn = Profile._el('button',
        'mt-3 px-3 py-1.5 rounded-lg text-sm font-medium border ' +
        'border-violet-500 text-violet-600 dark:text-violet-400 ' +
        'hover:bg-violet-50 dark:hover:bg-violet-950', 'Reveal');
      btn.addEventListener('click', () => {
        localStorage.setItem(Profile._REVEAL_KEY, '1');
        Profile._render();
      });
      card.appendChild(btn);
    }
    return card;
  },

  // Flattens the /me/breakdown response (event | season | global scope)
  // into label/points rows: one per event, plus offchain points when
  // present.
  _breakdownRows(breakdown) {
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
  },
};

// Still published as a global: app.js's #profile hash branch,
// App.navigateToProfile / _exitProfile and the header menu's Profile row all
// reach this through `window.Profile`, and app.js is a classic script.
// Guarded because the SSG prerender pass evaluates this module in Node (the
// island imports it).
if (typeof window !== 'undefined') window.Profile = Profile;
