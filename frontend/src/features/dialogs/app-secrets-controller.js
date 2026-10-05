// Per-app secrets UI — and, for the platform's own row, its "Platform
// variables" panel. One modal, two scopes.
//
// Backend lives in src/services/app-secrets.js + src/services/app-manifest.js
// and src/routes/apps.js (REST endpoints). The vote-based proposal path
// rides the existing issues machinery (kind='secret_change').
//
// This module renders a modal listing the manifest-declared keys (read
// from each dapp's `dapp.json`), plus any orphan keys the dapp no longer
// declares. Admins can either set/clear values directly via PUT/DELETE
// or open a 'secret_change' issue (when they want community buy-in for a
// sensitive change). Non-admins only see the propose path.
//
// The response's `scope` picks the semantics, and they differ in the one
// way a user has to know about:
//   'app'      — applying triggers a fresh rebuildProduction; the version
//                pill reflects deploy progress via the existing
//                app_redeploy_status WS broadcast, and the footer offers
//                "redeploy now".
//   'platform' — nothing is rebuilt. The value is materialized by the
//                platform's next deploy, so the panel says so up front and
//                there is no redeploy shortcut to offer. Rows additionally
//                carry `state` (set / unset / managed / orphan), a `group`
//                heading, and `unwritable` for the keys the deploy owns —
//                which get no controls at all, since the server refuses
//                both the direct write and the proposal.
//
// THREE ROW SOURCES beyond those, all read-only-ish:
//   state 'proposed'        — a key whose DECLARATION is up for vote (the
//                             "+ New variable" flow below). It has no
//                             manifest entry yet, so the only affordance
//                             is a link to the proposal.
//   source 'github-actions' — a platform-repo GitHub Actions secret.
//                             GitHub's API returns names + timestamps
//                             ONLY (no endpoint reveals a value, with any
//                             credential), so these rows are presence and
//                             freshness and nothing else.
//   row.githubSecret        — an existing row whose name exactly matches
//                             one of those secrets; annotated rather than
//                             duplicated.

import { attachReturnKey, pressButton } from '../../lib/return-to-next';

// The island's open/close controller, or null before hydration. Registered by
// `useDialog('appSecrets')` — see use-dialog.ts. Looked up on every call
// rather than captured, because the island unregisters on unmount.
function dialogController() {
  if (typeof window === 'undefined') return null;
  const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
  return (dialogs && dialogs.appSecrets) || null;
}

const Secrets = {
  currentSlug: null,
  // Last payload from GET /secrets — the declare form reads the scope, the
  // groups already in use, and canDeclare off it.
  currentData: null,
  declareOpen: false,

  init() {
    const modal = document.getElementById('app-secrets-modal');
    const redeploy = document.getElementById('app-secrets-redeploy');
    // Modal is the only piece this module hard-requires now. The entry-
    // point button moved to the dev-chat tab; AppView wires its click
    // to Secrets.openForCurrentApp() when that tab renders.
    if (!modal) return;

    // #1078 chunk I: the close button and the backdrop click are React's
    // now — AppSecretsDialog renders onClick on both, and closing is a
    // state update rather than a class write. Only the redeploy shortcut,
    // which is a plain action with no bearing on presentation, still binds
    // imperatively here.
    redeploy?.addEventListener('click', async () => {
      if (!Secrets.currentSlug) return;
      Secrets.setStatus(globalThis.PlatformI18n.t("core:triggering_redeploy_92e38e4a"), 'info');
      try {
        const res = await fetch(`/api/apps/${Secrets.currentSlug}/redeploy`, { method: 'POST' });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({}));
          throw new Error(error || `HTTP ${res.status}`);
        }
        Secrets.setStatus(globalThis.PlatformI18n.t("core:redeploy_started_watch_the_version_pill_c62e73bb"), 'ok');
      } catch (err) {
        Secrets.setStatus(globalThis.PlatformI18n.t("core:redeploy_failed_value1_99d664df", { value1: err.message }), 'err');
      }
    });
  },

  // Convenience for callers (currently the dev-chat Edit panel) that
  // know "the current app" but don't track its slug locally.
  openForCurrentApp() {
    const slug = AppView.appData?.slug;
    if (slug) Secrets.open(slug);
  },

  // Legacy header-badge hook. The standalone red dot is gone — the
  // dev-chat tab's "App secrets" row now shows "N missing" inline
  // (see AppView.refreshDevChatSecretsState). Kept as a no-op so older
  // call-sites don't break; safe to delete once nothing references it.
  applyMissingBadge() { /* no-op */ },

  // Kept as a noop-ish hook so AppView.close() can keep calling it
  // unchanged; it just makes sure any open modal is dismissed when the
  // user navigates away from the app.
  hide() {
    Secrets.close();
  },

  // Re-render the dev-chat secrets row after a successful direct edit
  // so "N missing" / "N of M set" reflects the new state without
  // forcing a tab reload. Best-effort: if the dev-chat tab isn't
  // mounted (user is on App / Group Chat) the helper itself no-ops.
  notifyDevChatRefresh() {
    if (window.AppView && typeof AppView.refreshDevChatSecretsState === 'function') {
      AppView.refreshDevChatSecretsState();
    }
  },

  // `opts.declare` expands the "New variable" form as part of opening —
  // the screenshot-state deep link (`?shot=secrets-new`) uses it, since a
  // form behind a click is invisible to the capture pipeline and to a
  // dapp.json test.
  //
  // #1078 chunk I: `open` no longer reveals anything. It asks the island to
  // open — React flips its state, `useStaticModal` drops `hidden` and lifts
  // the card into the kit shell, and the island then calls `_load` below with
  // the same arguments. Every legacy caller (`Secrets.open(slug)` from five
  // places in app-view.js) is unchanged; only who owns the reveal moved.
  async open(slug, opts = {}) {
    const island = dialogController();
    if (!island) return Secrets._load(slug, opts);
    island.open({ slug, opts });
  },

  /** The data half of the old `open`, run by the island once it is presented. */
  async _load(slug, opts = {}) {
    Secrets.currentSlug = slug;
    Secrets.declareOpen = !!opts.declare;
    const list = document.getElementById('app-secrets-list');
    if (!list) return;
    list.innerHTML = `<p class="text-sm text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:loading_ba3bbbe1")}</p>`;
    Secrets.setStatus('', '');
    try {
      const res = await fetch(`/api/apps/${slug}/secrets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      Secrets.render(data);
      // Opened straight into the form (the ?shot=secrets-new deep link):
      // it sits BELOW the row list in the shared scroller, so without this
      // the screenshot — and the reviewer — would see the rows and never
      // the form the link exists to show.
      if (opts.declare) {
        document.getElementById('app-secrets-declare')
          ?.scrollIntoView({ block: 'start' });
      }
    } catch (err) {
      list.innerHTML = `<p class="text-sm text-red-700 dark:text-red-400">${globalThis.PlatformI18n.htmlText("core:failed_to_load_value0_4a24175c", { value0: err.message })}</p>`;
    }
  },

  // Mirror of `open`: ask the island to close and let its `onClose` run the
  // reset. Callers that arrive before hydration (there are none today, but
  // `AppView.close()` calls this on every app teardown) still get the reset.
  close() {
    const island = dialogController();
    if (!island) return Secrets._reset();
    island.close();
  },

  // `close`, for a click whose default action then follows a link. A plain
  // close queues a history.back() that lands after the link's address and
  // undoes it (#3683); see DialogController.closeForNavigation.
  closeForNavigation() {
    const island = dialogController();
    if (!island) return Secrets._reset();
    island.closeForNavigation();
  },

  /** The state half of the old `close`, run by the island once it is hidden. */
  _reset() {
    Secrets.currentSlug = null;
    Secrets.currentData = null;
    Secrets.declareOpen = false;
  },

  // Row-state badges, for the platform-variables view. The server sends
  // `state` (set / unset / managed / orphan / proposed) and the badge is
  // the whole reason the states are worth distinguishing: "not set"
  // falling back to a committed default and "deploy-managed, not yours to
  // set" look identical without it.
  STATE_BADGES: {
    set: { get label() { return globalThis.PlatformI18n.t("core:set_b6f6f3ad"); }, cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    unset: { get label() { return globalThis.PlatformI18n.t("core:not_set_4895f731"); }, cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
    managed: { get label() { return globalThis.PlatformI18n.t("core:deploy_managed_fe835fe0"); }, cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    orphan: { get label() { return globalThis.PlatformI18n.t("core:no_longer_declared_d9865b55"); }, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
    proposed: { get label() { return globalThis.PlatformI18n.t("core:waiting_for_approval_10c5739b"); }, cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
  },

  // The group heading the server files GitHub-Actions rows under. Kept in
  // sync with GITHUB_ACTIONS_GROUP in src/routes/apps.js.
  get GITHUB_GROUP() { return globalThis.PlatformI18n.t("core:github_actions_secrets_platform_repo_818b1bec"); },

  render(data) {
    Secrets.currentData = data;
    const list = document.getElementById('app-secrets-list');
    const footer = document.getElementById('app-secrets-footer');
    const title = document.getElementById('app-secrets-title');
    const subtitle = document.getElementById('app-secrets-subtitle');
    if (!list) return;
    // View-only admins can SEE the secrets list (gated on isAdmin server-
    // side) but only full admins get the direct-write fast path — the
    // "Set/Replace/Clear" buttons and the "redeploy now" footer all gate
    // on canAdminWrite (issue #311). Everyone else still gets the vote-
    // based propose flow.
    const canWrite = !!App.user?.canAdminWrite;
    // The platform's own variables are the same panel with different
    // semantics: they reach the process through the platform's next DEPLOY,
    // not through a rebuild of this container, and there is no "redeploy
    // now" to offer (POST /redeploy refuses the self-app row).
    const isPlatform = data.scope === 'platform';
    const showFooter = canWrite && data.redeployable !== false;
    footer?.classList.toggle('hidden', !showFooter);

    if (title) {
      title.textContent = isPlatform ? globalThis.PlatformI18n.t("core:platform_variables_d570a27e") : globalThis.PlatformI18n.t("core:app_secrets_fbd64919");
    }
    if (subtitle) {
      subtitle.innerHTML = isPlatform
        ? `${globalThis.PlatformI18n.htmlText("core:the_platform_s_own_environment_variables_declare_6131d995")} <code class="text-xs">dapp.json</code>. <span class="font-semibold text-zinc-700 dark:text-zinc-300">${globalThis.PlatformI18n.htmlText("core:a_change_here_is_not_live_immediately_it_is_appl_a0209fbf")}</span>`
        : `${globalThis.PlatformI18n.htmlText("core:environment_variables_this_app_declares_in_8dd490a4")} <code class="text-xs">dapp.json</code>.`;
    }

    // Pre-first-deploy: there is no manifest snapshot to list declared
    // keys from. Say so — but keep rendering whatever rows DO exist below
    // it, because a declaration already up for vote is exactly the thing
    // someone opening this panel needs to see (and not open twice).
    const manifestNotice = data.manifestKnown ? '' : `
        <p class="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          ${globalThis.PlatformI18n.htmlText("core:no_manifest_snapshot_yet_once_this_app_s_first_d_b2bdf58e")}
        </p>`;
    if (!data.manifestKnown && (!data.secrets || !data.secrets.length)) {
      list.innerHTML = manifestNotice;
      Secrets.renderDeclareSection(data);
      return;
    }
    if (!data.secrets || !data.secrets.length) {
      list.innerHTML = isPlatform
        ? `<p class="text-sm text-zinc-500 dark:text-zinc-400">
             ${globalThis.PlatformI18n.htmlText("core:no_platform_variables_are_declared_yet_use_new_v_8f9e6c78")}
           </p>`
        : `<p class="text-sm text-zinc-500 dark:text-zinc-400">
             ${globalThis.PlatformI18n.htmlText("core:this_app_s_0ef16aec")} <code class="text-xs">dapp.json</code> ${globalThis.PlatformI18n.htmlText("core:doesn_t_declare_any_secrets_yet_use_new_secret_b_de76e19e")}
           </p>`;
      Secrets.renderDeclareSection(data);
      return;
    }

    // Platform variables arrive pre-ordered by group (the server sinks the
    // groups nobody can act on to the bottom), so render the group headings
    // in first-seen order rather than re-sorting here.
    if (isPlatform) {
      const groups = [];
      const byGroup = new Map();
      for (const s of data.secrets) {
        const g = s.group || 'General';
        if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
        byGroup.get(g).push(s);
      }
      // The GitHub-secrets group renders even with NO rows: "couldn't read
      // them" and "there are none" are different answers, and omitting the
      // group silently reads as the latter.
      const gh = data.githubSecrets;
      if (gh && gh.state !== 'hidden' && !byGroup.has(Secrets.GITHUB_GROUP)) {
        byGroup.set(Secrets.GITHUB_GROUP, []);
        groups.push(Secrets.GITHUB_GROUP);
      }
      list.innerHTML = manifestNotice + groups.map((g) => `
        <div class="mb-3">
          <h3 class="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">${escapeHtml(g)}</h3>
          ${Secrets.groupNoteHtml(g, data)}
          ${byGroup.get(g).map((s) => Secrets.renderRow(s, canWrite)).join('')}
        </div>`).join('');
    } else {
      list.innerHTML = manifestNotice + data.secrets.map((s) => Secrets.renderRow(s, canWrite)).join('');
    }

    list.querySelectorAll('[data-action="set"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleSet(btn.dataset.key, btn.dataset.sensitive === '1'));
    });
    list.querySelectorAll('[data-action="clear"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleClear(btn.dataset.key));
    });
    list.querySelectorAll('[data-action="propose-set"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleProposeSet(btn.dataset.key, btn.dataset.sensitive === '1'));
    });
    list.querySelectorAll('[data-action="propose-clear"]').forEach((btn) => {
      btn.addEventListener('click', () => Secrets.handleProposeClear(btn.dataset.key));
    });
    // A "View proposal" link navigates to the app's vote panel, so the
    // modal has to get out of the way first, without undoing the link's own
    // navigation (see closeForNavigation).
    list.querySelectorAll('[data-action="view-proposal"]').forEach((el) => {
      el.addEventListener('click', () => Secrets.closeForNavigation());
    });

    Secrets.renderDeclareSection(data);
  },

  // Extra copy under a group heading. Only the GitHub-Actions group has
  // any: it has to say where the rows come from, that values are never
  // retrievable, and — when the fetch failed — why there are no rows.
  groupNoteHtml(group, data) {
    if (group !== Secrets.GITHUB_GROUP) return '';
    const gh = data.githubSecrets || {};
    const where = `${globalThis.PlatformI18n.htmlText("core:read_only_change_these_in_the_repo_s_769f154c")} <span class="font-medium">${globalThis.PlatformI18n.htmlText("core:settings_secrets_and_variables_actions_2d73f2ef")}</span> ${globalThis.PlatformI18n.htmlText("core:on_github_github_never_returns_a_secret_s_value__76c3f8f6")}`;
    if (gh.state === 'unavailable') {
      return `<p class="text-xs text-amber-800 dark:text-amber-400 mb-2">${
        escapeHtml(gh.reason || globalThis.PlatformI18n.t("core:couldn_t_read_the_platform_repo_s_actions_secret_d28e4bf8"))}</p>`;
    }
    if (gh.state === 'ok' && !gh.count) {
      return `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${globalThis.PlatformI18n.htmlText("core:no_actions_secrets_on_this_repo")} ${where}</p>`;
    }
    return `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${where}${
      gh.staged ? ` <span class="italic">${globalThis.PlatformI18n.htmlText("core:staging_preview_this_list_is_demo_data_930485c3")}</span>` : ''}</p>`;
  },

  renderRow(s, canWrite) {
    const isGithubRow = s.source === 'github-actions';
    const isProposed = s.state === 'proposed';
    const requiredBadge = s.required
      ? `<span class="text-[0.65rem] uppercase font-bold text-red-700 dark:text-red-400">${globalThis.PlatformI18n.htmlText("core:required_d0a36305")}</span>`
      : '';
    const sensitiveBadge = s.sensitive && !isGithubRow
      ? `<span class="text-[0.65rem] uppercase font-bold text-amber-800 dark:text-amber-300" title="${globalThis.PlatformI18n.htmlText("core:value_never_shown_after_save_d7ce6649")}">${globalThis.PlatformI18n.htmlText("core:sensitive_2d5e8600")}</span>`
      : '';
    const orphanBadge = s.orphan
      ? `<span class="text-[0.65rem] uppercase font-bold text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:orphan_88f6811a")}</span>`
      : '';
    // Present only on the platform-variables view; ordinary app secrets
    // send no `state` and keep exactly the badges they always had — except
    // a 'proposed' row, which needs its badge in both scopes.
    const badge = s.state && Secrets.STATE_BADGES[s.state];
    const stateBadge = badge
      ? `<span class="rounded px-1.5 py-0.5 text-[0.6rem] font-medium ${badge.cls}">${badge.label}</span>`
      : '';

    let valueDisplay;
    if (isGithubRow) {
      // Names + timestamps are the entire API surface here (see the header
      // comment), so there is deliberately no value, no last-4, and no
      // "reveal" affordance to offer — not even to an admin.
      valueDisplay = `<span class="text-xs text-zinc-600 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:set_on_github_value0_d30b5633", { value0: s.updatedAt ? globalThis.PlatformI18n.t("core:updated_value1_4a05f376", { value1: Secrets.formatDate(s.updatedAt) }) : '' })}</span>`;
    } else if (isProposed) {
      valueDisplay = s.hasValue
        ? `<span class="text-xs text-violet-700 dark:text-violet-300">${globalThis.PlatformI18n.htmlText("core:value_included_value0_applied_when_the_proposal__06bbc07a", { value0: s.valueLast4 ? ` (…${s.valueLast4})` : '' })}</span>`
        : `<span class="text-xs text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:declaration_only_no_value_proposed_8c4c8583")}</span>`;
    } else if (s.hasValue && s.value != null) {
      // A non-private platform variable whose plaintext the server was
      // willing to return (admins only). Showing it in full is the point of
      // marking a variable non-private.
      valueDisplay = `<code class="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">${escapeHtml(s.value)}</code>`;
    } else if (s.hasValue && s.private && s.state) {
      valueDisplay = `<span class="text-xs text-zinc-500 dark:text-zinc-400 font-mono">${globalThis.PlatformI18n.htmlText("core:private_never_displayed_95098d11")}</span>`;
    } else if (s.hasValue && s.state === 'set' && !s.private && s.valueLast4 == null) {
      // Stored, but the plaintext couldn't be decrypted (rotated
      // JWT_SECRET, corrupt row). listView() degrades to this rather than
      // erroring the whole panel, so say so instead of rendering "set".
      valueDisplay = `<span class="text-xs text-amber-800 dark:text-amber-400">${globalThis.PlatformI18n.htmlText("core:set_but_the_stored_value_could_not_be_read_d84f2010")}</span>`;
    } else if (s.hasValue) {
      const last4 = s.valueLast4 ? `…${s.valueLast4}` : '••••••••';
      valueDisplay = `<span class="font-mono text-xs text-emerald-700 dark:text-emerald-400">${globalThis.PlatformI18n.htmlText("core:set_value0_b1bb6066", { value0: last4 })}</span>`;
    } else if (s.required && !s.unwritable) {
      valueDisplay = `<span class="text-xs font-medium text-red-700 dark:text-red-400">${globalThis.PlatformI18n.htmlText("core:missing_deploys_are_blocked_ee1b26d9")}</span>`;
    } else if (s.default != null) {
      valueDisplay = `<span class="font-mono text-xs text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:default_value0_591e75df", { value0: s.default })}</span>`;
    } else {
      valueDisplay = `<span class="text-xs text-zinc-500 dark:text-zinc-400">${globalThis.PlatformI18n.htmlText("core:not_set_1aef9399")}</span>`;
    }

    const setVerb = s.hasValue ? 'replace' : 'set';
    const sensitiveAttr = s.sensitive ? '1' : '0';
    // Direct path (admin only): filled violet for set/replace, red-outline
    // for clear — these slam the change in via PUT/DELETE.
    const directButtons = `
      <button data-action="set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
        class="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white">${setVerb}</button>
      ${s.hasValue ? `<button data-action="clear" data-key="${escapeAttr(s.key)}"
        class="text-xs px-2 py-1 rounded border border-red-400 text-red-700 hover:bg-red-50 dark:hover:bg-red-950 dark:text-red-400">${globalThis.PlatformI18n.htmlText("core:clear_913a4cb9")}</button>` : ''}
    `;
    // Vote path (everyone): muted outline styling so admins reach for
    // direct first by default, but can opt into the vote flow per row.
    const proposeButtons = `
      <button data-action="propose-set" data-key="${escapeAttr(s.key)}" data-sensitive="${sensitiveAttr}"
        class="text-xs px-2 py-1 rounded border border-violet-400 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950">${globalThis.PlatformI18n.htmlText("core:propose_value2_b4c9a0f6", { value2: setVerb })}</button>
      ${s.hasValue ? `<button data-action="propose-clear" data-key="${escapeAttr(s.key)}"
        class="text-xs px-2 py-1 rounded border border-red-300 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950">${globalThis.PlatformI18n.htmlText("core:propose_clear_0fb1baa2")}</button>` : ''}
    `;
    // A row whose key isn't declared yet gets a link to the declaration
    // proposal and nothing else: there is no manifest entry for a value
    // change to attach to, and the value already rides on that proposal.
    const proposalLink = (p) => (p
      ? `<a href="#/app/${escapeAttr(Secrets.currentSlug || '')}" data-action="view-proposal"
           class="text-xs px-2 py-1 rounded border border-violet-400 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950">${globalThis.PlatformI18n.htmlText("core:view_proposal_value1_83693615", { value1: p.prNumber ? ` #${escapeHtml(String(p.prNumber))}` : '' })}</a>`
      : '');
    // An `unwritable` row gets NEITHER path. Its value comes from a GitHub
    // secret at deploy time and the server refuses both the direct write and
    // the proposal, so a button here could only ever produce an error — or,
    // worse, a vote that can't be honoured. Offering none is the honest UI.
    let actions;
    if (isProposed) {
      actions = proposalLink(s.pending);
    } else if (s.unwritable) {
      actions = '';
    } else {
      actions = canWrite
        ? `${directButtons}<span class="inline-block w-px h-4 bg-zinc-300 dark:bg-zinc-700 mx-1 self-center" aria-hidden="true"></span>${proposeButtons}`
        : proposeButtons;
    }

    const alsoGithub = (g) => globalThis.PlatformI18n.t("core:also_a_github_actions_secret_on_the_platform_rep_7e665b37", { value1: g.updatedAt ? globalThis.PlatformI18n.t("core:updated_value1_4a05f376", { value1: escapeHtml(Secrets.formatDate(g.updatedAt)) }) : '' });

    return `
      <div class="py-3 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <code class="text-sm font-mono font-bold text-zinc-900 dark:text-zinc-100">${escapeHtml(s.key)}</code>
          ${stateBadge}
          ${requiredBadge}
          ${sensitiveBadge}
          ${orphanBadge}
        </div>
        ${s.description ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${escapeHtml(s.description)}</p>` : ''}
        ${isGithubRow ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:stored_as_an_actions_secret_on_the_platform_repo_6e9da594")}</p>` : ''}
        ${!isGithubRow && s.unwritable ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:set_by_the_deploy_from_a_github_secret_it_can_t__a1daa1aa")}</p>` : ''}
        ${!isGithubRow && s.githubSecret ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          ${alsoGithub(s.githubSecret)}</p>` : ''}
        ${isProposed ? `<p class="text-xs text-violet-700 dark:text-violet-300 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:not_declared_yet_a_change_adding_it_to_a519d8ea")} <code class="text-[0.65rem]">dapp.json</code>
          ${globalThis.PlatformI18n.htmlText("core:is_waiting_for_approval_value0_adf4696b", { value0: s.pending && s.pending.proposedBy
    ? globalThis.PlatformI18n.t("core:opened_by_value1_3ef3d7ab", { value1: escapeHtml(s.pending.proposedBy) }) : '' })}</p>` : ''}
        ${!isProposed && s.pending ? `<p class="text-xs text-violet-700 dark:text-violet-300 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:value_set_its_declaration_is_waiting_for_approva_6cb76a48", { value0: s.pending.prNumber
    ? globalThis.PlatformI18n.t("core:pr_value1_700c53a1", { value1: escapeHtml(String(s.pending.prNumber)) }) : '' })}</p>` : ''}
        ${s.state === 'orphan' ? `<p class="text-xs text-amber-800 dark:text-amber-400 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:no_longer_declared_in_895dc423")} <code class="text-[0.65rem]">dapp.json</code>${globalThis.PlatformI18n.htmlText("core:its_value_is_kept_so_a_rollback_still_works_so_c_c761409a")}</p>` : ''}
        <div class="flex items-center gap-2 flex-wrap">
          ${valueDisplay}
          <span class="flex-1"></span>
          ${actions}
        </div>
      </div>`;
  },

  // Short, locale-aware date for a GitHub timestamp. Falls back to the raw
  // string when it isn't parseable — better than rendering "Invalid Date".
  formatDate(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleDateString(globalThis.PlatformI18n.getLanguage(), { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return String(iso);
    }
  },

  // ──────────────────────────────────────────────────────────────────
  // "+ New variable" — declare a key dapp.json doesn't have yet.
  //
  // One submit produces ONE proposal: a PR appending the declaration to
  // dapp.json, plus the value — written immediately for a full admin (who
  // may already set values directly) and held until the merge for
  // everyone else. The server owns all the validation below; the local
  // checks exist only to save a round trip.
  // ──────────────────────────────────────────────────────────────────
  renderDeclareSection(data) {
    const host = document.getElementById('app-secrets-declare');
    if (!host) return;
    const isPlatform = data.scope === 'platform';
    host.classList.remove('hidden');

    const canWrite = !!App.user?.canAdminWrite;
    const noun = isPlatform ? 'variable' : 'secret';
    // `canDeclare === false` (no repo, or GitHub unconfigured on the
    // platform) doesn't hide the affordance: the form still opens, states
    // the reason, and refuses to submit. Hiding it entirely would leave
    // "there is no such feature" and "it can't run right now" looking
    // identical — and a submit that could only 503 is the thing worth
    // preventing, not the explanation.
    const blocked = data.canDeclare === false;

    if (!Secrets.declareOpen) {
      host.innerHTML = `
        <div class="border-t border-zinc-200 dark:border-zinc-800 pt-3">
          <button id="app-secrets-declare-open"
            class="text-xs px-2.5 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white font-medium">
            ${globalThis.PlatformI18n.htmlText("core:new_value0_57a9d30e", { value0: noun })}</button>
          <span class="ml-2 text-xs text-zinc-500 dark:text-zinc-400">${blocked
    ? escapeHtml(data.declareDisabledReason || globalThis.PlatformI18n.t("core:unavailable_right_now_2cb2c126"))
    : (canWrite
      ? globalThis.PlatformI18n.t("core:declares_it_in_dapp_json_a_proposal_and_stores_y_ecc75307")
      : globalThis.PlatformI18n.t("core:declaration_and_value_wait_for_approval_together_6c8b2282"))}</span>
        </div>`;
      document.getElementById('app-secrets-declare-open')?.addEventListener('click', () => {
        Secrets.declareOpen = true;
        Secrets.renderDeclareSection(data);
        const field = document.getElementById('decl-key');
        field?.focus();
        // The form is taller than the remaining space in the shared
        // scroller, so bring it into view instead of leaving the user
        // looking at the row list wondering what the button did.
        field?.scrollIntoView({ block: 'nearest' });
      });
      return;
    }

    // Groups already in use, offered as a datalist so a new platform
    // variable lands under an existing heading instead of inventing a
    // near-duplicate one.
    const groups = [...new Set((data.secrets || []).map((s) => s.group).filter(Boolean))]
      .filter((g) => g !== Secrets.GITHUB_GROUP);
    const input = 'w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 '
      + 'px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400';
    const lbl = 'block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1';
    const help = 'text-[0.7rem] text-zinc-500 mt-0.5 dark:text-zinc-400';

    host.innerHTML = `
      <div class="border-t border-zinc-200 dark:border-zinc-800 pt-3">
        <h3 class="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          ${globalThis.PlatformI18n.htmlText("core:new_value0_642f9e9b", { value0: isPlatform ? globalThis.PlatformI18n.t("core:platform_variable_b25b19bb") : globalThis.PlatformI18n.t("core:app_secret_409e5ad7") })}</h3>
        ${blocked ? `<p id="app-secrets-declare-blocked"
          class="text-xs text-amber-800 dark:text-amber-400 mb-2">${
  escapeHtml(data.declareDisabledReason || globalThis.PlatformI18n.t("core:new_variables_can_t_be_declared_right_now_cf07d984"))}</p>` : ''}
        <div class="space-y-2">
          <div>
            <label class="${lbl}" for="decl-key">${globalThis.PlatformI18n.htmlText("core:key_99a52df3")}</label>
            <input id="decl-key" class="${input} font-mono" placeholder="${globalThis.PlatformI18n.htmlText("core:my_new_token_66d5b2c1")}"
              autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="next">
            <p class="${help}">${globalThis.PlatformI18n.htmlText("core:upper_snake_case_the_name_your_code_reads_from_t_6a69b602")}</p>
          </div>
          <div>
            <label class="${lbl}" for="decl-description">${globalThis.PlatformI18n.htmlText("core:description_526e0087")}</label>
            <input id="decl-description" class="${input}" placeholder="${globalThis.PlatformI18n.htmlText("core:what_this_value_is_and_where_to_get_it_cb663adf")}"
              enterkeyhint="next">
          </div>
          <div>
            <label class="${lbl}" for="decl-value">${globalThis.PlatformI18n.htmlText("core:value_8e37953d")}</label>
            <input id="decl-value" class="${input} font-mono" placeholder="${globalThis.PlatformI18n.htmlText("core:leave_blank_to_declare_only_453d7d74")}"
              autocomplete="off" spellcheck="false" enterkeyhint="next">
            <p class="${help}">${canWrite
    ? globalThis.PlatformI18n.t("core:stored_as_soon_as_you_submit_optional_if_you_giv_f30fc98e")
    : globalThis.PlatformI18n.t("core:held_encrypted_and_stored_when_the_proposal_merg_17a9bed5")}</p>
          </div>
          <div class="flex items-center gap-4 pt-0.5">
            <label class="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" id="decl-required" class="rounded"> ${globalThis.PlatformI18n.htmlText("core:required_4850b174")}
            </label>
            <label class="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" id="decl-private" class="rounded"> ${globalThis.PlatformI18n.htmlText("core:private_c63eb672")}
            </label>
          </div>
          <p class="${help}">${globalThis.PlatformI18n.htmlText("core:required_blocks_deploys_until_it_has_a_value_pri_3890be15", { value12: isPlatform ? '' : globalThis.PlatformI18n.t("core:message_f704c2eea21c") })}</p>
          <div>
            <label class="${lbl}" for="decl-default">${globalThis.PlatformI18n.htmlText("core:default_21b111cb")}</label>
            <input id="decl-default" class="${input} font-mono" placeholder="${globalThis.PlatformI18n.htmlText("core:optional_ec91fdd9")}" enterkeyhint="next">
            <p class="${help}">${isPlatform
    ? globalThis.PlatformI18n.t("core:documents_the_fallback_your_code_already_uses_th_3e65014c")
    : globalThis.PlatformI18n.t("core:used_at_deploy_time_when_no_value_is_stored_c534d9cb")}</p>
          </div>
          ${isPlatform ? `
          <div>
            <label class="${lbl}" for="decl-group">${globalThis.PlatformI18n.htmlText("core:group_34ca0e76")}</label>
            <input id="decl-group" class="${input}" list="decl-group-options" placeholder="${globalThis.PlatformI18n.htmlText("core:general_c910d474")}"
              enterkeyhint="done">
            <datalist id="decl-group-options">${groups.map((g) => `<option value="${escapeAttr(g)}"></option>`).join('')}</datalist>
            <p class="${help}">${globalThis.PlatformI18n.htmlText("core:the_heading_this_row_files_under_in_this_panel_29efebbb")}</p>
          </div>` : `
          <div>
            <label class="${lbl}" for="decl-staging-default">${globalThis.PlatformI18n.htmlText("core:staging_default_504b5f39")}</label>
            <input id="decl-staging-default" class="${input} font-mono" placeholder="${globalThis.PlatformI18n.htmlText("core:optional_ec91fdd9")}"
              enterkeyhint="done">
            <p class="${help}">${globalThis.PlatformI18n.htmlText("core:staging_default_help_pr_previews")}</p>
          </div>`}
        </div>
        <div class="flex items-center gap-2 mt-3">
          <button id="app-secrets-declare-submit" ${blocked ? 'disabled' : ''}
            class="text-xs px-2.5 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white font-medium ${blocked ? 'opacity-50 cursor-not-allowed' : ''}">${canWrite ? globalThis.PlatformI18n.t("core:add_amp_set_value_35f96694") : globalThis.PlatformI18n.t("core:propose_new_bbd2ee2f") + noun}</button>
          <button id="app-secrets-declare-cancel"
            class="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">${globalThis.PlatformI18n.htmlText("core:cancel_19766ed6")}</button>
        </div>
      </div>`;

    // #3907: Return walks the five fields (the checkboxes are stepped over)
    // and the last one presses the submit button, so a blocked form still
    // refuses the same way a tap does. The iOS keyboard has no chevrons to
    // walk them with any more. On the node this render just wrote, so a
    // re-render never stacks a second listener.
    attachReturnKey(host.firstElementChild, {
      submit: () => { pressButton(document.getElementById('app-secrets-declare-submit')); },
    });
    document.getElementById('app-secrets-declare-cancel')?.addEventListener('click', () => {
      Secrets.declareOpen = false;
      Secrets.setStatus('', '');
      Secrets.renderDeclareSection(data);
    });
    document.getElementById('app-secrets-declare-submit')?.addEventListener('click', () => {
      Secrets.submitDeclare(data);
    });
  },

  // Client-side mirror of the server's rules (src/routes/apps.js
  // POST /secret-declaration-pr). Returns an error string, or null when
  // the form looks submittable. The server stays authoritative.
  validateDeclaration(f, isPlatform) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(f.key)) {
      return globalThis.PlatformI18n.t("core:key_must_be_upper_snake_case_letters_digits_and__7b8ea689");
    }
    if (f.required && !f.value && !f.default) {
      return globalThis.PlatformI18n.t("core:a_required_variable_needs_either_a_value_or_a_de_c06e02a6");
    }
    if (!isPlatform && f.required && f.private && !f.stagingDefault && !f.default) {
      return globalThis.PlatformI18n.t("core:pr_previews_of_this_app_won_t_boot_without_a_sta_86401def");
    }
    // Same .env-representability rule platform-env.validateValue enforces
    // server-side: a single quote or a bare CR can't survive the
    // single-quoted line the platform's deploy writes.
    if (isPlatform && f.value && /['\r]/.test(f.value)) {
      return globalThis.PlatformI18n.t("core:values_can_t_contain_a_single_quote_or_a_carriag_732695af");
    }
    return null;
  },

  async submitDeclare(data) {
    // Belt to the disabled button's braces: the server would 503 anyway,
    // but saying why here beats a generic failure line.
    if (data.canDeclare === false) {
      Secrets.setStatus(data.declareDisabledReason || globalThis.PlatformI18n.t("core:new_variables_can_t_be_declared_right_now_cf07d984"), 'err');
      return;
    }
    const isPlatform = data.scope === 'platform';
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const fields = {
      key: val('decl-key').toUpperCase(),
      description: val('decl-description'),
      value: document.getElementById('decl-value')?.value || '',
      required: !!document.getElementById('decl-required')?.checked,
      private: !!document.getElementById('decl-private')?.checked,
      default: val('decl-default'),
      group: isPlatform ? (val('decl-group') || 'General') : undefined,
      stagingDefault: isPlatform ? undefined : val('decl-staging-default'),
    };

    const invalid = Secrets.validateDeclaration(fields, isPlatform);
    if (invalid) {
      Secrets.setStatus(invalid, 'err');
      return;
    }

    const submit = document.getElementById('app-secrets-declare-submit');
    if (submit) submit.disabled = true;
    Secrets.setStatus(globalThis.PlatformI18n.t("core:opening_a_proposal_for_value1_6678090b", { value1: fields.key }), 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/secret-declaration-pr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      Secrets.declareOpen = false;
      const opened = globalThis.PlatformI18n.t("core:proposal_opened_for_value1_value2_fb087900", { value1: fields.key, value2: payload.prNumber ? globalThis.PlatformI18n.t("core:pr_value1_700c53a1", { value1: payload.prNumber }) : '' });
      Secrets.setStatus(`${opened} ${payload.valueApplied
        ? globalThis.PlatformI18n.t("core:your_value_is_stored_the_declaration_still_needs_eafa3e50")
        : globalThis.PlatformI18n.t("core:vote_on_it_in_the_group_chat_panel_the_value_app_174cbdbd")}`, 'ok');
      Secrets.notifyDevChatRefresh();
      await Secrets.open(Secrets.currentSlug);
      // open() clears the status line, so re-post the outcome after it.
      Secrets.setStatus(`${opened} ${payload.valueApplied
        ? globalThis.PlatformI18n.t("core:your_value_is_stored_the_declaration_still_needs_eafa3e50")
        : globalThis.PlatformI18n.t("core:vote_on_it_in_the_group_chat_panel_the_value_app_174cbdbd")}`, 'ok');
    } catch (err) {
      Secrets.setStatus(globalThis.PlatformI18n.t("core:failed_value1_c9a5148f", { value1: err.message }), 'err');
    } finally {
      if (submit) submit.disabled = false;
    }
  },

  async handleSet(key, sensitive) {
    const value = await PlatformUI.prompt({
      get title() { return globalThis.PlatformI18n.t("core:set_value1_55e7bccc", { value1: key }); },
      message: sensitive ? globalThis.PlatformI18n.t("core:this_value_is_sensitive_it_is_encrypted_at_rest__2103461f") : undefined,
      get placeholder() { return globalThis.PlatformI18n.t("core:value_cd42404d"); },
      get confirmLabel() { return globalThis.PlatformI18n.t("core:save_1509f561"); },
    });
    if (value == null || !value.length) return;
    Secrets.setStatus(globalThis.PlatformI18n.t("core:setting_value1_50c9409d", { value1: key }), 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(globalThis.PlatformI18n.t("core:saved_value1_25b0f064", { value1: key }), 'ok');
      Secrets.notifyDevChatRefresh();
      await Secrets.open(Secrets.currentSlug);
    } catch (err) {
      Secrets.setStatus(globalThis.PlatformI18n.t("core:failed_to_set_value1_value2_0ee9a95f", { value1: key, value2: err.message }), 'err');
    }
  },

  async handleClear(key) {
    if (!await PlatformUI.confirm({ get title() { return globalThis.PlatformI18n.t("core:clear_value1_c6d6200e", { value1: key }); }, get confirmLabel() { return globalThis.PlatformI18n.t("core:clear_83b12c22"); }, danger: true })) return;
    Secrets.setStatus(globalThis.PlatformI18n.t("core:clearing_value1_f06c3e24", { value1: key }), 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(globalThis.PlatformI18n.t("core:cleared_value1_73e1cf5d", { value1: key }), 'ok');
      Secrets.notifyDevChatRefresh();
      await Secrets.open(Secrets.currentSlug);
    } catch (err) {
      Secrets.setStatus(globalThis.PlatformI18n.t("core:failed_to_clear_value1_value2_9dd3e124", { value1: key, value2: err.message }), 'err');
    }
  },

  async handleProposeSet(key, sensitive) {
    const value = await PlatformUI.prompt({
      get title() { return globalThis.PlatformI18n.t("core:propose_setting_value1_c65ef30a", { value1: key }); },
      message: (sensitive ? globalThis.PlatformI18n.t("core:this_value_is_sensitive_7edd08e6") : '') + globalThis.PlatformI18n.t("core:a_majority_of_active_users_must_vote_up_before_t_44ca47fc"),
      get placeholder() { return globalThis.PlatformI18n.t("core:value_cd42404d"); },
      get confirmLabel() { return globalThis.PlatformI18n.t("core:propose_1cbd9e71"); },
    });
    if (value == null || !value.length) return;
    Secrets.setStatus(globalThis.PlatformI18n.t("core:opening_proposal_for_value1_763366b9", { value1: key }), 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'secret_change',
          payload: { key, action: 'set', value },
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(globalThis.PlatformI18n.t("core:proposal_opened_vote_in_the_group_chat_tab_20b2e510"), 'ok');
    } catch (err) {
      Secrets.setStatus(globalThis.PlatformI18n.t("core:failed_value1_c9a5148f", { value1: err.message }), 'err');
    }
  },

  async handleProposeClear(key) {
    if (!await PlatformUI.confirm({ get title() { return globalThis.PlatformI18n.t("core:propose_removing_value1_d41a10aa", { value1: key }); }, get confirmLabel() { return globalThis.PlatformI18n.t("core:propose_1cbd9e71"); }, danger: true })) return;
    Secrets.setStatus(globalThis.PlatformI18n.t("core:opening_proposal_for_value1_763366b9", { value1: key }), 'info');
    try {
      const res = await fetch(`/api/apps/${Secrets.currentSlug}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'secret_change',
          payload: { key, action: 'delete' },
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `HTTP ${res.status}`);
      }
      Secrets.setStatus(globalThis.PlatformI18n.t("core:proposal_opened_vote_in_the_group_chat_tab_20b2e510"), 'ok');
    } catch (err) {
      Secrets.setStatus(globalThis.PlatformI18n.t("core:failed_value1_c9a5148f", { value1: err.message }), 'err');
    }
  },

  setStatus(msg, level) {
    const el = document.getElementById('app-secrets-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.classList.remove('text-zinc-500', 'dark:text-zinc-400', 'text-emerald-700', 'dark:text-emerald-400', 'text-red-700', 'dark:text-red-400');
    if (level === 'ok') el.classList.add('text-emerald-700', 'dark:text-emerald-400');
    else if (level === 'err') el.classList.add('text-red-700', 'dark:text-red-400');
    else el.classList.add('text-zinc-500', 'dark:text-zinc-400');
  },
};

// ── Moved into the React bundle by #1078 chunk I ──────────────────
//
// This file was public/js/app-secrets.js, a classic <script> tag at the end
// of <body>. It is a MOVE, not a rewrite: everything above this line is the
// module as it shipped, byte for byte. Only the bootstrap changed, and only
// in the two ways AGENTS.md prescribes for a module that joins the bundle.
//
//   1. The `window.Secrets` publication STAYS. app-view.js still calls
//      `Secrets.open(slug)`, `Secrets.hide()`, `Secrets.openForCurrentApp()`
//      and `Secrets.applyMissingBadge(...)` from five places, all behind
//      `if (window.Secrets)` guards, and those callers are untouched. The
//      guard below is `typeof window !== 'undefined'` because the SSG
//      prerender pass (frontend/scripts/build-shell.mjs) evaluates this
//      module's whole graph in Node, where there is no window to publish onto.
//   2. The `DOMContentLoaded` bootstrap is GONE, replaced by the exported
//      `init` below, which AppSecretsDialog calls from its layout effect.
//      That runs EARLIER than the listener did — hydration is flushSync'd in
//      main.tsx and finishes before DOMContentLoaded — so every legacy caller
//      still finds an initialized module, with more margin than before.
//
// The dialog's open/close lifecycle is NOT in here anymore: `Secrets.open`
// and `Secrets.hide` route through the island's controller, so React owns the
// `hidden` toggle and the kit lift. See app-secrets.tsx.

if (typeof window !== 'undefined') window.Secrets = Secrets;

/** Called once from AppSecretsDialog's layout effect (was DOMContentLoaded). */
export function init() {
  Secrets.init();
}

export { Secrets };
