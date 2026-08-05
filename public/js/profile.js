// Profile screen — the mobile app's native Profile screen absorbed into SV
// (profile-and-settings-to-web migration, NATIVE-BRIDGE.md). Renders the
// user's rank + points, token allocation (with reveal), points breakdown,
// and completed challenges from the in-process /challenges-api routes
// (src/routes/topochain/mobile.js).
//
// Identity comes from the platform session: since the topochain merge,
// leaderboard participants ARE platform users, so the /me/* routes scope
// to the signed-in session server-side. The bridge's getProfileInfo()
// participant id (bridge v3) is no longer consulted for data.
//
// Hosted in #profile-root; mounted/unmounted by App.navigateToProfile /
// App._exitProfile when the #profile hash route is active.

const Profile = {
  _open: false,
  _loading: false,
  // { ranking, breakdown, challenges, season } — kept across open/close so
  // re-entering the screen paints instantly, then refreshes.
  _data: null,
  _social: {
    loaded: false, loading: false, error: null, tab: 'contacts',
    contacts: [], groups: [], blocks: [], groupDetail: null,
  },

  // The token figure stays blurred until the user taps "Reveal" once;
  // mirrors the native TokenAllocationReveal acknowledgement.
  _REVEAL_KEY: 'sv:profile_tokens_revealed',

  isOpen() { return Profile._open; },

  async open() {
    Profile._open = true;
    Profile._render();
    await Promise.all([Profile._load(), Profile._loadSocial()]);
  },

  close() {
    Profile._open = false;
  },

  async _fetchJson(path) {
    const res = await fetch(path);
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
      // Scope everything to the active season, like the challenges screen.
      const seasonsRaw = await Profile._fetchJson('/challenges-api/seasons');
      const seasons = Array.isArray(seasonsRaw)
        ? seasonsRaw
        : (seasonsRaw && seasonsRaw.seasons) || [];
      const active = seasons.find((s) => s.is_active) ||
        seasons[seasons.length - 1] || null;
      const seasonId = active ? (active.season_id ?? active.id) : null;
      const seasonQS = seasonId != null ? `?season_id=${seasonId}` : '';

      const [ranking, breakdown, challenges] = await Promise.all([
        Profile._fetchJson(`/challenges-api/me/ranking${seasonQS}`),
        Profile._fetchJson(
          '/challenges-api/me/breakdown?include_activity=1' +
          (seasonId != null ? `&season_id=${seasonId}` : ''))
          .catch(() => null),
        seasonId != null
          ? Profile._fetchJson(
              `/challenges-api/challenges?season_id=${seasonId}`)
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      Profile._data = {
        season: active,
        ranking,
        breakdown,
        challenges: Array.isArray(challenges) ? challenges : [],
      };
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

    // Completed challenges.
    const completed = d.challenges.filter((c) => c.completed);
    root.appendChild(Profile._el('div',
      'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2',
      'Completed challenges'));
    if (completed.length === 0) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-2', 'No completed challenges yet.'));
    }
    for (const c of completed) {
      const card = Profile._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 mb-2 ' +
        'flex items-center gap-3');
      const body = Profile._el('div', 'flex-1 min-w-0');
      body.appendChild(Profile._el('div', 'font-medium text-sm truncate',
        c.goal || c.task));
      if (c.category) {
        body.appendChild(Profile._el('div',
          'text-xs text-zinc-500 dark:text-zinc-400 mt-0.5', c.category));
      }
      card.appendChild(body);
      card.appendChild(Profile._el('span',
        'shrink-0 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold ' +
        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        'Completed'));
      root.appendChild(card);
    }
    Profile._renderSocial(root);
  },

  async _loadSocial() {
    if (Profile._social.loading || !window.App?.user) return;
    Profile._social.loading = true;
    Profile._social.error = null;
    try {
      const [contacts, groups, blocks] = await Promise.all([
        Profile._fetchJson('/api/social/contacts?limit=50'),
        Profile._fetchJson('/api/social/groups?limit=50'),
        Profile._fetchJson('/api/social/blocks?limit=50'),
      ]);
      Profile._social.contacts = contacts.contacts || [];
      Profile._social.groups = groups.groups || [];
      Profile._social.blocks = blocks.blocks || [];
      Profile._social.loaded = true;
    } catch (err) {
      Profile._social.error = err?.status === 401 ? 'Sign in to manage contacts.'
        : 'Could not load contacts and groups.';
    } finally {
      Profile._social.loading = false;
      if (Profile._open) Profile._render();
    }
  },

  async _socialRequest(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body != null) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  },

  _socialButton(text, action, tone = 'neutral') {
    const tones = {
      primary: 'bg-violet-600 hover:bg-violet-700 text-white border-violet-600',
      danger: 'text-red-600 dark:text-red-400 border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950',
      neutral: 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
    };
    const btn = Profile._el('button',
      `min-h-[44px] px-3 rounded-lg border text-sm font-medium ${tones[tone]}`, text);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await action(); } catch (err) {
        Profile._social.error = err.message || 'That change could not be saved.';
      } finally {
        btn.disabled = false;
        if (Profile._open) Profile._render();
      }
    });
    return btn;
  },

  _socialForm({ label, placeholder, button, onSubmit }) {
    const form = Profile._el('form', 'flex flex-col sm:flex-row gap-2 mb-3');
    const input = Profile._el('input',
      'flex-1 min-h-[44px] px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 ' +
      'bg-white dark:bg-zinc-900 text-sm');
    input.type = 'text';
    input.maxLength = 255;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    const submit = Profile._el('button',
      'min-h-[44px] px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium',
      button);
    submit.type = 'submit';
    form.append(input, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      submit.disabled = true;
      try {
        await onSubmit(value);
        input.value = '';
        Profile._social.error = null;
      } catch (err) {
        Profile._social.error = err.message || 'That change could not be saved.';
      } finally {
        submit.disabled = false;
        if (Profile._open) Profile._render();
      }
    });
    return form;
  },

  async _refreshSocial() {
    Profile._social.loaded = false;
    await Profile._loadSocial();
  },

  _renderSocial(root) {
    if (!window.App?.user) return;
    const state = Profile._social;
    const section = Profile._el('section', 'mt-8 pt-6 border-t border-zinc-200 dark:border-zinc-800');
    section.setAttribute('aria-labelledby', 'profile-social-heading');
    const heading = Profile._el('h2', 'text-lg font-semibold mb-1', 'Contacts and groups');
    heading.id = 'profile-social-heading';
    section.appendChild(heading);
    section.appendChild(Profile._el('p', 'text-sm text-zinc-500 dark:text-zinc-400 mb-3',
      'Private mutual contacts and membership-only groups. They never grant app or voting access.'));

    const tabs = Profile._el('div', 'flex gap-2 mb-4');
    tabs.setAttribute('role', 'tablist');
    for (const [key, text] of [['contacts', 'Contacts'], ['groups', 'Groups']]) {
      const selected = state.tab === key;
      const tab = Profile._socialButton(text, () => {
        state.tab = key;
        state.groupDetail = null;
      }, selected ? 'primary' : 'neutral');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tabs.appendChild(tab);
    }
    section.appendChild(tabs);
    if (state.error) {
      const error = Profile._el('p', 'text-sm text-red-600 dark:text-red-400 mb-3', state.error);
      error.setAttribute('role', 'alert');
      section.appendChild(error);
    }
    if (state.loading && !state.loaded) {
      const loading = Profile._el('p', 'text-sm text-zinc-500 py-4', 'Loading…');
      loading.setAttribute('role', 'status');
      section.appendChild(loading);
    } else if (state.tab === 'contacts') {
      Profile._renderContacts(section);
    } else {
      Profile._renderGroups(section);
    }
    root.appendChild(section);
  },

  _renderContacts(section) {
    const state = Profile._social;
    section.appendChild(Profile._socialForm({
      label: 'Exact username', placeholder: 'Exact username', button: 'Send request',
      onSubmit: async (username) => {
        await Profile._socialRequest('/api/social/contacts/requests', {
          method: 'POST', body: JSON.stringify({ username }),
        });
        await Profile._refreshSocial();
      },
    }));
    if (!state.contacts.length) {
      section.appendChild(Profile._el('p', 'text-sm text-zinc-500 py-3', 'No contacts or pending requests.'));
    }
    for (const item of state.contacts) {
      const row = Profile._el('div',
        'flex flex-col sm:flex-row sm:items-center gap-2 py-3 border-b border-zinc-100 dark:border-zinc-800');
      const who = Profile._el('div', 'flex-1 min-w-0');
      who.appendChild(Profile._el('div', 'font-medium text-sm truncate', `@${item.username}`));
      who.appendChild(Profile._el('div', 'text-xs text-zinc-500',
        item.direction === 'mutual' ? 'Contact'
          : (item.direction === 'incoming' ? 'Wants to connect' : 'Request pending')));
      row.appendChild(who);
      const actions = Profile._el('div', 'flex flex-wrap gap-2');
      if (item.direction === 'incoming') {
        actions.appendChild(Profile._socialButton('Accept', async () => {
          await Profile._socialRequest(`/api/social/contacts/requests/${item.userId}/accept`, { method: 'POST' });
          await Profile._refreshSocial();
        }, 'primary'));
        actions.appendChild(Profile._socialButton('Decline', async () => {
          await Profile._socialRequest(`/api/social/contacts/requests/${item.userId}`, { method: 'DELETE' });
          await Profile._refreshSocial();
        }));
      } else if (item.direction === 'outgoing') {
        actions.appendChild(Profile._socialButton('Cancel', async () => {
          await Profile._socialRequest(`/api/social/contacts/requests/${item.userId}`, { method: 'DELETE' });
          await Profile._refreshSocial();
        }));
      } else {
        actions.appendChild(Profile._socialButton('Remove', async () => {
          await Profile._socialRequest(`/api/social/contacts/${item.userId}`, { method: 'DELETE' });
          await Profile._refreshSocial();
        }));
      }
      actions.appendChild(Profile._socialButton('Block', async () => {
        if (!window.confirm(`Block @${item.username}? Your contact or request will be removed.`)) return;
        await Profile._socialRequest(`/api/social/blocks/${item.userId}`, { method: 'PUT' });
        await Profile._refreshSocial();
      }, 'danger'));
      row.appendChild(actions);
      section.appendChild(row);
    }
    if (state.blocks.length) {
      section.appendChild(Profile._el('h3', 'text-sm font-semibold mt-5 mb-1', 'Blocked accounts'));
      for (const item of state.blocks) {
        const row = Profile._el('div', 'flex items-center gap-2 py-2');
        row.appendChild(Profile._el('span', 'flex-1 text-sm truncate', `@${item.username}`));
        row.appendChild(Profile._socialButton('Unblock', async () => {
          await Profile._socialRequest(`/api/social/blocks/${item.userId}`, { method: 'DELETE' });
          await Profile._refreshSocial();
        }));
        section.appendChild(row);
      }
    }
  },

  _renderGroups(section) {
    const state = Profile._social;
    section.appendChild(Profile._socialForm({
      label: 'Group name', placeholder: 'Group name', button: 'Create group',
      onSubmit: async (name) => {
        await Profile._socialRequest('/api/social/groups', {
          method: 'POST', body: JSON.stringify({ name }),
        });
        await Profile._refreshSocial();
      },
    }));
    if (state.groupDetail) {
      Profile._renderGroupDetail(section, state.groupDetail);
      return;
    }
    if (!state.groups.length) {
      section.appendChild(Profile._el('p', 'text-sm text-zinc-500 py-3', 'No groups or pending invitations.'));
    }
    for (const group of state.groups) {
      const row = Profile._el('div',
        'flex flex-col sm:flex-row sm:items-center gap-2 py-3 border-b border-zinc-100 dark:border-zinc-800');
      const body = Profile._el('div', 'flex-1 min-w-0');
      body.appendChild(Profile._el('div', 'font-medium text-sm truncate', group.name));
      body.appendChild(Profile._el('div', 'text-xs text-zinc-500',
        group.status === 'invited' ? `Invited by @${group.ownerUsername}`
          : (group.role === 'owner' ? 'You own this group' : `Owned by @${group.ownerUsername}`)));
      row.appendChild(body);
      const actions = Profile._el('div', 'flex flex-wrap gap-2');
      if (group.status === 'invited') {
        actions.appendChild(Profile._socialButton('Accept', async () => {
          await Profile._socialRequest(`/api/social/groups/${group.id}/invites/accept`, { method: 'POST' });
          await Profile._refreshSocial();
        }, 'primary'));
        actions.appendChild(Profile._socialButton('Decline', async () => {
          await Profile._socialRequest(`/api/social/groups/${group.id}/invites/decline`, { method: 'POST' });
          await Profile._refreshSocial();
        }));
      } else {
        actions.appendChild(Profile._socialButton('Open', async () => {
          const data = await Profile._socialRequest(`/api/social/groups/${group.id}`);
          state.groupDetail = data;
        }, 'primary'));
      }
      row.appendChild(actions);
      section.appendChild(row);
    }
  },

  _renderGroupDetail(section, detail) {
    const { group, members = [] } = detail;
    section.appendChild(Profile._socialButton('Back to groups', () => { Profile._social.groupDetail = null; }));
    section.appendChild(Profile._el('h3', 'text-base font-semibold mt-4', group.name));
    section.appendChild(Profile._el('p', 'text-xs text-zinc-500 mb-3', `Owned by @${group.ownerUsername}`));
    if (group.role === 'owner') {
      section.appendChild(Profile._socialForm({
        label: 'New group name', placeholder: 'New group name', button: 'Rename',
        onSubmit: async (name) => {
          await Profile._socialRequest(`/api/social/groups/${group.id}`, {
            method: 'PATCH', body: JSON.stringify({ name }),
          });
          Profile._social.groupDetail = await Profile._socialRequest(`/api/social/groups/${group.id}`);
          await Profile._refreshSocial();
        },
      }));
      section.appendChild(Profile._socialForm({
        label: 'Exact username to invite', placeholder: 'Exact username', button: 'Invite',
        onSubmit: async (username) => {
          await Profile._socialRequest(`/api/social/groups/${group.id}/invites`, {
            method: 'POST', body: JSON.stringify({ username }),
          });
          Profile._social.groupDetail = await Profile._socialRequest(`/api/social/groups/${group.id}`);
        },
      }));
    }
    for (const member of members) {
      const row = Profile._el('div', 'flex flex-col sm:flex-row sm:items-center gap-2 py-2 border-b border-zinc-100 dark:border-zinc-800');
      const label = member.role === 'owner' ? `@${member.username} · owner`
        : `@${member.username}${member.status === 'invited' ? ' · invited' : ''}`;
      row.appendChild(Profile._el('span', 'flex-1 text-sm truncate', label));
      if (group.role === 'owner' && member.role !== 'owner') {
        const actions = Profile._el('div', 'flex flex-wrap gap-2');
        if (member.status === 'member') {
          actions.appendChild(Profile._socialButton('Make owner', async () => {
            if (!window.confirm(`Transfer ownership to @${member.username}?`)) return;
            await Profile._socialRequest(`/api/social/groups/${group.id}/transfer`, {
              method: 'POST', body: JSON.stringify({ userId: member.userId }),
            });
            await Profile._refreshSocial();
            Profile._social.groupDetail = null;
          }));
        }
        actions.appendChild(Profile._socialButton(member.status === 'invited' ? 'Revoke' : 'Remove', async () => {
          await Profile._socialRequest(`/api/social/groups/${group.id}/members/${member.userId}`, { method: 'DELETE' });
          Profile._social.groupDetail = await Profile._socialRequest(`/api/social/groups/${group.id}`);
        }, 'danger'));
        row.appendChild(actions);
      }
      section.appendChild(row);
    }
    const danger = Profile._el('div', 'flex flex-wrap gap-2 mt-4');
    if (group.role === 'owner') {
      danger.appendChild(Profile._socialButton('Delete group', async () => {
        if (!window.confirm(`Delete “${group.name}”? This cannot be undone.`)) return;
        await Profile._socialRequest(`/api/social/groups/${group.id}`, { method: 'DELETE' });
        Profile._social.groupDetail = null;
        await Profile._refreshSocial();
      }, 'danger'));
    } else {
      const me = members.find((m) => m.userId === window.App?.user?.id);
      if (me) danger.appendChild(Profile._socialButton('Leave group', async () => {
        await Profile._socialRequest(`/api/social/groups/${group.id}/members/${me.userId}`, { method: 'DELETE' });
        Profile._social.groupDetail = null;
        await Profile._refreshSocial();
      }, 'danger'));
    }
    section.appendChild(danger);
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

window.Profile = Profile;
