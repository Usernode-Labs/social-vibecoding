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
// to the signed-in session server-side. Native publishes no profile identity.
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
// ── What this file is, after #1191 slice 6 ─────────────────────────────
//
// This module used to BUILD the screen, with createElement and textContent,
// into an unmanaged #profile-root. It no longer touches the DOM at all.
// Conversion 1 of slice 6 made #profile-root React-owned end to end, which the
// island rule requires before the region may hold state: the markup is now
// ./profile-view.tsx, the shaping that decides what that markup says is
// ./profile-store.js, and what is left here is the part that was never about
// the DOM — the fetches, the load-token discipline, the avatar downscale, the
// save order, and the `window.Profile` publication every legacy caller reaches
// this screen through.
//
// `_render()` kept its name and its callers; it is now a store push. Anything
// that called it to repaint after a write still works, and now repaints through
// React instead of rebuilding the subtree.

import {
  profileStore,
  breakdownRows,
  relativeDate,
  safeHref,
  displayNameOf,
  initialOf,
} from './profile-store.js';

const Profile = {
  _open: false,
  _loading: false,
  _targetUsername: null,
  _loadToken: 0,
  // { ranking, breakdown, completed, season } — kept across open/close so
  // re-entering the screen paints instantly, then refreshes.
  _data: null,

  // The token figure stays blurred until the user taps "Reveal" once;
  // mirrors the native TokenAllocationReveal acknowledgement.
  _REVEAL_KEY: 'sv:profile_tokens_revealed',

  // The avatar change staged by the photo picker. `_pendingAvatar` is a Blob to
  // upload, the string 'remove' to delete, or null for "leave it alone" —
  // nothing reaches the server until Save. The Blob stays here rather than in
  // the store because nothing renders it; only its object URL does, and that is
  // what the store carries.
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

  // Re-exported so the shaping has ONE home (./profile-store.js) while the
  // legacy `window.Profile` surface keeps every method it published.
  _safeHref: safeHref,
  _relativeDate: relativeDate,
  _breakdownRows: breakdownRows,
  _displayName() { return displayNameOf(Profile._user()); },
  _initial() { return initialOf(Profile._user()); },

  _user() { return (typeof window !== 'undefined' && window.App && App.user) || {}; },

  _revealed() {
    try { return localStorage.getItem(Profile._REVEAL_KEY) === '1'; } catch (_) { return false; }
  },

  async open(targetUsername = null) {
    Profile._open = true;
    Profile._targetUsername = targetUsername || null;
    Profile._data = null;
    Profile._render();
    const token = ++Profile._loadToken;
    await Profile._load(token);
    if (Profile._open && token === Profile._loadToken && !Profile._targetUsername) {
      Profile._maybeOpenShot();
    }
  },

  close() {
    Profile._open = false;
    Profile._targetUsername = null;
    Profile._loadToken++;
    Profile._dismissSheet();
    Profile._render();
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

  async _load(token = ++Profile._loadToken) {
    Profile._loading = true;
    try {
      if (Profile._targetUsername) {
        const target = Profile._targetUsername;
        try {
          const payload = await Profile._fetchJson(
            `/api/public/profiles/${encodeURIComponent(target)}`
          );
          if (token !== Profile._loadToken || target !== Profile._targetUsername) return;
          Profile._data = { publicProfile: payload.profile };
        } catch (err) {
          if (token !== Profile._loadToken || target !== Profile._targetUsername) return;
          Profile._data = err && err.status === 404
            ? { publicNotFound: true }
            : { error: true };
        }
        if (Profile._open && token === Profile._loadToken) Profile._render();
        return;
      }
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

      const [ranking, breakdown, completed, ownerPublicProfile] = await Promise.all([
        Profile._fetchJson(`/challenges-api/me/ranking${seasonQS}`),
        Profile._fetchJson(
          '/challenges-api/me/breakdown?include_activity=1' +
          (seasonId != null ? `&season_id=${seasonId}` : ''))
          .catch(() => null),
        // The viewer's OWN completions. Non-fatal: a failure leaves the
        // rest of the screen intact and the section shows its empty state.
        Profile._fetchJson('/api/me/challenges/completed').catch(() => null),
        Profile._fetchJson('/api/me/public-profile').catch(() => null),
      ]);

      if (token !== Profile._loadToken || Profile._targetUsername) return;
      Profile._data = {
        season: active,
        ranking,
        breakdown,
        completed,
        ownerPublicProfile,
      };
    } catch (err) {
      if (token !== Profile._loadToken) return;
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
      if (token === Profile._loadToken) Profile._loading = false;
    }
    if (Profile._open && token === Profile._loadToken) Profile._render();
  },

  // ── rendering ─────────────────────────────────────────────────────────
  //
  // One store push. Every branch this used to build by hand — the loading
  // line, the signed-out prompt with its #login link, the connection-error
  // copy, the "This profile is unavailable" 404, the public card and the
  // owner's own screen — is now a `kind` on the view ./profile-store.js
  // derives, rendered by ./profile-view.tsx. The order of those checks is
  // load-bearing and lives in `buildProfileView`: signedOut is tested BEFORE
  // error, or a lapsed session reads as a network fault.

  _render() {
    profileStore.set({
      open: Profile._open,
      data: Profile._data,
      user: Profile._user(),
      revealed: Profile._revealed(),
      pendingAvatarUrl: Profile._pendingAvatarUrl,
      pendingRemove: Profile._pendingAvatar === 'remove',
    });
  },

  // The token figure unblurs once, and stays unblurred (the acknowledgement
  // is the point, not the animation).
  revealTokens() {
    try { localStorage.setItem(Profile._REVEAL_KEY, '1'); } catch (_) { /* private mode */ }
    profileStore.set({ revealed: true });
  },

  // Web terms sheet (thin-shell migration) — the native terms screen is
  // gone. Refresh the profile after an accept so the token allocation
  // un-gates immediately.
  reviewTerms() {
    if (window.Settings && typeof Settings.showTermsSheet === 'function') {
      Settings.showTermsSheet(() => Profile._load());
    }
  },

  // ── opt-in public profile (#582) ────────────────────────────────────

  togglePreview() {
    profileStore.set((state) => ({ ...state, previewOpen: !state.previewOpen }));
  },

  async copyPublicLink(href) {
    const absolute = new URL(href, location.origin).href;
    try {
      await navigator.clipboard.writeText(absolute);
      profileStore.set({ publicStatus: 'Public link copied.' });
    } catch (_) {
      profileStore.set({ publicStatus: `Copy this link: ${absolute}` });
    }
  },

  async _setPublished(published) {
    profileStore.set({
      publishing: true,
      publicStatus: published ? 'Publishing…' : 'Unpublishing…',
    });
    try {
      const res = await fetch('/api/me/public-profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ published }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Could not update publication.');
      if (Profile._data) Profile._data.ownerPublicProfile = payload;
      profileStore.set({ publishing: false, publicStatus: '' });
      Profile._render();
      if (window.PlatformUI) {
        PlatformUI.toast(published ? 'Public profile published' : 'Public profile unpublished');
      }
    } catch (err) {
      profileStore.set({
        publishing: false,
        publicStatus: (err && err.message) || 'Could not update publication.',
      });
    }
  },

  // The report form on someone else's public card. Returns the status line
  // rather than writing it, so the component owns its own field state.
  async sendReport(username, reason, detail) {
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(username)}/report`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason, detail: detail || null }),
        }
      );
      if (!res.ok) throw new Error('request failed');
      return { ok: true, status: 'Report received.' };
    } catch (_) {
      return { ok: false, status: 'Could not send the report. Try again.' };
    }
  },

  // ── edit sheet ────────────────────────────────────────────────────────
  //
  // The panel is React's now (./profile-edit-sheet.tsx). It is rendered inside
  // #profile-root and lifted into the native kit's bottom sheet by
  // lib/kit-surface.ts — the same `PlatformUI.sheet` presentation it always
  // had, with the same `|| null` degradation: no kit means the panel simply
  // stays where React put it, at the top of the screen, so the editor is never
  // unreachable.

  showEditSheet() {
    // Re-entering replaces any open sheet rather than stacking two.
    Profile._dismissSheet();
    profileStore.set({ sheetOpen: true });
  },

  _dismissSheet() {
    profileStore.set({ sheetOpen: false });
    Profile._clearPendingAvatar();
  },

  _clearPendingAvatar() {
    if (Profile._pendingAvatarUrl) {
      try { URL.revokeObjectURL(Profile._pendingAvatarUrl); } catch (_) {}
    }
    Profile._pendingAvatar = null;
    Profile._pendingAvatarUrl = null;
    profileStore.set({ pendingAvatarUrl: null, pendingRemove: false });
  },

  /** Stage a chosen file. Throws a user-facing message when it cannot be used. */
  async stageAvatar(file) {
    const blob = await Profile._prepareAvatar(file);
    Profile._clearPendingAvatar();
    Profile._pendingAvatar = blob;
    Profile._pendingAvatarUrl = URL.createObjectURL(blob);
    profileStore.set({ pendingAvatarUrl: Profile._pendingAvatarUrl, pendingRemove: false });
  },

  /** Stage a deletion. Nothing reaches the server until Save. */
  stageAvatarRemoval() {
    Profile._clearPendingAvatar();
    Profile._pendingAvatar = 'remove';
    profileStore.set({ pendingAvatarUrl: null, pendingRemove: true });
  },

  hasPendingAvatar() { return Profile._pendingAvatar != null; },

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
  //
  // Returns `{ ok: true }`, `{ fieldErrors }` (server-side per-field messages,
  // which keep the sheet open with the user's other edits intact) or
  // `{ error }`. The sheet component owns the disabled state and the messages;
  // this owns the order and the truth-refresh.
  async _save({ displayName, bio, github, x }) {
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
        body: JSON.stringify({ displayName, bio, github, x }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const details = body && body.details;
        if (details && typeof details === 'object') {
          const fieldErrors = {};
          let pinned = false;
          for (const [key, msgs] of Object.entries(details)) {
            if (!['displayName', 'bio', 'github', 'x'].includes(key)) continue;
            fieldErrors[key] = Array.isArray(msgs) ? msgs[0] : String(msgs);
            pinned = true;
          }
          // Field-level messages are the whole feedback — keep the sheet
          // open with the user's other edits intact.
          if (pinned) return { fieldErrors };
        }
        throw new Error((body && body.error) || 'Could not save your profile.');
      }

      await Profile._refreshUser();
      Profile._dismissSheet();
      Profile._render();
      if (window.PlatformUI) PlatformUI.toast('Profile saved');
      return { ok: true };
    } catch (err) {
      return { error: (err && err.message) || 'Could not save your profile.' };
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
};

// Still published as a global: app.js's #profile hash branch,
// App.navigateToProfile / _exitProfile and the header menu's Profile row all
// reach this through `window.Profile`, and app.js is a classic script.
// Guarded because the SSG prerender pass evaluates this module in Node (the
// island imports it).
if (typeof window !== 'undefined') window.Profile = Profile;

export { Profile };
