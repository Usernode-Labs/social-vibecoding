// #30 — Settings (BYOK: bring your own Anthropic API key) — and, since the
// settings-modal-to-screen conversion, the whole #settings SCREEN.
//
// The Settings row in the header drawer is a real anchor to #settings;
// App.restoreFromHash → App.navigateToSettings mounts #settings-screen and
// hands rendering to this module, the same shape as the Challenges /
// Profile / Admin console screens. Users can paste an `sk-ant-...` key; the
// server verifies it with a cheap 1-token call and only then encrypts
// + stores it. Once saved, a small emerald dot appears on the drawer's
// Settings row so the user can tell at a glance that their key is
// active — and so can any other user viewing over their shoulder
// (no secrets leak, just the indicator).
//
// LAYOUT (mirrors features/admin/admin-console.js — read that file's header for
// the reasoning, this is the same shell with different data):
//
//   desktop (md+)          a grouped sidebar of sections + the active
//                          section beside it, switched in place;
//   level 1 (#settings)    below md, the grouped section menu, one tappable
//                          row per section under the same headings;
//   level 2 (#settings/<k>) that one section, full width, with the platform
//                          header's back button flipped to an arrow and its
//                          title set to the section label.
//
// The hash is the single source of truth for WHICH section shows; the level
// is derived from it (bare #settings on mobile = the menu). A menu tap is a
// REAL hash navigation, so it pushes a history entry and the device /
// WebView back gesture pops back to the menu through exactly the same code
// path as the on-screen arrow (see _openSection / handleBack / route).
//
// MOVE, DON'T REWRITE: the section markup is STATIC in index.html and every
// control is bound by id exactly once in init(). The router only toggles
// `hidden` on the [data-settings-section] WRAPPERS — it never rebuilds a
// section, because that would silently detach every listener. Each
// section's own `hidden` (the wallet / usernode / admin-preview capability
// gates) keeps living on the INNER node, which is also how _visibleSections
// derives menu membership without duplicating those gates.
(function () {
  'use strict';

  // ── Status lines ──────────────────────────────────────────────────────
  //
  // Seven sections report the result of the user's last action in a status
  // line, and all seven paint it identically: reveal the node, write the
  // text, swap in one of three colour pairs. This is that paint, and the
  // palette below is the only place those classes are named.
  //
  // The pairs are TOKEN ARRAYS and they are SPREAD into classList, because a
  // DOMTokenList token may not contain whitespace: `classList.add('a b')`
  // throws InvalidCharacterError. Each of these was a SINGLE class when it
  // was written (#1380); #1400's widget-library migration rewrote all seven
  // into `dark:` pairs and left the single-argument `add(cls)` in place, so
  // every status write in this file threw. It read as cosmetic because the
  // text is written FIRST and still landed — what actually broke was the
  // code AFTER the call. changeUsername() is the case that was reported: it
  // painted "Saving…", threw before its fetch was ever issued, and left the
  // button disabled under a message that could never resolve. Keep these
  // arrays, and add a colour by adding a pair here rather than a string at a
  // call site. _wireConnectorNameSpelling's link-status write already spread
  // its pair, which is why that one line kept working.
  const STATUS_PALETTE = {
    error: ['text-red-700', 'dark:text-red-400'],
    ok: ['text-emerald-700', 'dark:text-emerald-400'],
    info: ['text-zinc-500', 'dark:text-zinc-400'],
  };
  const STATUS_PALETTE_CLASSES = [
    'hidden',
    ...STATUS_PALETTE.error, ...STATUS_PALETTE.ok, ...STATUS_PALETTE.info,
  ];

  /** Reveal `el`, write `text`, colour it for `kind` (anything else: info). */
  function paintStatus(el, text, kind) {
    el.textContent = text;
    el.classList.remove(...STATUS_PALETTE_CLASSES);
    el.classList.add(...(STATUS_PALETTE[kind] || STATUS_PALETTE.info));
  }

  // #2119: an OpenRouter key's allowance is named from the reset cadence the
  // server reports for it ('weekly' for company keys carrying the platform
  // allowance, 'daily' for older ones until they are re-limited, whatever
  // OpenRouter says for a personal key, which may be nothing), never from a
  // hard-coded word, so the copy stays truthful for every key it describes.
  function limitNoun(reset, noun = 'limit') {
    const cadence = typeof reset === 'string' ? reset.trim().toLowerCase() : '';
    return cadence ? `${cadence} ${noun}` : noun;
  }

  // ── Post-logout landing (#1524) ───────────────────────────────────────
  //
  // Signing out always ends on the PUBLIC LANDING page, on every surface.
  // `/` with no fragment is the only address that boots the anonymous shell
  // there: App.restoreFromHash treats any other hash (or any `/app/<slug>`
  // path) as a remembered deep link and answers with the bare sign-in form.
  // A bare '/' rather than App._rootUrl() so a leftover `?shot=` / `?signup=`
  // query cannot survive the sign-out either.
  const LANDING_URL = '/';

  // A native sign-out whose terminal step fails leaves this document alive
  // with server authority already revoked, so it navigates to the landing
  // page like every other surface. The advisory that used to be toasted here
  // would be destroyed by that navigation, so it is handed to the anonymous
  // boot instead: App.enterAnonymous reads this key once and toasts it.
  const LOGOUT_NOTICE_KEY = 'sv:logout_notice';
  const NATIVE_SHUTDOWN_NOTICE =
    globalThis.PlatformI18n.t("settings:signed_out_close_and_reopen_the_app_to_finish_sh_31055a5a");

  // A successful native logout replaces the WebView, so nothing below it in
  // this document normally runs. This bounded net covers the case where the
  // replacement does not arrive: rather than leave a signed-out user looking
  // at the Settings screen forever, land them on the landing page.
  const NATIVE_LOGOUT_SAFETY_MS = 5000;

  // How long the sign-out POST may take before it is abandoned. Two budgets,
  // because the two paths fail differently (#2078):
  //
  //   - A capable phone (protocol 2 + `offlineLogout`) has native deleting the
  //     cookie and the durable credential locally, so remote revocation is
  //     best effort. Giving up after two seconds still ends in a real
  //     sign-out, and waiting longer only holds a person on a screen whose
  //     work is already done.
  //   - The ordinary WEB path has no such guarantee: only the server can
  //     revoke a web session, so abandoning the request means the sign-out did
  //     NOT happen and the user is told so. The budget is therefore generous —
  //     far longer than any working round trip, including a slow phone
  //     network — and exists only to stop a request that will never settle
  //     from holding the disabled button forever.
  const OFFLINE_LOGOUT_TIMEOUT_MS = 2000;
  const WEB_LOGOUT_TIMEOUT_MS = 15000;

  const Settings = {
    // Planted by ./mount.ts, never imported: this file is a classic IIFE that
    // tests/settings-mobile-push.test.js evaluates with vm.runInContext, where
    // an import statement is a syntax error. `_store` is ./settings-nav-store.js
    // (the two nav hosts' descriptors) and `_footerHome` is the placeholder
    // seam #settings-footer leaves behind when _syncFooter moves it. Both stay
    // null in the vm harnesses and during the SSG prerender pass, and every
    // use below goes through `?.` for exactly that reason.
    _store: null,
    _footerHome: null,
    // `devFlowPreference` is the "remember my option" answer from the
    // dev-chat flow picker (#1049): null = ask every time (the default),
    // otherwise 'platform' | 'claude-code' | 'codex'. `externalFlowsAvailable`
    // says whether this deployment can offer the Claude Code / Codex
    // hand-off at all — the server decides, we only render what it reports.
    state: { hasApiKey: false, demoKey: false, keyLast4: null, usernodePubkey: null, walletLinkEnabled: false, aiProgressEstimate: false, sessionBridgeEnabled: false, homeroomBotDm: false, homeroomBotForEveryone: false, locale: null, devFlowPreference: null, externalFlowsAvailable: false },
    _walletPollTimer: null,
    _alertsTestTimer: null,
    _walletExpiresAt: null,
    _walletCountdownTimer: null,
    _cliTokens: [],
    _cliTokenCursor: null,
    _cliTokensLoading: false,
    _cliTokenLoadId: 0,
    // #907: machines currently attached to one of this account's sessions.
    _localAgents: [],
    _connectors: [],
    _connectorLoadId: 0,
    _githubLink: null,
    _openRouterModels: [],
    _openRouterSelectedModelId: '',
    _openRouterRecommendedModelId: '',
    _openRouterCatalogRefreshedAt: null,
    _openRouterCatalogTotal: 0,
    _openRouterFavoritesOnly: false,
    _mobilePushPreferences: null,
    _mobilePushLoading: false,
    _mobilePushSaving: false,
    _mobilePushLoadToken: 0,

    // ── Screen state ─────────────────────────────────────────────────────
    _open: false,
    // Which PAGE is showing (or would show on a viewport crossing) — a page
    // key, never a part key (see SECTIONS). It doubles as "last visited in
    // this tab": open() keeps it when it is still a visible page, so
    // returning to Settings lands where you left off.
    //
    // THAT IS WHY THE INITIAL VALUE MATTERS. It was 'api-key', hard-coded
    // here before DEFAULT_SECTION existed, and a bare #settings on a fresh
    // tab therefore resolved to it whatever the registry said — so THE UI
    // OVERHAUL putting Theme first had no effect at all until this moved too.
    // Kept as a literal because DEFAULT_SECTION is declared further down this
    // same object literal; the two are pinned together by
    // tests/settings-screen.test.js.
    _section: 'account',
    // The PART a deep link named, when it is not the first part of its page
    // (#settings/password opens Account and scrolls to Password). Null when
    // the page itself was asked for. Spent by _scrollToAnchor().
    _anchor: null,
    // Counts open() calls, so the nav's filter box can start each visit
    // empty instead of greeting a returning viewer with last week's query.
    _visit: 0,
    // Which level the phone layout is showing: 1 = the section menu,
    // 2 = one section. Kept in sync on desktop too (it is ignored there)
    // so a viewport crossing resolves without guessing.
    _level: 1,
    // True while the level-2 entry we're sitting on was PUSHED by a menu
    // tap during this mount — the only case where history.back() is
    // guaranteed to land on our own menu entry. A deep link (bookmark, a
    // prose "Settings → Change password" link) leaves it false, and back
    // replaces the entry instead of creating a forward one. Per-mount
    // state: open() resets it.
    _pushedFromMenu: false,
    // #settings-screen scrollTop saved on drill-in, restored on the way back.
    _menuScrollTop: 0,
    // A deep-linked section that is registered but not offered YET (#2893):
    // its gate resolves after the route did — the Homeroom app one waits on
    // the native bridge. _renderNavIfOpen spends it once the gate opens,
    // provided the address still names it. open() and close() drop it.
    _pendingSection: null,
    _mediaBound: false,
    _socialPushStateListener: null,
    // True between an open({ chrome: false }) and the syncChrome() that
    // app.js runs inside the screen transition (#979) — _syncChrome is a
    // no-op while it is set, so nothing writes the platform header before
    // the outgoing page has been captured.
    _chromeSuspended: false,

    // The single source of truth in JS for where the sidebar layout starts.
    // Must stay in step with the `md:` classes in index.html's
    // #settings-screen markup (Tailwind's md breakpoint IS 768px) — same
    // discipline as AdminConsole.DESKTOP_MEDIA.
    DESKTOP_MEDIA: '(min-width: 768px)',

    // ── Parts and pages ───────────────────────────────────────────────────
    //
    // Each entry below is a PART: one [data-settings-section] wrapper in
    // ./sections, and the #settings/<key> address that has always reached it.
    // Parts that share a `page` are shown together as ONE row of the nav and
    // one screen of content; a part without `page` is a page of its own,
    // keyed by its own key. Page labels live in PAGES; a one-part page uses
    // its part's label.
    //
    // The settings restructure folded twenty-three rows (seven of them behind
    // a collapsed "Advanced" group, #1554) into a dozen pages a viewer can
    // read without opening anything. Every old address still works: a part
    // key resolves to its page and scrolls to that part (_resolve,
    // _scrollToAnchor), so the out-of-credits card's #settings/cli, the
    // profile editor's #settings/username and every server-written link keep
    // landing on the thing they named.
    //
    // Order here IS menu order and DOM order (./sections/index.tsx renders
    // the wrappers in this sequence, so a page's parts stack the way they are
    // listed). The parts of one page must be contiguous. The group of a page
    // is its first part's group, and the first VISIBLE page is the default.
    //
    // `gate` names the INNER node whose own `hidden` decides whether the part
    // is offered at all — Homeroom Wallet (wallet linking enabled), Language
    // (a saved locale), Homeroom app (the native bridge) and Admin preview (a
    // real platform admin). Those gates live in their _render* methods and
    // are read here, never duplicated. A page is offered while any of its
    // parts is. A gated part that is a page of its own hides exactly one row;
    // one that shares a page (Admin preview, on Appearance) hides only its
    // own block, and its address opens that page either way.
    SECTIONS: [
      // ── Account ─────────────────────────────────────────────────────────
      // Who you are and how you sign in, on one page, with Delete account at
      // its foot, apart from everything harmless above it (GitHub's and
      // Apple's placement: easy to find, never next to a routine control).
      { key: 'profile', get label() { return globalThis.PlatformI18n.t("settings:profile_d696a35b"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, page: 'account' },
      { key: 'username', get label() { return globalThis.PlatformI18n.t("settings:username_e3b89e9d"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, page: 'account' },
      { key: 'email', get label() { return globalThis.PlatformI18n.t("settings:email_recovery_4ee4c511"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, page: 'account' },
      { key: 'password', get label() { return globalThis.PlatformI18n.t("settings:password_e7cf3ef4"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, page: 'account' },
      { key: 'delete-account', get label() { return globalThis.PlatformI18n.t("settings:delete_account_a2e20a33"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, page: 'account' },
      // GitHub and X, which decide the daily credits and can be shown on the
      // public page. They shared a pane with the chat connectors, which have
      // nothing to do with identity.
      { key: 'linked-accounts', get label() { return globalThis.PlatformI18n.t("settings:linked_accounts_feda46a4"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); } },
      { key: 'wallet', get label() { return globalThis.PlatformI18n.t("settings:homeroom_wallet_6e5f658a"); }, get group() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); }, gate: 'wallet-section' },

      // ── AI & building ───────────────────────────────────────────────────
      // The allowance leads: it is the figure most builders open Settings to
      // find. OpenRouter follows it — the included key and the default
      // session model — and the Anthropic key, the one you add when the
      // allowance runs out, comes last.
      { key: 'usage', get label() { return globalThis.PlatformI18n.t("settings:usage_8d59829c"); }, group: 'AI & building', page: 'ai' },
      { key: 'openrouter', get label() { return globalThis.PlatformI18n.t("settings:openrouter_eb70c3bc"); }, group: 'AI & building', page: 'ai' },
      { key: 'api-key', get label() { return globalThis.PlatformI18n.t("settings:anthropic_api_key_97d1086e"); }, group: 'AI & building', page: 'ai' },
      // Everything about building from outside Homeroom: the chat connectors
      // (Claude, ChatGPT, Codex), the default hand-off they make possible, and
      // the CLI credentials. The out-of-credits card deep-links
      // #settings/connectors and #settings/cli; both land on this page
      // (public/js/credit-options.js). Connectors leads because the page is
      // keyed by it: a page key that named a LATER part would open the page
      // scrolled past everything above that part.
      { key: 'connectors', get label() { return globalThis.PlatformI18n.t("settings:connectors_c3d2e79e"); }, group: 'AI & building', page: 'connectors' },
      { key: 'build-venue', get label() { return globalThis.PlatformI18n.t("settings:where_changes_get_built_1664c33e"); }, group: 'AI & building', page: 'connectors' },
      { key: 'cli', get label() { return globalThis.PlatformI18n.t("settings:cli_coding_agent_access_f5b96ef5"); }, group: 'AI & building', page: 'connectors' },
      { key: 'agent-files', get label() { return globalThis.PlatformI18n.t("settings:agent_instructions_skills_7c5c7975"); }, group: 'AI & building' },
      { key: 'global-chat', get label() { return globalThis.PlatformI18n.t("settings:global_chat_experimental_1dfd6900"); }, group: 'AI & building' },
      { key: 'experimental', get label() { return globalThis.PlatformI18n.t("settings:experimental_3dc9f569"); }, group: 'AI & building' },

      // ── Preferences ─────────────────────────────────────────────────────
      // THE UI OVERHAUL moved Theme here out of the hamburger drawer. The
      // developer console's switch and the admin preview are the same kind of
      // setting — what the shell shows on this device — so they share its
      // page. Admin preview is gated to real admins; for everyone else its
      // wrapper is empty and the page is Theme and the console switch. It had
      // a group of its own, which put an "Admin" heading directly above the
      // footer's own Admin block.
      { key: 'theme', get label() { return globalThis.PlatformI18n.t("settings:theme_efb52e71"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'theme' },
      { key: 'dev-console', get label() { return globalThis.PlatformI18n.t("settings:developer_console_2ef15ac2"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'theme' },
      { key: 'admin-preview', get label() { return globalThis.PlatformI18n.t("settings:admin_preview_a702a4e3"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'theme', gate: 'settings-admin-section' },
      { key: 'language', get label() { return globalThis.PlatformI18n.t("settings:language_a4fe6526"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); } },
      { key: 'alerts', get label() { return globalThis.PlatformI18n.t("settings:notifications_78801183"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); } },
      // What each app may do: the device access and AI spending you granted,
      // and the apps you blocked. They were split between Preferences and the
      // collapsed Advanced group, which hid two privacy controls from the
      // people they protect.
      { key: 'app-permissions', get label() { return globalThis.PlatformI18n.t("settings:app_device_permissions_bad62fc7"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'app-permissions' },
      { key: 'app-ai', get label() { return globalThis.PlatformI18n.t("settings:app_ai_permissions_8be55dd9"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'app-permissions' },
      { key: 'blocked-apps', get label() { return globalThis.PlatformI18n.t("settings:blocked_apps_adfc2938"); }, get group() { return globalThis.PlatformI18n.t("settings:preferences_66962f72"); }, page: 'app-permissions' },

      // ── Help & about ────────────────────────────────────────────────────
      // Panes you come to read or replay rather than configure. The welcome
      // tour's own Skip promises its row exists (#2255). About is last among
      // them — the Improve panel is where the same facts turn into something
      // to act on (a build in flight, a reload waiting). See sections/about.tsx.
      { key: 'tour', get label() { return globalThis.PlatformI18n.t("settings:welcome_tour_5155b987"); }, group: 'Help & about' },
      { key: 'usernode', get label() { return globalThis.PlatformI18n.t("settings:homeroom_app_92077421"); }, group: 'Help & about', gate: 'settings-usernode-section' },
      { key: 'about', get label() { return globalThis.PlatformI18n.t("settings:about_4efca0d1"); }, group: 'Help & about' },
    ],

    // The label of each page that holds more than one part. A page of one
    // part is labelled by that part; the label here is also the title the
    // phone's header shows inside the page.
    PAGES: {
      get account() { return globalThis.PlatformI18n.t("settings:account_7e1b0d56"); },
      get ai() { return globalThis.PlatformI18n.t("settings:ai_usage_models_429f837f"); },
      connectors: 'Connectors & CLI',
      get theme() { return globalThis.PlatformI18n.t("settings:appearance_3907fa7f"); },
      get 'app-permissions'() { return globalThis.PlatformI18n.t("settings:app_permissions_7e07c5e7"); },
    },

    // Extra words the nav's filter box matches for each part, beyond its own
    // label and its page's. Lower case, space separated: the words people
    // type for a thing, not the words the pane uses for it.
    KEYWORDS: {
      profile: 'name display photo avatar picture bio public page',
      get username() { return globalThis.PlatformI18n.t("settings:handle_rename_at_946d3398"); },
      get email() { return globalThis.PlatformI18n.t("settings:address_verify_verification_recovery_a5502b4d"); },
      get password() { return globalThis.PlatformI18n.t("settings:sign_in_login_security_40de7fa2"); },
      get 'delete-account'() { return globalThis.PlatformI18n.t("settings:close_remove_deactivate_anonymise_anonymize_cb07cd2e"); },
      get 'linked-accounts'() { return globalThis.PlatformI18n.t("settings:github_x_twitter_social_verified_daily_credits_c_258ff933"); },
      get wallet() { return globalThis.PlatformI18n.t("settings:crypto_link_qr_4c692491"); },
      get usage() { return globalThis.PlatformI18n.t("settings:allowance_limit_credits_budget_spend_remaining_w_0adb04f2"); },
      'api-key': 'claude byok key sk-ant billing',
      get openrouter() { return globalThis.PlatformI18n.t("settings:model_glm_deepseek_reasoning_default_coding_agen_0f8e1093"); },
      'build-venue': 'claude code codex hand off handoff default build',
      connectors: 'mcp claude chatgpt codex chat connector',
      cli: 'terminal token credentials revoke local agent opencode claude code',
      'agent-files': 'instructions skills agents md claude md prompt files',
      get 'global-chat'() { return globalThis.PlatformI18n.t("settings:model_cap_chat_e2314f06"); },
      get experimental() { return globalThis.PlatformI18n.t("settings:beta_labs_progress_estimate_session_bridge_local_219943a6"); },
      get theme() { return globalThis.PlatformI18n.t("settings:dark_light_mode_appearance_sidebar_f7de49fc"); },
      get 'dev-console'() { return globalThis.PlatformI18n.t("settings:bug_icon_logs_errors_debug_developer_ba4aca35"); },
      get language() { return globalThis.PlatformI18n.t("settings:locale_translate_fc923f36"); },
      get alerts() { return globalThis.PlatformI18n.t("settings:notifications_sound_push_phone_mute_bell_chime_0df389bd"); },
      get 'app-permissions'() { return globalThis.PlatformI18n.t("settings:camera_microphone_location_screen_device_3b79e8e8"); },
      get 'app-ai'() { return globalThis.PlatformI18n.t("settings:ai_spending_cap_grants_budget_857b9506"); },
      get 'blocked-apps'() { return globalThis.PlatformI18n.t("settings:block_hide_unblock_4ee95163"); },
      get tour() { return globalThis.PlatformI18n.t("settings:walkthrough_help_onboarding_0a330344"); },
      get usernode() { return globalThis.PlatformI18n.t("settings:mobile_phone_native_diagnostics_block_production_b303cf2b"); },
      get about() { return globalThis.PlatformI18n.t("settings:version_build_terms_d83db505"); },
      'admin-preview': 'non-admin view as',
    },

    DEFAULT_SECTION: 'account',

    init() {
      // The entry point is the drawer's Settings row, a real anchor to
      // #settings — restoreFromHash → App.navigateToSettings → open().
      // Every control below is bound ONCE, here, by id: the section markup
      // is static in index.html and only ever hidden/shown, never rebuilt
      // (see the "MOVE, DON'T REWRITE" note on #settings-screen).

      // The Homeroom app → connection panel offers wallet recovery only while
      // native admission is refused for want of a seeded wallet
      // (_walletRecoveryAvailable). Admission flipping either way — the
      // recovery dialog succeeding, a sign-out — must repaint that panel
      // without a navigation, and this event is how NativeChrome says so.
      window.addEventListener('usernode:native-session-admission',
        () => this._publishUsernode());
      document.getElementById('settings-save').addEventListener('click', () => this.save());
      document.getElementById('settings-remove').addEventListener('click', () => this.remove());

      // The static shell is still under the markup-parity migration guard,
      // so provider copy is normalized at runtime while this hidden section
      // mounts. Users should only see the provider they configured; the
      // worker implementation behind OpenRouter is not a product choice.
      this._normalizeOpenRouterCopy();

      // OpenRouter & Codex (BYOK). Section bindings — all guarded on
      // existence so the section degrades cleanly if the feature flag is
      // off server-side (the section markup stays, the controls no-op).
      const orSave = document.getElementById('settings-openrouter-save');
      const orRemove = document.getElementById('settings-openrouter-remove');
      const orSetDefault = document.getElementById('settings-openrouter-set-default');
      const orModel = document.getElementById('settings-openrouter-model');
      const orModelSearch = document.getElementById('settings-openrouter-model-search');
      const orFavoritesOnly = document.getElementById('settings-openrouter-favorites-only');
      const orRefreshModels = document.getElementById('settings-openrouter-refresh-models');
      const orStarModel = document.getElementById('settings-openrouter-star-model');
      const claudeSetDefault = document.getElementById('settings-claude-set-default');
      if (orSave) orSave.addEventListener('click', () => this._saveOpenRouterKey());
      if (orRemove) orRemove.addEventListener('click', () => this._removeOpenRouterKey());
      if (orSetDefault) orSetDefault.addEventListener('click', () => this._saveOpenRouterDefault());
      if (orModel) orModel.addEventListener('change', () => {
        this._openRouterSelectedModelId = orModel.value;
        this._syncOpenRouterModelDetails();
      });
      if (orModelSearch) orModelSearch.addEventListener('input', () => this._renderOpenRouterModelOptions());
      if (orFavoritesOnly) orFavoritesOnly.addEventListener('click', () => {
        this._openRouterFavoritesOnly = !this._openRouterFavoritesOnly;
        this._renderOpenRouterModelOptions();
      });
      if (orRefreshModels) orRefreshModels.addEventListener('click', () => this._refreshOpenRouterModelsNow());
      if (orStarModel) orStarModel.addEventListener('click', () => this._toggleSelectedOpenRouterFavorite());
      if (claudeSetDefault) claudeSetDefault.addEventListener('click', () => this._saveClaudeDefault());

      const linkBtn = document.getElementById('wallet-link-btn');
      if (linkBtn) linkBtn.addEventListener('click', () => this._startWalletLink());
      const unlinkBtn = document.getElementById('wallet-unlink-btn');
      if (unlinkBtn) unlinkBtn.addEventListener('click', () => this._unlinkWallet());
      const cancelLink = document.getElementById('wallet-link-cancel');
      if (cancelLink) cancelLink.addEventListener('click', () => this._cancelWalletLink());

      const logoutBtn = document.getElementById('settings-logout');
      if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());
      const cliMore = document.getElementById('cli-tokens-more');
      if (cliMore) cliMore.addEventListener('click', () => this._loadCliTokens(false));

      // Copy the connector URL — the one thing the user has to carry over
      // into Claude.ai / ChatGPT by hand.
      this._wireCopyControl('connector-url-copy', {
        read: () => {
          const field = document.getElementById('connector-url');
          return field ? field.value : null;
        },
        get successMessage() { return globalThis.PlatformI18n.t("settings:mcp_server_url_copied_149289b1"); },
        get failureMessage() { return globalThis.PlatformI18n.t("settings:could_not_copy_the_mcp_server_url_6d0a55e7"); },
        selectOnFail: () => {
          const field = document.getElementById('connector-url');
          if (field) field.select();
        },
      });

      // Copy the read-only allow rules. Two blocks with identical content and
      // different destinations: the user's PERSONAL ~/.claude/settings.json,
      // which covers every repo on their machine, and the per-repo
      // .claude/settings.json, which is the copy a fresh web container can
      // actually see. Byte-identical content is exactly why the toast names
      // the DESTINATION rather than saying "Copied" (#1290) — the label swap
      // alone cannot tell the two buttons apart, and on a phone the thumb is
      // over it anyway.
      const RULE_BLOCKS = {
        'connector-allow-rules': {
          success: 'Copied. Paste it into ~/.claude/settings.json',
          get failure() { return globalThis.PlatformI18n.t("settings:could_not_copy_the_allow_rules_51bb60c2"); },
        },
        'connector-repo-allow-rules': {
          success: 'Copied. Commit it as .claude/settings.json in your app repo',
          get failure() { return globalThis.PlatformI18n.t("settings:could_not_copy_the_allow_rules_51bb60c2"); },
        },
      };
      for (const id of ['connector-allow-rules', 'connector-repo-allow-rules']) {
        this._wireCopyControl(`${id}-copy`, {
          // Read at CLICK time, not wire time: _wireConnectorNameSpelling()
          // rewrites these blocks in place, and the copy has to be whatever
          // the user is actually looking at.
          read: () => {
            const block = document.getElementById(id);
            return block ? block.textContent : null;
          },
          successMessage: RULE_BLOCKS[id].success,
          failureMessage: RULE_BLOCKS[id].failure,
          selectOnFail: () => {
            const block = document.getElementById(id);
            if (!block || !window.getSelection || !document.createRange) return;
            const range = document.createRange();
            range.selectNodeContents(block);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          },
        });
      }

      // #1892: the two Codex CLI blocks. Read at click time for the same
      // reason as above: _renderConnectors() swaps the URL placeholder for
      // the live connector URL after this wiring runs.
      const CODEX_BLOCKS = {
        'connector-codex-add': {
          success: 'Copied. Run it in a terminal where Codex is installed',
          failure: 'Could not copy the Codex command',
        },
        'connector-codex-config': {
          success: 'Copied. Paste it into ~/.codex/config.toml',
          failure: 'Could not copy the Codex config entry',
        },
      };
      for (const id of Object.keys(CODEX_BLOCKS)) {
        this._wireCopyControl(`${id}-copy`, {
          read: () => {
            const block = document.getElementById(id);
            return block ? block.textContent : null;
          },
          successMessage: CODEX_BLOCKS[id].success,
          failureMessage: CODEX_BLOCKS[id].failure,
          selectOnFail: () => {
            const block = document.getElementById(id);
            if (!block || !window.getSelection || !document.createRange) return;
            const range = document.createRange();
            range.selectNodeContents(block);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          },
        });
      }

      this._wireConnectorNameSpelling();

      // Change password (issue #282) → POST /api/me/password.
      const cuSave = document.getElementById('cu-save');
      if (cuSave) cuSave.addEventListener('click', () => this.changeUsername());
      // Enter in either field submits, like the password form's fields do
      // not — this one is two fields and a button, and a rename typed on a
      // phone should not require reaching for the button.
      ['cu-new', 'cu-password'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.changeUsername(); }
          });
        }
      });
      const cpSave = document.getElementById('cp-save');
      if (cpSave) cpSave.addEventListener('click', () => this.changePassword());

      // Wallet-signed change-password → POST /api/me/wallet-change-password.
      // Only reachable when the wallet-mode link is shown (native + linked).
      const cpWalletSave = document.getElementById('cp-wallet-save');
      if (cpWalletSave) cpWalletSave.addEventListener('click', () => this.changePasswordWithWallet());
      const useWallet = document.getElementById('cp-use-wallet');
      if (useWallet) useWallet.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('wallet'); });
      const usePassword = document.getElementById('cp-use-password');
      if (usePassword) usePassword.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('password'); });

      // Dev console "always show" toggle. State lives in DevConsole +
      // localStorage; we just mirror it here. Wire change immediately
      // so the icon appears/disappears without needing to close the
      // modal.
      const devConsoleToggle = document.getElementById('dev-console-always-show');
      if (devConsoleToggle) {
        devConsoleToggle.addEventListener('change', (e) => {
          if (!window.DevConsole) return;
          DevConsole.setMode(e.target.checked
            ? DevConsole.MODE_ALWAYS
            : DevConsole.MODE_ERRORS_ONLY);
        });
      }

      // Experimental "AI progress estimate" toggle. Server-side per-user
      // flag (default OFF) — fire the POST on change so it takes effect
      // on the next coding run without closing the modal; revert the
      // checkbox if the save fails.
      const estimateToggle = document.getElementById('ai-progress-estimate');
      if (estimateToggle) {
        estimateToggle.addEventListener('change', (e) => this._saveAiProgressEstimate(e.target.checked));
      }

      // #1281: the session-bridge opt-in, same shape as the toggle above —
      // POST on change so the venue appears (or stops appearing) on the next
      // paint of any picker, without closing the modal.
      const bridgeToggle = document.getElementById('session-bridge-enabled');
      if (bridgeToggle) {
        bridgeToggle.addEventListener('change', (e) => this._saveSessionBridge(e.target.checked));
      }

      // #3624: join (or leave) the Homeroom bot's DM. Same shape again; the
      // server may refuse a join when the bot's list is full, and the
      // checkbox goes back to what is stored.
      const botDmToggle = document.getElementById('homeroom-bot-dm-enabled');
      if (botDmToggle) {
        botDmToggle.addEventListener('change', (e) => this._saveHomeroomBotDm(e.target.checked));
      }

      // Platform-level language preference (issue #757). Server-side
      // per-user BCP-47 tag (default unset = "Auto"); apps read it via
      // the iframe JWT claim and usernode.getUserLocale(). Fires the
      // POST on change so it takes effect without closing the modal;
      // revert the select if the save fails.
      const localeSelect = document.getElementById('settings-locale');
      if (localeSelect) {
        localeSelect.addEventListener('change', (e) => this._saveLocale(e.target.value));
      }

      // #138 "Dev-chat sound & alerts" toggle. Client-only preference
      // (localStorage, default ON) owned by DevAlerts — we just mirror its
      // checked state and flip the stored flag. Turning it ON is a user
      // gesture, so unlock audio + request notification permission then.
      const alertsToggle = document.getElementById('devchat-alerts-toggle');
      if (alertsToggle) {
        alertsToggle.checked = window.DevAlerts ? DevAlerts.enabled() : true;
        alertsToggle.addEventListener('change', (e) => {
          if (!window.DevAlerts) return;
          DevAlerts.setEnabled(e.target.checked);
          if (e.target.checked) {
            DevAlerts._unlockAudio();
            DevAlerts.requestNotifyPermission();
          }
        });
      }

      // The server owns delayed push delivery; this countdown only explains
      // when the optional live-page chime will run.
      const alertsTest = document.getElementById('devchat-alerts-test');
      if (alertsTest) {
        alertsTest.addEventListener('click', async () => {
          if (!window.DevAlerts || alertsTest.disabled) return;
          const status = document.getElementById('devchat-alerts-test-status');
          this._clearAlertsTestCountdown();
          alertsTest.disabled = true;
          if (status) {
            status.classList.remove('hidden');
            status.textContent = globalThis.PlatformI18n.t("settings:queueing_test_alert_682578be");
          }
          try {
            const result = await DevAlerts.testAlert();
            if (!status) return;
            const pushStatus = result.queued
              ? globalThis.PlatformI18n.t("settings:phone_push_queued_background_or_close_the_mobile_1a41bc7e")
              : result.reason === 'preference_disabled'
                ? globalThis.PlatformI18n.t("settings:phone_push_was_not_queued_enable_agent_sessions__a84eea9d")
                : globalThis.PlatformI18n.t("settings:phone_push_was_not_queued_sign_in_on_your_phone__08615bef");
            let remaining = Math.ceil(result.delayMs / 1000);
            const render = () => {
              status.textContent = globalThis.PlatformI18n.t("settings:alert_in_value1_s_value2_stay_here_for_the_chime_4d1f636f", { value1: remaining, value2: pushStatus });
            };
            render();
            this._alertsTestTimer = setInterval(() => {
              remaining -= 1;
              if (remaining > 0) {
                render();
                return;
              }
              this._clearAlertsTestCountdown();
              status.textContent = result.queued
                ? globalThis.PlatformI18n.t("settings:the_test_push_is_queued_for_delivery_check_your__ce2787f1")
                : pushStatus;
            }, 1000);
          } catch (err) {
            if (status) status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_queue_the_test_push_please_try_again_237ab0ed");
          } finally {
            alertsTest.disabled = false;
          }
        });
      }

      // Account-level remote-push categories. These are deliberately
      // separate from the native bridge's per-device Activity notifications
      // switch: every signed-in browser can edit them, while a phone still
      // has to be registered and enabled before any category can deliver.
      document.querySelectorAll(
        '#settings-mobile-push-preferences [data-mobile-push-category]'
      ).forEach((row) => {
        const input = row.querySelector('input[type="checkbox"]');
        const category = row.dataset.mobilePushCategory;
        if (!input || !category) return;
        input.addEventListener('change', () => {
          this._saveMobilePushPreference(category, input.checked);
        });
      });

      // "View as non-admin" admin tool. Mirror state to localStorage
      // and reload — the simplest way to flush every admin-gated
      // render path (home buttons, app-secrets editor, etc.) without
      // having to re-derive each one. See app.js for where the flag
      // is read and applied to App.user.isAdmin.
      const viewAsToggle = document.getElementById('view-as-non-admin');
      if (viewAsToggle) {
        viewAsToggle.addEventListener('change', (e) => {
          if (e.target.checked) {
            localStorage.setItem('viewAsNonAdmin', '1');
          } else {
            localStorage.removeItem('viewAsNonAdmin');
          }
          window.location.reload();
        });
      }
      // The persistent header banner has its own "Switch back" link for
      // admins who notice they're in preview mode mid-session. That banner
      // is a React island now (#1078) and owns its own click handler —
      // binding it from here too would run the reload path twice.

      // No backdrop / Escape dismissal any more: Settings is a screen, not
      // a modal. Leaving it is a real hash navigation (the header back
      // button, the device back gesture) — see handleBack / _exitSettings.

      this.refresh();
    },

    // #1055: the page's ?demo=1 rides along on the /api/auth/me read, so a
    // staging reviewer sees the key-on-file branch of the composer meter and
    // the session-options menu without pasting a real key into a preview.
    // Honoured only in staging (routes/auth.js), so it is safe to send
    // always — same pass-through as _cliTokensDemo below.
    async refresh() {
      try {
        const meDemoQ = this._cliTokensDemo() ? '?demo=1' : '';
        const j = await this._readMe(meDemoQ);
        if (!j) return;
        this.state.hasApiKey = !!j.user?.hasApiKey;
        // Staging only, and only under ?demo=1: the key reported above is a
        // fixture, not something anything can be billed to. Carried so the
        // surfaces that branch on "a key is on file" can tell the two apart
        // (DevChat._creditsExhausted is the one that has to).
        this.state.demoKey = !!j.user?.demoKey;
        this.state.keyLast4 = j.user?.keyLast4 || null;
        this.state.usernodePubkey = j.user?.usernodePubkey || null;
        this.state.walletLinkEnabled = !!j.user?.walletLinkEnabled;
        this.state.aiProgressEstimate = !!j.user?.aiProgressEstimate;
        this.state.sessionBridgeEnabled = !!j.user?.sessionBridgeEnabled;
        this.state.homeroomBotDm = !!j.user?.homeroomBotDm;
        this.state.homeroomBotForEveryone = !!j.user?.homeroomBotForEveryone;
        this.state.locale = j.user?.locale || null;
        this.state.devFlowPreference = j.user?.devFlowPreference || null;
        this.state.externalFlowsAvailable = !!j.user?.externalFlowsAvailable;
        // Same payload the CLI-credentials gate needs, so prime its memo
        // rather than let it issue a second /api/auth/me. (It still
        // fetches on its own when it runs first — the two orders both
        // resolve to the same deployment-constant answer.)
        this._cliAuthPromise = Promise.resolve(j.user?.cliAuthEnabled !== false);
        this._renderIndicator();
        // `walletLinkEnabled` decides whether the Homeroom Wallet row is in
        // the menu at all, and it lands here — possibly AFTER a cold-boot
        // deep link has already painted. Re-resolve the menu.
        this._renderWalletSection();
        // The preference lands here too, and its page may already be
        // painted (a cold-boot deep link to #settings/build-venue renders
        // before this resolves). Same reasoning as the wallet row above.
        this._renderDevFlowSection();
        // #1556: `locale` decides whether the Language row is in the menu at
        // all, and it lands here too — a cold-boot deep link paints before
        // this resolves. Same reasoning as the two rows above.
        this._renderLanguageSection();
        this._renderNavIfOpen();
      } catch {}
    },

    /**
     * The /api/auth/me payload, JOINING the boot read rather than repeating
     * it. Returns the parsed body, or null when there is no usable answer.
     *
     * This runs from init(), which a React layout effect fires at document
     * load on EVERY screen — the byok dot rides the Profile screen and
     * DevChat's budget indicator, so the state is genuinely needed before
     * #settings is ever opened. It just does not need its own request:
     * every field read above is on the same `user` object App.init is
     * fetching 16ms later, and the two were queueing behind each other for
     * ~130ms on the first paint of every screen. See App.bootSession.
     *
     * `?demo=1` still reads for itself, and must: staging answers that
     * request differently (the fixture key behind `demoKey`), so the boot's
     * plain answer is the wrong one — not a stale copy of the right one.
     */
    async _readMe(meDemoQ) {
      if (!meDemoQ && typeof window.App?.bootSession === 'function') {
        const boot = await window.App.bootSession();
        if (boot?.user) return { user: boot.user };
        // Answered 401/403. A second ask gets the same answer.
        if (boot?.signedOut) return null;
        // `unknown` — the boot read never landed and the shell is on the
        // snapshot, which carries none of these fields. Read for ourselves;
        // offline the worker answers it from cache, as it always has.
      }
      const r = await fetch(`/api/auth/me${meDemoQ}`, { credentials: 'same-origin' });
      if (!r.ok) return null;
      return await r.json();
    },

    _renderIndicator() {
      // Published rather than written by id: the dot rides the Profile
      // screen's account group, which React renders only once profile data
      // lands. See App.renderAdminButton for the same move and why.
      window.App?.Visibility?.publish?.('switcher-byok-dot', !!this.state.hasApiKey);
      // Let dev-chat swap its budget indicator for the BYOK badge
      // without having to observe us directly.
      if (window.DevChat && typeof DevChat.renderBudget === 'function') {
        try { DevChat.renderBudget(); } catch {}
      }
    },

    isOpen() { return Settings._open; },

    // The panes are not in the prerendered document any more: the
    // island mounts them on the screen's first reveal (lib/mount-on-reveal.ts,
    // #settings-section-content ships empty like #admin-section-content).
    // Everything below open() reads their ids on its next line — _renderBody
    // dereferences #settings-key-display outright — so the interior has to
    // exist BEFORE a single pane renders. The bridge mounts it inside
    // flushSync and returns with the nodes in the document; init() runs in
    // that same flush, so the id-bound listeners are live too. Reached by
    // name, not import: a dozen tests run this file as a script in a `vm`.
    _ensureMounted() {
      try {
        window.UsernodeReact?.mount?.ensure?.('settings-screen');
      } catch (err) { /* an absent bridge is the prerender pass */ }
    },

    // Repaint every section's body. Cheap (they're all local state or a
    // small fetch) and it keeps the ONE render path — a section is never
    // rendered lazily on first reveal, so its controls are correct whether
    // the viewer lands on it or switches to it later.
    _renderAllSections() {
      this._renderBody();
      this._refreshSpend();
      this._refreshOpenRouter();
      this._renderLlmGrants();
      this._renderAppPermissions();
      this._renderNotificationPrefs();
      this._loadCliTokens(true);
      this._loadConnectors();
      this._loadGithubLink();
      this._renderAgentFilesSection();
      this._renderWalletSection();
      this._renderDevFlowSection();
      this._renderChangeUsernameSection();
      this._renderChangePasswordSection();
      this._renderDevConsoleSection();
      this._renderLanguageSection();
      this._loadMobilePushPreferences();
      this._renderExperimentalSection();
      this._renderAdminSection();
      this._renderUsernodeSection();
      this._clearStatus();
    },

    // `section` is the hash's optional second segment (null for bare
    // #settings). Intentionally do NOT auto-focus the API key field: on
    // mobile, focusing an input on open immediately pops the on-screen
    // keyboard, which is jarring when the user just wanted to view
    // settings. The credits-exhausted banner (#463) deep-links straight to
    // #settings/api-key instead of asking for a scroll.
    // `opts.chrome === false` renders WITHOUT touching the platform
    // header (#979): app.js calls this while #settings-screen is still
    // hidden — invisible, so it may run before the screen transition —
    // but the header title / back icon are visible, and writing them
    // early bakes the incoming screen's chrome into the View Transition's
    // snapshot of the page the user is leaving. The caller runs
    // Settings.syncChrome() inside the transition callback instead.
    open(section, opts) {
      Settings._ensureMounted();
      Settings._open = true;
      // A new visit starts with an empty filter box: the nav components
      // clear their query whenever this changes (see _renderNav).
      Settings._visit += 1;
      Settings._pushedFromMenu = false;
      Settings._menuScrollTop = 0;
      Settings._chromeSuspended = !!(opts && opts.chrome === false);
      // Per-mount state: the Homeroom-app auto-retry is offered once per
      // visit to Settings, not once per document.
      Settings._usernodeAuthRetryUsed = false;
      Settings._ensureMediaListener();
      Settings._pendingSection = null;
      Settings._renderAllSections();

      const visible = Settings._visiblePages();
      const target = Settings._resolve(section);
      const valid = !!target.page && visible.some((p) => p.key === target.page);
      Settings._notePendingSection(section, valid);
      const fallback = visible.some((p) => p.key === Settings._section)
        ? Settings._section
        : (visible[0] ? visible[0].key : Settings.DEFAULT_SECTION);

      // On mobile, a bare #settings means the MENU — never a last-visited
      // section resurrected from earlier in this tab. On desktop it keeps
      // meaning the default section, exactly like the admin console.
      if (Settings._isMobile() && !valid) {
        Settings._level = 1;
        Settings._section = fallback;
        Settings._anchor = null;
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        return;
      }
      Settings._level = 2;
      Settings._section = valid ? target.page : fallback;
      Settings._anchor = valid ? target.anchor : null;
      Settings.setSection(Settings._section, { writeHash: false, anchor: Settings._anchor });
      // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
      // header ends up showing the section's name rather than "Settings".
      Settings._syncChrome();
    },

    // Re-entry while the screen is ALREADY mounted (app.js routes here
    // instead of re-running the whole screen swap — see navigateToSettings).
    // Mirrors AdminConsole.route.
    //
    // IDEMPOTENT (#1102). A same-document history traversal — the header
    // chevron's history.back(), the device back gesture, browser back/forward
    // — fires BOTH popstate and hashchange, so restoreFromHash runs TWICE in
    // one tick and app.js hands us the SAME section twice. #987 stopped the
    // duplicate replaying the screen ENTRY, but not the in-screen LEVEL
    // change, and this screen's level swap mutates an already-VISIBLE root:
    // the second call resolved the same level, so it asked for 'none', which
    // the kit runs SYNCHRONOUSLY — landing the level swap before the first
    // call's still-pending View Transition had captured the outgoing page.
    // The animation then played the incoming page against a dimmed copy of
    // itself (two menus on screen, the section gone instantly). So resolve
    // the whole target FIRST and bail out when it is already on screen —
    // don't "optimise" this into a repaint, and don't move it below the
    // _transition() call. Browse.route has the same guard for the same
    // reason. A late capability change (a section appearing/disappearing)
    // repaints through refreshMenu(), not through here.
    route(section) {
      Settings._ensureMounted();
      const visible = Settings._visiblePages();
      const target = Settings._resolve(section);
      const valid = !!target.page && visible.some((p) => p.key === target.page);
      Settings._notePendingSection(section, valid);
      const mobile = Settings._isMobile();
      // The level, page and part this call WOULD end on. Level 1 keeps
      // whatever page sits behind the menu, so there the level is the whole
      // target. The part is part of the target: #settings/password while
      // Account is already showing is a different request (scroll to it),
      // while the duplicate dispatch of one traversal carries the same one.
      const targetLevel = (!mobile || valid) ? 2 : 1;
      const targetSection = valid
        ? target.page
        : (mobile ? Settings._section : (visible[0] ? visible[0].key : Settings.DEFAULT_SECTION));
      const targetAnchor = valid ? target.anchor : null;
      if (targetLevel === Settings._level && targetSection === Settings._section) {
        // Same page at the same level. Only a different PART makes it a new
        // request; anything else is the duplicate, and it stops here.
        if (targetLevel === 1 || targetAnchor === Settings._anchor) {
          Settings._markRoute('skipped');
          return;
        }
      }
      Settings._markRoute('applied');
      if (!mobile) {
        // setSection() assigns the page and part itself, and decides from the
        // page it replaces whether to start the new one at its top.
        Settings.setSection(targetSection, { writeHash: false, anchor: targetAnchor });
        Settings._level = 2;
        Settings._syncChrome();
        return;
      }
      // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
      // the kit's fidelity rule is no animation on same-level repaints.
      const type = targetLevel === Settings._level
        ? 'none'
        : (targetLevel === 2 ? 'push' : 'pop');
      if (targetLevel === 2) {
        Settings._menuScrollTop = Settings._level === 1
          ? Settings._scrollTop()
          : Settings._menuScrollTop;
        Settings._section = target.page;
        Settings._anchor = targetAnchor;
      } else {
        Settings._pushedFromMenu = false;
        Settings._anchor = null;
      }
      Settings._level = targetLevel;
      Settings._transition(() => {
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        Settings._restoreScroll();
        Settings._scrollToAnchor();
      }, type);
    },

    // The on-screen back arrow AND the platform header's back button both
    // land here (app.js:back-btn). Returns true when the press was consumed
    // — i.e. mobile, inside a section — so the header falls through to
    // navigateHome() everywhere else (all of desktop included).
    handleBack() {
      if (!Settings._open) return false;
      if (!Settings._isMobile() || Settings._level !== 2) return false;
      if (Settings._pushedFromMenu || Settings._entryBelow()) {
        // Something of ours is below this entry, so popping lands on it —
        // routing back through popstate → restoreFromHash → route(), the
        // same path the device back gesture takes.
        //
        // `_pushedFromMenu` is the case where we know exactly what that is:
        // our own menu. It is not the only one (#1565). A link from
        // ELSEWHERE in the app — the profile editor's "Settings → Username",
        // which is where a viewer who wants to rename themselves is sent —
        // pushes an entry too, and what sits below it is the screen the
        // viewer actually came from.
        // Replacing it with the menu stranded them a level deeper than they
        // started: two presses to get back to Profile, the first of which
        // went somewhere they had never been.
        history.back();
        return true;
      }
      // A COLD deep link — a bookmark, a push notification, a reload on the
      // section — really does have nothing of ours below, and back would
      // leave the app. REPLACE the entry with the menu rather than pushing
      // one, so back can't bounce the viewer between the section and the
      // menu forever.
      try { history.replaceState(null, '', '#settings'); } catch { /* non-fatal */ }
      Settings._level = 1;
      Settings._transition(() => {
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        Settings._restoreScroll();
      }, 'pop');
      return true;
    },

    // Did this DOCUMENT put an address below the one on screen? The router
    // is the only thing that can say (see App.previousRoute), and a shell
    // that never answers — the vm harnesses, the prerender pass — is treated
    // as a cold deep link, which is the conservative half: it keeps the
    // viewer inside Settings rather than sending back somewhere that may not
    // exist.
    _entryBelow() {
      try { return window.App?.previousRoute?.() != null; }
      catch { return false; }
    },

    // Where the level-2 chevron POINTS. It has to name the same place
    // handleBack goes, or a native/middle click lands somewhere the plain
    // click does not — and the arrow's href is the platform's fallback
    // answer for "back to where?" (app.js's back-btn handler follows it).
    _upHref() {
      if (Settings._pushedFromMenu || !Settings._entryBelow()) return '#settings';
      // `''` is home; undefined lets setBackIcon fall back to the home href.
      return window.App.previousRoute() || undefined;
    },

    // Below the sidebar breakpoint — i.e. the two-level layout is live.
    // Anything that can't answer (no matchMedia) is treated as desktop, so
    // a browser without it keeps the sidebar rather than a phone layout it
    // never asked for.
    _isMobile() {
      try { return !window.matchMedia(Settings.DESKTOP_MEDIA).matches; }
      catch { return false; }
    },

    // One-time viewport listener: crossing the breakpoint re-resolves the
    // layout in place. Crossing UP renders the active section in the
    // sidebar shell; crossing DOWN keeps that section as level 2 (no menu
    // flash) and writes its explicit hash so the address matches what's on
    // screen. Lazy-bound, like AdminConsole._ensureMediaListener.
    _ensureMediaListener() {
      if (Settings._mediaBound || !window.matchMedia) return;
      try {
        const mql = window.matchMedia(Settings.DESKTOP_MEDIA);
        const onChange = () => {
          if (!Settings._open) return;
          if (!mql.matches && Settings._level !== 1) {
            Settings._writeHash(Settings._anchor || Settings._section);
          }
          Settings._renderNav();
          Settings._renderContent();
          Settings._syncChrome();
        };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
        Settings._mediaBound = true;
      } catch { /* no matchMedia — desktop path stands */ }
    },

    // The sections the current viewer may navigate to: everything whose
    // gate node is absent or currently un-hidden. Reading the node rather
    // than re-deriving the condition is what keeps this in step with
    // _renderWalletSection / _renderUsernodeSection / _renderAdminSection.
    //
    // ONE GATE IS READ FROM ITS MODEL (#2893). The Homeroom app gate is
    // decided here, in _renderUsernodeSection, and reaches its node through
    // usernodeSectionStore — which, unlike the nav store, commits on React's
    // next tick rather than synchronously. On the first open of the screen in
    // a document, open() reads the gate straight after that decision, so a
    // deep link to #settings/usernode (the block-production challenge's
    // button) found the node still hidden and fell back to the Settings
    // root. `_usernodeGated` is the value the node is rendered FROM, so once
    // it has been decided it is the truth; before that the node still is.
    _visibleSections() {
      return Settings.SECTIONS.filter((s) => {
        if (!s.gate) return true;
        if (s.gate === 'settings-usernode-section' && typeof Settings._usernodeGated === 'boolean') {
          return Settings._usernodeGated;
        }
        const el = document.getElementById(s.gate);
        return !!el && !el.classList.contains('hidden');
      });
    },

    // The page a part lives on: its `page`, or its own key.
    _pageKey(s) {
      return String((s && (s.page || s.key)) || '');
    },

    // What an address segment asks for: `{ page, anchor }`. A page key opens
    // that page at its top. A part key opens the page the part lives on,
    // scrolled to the part — unless it is that page's FIRST part, whose
    // address simply is the page (#settings/profile → Account at its top;
    // #settings/password → Account, scrolled to Password). Anything unknown
    // is `{ page: null }`, which every caller treats as "not a valid
    // section".
    _resolve(key) {
      const k = key == null ? '' : String(key);
      if (!k) return { page: null, anchor: null };
      const part = Settings.SECTIONS.find((s) => s.key === k);
      if (part) {
        const page = Settings._pageKey(part);
        const first = Settings.SECTIONS.find((s) => Settings._pageKey(s) === page);
        return { page, anchor: first && first.key !== k ? k : null };
      }
      if (Settings.SECTIONS.some((s) => Settings._pageKey(s) === k)) {
        return { page: k, anchor: null };
      }
      return { page: null, anchor: null };
    },

    // The pages the viewer may navigate to, in registry order: every page
    // with at least one visible part. Each carries its label, its group (its
    // first part's) and the parts the viewer can see on it. This is what the
    // nav lists and what open()/route()/setSection() validate against.
    _visiblePages() {
      const pages = [];
      for (const s of Settings._visibleSections()) {
        const key = Settings._pageKey(s);
        let p = pages.find((x) => x.key === key);
        if (!p) {
          p = {
            key,
            label: Settings.PAGES[key] || s.label,
            group: s.group || 'Other',
            parts: [],
          };
          pages.push(p);
        }
        p.parts.push(s);
      }
      return pages;
    },

    // Remember a deep link to a REGISTERED section that is not offered yet
    // (its gate resolves later), so _renderNavIfOpen can finish the route
    // instead of leaving the viewer on the menu. Anything else clears it.
    _notePendingSection(section, valid) {
      Settings._pendingSection = (!!section && !valid
        && Settings.SECTIONS.some((s) => s.key === section && s.gate)) ? section : null;
    },

    // The visible PAGES bucketed by group, in first-appearance order. Shared
    // by the desktop sidebar and the mobile level-1 menu so the two can never
    // drift into different groupings.
    //
    // No group collapses any more. #1554 shut seven rarely used panes inside
    // an "Advanced" group to keep the menu short; folding parts into pages
    // made it short without hiding anything, and two of those seven (what an
    // app may use on your device, what it may spend) were privacy controls
    // that should never have needed a disclosure to find.
    _groupedSections() {
      const groups = [];
      for (const p of Settings._visiblePages()) {
        const name = p.group || globalThis.PlatformI18n.t("settings:other_f97e9da0");
        let g = groups.find((x) => x.name === name);
        if (!g) { g = { name, items: [] }; groups.push(g); }
        g.items.push(p);
      }
      return groups;
    },

    str(s) {
      return String(s == null ? '' : s);
    },

    // What the nav's filter box matches a page on, and what it can show under
    // a matching row: the page label, then each visible part with its own
    // label and KEYWORDS. Lower-cased here once, so the component only ever
    // compares. A part is listed even when it is the page's only one — the
    // component decides whether its label is worth repeating.
    _filterTerms(p) {
      return {
        terms: Settings.str(p.label).toLowerCase(),
        parts: p.parts.map((s) => ({
          key: s.key,
          label: Settings.str(s.label),
          terms: `${Settings.str(s.label)} ${Settings.KEYWORDS[s.key] || ''}`.toLowerCase(),
        })),
      };
    },

    // Desktop sidebar rows, grouped under headings — one row per PAGE.
    //
    // A DESCRIPTOR, not HTML, since #1191 slice 6 conversion 8 —
    // ./settings-nav.tsx is the only writer of #settings-nav-desktop now. The
    // shape is `[{ name, first, items: [{ key, label, active, className,
    // terms, parts }] }]`.
    //
    // `className` is computed HERE rather than in the component on purpose:
    // it is the one class string on this screen that varies with state, it is
    // carried over from the retired _navItemsHtml() character for character
    // (so the rendered attribute cannot drift), and the shaping-stays-in-JS
    // rule is what keeps this module loadable by the vm harnesses. Tailwind's
    // extractor scans frontend/** including .js, so both spellings still
    // compile.
    _navView() {
      const active = Settings._section;
      const item = (p) => ({
        key: p.key,
        label: Settings.str(p.label),
        active: p.key === active,
        className: 'settings-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors '
          + (p.key === active
            ? 'bg-violet-600/10 text-violet-700 dark:text-violet-400'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'),
        ...Settings._filterTerms(p),
      });
      return Settings._groupedSections().map((g, i) => ({
        name: Settings.str(g.name),
        first: i === 0,
        items: g.items.map(item),
      }));
    },

    // Mobile level 1: the section menu. A list, not a tab set — so plain
    // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
    // idiom from index.html (44px minimum, hairline between rows, chevron
    // on the right), exactly as the admin console's level-1 menu. The row
    // classes and the chevron are the component's now (the chevron is
    // ChevronRightIcon, same 24x24 path); the grouping is still this
    // module's, shared with _navView through _groupedSections().
    _menuView() {
      return Settings._groupedSections().map((g) => ({
        name: Settings.str(g.name),
        items: g.items.map((p) => ({
          key: p.key,
          label: Settings.str(p.label),
          ...Settings._filterTerms(p),
        })),
      }));
    },

    // Paint BOTH nav hosts. These two elements were the only ones this
    // module ever innerHTML-wrote — the section wrappers are static markup
    // and are only ever hidden/shown.
    _renderNav() {
      // Level 2 on a phone must not leave the menu rows above the section;
      // desktop hides the host through its own md:hidden class. `null` is
      // what the empty-string innerHTML write used to mean.
      const showMenu = Settings._isMobile() && Settings._level === 1;
      Settings._store?.set({
        desktop: Settings._navView(),
        mobile: showMenu ? Settings._menuView() : null,
        visit: Settings._visit,
      });
    },

    // Every [data-settings-nav] control routes through here — the component
    // calls it from onClick, where _wireNavButtons used to re-bind a listener
    // per button after every repaint. On mobile a press is a DRILL-IN (a real
    // hash navigation that pushes history); on desktop it's an in-place
    // sidebar switch.
    _navClick(key) {
      if (Settings._isMobile()) Settings._openSection(key);
      else Settings.setSection(key);
    },

    // Drill-in from a level-1 menu row. A REAL hash navigation so the
    // pushed entry makes the browser / WebView back gesture work for free;
    // restoreFromHash routes it back into route() a tick later. Assigning
    // location.hash preserves the query string, so ?demo=1 survives.
    _openSection(key) {
      Settings._menuScrollTop = Settings._scrollTop();
      Settings._pushedFromMenu = true;
      const target = `#settings/${key}`;
      if (location.hash === target) {
        // Same-value assignment fires no hashchange — route by hand.
        Settings.route(key);
        return;
      }
      location.hash = target;
    },

    // `key` may be a page or a part: a part opens its page scrolled to it
    // (the filter box's matched-part rows, open()'s and route()'s deep links
    // pass `opts.anchor` already resolved). An unknown or unavailable key
    // falls back to the first visible page, as it always has.
    setSection(key, opts) {
      const visible = Settings._visiblePages();
      const target = Settings._resolve(key);
      let page = target.page;
      let anchor = opts && 'anchor' in opts ? opts.anchor : target.anchor;
      if (!page || !visible.some((p) => p.key === page)) {
        page = visible[0] ? visible[0].key : Settings.DEFAULT_SECTION;
        anchor = null;
      }
      const changed = page !== Settings._section;
      Settings._section = page;
      Settings._anchor = anchor || null;
      if (!opts || opts.writeHash !== false) Settings._writeHash(Settings._anchor || page);
      Settings._renderNav();
      Settings._renderContent();
      // A different page starts at its top. Pages are several parts long
      // now, so keeping the old scroll offset across a sidebar switch would
      // open the next page part-way down. A part deep link scrolls to the
      // part instead.
      if (Settings._anchor) Settings._scrollToAnchor();
      else if (changed) Settings._restoreScroll();
    },

    // Section switches update the address without polluting history —
    // replaceState, and only while we're actually on the #settings route
    // (the AdminConsole._writeHash / Leaderboard._setSub pattern).
    // Entering/leaving the screen still gets a real history entry via
    // normal hash navigation.
    //
    // Mobile writes #settings/account rather than bare #settings: down here
    // a bare #settings means the MENU, so the default section needs an
    // explicit segment to stay distinguishable (and deep-linkable) from
    // level 1. Desktop keeps the default → bare #settings mapping.
    _writeHash(key) {
      const target = (key === Settings.DEFAULT_SECTION && !Settings._isMobile())
        ? '#settings'
        : `#settings/${key}`;
      if (location.hash.startsWith(`${target}/`)) return;
      if (location.hash.startsWith('#settings') && location.hash !== target) {
        history.replaceState(null, '', target);
      }
    },

    // The single dispatcher for what goes in the content area: the mobile
    // level-1 menu, or every part wrapper of exactly one page.
    _renderContent() {
      const host = document.getElementById('settings-section-content');
      const footer = document.getElementById('settings-footer');
      const menuLevel = Settings._isMobile() && Settings._level === 1;
      if (host) {
        host.classList.toggle('hidden', menuLevel);
        host.querySelectorAll('[data-settings-section]').forEach((el) => {
          const page = Settings._resolve(el.dataset.settingsSection).page;
          el.classList.toggle('hidden', menuLevel || page !== Settings._section);
        });
      }
      if (footer) Settings._syncFooter();
      // The AI-credit figure in the Usage part renders from a
      // me-scoped fetch and is throttled inside AiCredit, so refreshing it on
      // every section change is cheap and keeps it honest. This is where the
      // hamburger's open-time refresh went when the row moved here.
      if (window.AiCredit?.refreshAll) window.AiCredit.refreshAll();
      // Announce which section is showing. The one listener today is the
      // Theme pane (features/settings/sections/theme.tsx), which re-reads
      // Theme.get() so a mode changed in another tab — or an explicit value
      // that happens to match the OS — is reflected when you come back to it.
      // This replaces the drawer's `usernode:header-menu-open`, which did
      // exactly the same job when the control lived there.
      try {
        window.dispatchEvent(new CustomEvent('usernode:settings-section', {
          detail: { section: Settings._section },
        }));
      } catch (err) { /* ignore */ }
    },

    // Log out sits under the sidebar on desktop and under the level-1 menu
    // on a phone. The phone case needs a real node MOVE: the sidebar column
    // is `display:none` below md and would take the footer with it. Moving
    // the node (never rebuilding it) is what keeps #settings-logout's
    // click handler — bound once in init() — alive.
    _syncFooter() {
      const footer = document.getElementById('settings-footer');
      if (!footer) return;
      const mobile = Settings._isMobile();
      if (mobile) {
        const parent = document.getElementById('settings-content-col');
        if (parent && footer.parentElement !== parent) {
          // Leave a comment in the sidebar column where the footer was, so
          // React's picture of that column's children still describes the
          // document while the node is away (#1191 slice 6, conversion 8 —
          // lib/kit-surface.ts's createPlaceholderHome, the same seam the
          // dialog cards' lift uses). Planted by ./mount.ts; absent in the
          // vm harnesses, where the plain appendChild below is the whole
          // behaviour and always was.
          Settings._footerHome?.lift();
          parent.appendChild(footer);
        }
      } else if (Settings._footerHome) {
        // restore() puts it back where the comment SITS — after
        // #settings-nav-desktop in the sidebar column, i.e. its rendered
        // position — rather than merely inside the right parent.
        Settings._footerHome.restore();
      } else {
        const parent = document.getElementById('settings-sidebar-col');
        if (parent && footer.parentElement !== parent) parent.appendChild(footer);
      }
      // On a phone it belongs to the MENU level only — a drilled-in section
      // shouldn't end with a Log out button.
      footer.classList.toggle('hidden', mobile && Settings._level === 2);
    },

    _transition(fn, type) {
      if (window.PlatformUI && PlatformUI.transition) PlatformUI.transition(fn, { type: type || 'none' });
      else fn();
    },

    // Runtime-only marker recording what the LAST route() call did —
    // 'applied' (it repainted) or 'skipped' (the idempotence guard above
    // bailed out). Nothing reads it at runtime: it exists so the dapp.json
    // checks can assert an ordering that is otherwise only observable
    // mid-animation, exactly like App._entryTransition's data-entered stamp
    // (#977). Because it is written at runtime it is deliberately absent
    // from tests/baselines/shell-markup.json.
    _markRoute(state) {
      const el = document.getElementById('settings-screen');
      if (el) el.setAttribute('data-settings-route', state);
    },

    _scrollTop() {
      const screen = document.getElementById('settings-screen');
      const el = window.PlatformUI?.scrollElement?.(screen) || screen;
      return el ? el.scrollTop : 0;
    },

    // A deep link to a part that is not its page's first: bring it into view
    // once its page is showing. scrollIntoView rather than a scrollTop sum,
    // because the scroller differs by surface (the screen on desktop, the
    // document in the phone's browser-scroller mode) and the browser already
    // knows which one holds the node. Never on the phone's menu level, where
    // the wrappers are not on screen at all.
    _scrollToAnchor() {
      const key = Settings._anchor;
      if (!key || (Settings._isMobile() && Settings._level === 1)) return;
      const el = document.querySelector?.(`[data-settings-section="${key}"]`);
      if (!el || el.classList.contains('hidden')) return;
      try { el.scrollIntoView({ block: 'start' }); } catch { /* old engines: no scroll */ }
    },

    // A pushed screen starts at the top; a pop restores where the menu was.
    _restoreScroll() {
      const screen = document.getElementById('settings-screen');
      const el = window.PlatformUI?.scrollElement?.(screen) || screen;
      if (!el) return;
      el.scrollTop = (Settings._isMobile() && Settings._level === 1)
        ? Settings._menuScrollTop
        : 0;
    },

    // Platform-header chrome for the current level: inside a mobile section
    // the header becomes that section's nav bar (arrow + section name),
    // everywhere else it stays "Settings" and the home icon. setHeaderTitle
    // mirrors into document.title, so the native shell's AppBar picks the
    // section name up too.
    // The public half of _syncChrome: clears the suspension a
    // `chrome: false` open() set and applies the chrome for real. app.js
    // calls this INSIDE the screen transition's callback (#979).
    syncChrome() {
      Settings._chromeSuspended = false;
      Settings._syncChrome();
    },

    _syncChrome() {
      if (!window.App || Settings._chromeSuspended) return;
      const inSection = Settings._isMobile() && Settings._level === 2;
      // #1036: the header control is a real anchor — inside a section the
      // chevron pops to whatever is below it, which is the settings menu
      // unless the viewer arrived from elsewhere in the app (#1565, see
      // _upHref), so that is its href.
      //
      // TWO LEVELS, ONE GLYPH. The mobile drill-in's chevron is the only way
      // up a level INSIDE this screen — without it a phone viewer is stranded
      // in a section — and since #2718's review the ROOT draws one too.
      //
      // Level 1 spent two rounds hiding it. That was right while Settings was
      // reached from Home's account row: the row you came from was one tap
      // behind you and a second affordance pointing at it was chrome. The Me
      // tab replaced that row, and `'home'` sends you to a screen the bar's
      // own Home tab already reaches while the tab still lit is Me — so the
      // root's arrow points at #profile, the level it is genuinely under.
      // App._BACK_SLOT['settings-screen'] says the same thing on the screen
      // reveal; this is the second writer, and the later one wins.
      if (App.setBackIcon) App.setBackIcon('arrow', inSection ? Settings._upHref() : '#profile');
      if (!App.setHeaderTitle) return;
      if (inSection) {
        const p = Settings._visiblePages().find((x) => x.key === Settings._section);
        App.setHeaderTitle(p ? p.label : globalThis.PlatformI18n.t("settings:settings_74a883a0"));
      } else {
        App.setHeaderTitle(globalThis.PlatformI18n.t("settings:settings_74a883a0"));
      }
    },

    // Re-resolve the menu after late-arriving state: `walletLinkEnabled`
    // lands with refresh()'s /api/auth/me response and the Homeroom-app
    // capability with the bridge's async probe, both of which can resolve
    // AFTER a cold-boot deep link has already painted. Without this the
    // menu would be missing those rows until the next navigation.
    _renderNavIfOpen() {
      if (!Settings._open) return;
      // A deep link that arrived before its section's gate opened (#2893):
      // finish it now, once, if the address still asks for that section —
      // a viewer who has since moved elsewhere is not pulled back.
      const want = Settings._pendingSection;
      if (want && Settings._visibleSections().some((s) => s.key === want)) {
        Settings._pendingSection = null;
        const hash = String((typeof location !== 'undefined' && location.hash) || '');
        if (hash === `#settings/${want}` || hash.startsWith(`#settings/${want}?`)) {
          Settings.route(want);
          return;
        }
      }
      Settings._renderNav();
      // A page that just became unavailable must not stay on screen.
      if (!Settings._visiblePages().some((p) => p.key === Settings._section)) {
        Settings.setSection(Settings._section);
      }
    },

    _renderDevConsoleSection() {
      const toggle = document.getElementById('dev-console-always-show');
      if (!toggle) return;
      const mode = window.DevConsole ? DevConsole.getMode() : 'errors-only';
      toggle.checked = mode === 'always';
    },

    _renderExperimentalSection() {
      const toggle = document.getElementById('ai-progress-estimate');
      if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
      const status = document.getElementById('ai-progress-estimate-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      const bridge = document.getElementById('session-bridge-enabled');
      if (bridge) bridge.checked = !!this.state.sessionBridgeEnabled;
      const bridgeStatus = document.getElementById('session-bridge-status');
      if (bridgeStatus) { bridgeStatus.classList.add('hidden'); bridgeStatus.textContent = ''; }
      const botDm = document.getElementById('homeroom-bot-dm-enabled');
      if (botDm) botDm.checked = !!this.state.homeroomBotDm;
      // With the bot on for everyone there is no list to join or leave: its
      // whole block (the switch, its note and its status line) goes.
      const botDmBlock = botDm ? botDm.closest('.border-t') : null;
      if (botDmBlock) botDmBlock.classList.toggle('hidden', !!this.state.homeroomBotForEveryone);
      const botDmStatus = document.getElementById('homeroom-bot-dm-status');
      if (botDmStatus) { botDmStatus.classList.add('hidden'); botDmStatus.textContent = ''; }
      this._renderLocalAgentsSection();
    },

    // #907: the machines currently attached to one of this account's dev
    // sessions. GET /api/me/local-agents is deliberately NOT part of the CLI
    // token surface — a lease is routing state, not a credential — so unlike
    // the token list above it answers on staging too.
    //
    // The block hides itself outright when nothing is attached. An empty
    // "Local coding agent — none" panel would be noise on every account that
    // has never used the CLI, which is nearly all of them.
    async _renderLocalAgentsSection() {
      const section = document.getElementById('settings-local-agents-section');
      const list = document.getElementById('settings-local-agents-list');
      const status = document.getElementById('settings-local-agents-status');
      if (!section || !list) return;
      if (status) { status.classList.add('hidden'); status.textContent = ''; }

      let agents = [];
      try {
        const query = this._cliTokensDemo() ? '?demo=1' : '';
        const r = await fetch(`/api/me/local-agents${query}`, { credentials: 'same-origin' });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.agents)) agents = j.agents;
        }
      } catch {}

      this._localAgents = agents;
      // The SECTION's own `hidden` is a sibling concern and stays here: an
      // empty "Local coding agent — none" panel would be noise on every
      // account that has never used the CLI, which is nearly all of them.
      section.classList.toggle('hidden', agents.length === 0);
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsLocalAgents : null;
      if (bridge) {
        bridge.publish({
          phase: 'ready',
          agents: agents.map((agent) => this._localAgentView(agent)),
        });
      }
      if (status && agents.some((a) => a.demo)) {
        status.textContent = globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930");
        status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400');
      }
    },

    // One attached machine, as ./local-agents-list.tsx draws it.
    //
    // This was `_localAgentCard`, built with DOM calls rather than innerHTML
    // for one reason: the label is free text the user typed on their own
    // machine and arrives verbatim. React escapes it for the same reason, so
    // the safety property survives the renderer swap — `leaseId` and `demo`
    // collapse into the one fact the row needs, which is whether there is a
    // lease to release at all.
    _localAgentView(agent) {
      const app = agent.appName || agent.appSlug || globalThis.PlatformI18n.t("settings:an_app_66e93a7c");
      return {
        leaseId: agent.leaseId || null,
        label: agent.label || null,
        title: agent.label || globalThis.PlatformI18n.t("settings:unnamed_machine_06081018"),
        where: agent.sessionTitle ? `${app} · ${agent.sessionTitle}` : String(app),
        runtime: agent.runtime || 'claude-code',
        // #1808: the raw instant, NOT a formatted time. This was
        // `toLocaleTimeString()`, so a machine last seen in March read
        // "last seen 10:00" — the same words as one seen this morning, on a
        // row whose entire job is to say whether the machine is still there.
        // ./local-agents-list.tsx stamps it with the shared helper, which
        // this module cannot import: four test harnesses run its real source
        // through `vm.runInContext` as a classic script, where a top-level
        // `import` is a syntax error. Formatting in the renderer is the
        // arrangement that needs no second copy of the helper.
        lastSeenAt: Number.isFinite(Date.parse(agent.lastSeenAt)) ? agent.lastSeenAt : null,
        // Demo rows (staging ?demo=1) are fabricated per request and own no
        // lease, so there is nothing for a button to release.
        detachable: !agent.demo && !!agent.leaseId,
      };
    },

    // Releasing from here must not need the machine to cooperate: the common
    // case is a laptop that was closed or lost its network, and the whole
    // point is to get the session's turns back without waiting out the lease.
    async _detachLocalAgent(agent, button) {
      const label = agent.label || globalThis.PlatformI18n.t("settings:this_machine_e223809d");
      if (!window.confirm(globalThis.PlatformI18n.t("settings:detach_value1_its_session_s_coding_turns_go_back_17c8e49c", { value1: label }))) return;
      const status = document.getElementById('settings-local-agents-status');
      button.disabled = true;
      try {
        const r = await fetch(`/api/me/local-agents/${encodeURIComponent(agent.leaseId)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        // 404 means it already went away (it detached itself, or the sweeper
        // expired it) — the user's intent is satisfied either way.
        if (r.status !== 204 && r.status !== 404) throw new Error(globalThis.PlatformI18n.t("settings:could_not_detach_that_machine_6034c97c"));
        await this._renderLocalAgentsSection();
      } catch (err) {
        button.disabled = false;
        if (status) {
          status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_detach_that_machine_6034c97c");
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      }
    },

    // Home sections are permanent (#1801); the old widget visibility
    // settings, menu and endpoint are retired together.

    _renderLanguageSection() {
      const select = document.getElementById('settings-locale');
      if (!select) return;
      // Language is now a platform preference, available even in Auto.
      const section = document.getElementById('settings-language-section');
      const value = this.state.locale || '';
      if (section) {
        // The platform now implements this preference, including Auto.
        section.classList.remove('hidden');
      }
      // A saved value outside the curated list (set via the API, or a
      // future wider picker) still needs to render truthfully — inject
      // an option for it so the select doesn't silently show "Auto".
      if (value && ![...select.options].some((o) => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      }
      select.value = value;
      const status = document.getElementById('settings-locale-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
    },

    // "Preferred build flow" (#1049). The BLOCK is markup now
    // (sections/connectors.tsx) — it was injected here at runtime until
    // #1191, because the shell's body was a hand-written document pinned
    // id-for-id and a new settings control had nowhere else to go. What is
    // left is what this module does for every other control on the screen:
    // bind the change, reflect the stored value, and gate the two hand-off
    // options on whether this deployment has the external flows at all.
    //
    // Idempotent — _renderAllSections and refresh() both call it, and the
    // listener is attached once, to an element React keeps.
    _renderDevFlowSection() {
      const select = document.getElementById('settings-dev-flow');
      if (!select) return;
      if (!select.__devFlowWired) {
        select.__devFlowWired = true;
        select.addEventListener('change', (e) => this._saveDevFlow(e.target.value));
      }
      // A deployment without the external flows can still express "always
      // build on Homeroom" vs "ask me" — just not the two hand-offs.
      select.querySelectorAll('option[value="claude-code"], option[value="codex"]').forEach((opt) => {
        opt.disabled = !this.state.externalFlowsAvailable;
      });
      select.value = this.state.devFlowPreference || '';
      const status = document.getElementById('settings-dev-flow-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
    },

    // Does the CLI-credentials surface exist in this deployment?
    //
    // The whole /api/me/cli-tokens + /api/cli/* family is 404'd in a
    // staging preview (routes/cli-auth.js gates it — unreviewed PR code
    // must never mint CLI tokens). The 404 branch in _loadCliTokens
    // already handles that gracefully in JS, but the REQUEST ITSELF is
    // the problem: a failed fetch is an error line in the page console
    // no matter how the app handles it, and the proposal checks fail any
    // route that logs one. So we ask first and skip the fetch entirely.
    //
    // Deployment-constant, so it resolves at most once per page load.
    // Unknown / unreachable / a shell older than the flag all answer
    // TRUE — the behaviour is then exactly what it was before this
    // helper existed, with the 404 branch as the backstop. Only an
    // explicit `false` from the server suppresses the request.
    _cliAuthPromise: null,

    _cliAuthAvailable() {
      if (!this._cliAuthPromise) {
        this._cliAuthPromise = (async () => {
          try {
            const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
            if (!r.ok) return true;
            const j = await r.json();
            return j.user?.cliAuthEnabled !== false;
          } catch { return true; }
        })();
      }
      return this._cliAuthPromise;
    },

    // The two read-only CLI credential fixtures the staging server knows:
    // rows for the everyday review route, or #1609's instruction-rich empty
    // state. All boolean callers use _cliTokensDemo(); the credential fetch
    // also needs the exact value so it can select the right fixture.
    _cliTokensDemoValue() {
      try {
        const flag = new URLSearchParams(window.location.search).get('demo');
        return flag === '1' || flag === 'cli-empty' ? flag : null;
      } catch { return null; }
    },

    _cliTokensDemo() {
      return this._cliTokensDemoValue() !== null;
    },

    // ── Claude & ChatGPT connectors ──────────────────────────────────────
    //
    // Same shape as the CLI-credentials block below: a load-generation
    // guard so a slow response can't repaint stale credential state over a
    // fresh one, and the page's ?demo= flag passed through (mcp_tokens and
    // mcp_connector_hints are both staging:private, so a staging clone would
    // render an empty list and a status line with nothing to say).

    // Wider than _cliTokensDemo above, because this panel has six reviewable
    // states rather than one: `1` is the everyday mixed state and the
    // `connectors-*` values each pin one of the others. Anything else is not
    // passed on. The server only honours any of it in staging.
    _connectorsDemo() {
      try {
        const flag = new URLSearchParams(window.location.search).get('demo');
        if (flag === '1' || (flag && flag.startsWith('connectors-'))) return flag;
        return null;
      } catch { return null; }
    },

    // ── Rewriting the allow rules for a different connector name ─────────
    //
    // The two blocks ship covering `homeroom` and `Homeroom` plus the
    // pre-rename `usernode` and `Usernode`. Anything else — a typo like the `Uesrnode`
    // from #1218, or a name someone simply chose — needs the same rules with
    // that segment, and asking a user to hand-edit six JSON strings is asking
    // for a seventh mistake. So the page does the edit.
    //
    // The rules are rebuilt from the SHAPE of the rendered block rather than
    // from a second template kept here: the prerendered default is parsed
    // once, its tool suffixes are read off it, and a rewrite re-emits those
    // suffixes under the typed segment. A rule added to READ_ONLY_ALLOW_RULES
    // reaches this field with no edit in this file.
    //
    // textContent throughout, never innerHTML — the value being written comes
    // from a text input.
    /**
     * Wire one Copy button (#1290).
     *
     * Three of them live on this screen — the connector URL and the two
     * allow-rule blocks — and before this they were three ad-hoc handlers
     * that each got something wrong: the URL one wrote 'Copied' even when
     * `writeText` had rejected, none of them went through
     * `PlatformUI.copyText` (so an insecure origin or a locked-down webview
     * failed silently instead of taking the execCommand fallback every other
     * copy on the platform gets), none toasted, and none held onto the reset
     * timer, so a second press cut the first press's confirmation short.
     *
     * `read` and `selectOnFail` are called at CLICK time so the source can
     * change under the button — which it does: the name-spelling field
     * rewrites both <pre> blocks in place.
     *
     * textContent only, never innerHTML: these buttons are rendered by
     * Shell.tsx and a glyph would need markup React owns.
     */
    _wireCopyControl(buttonId, { read, successMessage, failureMessage, selectOnFail }) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      // The label React rendered, restored rather than a hardcoded 'Copy'.
      const restLabel = btn.textContent;
      let resetTimer = null;
      btn.addEventListener('click', async () => {
        const text = read();
        if (text == null) return;
        const ok = window.PlatformUI && PlatformUI.copyText
          ? await PlatformUI.copyText(text)
          : await (async () => {
            try {
              await navigator.clipboard.writeText(text);
              return true;
            } catch {
              return false;
            }
          })();
        if (!ok && selectOnFail) {
          // Leave the text selected so Ctrl/Cmd-C still works.
          try { selectOnFail(); } catch {}
        }
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(ok ? successMessage : failureMessage,
            ok ? {} : { error: true });
        }
        btn.textContent = ok ? globalThis.PlatformI18n.t("settings:copied_8d525e5f") : globalThis.PlatformI18n.t("settings:copy_failed_5b50e7a6");
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetTimer = null;
          btn.textContent = restLabel;
        }, 1500);
      });
    },

    _wireConnectorNameSpelling() {
      const field = document.getElementById('connector-name-spelling');
      if (!field) return;
      const blocks = ['connector-allow-rules', 'connector-repo-allow-rules']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      if (!blocks.length) return;

      // Captured before anything is written: this is the canonical answer,
      // and the fallback for an empty or unusable field.
      const canonical = blocks[0].textContent;
      let suffixes = [];
      let covered = new Set();
      try {
        const allow = JSON.parse(canonical)?.permissions?.allow || [];
        suffixes = [...new Set(allow.map((rule) => rule.slice(rule.indexOf('__', 5) + 2)))];
        // The spellings the shipped block ALREADY covers, read out of the
        // block itself for the same reason the suffixes are: a second copy
        // of the list here would be the thing that drifts. Typing any of
        // them means there is nothing to rewrite — including the spellings
        // that predate the rename, which a long-connected user is still on.
        covered = new Set(allow.map((rule) => rule.split('__')[1].toLowerCase()));
      } catch {
        suffixes = [];
        covered = new Set();
      }

      const render = () => {
        // Only what a permission rule's server segment can hold. `__` is the
        // separator itself, so a name containing one would silently produce a
        // rule for a different tool — those characters are dropped, not
        // escaped, and the result is shown so the user can see what happened.
        const name = String(field.value || '').trim().replace(/[^A-Za-z0-9.-]/g, '');
        const custom = name && !covered.has(name.toLowerCase()) && suffixes.length;
        const text = custom
          ? JSON.stringify(
            { permissions: { allow: suffixes.map((s) => `mcp__${name}__${s}`) } }, null, 2
          )
          : canonical;
        for (const block of blocks) block.textContent = text;
      };
      field.addEventListener('input', render);
    },

    async _loadConnectors() {
      const section = document.getElementById('connectors-section');
      const status = document.getElementById('connectors-status');
      if (!section || !status) return;

      // The connector URL is derived from the origin the SPA is served
      // from, so a self-hosted fork shows its own.
      const urlField = document.getElementById('connector-url');
      const connectorUrl = `${window.location.origin}/mcp`;
      if (urlField) urlField.value = connectorUrl;

      // #1607: the "set it up in <product>" links open a new chat pre-loaded
      // with the job. Built HERE, from the same derived origin the field
      // shows, so a fork or a config change cannot leave a hardcoded URL
      // behind — the rule the written steps already follow by pointing back
      // at #connector-url rather than naming a host.
      //
      // The prompt carries the two things people get wrong: that Homeroom
      // uses dynamic client registration (so there is no client ID or secret
      // to go looking for), and the exact name `homeroom`, which is what
      // Claude Code builds its permission rules from (#1218) and which one
      // account once mistyped, silently missing every rule the platform
      // ships.
      //
      // Deliberately short. It is a query string, and nothing secret is in
      // it: the connector URL is a public endpoint and the authorisation
      // happens through OAuth inside the product, not in this link.
      const chatPrompt = `I want to add a custom MCP connector. The server URL is ${connectorUrl}`
        + globalThis.PlatformI18n.t("settings:and_it_uses_dynamic_client_registration_so_there_1f22ccd8")
        + globalThis.PlatformI18n.t("settings:name_it_exactly_homeroom_walk_me_through_it_one__dff902bc");
      const chatLinks = [
        ['connector-open-claude', 'https://claude.ai/new?q='],
        ['connector-open-chatgpt', 'https://chatgpt.com/?q='],
      ];
      for (const [id, base] of chatLinks) {
        const link = document.getElementById(id);
        if (link) link.href = `${base}${encodeURIComponent(chatPrompt)}`;
      }

      // #1892: the Codex CLI blocks ship with a placeholder where the URL
      // goes, for the same reason the steps point at #connector-url instead
      // of naming a host. Swap it for the derived value here, by textContent
      // and never innerHTML. Idempotent: once swapped, the placeholder is
      // gone and a re-render finds nothing to replace.
      const CODEX_URL_PLACEHOLDER = 'https://<your-homeroom-host>/mcp';
      for (const id of ['connector-codex-add', 'connector-codex-config']) {
        const block = document.getElementById(id);
        if (block && block.textContent.includes(CODEX_URL_PLACEHOLDER)) {
          block.textContent = block.textContent.split(CODEX_URL_PLACEHOLDER).join(connectorUrl);
        }
      }

      this._connectorLoadId = (this._connectorLoadId || 0) + 1;
      const loadId = this._connectorLoadId;
      this._publishConnectors({ phase: 'loading', connectors: [] });
      status.classList.add('hidden');

      try {
        const demoFlag = this._connectorsDemo();
        const demoQ = demoFlag ? `?demo=${encodeURIComponent(demoFlag)}` : '';
        const response = await fetch(`/api/me/connectors${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._connectorLoadId) return;
        if (response.status === 404) {
          // The connector surface is production-only; hide rather than
          // showing a section that can't work here.
          section.classList.add('hidden');
          return;
        }
        if (!response.ok) throw new Error(globalThis.PlatformI18n.t("settings:could_not_load_your_connections_18fb599b"));
        const data = await response.json();
        if (!data || !Array.isArray(data.connectors)) {
          throw new Error(globalThis.PlatformI18n.t("settings:the_connections_response_was_invalid_972f96a2"));
        }
        section.classList.remove('hidden');
        this._connectors = data.connectors;
        this._connectorHint = data.hint || null;
        this._renderConnectors();
      } catch (err) {
        if (loadId !== this._connectorLoadId) return;
        this._publishConnectors({ phase: 'idle', connectors: [] });
        status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_load_your_connections_18fb599b");
        status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
        status.classList.add('text-red-700', 'dark:text-red-400');
      }
    },

    // Which of the three "stop the prompts" cases apply to what is actually
    // connected. Substring matching on the registered client name, which is
    // attacker-choosable and often just a product name — so this only ever
    // decides what to SHOW, never what to allow, and anything it cannot place
    // falls back to showing every case.
    _connectorFamilies(connectors) {
      let claude = false;
      let chatgpt = false;
      let unknown = false;
      for (const connector of connectors) {
        const name = String(connector.client_name || '').toLowerCase();
        if (/claude|anthropic/.test(name)) claude = true;
        else if (/chatgpt|openai|codex/.test(name)) chatgpt = true;
        else unknown = true;
      }
      return { claude, chatgpt, unknown };
    },

    // The Claude Code cases are hidden only when EVERY connection is a
    // ChatGPT-family one, where they are advice about a file that product
    // does not read. They stay up for a Claude-family name because that name
    // does not distinguish claude.ai chat from Claude Code — both arrive as
    // some spelling of "Claude" — so hiding them there would hide the fix
    // from the surface that needs it.
    _renderConnectorCases(connectors) {
      const { claude, unknown } = this._connectorFamilies(connectors);
      const claudeCode = !connectors.length || unknown || claude;
      for (const id of ['connector-case-cc-local', 'connector-case-cc-web']) {
        const node = document.getElementById(id);
        if (node) node.classList.toggle('hidden', !claudeCode);
      }
    },

    // The read-only tip status. There is no control next to it: arming
    // happens when a chat client opens a session (services/mcp-hint-throttle.js),
    // so "open a new chat" is the reset, and a button here would only be a
    // way to make the connector nag.
    _renderConnectorHint(connectors) {
      const line = document.getElementById('connector-hint-status');
      if (!line) return;
      const hint = this._connectorHint;
      const { claude, unknown } = this._connectorFamilies(connectors);
      // No line at all in two cases: no status to report, and a connection
      // set that is entirely ChatGPT-family. The tip is suppressed for that
      // family — there are no per-call prompts there to stop — so "not shown
      // yet" would read as a promise that one is coming, and a count would
      // report a budget that will never be spent.
      if (!hint || (connectors.length && !claude && !unknown)) {
        line.textContent = '';
        line.classList.add('hidden');
        return;
      }
      const shown = Number(hint.shownThisWindow) || 0;
      const cap = Number(hint.maxPerWindow) || 0;
      const days = Number(hint.windowDays) || 0;

      let text;
      if (!shown) {
        text = globalThis.PlatformI18n.t("settings:homeroom_has_not_sent_you_this_tip_in_chat_yet_i_7d929cc0");
      } else {
        const when = Number.isFinite(Date.parse(hint.lastShownAt))
          ? new Date(hint.lastShownAt).toLocaleString(globalThis.PlatformI18n.getLanguage())
          : 'recently';
        const times = shown === 1 ? 'once' : globalThis.PlatformI18n.t("settings:value1_times_6140f307", { value1: shown });
        text = globalThis.PlatformI18n.t("settings:homeroom_sent_you_this_tip_in_chat_value1_in_the_70ec27b5", { value1: times, value2: days, value3: when });
        // Three different answers to "why am I not seeing it", and they are
        // not interchangeable: the budget is spent (comes back next week),
        // the hour since the last one has not passed (comes back shortly), or
        // neither (open a new conversation). Saying "open a new conversation"
        // during the quiet hour is advice that does not work, which is worse
        // than saying nothing.
        const cooldown = Number(hint.cooldownMinutes) || 0;
        const shownAt = Date.parse(hint.lastShownAt);
        const quietUntil = cooldown && Number.isFinite(shownAt)
          ? shownAt + cooldown * 60 * 1000
          : 0;
        if (cap && shown >= cap) {
          text += globalThis.PlatformI18n.t("settings:that_is_the_limit_of_value1_per_connection_per_v_c06cb72f", { value1: cap, value2: days });
        } else if (quietUntil > Date.now()) {
          // #1808: a bare "12:20 AM" here can be TOMORROW's. The cooldown
          // runs from the last tip, so one sent late in the evening puts the
          // deadline past midnight, and a reader comparing it to the clock
          // concludes the window has already passed. A day word settles it,
          // and anything further out gets the whole stamp.
          const end = new Date(quietUntil);
          const deadline = end.toDateString() === new Date().toDateString()
            ? globalThis.PlatformI18n.t("settings:today_at_value1_9a17d547", { value1: end.toLocaleTimeString(globalThis.PlatformI18n.getLanguage()) })
            : end.toLocaleString(globalThis.PlatformI18n.getLanguage());
          text += globalThis.PlatformI18n.t("settings:it_stays_quiet_for_value1_minutes_after_each_one_af1305d4", { value1: cooldown })
            + globalThis.PlatformI18n.t("settings:value1_will_not_carry_it_one_opened_after_that_w_7db50018", { value1: deadline });
        } else {
          text += globalThis.PlatformI18n.t("settings:open_a_new_conversation_to_see_it_again_2a2c7f84");
        }
      }
      line.textContent = text;
      line.classList.remove('hidden');
    },

    // Publish the connector cards. Was a `document.createElement` tree per
    // connection — card, top row, title, metadata, Disconnect and its listener
    // — and is ./connectors-list.tsx's markup now. The two date formats and
    // the "never used" fallback are resolved here, where the payload is.
    _publishConnectors(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsConnectors : null;
      if (bridge) bridge.publish(next);
    },

    _renderConnectors() {
      const connectors = this._connectors || [];
      // Two SIBLINGS of the list host, both still this module's: the static
      // "stop the prompts" prose blocks, whose visibility follows which client
      // families are connected, and the read-only tip status.
      this._renderConnectorCases(connectors);
      this._renderConnectorHint(connectors);
      this._publishConnectors({
        phase: 'ready',
        connectors: connectors.map((connector) => {
          const connected = Number.isFinite(Date.parse(connector.connected_at))
            ? new Date(connector.connected_at).toLocaleString(globalThis.PlatformI18n.getLanguage()) : globalThis.PlatformI18n.t("settings:unknown_date_bced143d");
          const used = connector.last_used_at
            && Number.isFinite(Date.parse(connector.last_used_at))
            ? globalThis.PlatformI18n.t("settings:last_used_value1_8867dad3", { value1: new Date(connector.last_used_at).toLocaleString(globalThis.PlatformI18n.getLanguage()) })
            : globalThis.PlatformI18n.t("settings:never_used_8a0057fc");
          return {
            id: String(connector.id),
            title: connector.client_name || globalThis.PlatformI18n.t("settings:connected_client_0dd50071"),
            detail: globalThis.PlatformI18n.t("settings:connected_value1_value2_10041a30", { value1: connected, value2: used }),
          };
        }),
      });
    },

    async _disconnectConnector(id, button) {
      const status = document.getElementById('connectors-status');
      if (button) button.disabled = true;
      try {
        const response = await fetch(`/api/me/connectors/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(globalThis.PlatformI18n.t("settings:could_not_disconnect_try_again_5662fa4b"));
        }
        await this._loadConnectors();
        if (status) {
          status.textContent = globalThis.PlatformI18n.t("settings:disconnected_7fcdbd4a");
          status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400');
          status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        }
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_disconnect_975d7bac");
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      }
    },

    // ── Social account ownership proofs + Layer-1 credits ────────────────

    _socialIdentityDemoQuery() {
      try {
        const demo = new URLSearchParams(window.location.search).get('demo');
        if (demo === '1' || demo === 'identity-connected'
            || demo === 'identity-unverified' || demo === 'identity-legacy'
            || demo === 'identity-x-misconfigured' || demo === 'identity-replacement') {
          return `?demo=${encodeURIComponent(demo)}`;
        }
      } catch { /* ordinary production read */ }
      return '';
    },

    async _loadGithubLink() {
      const section = document.getElementById('github-link-section');
      if (!section) return;
      this._publishSocialIdentity({
        phase: 'loading', get message() { return globalThis.PlatformI18n.t("settings:loading_ba3bbbe1"); }, tier: null, providers: [],
      });
      try {
        const response = await fetch(`/api/me/social-identities${this._socialIdentityDemoQuery()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (response.status === 404) {
          section.classList.add('hidden');
          return;
        }
        if (!response.ok) throw new Error(globalThis.PlatformI18n.t("settings:social_identity_request_failed_value1_77815ad7", { value1: response.status }));
        const data = await response.json();
        if (!data || !data.providers || !data.entitlement) {
          throw new Error(globalThis.PlatformI18n.t("settings:invalid_social_identity_response_b1dcbc60"));
        }
        section.classList.remove('hidden');
        // Keep the established property/method names: external-agent code
        // calls _loadGithubLink after attribution changes. The value is now
        // the provider-neutral response.
        this._githubLink = data;
        this._renderGithubLink();
      } catch {
        this._publishSocialIdentity({
          phase: 'error',
          get message() { return globalThis.PlatformI18n.t("settings:could_not_load_social_accounts_try_again_shortly_8c11d8b6"); },
          tier: null,
          providers: [],
        });
        section.classList.remove('hidden');
      }
    },

    // Keep the connector panel and every profile surface on the same
    // post-mutation truth. The panel reads the provider-neutral status route;
    // the profile editor reads App.user.links, which comes from /api/auth/me.
    async _refreshSocialIdentitySurfaces() {
      await Promise.all([
        this._loadGithubLink(),
        (typeof window !== 'undefined' && window.Profile?._refreshUser)
          ? window.Profile._refreshUser()
          : Promise.resolve(),
      ]);
    },

    _publishSocialIdentity(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsSocialIdentity : null;
      if (bridge) bridge.publish(next);
    },

    _renderGithubLink() {
      const status = document.getElementById('github-link-status');
      if (status) status.classList.add('hidden');
      const payload = this._githubLink || { providers: {}, entitlement: {} };
      const entitlement = payload.entitlement || {};
      this._publishSocialIdentity({
        phase: 'ready',
        message: null,
        tier: this._socialIdentityTierView(entitlement),
        providers: ['github', 'x'].map((provider) => this._socialIdentityRowView(
          provider,
          payload.providers[provider] || { provider, linked: false, available: false },
          entitlement,
          !!payload.demo,
          payload.providers
        )),
      });
      // A SIBLING of the block, and still this module's: it reports the OAuth
      // result carried in the hash query, which is about the navigation that
      // just happened rather than about the block's contents.
      this._socialIdentityCallbackStatus(status);
    },

    // The head row of the daily-credits list, in its five states. Every one
    // of them is a different answer to "how much can this account spend today,
    // and why", so the wording is decided here, next to the entitlement it
    // reads.
    //
    // #2370: this was a bordered card carrying a title and a sentence — "Layer
    // 1 locked · $0/day", then a paragraph explaining what would unlock it. It
    // is the FIRST ROW of one list now, and the rows under it are the things
    // that change the figure, so the relationship the paragraph described is
    // the layout instead. Three fields rather than two:
    //
    //   title   what this row is ("Signed in" on the ladder, "Your credits"
    //           where there is no ladder to stand on — never "Daily credits",
    //           which is the label the list already sits under)
    //   amount  the figure, or null where there honestly is none
    //   note    one sentence under the list, or null
    //   tone    'warn' for the one state that reports a fault. A locked ladder
    //           is NOT a warning — it is the thing to do next, and the rows
    //           under it say so — so the amber card it used to wear is gone.
    //
    // "Layer 1" is gone on purpose. It is the policy's name for the tier in
    // src/services/limits.js, and a reader has no Layer 0 or Layer 2 to place
    // it against.
    //
    // ONLY the two ladder states say "Signed in · $0 / day". On a deployment
    // whose policy is `legacy` (the default — see IDENTITY_CREDIT_POLICY) or
    // for an account with an administrator override, connecting an account
    // changes nothing about credits, and a list that implied otherwise would
    // be a false promise with a Connect button under it.
    _socialIdentityMoney(cents) {
      const value = Math.max(0, Number(cents) || 0) / 100;
      return globalThis.PlatformI18n.t("settings:value1_day_e8b9a7c0", { value1: Number.isInteger(value) ? value : value.toFixed(2) });
    },

    _socialIdentityTierView(entitlement) {
      const e = entitlement || {};
      const amount = this._socialIdentityMoney(e.limitCents);
      if (e.entitlementAvailable === false) {
        return {
          tone: 'warn',
          done: false,
          get title() { return globalThis.PlatformI18n.t("settings:daily_credits_unavailable_34d88d0b"); },
          amount: null,
          get note() { return globalThis.PlatformI18n.t("settings:we_could_not_check_your_credits_so_calls_we_pay__7d883cca"); },
        };
      }
      if (e.policy === 'legacy') {
        return {
          tone: 'plain',
          done: true,
          get title() { return globalThis.PlatformI18n.t("settings:your_credits_0422797b"); },
          amount,
          get note() { return globalThis.PlatformI18n.t("settings:your_credits_do_not_depend_on_a_connected_accoun_5fffe4b6"); },
        };
      }
      if (e.tier === 'override') {
        return {
          tone: 'plain',
          done: true,
          get title() { return globalThis.PlatformI18n.t("settings:your_credits_0422797b"); },
          amount,
          get note() { return globalThis.PlatformI18n.t("settings:an_administrator_set_this_amount_a_connected_acc_ed2bf45d"); },
        };
      }
      return {
        tone: 'plain',
        done: true,
        get title() { return globalThis.PlatformI18n.t("settings:signed_in_ca566c89"); },
        amount: this._socialIdentityMoney(0),
        get note() { return globalThis.PlatformI18n.t("settings:either_one_is_enough_connecting_both_does_not_ad_56c6a818"); },
      };
    },

    // One provider row. Connection, provider verification, public visibility,
    // replacement confirmation and destructive disconnect stay separate.
    _socialIdentityRowView(provider, link, entitlement, demo, others) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      const actionHref = (intent) => demo
        ? null
        : `/api/me/social-identities/${provider}/connect?intent=${intent}`;
      // #2370: `amount` is the row's figure on the ladder, and it is the
      // reason a row is worth tapping — "$10 / day" sits where "Not connected ·
      // connect X to unlock Layer 1" used to. Two rules keep it honest, both
      // from src/services/limits.js ("provider proofs replace one another;
      // they do not stack"):
      //
      //   * an UNLINKED row carries the figure only while the tier is still
      //     locked. Once one provider has unlocked it, a second "$10 / day"
      //     beside a Connect button reads as a further $10.
      //   * of two LINKED rows, only the first carries it, for the same reason.
      //
      // Off the ladder (`legacy`, an override, an unverifiable entitlement)
      // there is no figure at all, because connecting changes no figure.
      const tiered = entitlement.policy === 'tiered' && entitlement.tier !== 'override'
        && entitlement.entitlementAvailable !== false;
      // The figure limits.js calls TIER_ONE_LIMIT_CENTS. A literal, as the
      // sentence it replaces had it: the status payload reports the CURRENT
      // limit, not what the next tier would be.
      const unlock = '$10 / day';
      const firstLinked = provider === 'github' || !(others && others.github
        && others.github.linked && !others.github.reconnectRequired);
      let state;
      let amount = null;
      if (link.reconnectRequired) {
        state = {
          tone: 'amber',
          get text() { return globalThis.PlatformI18n.t("settings:linked_for_github_attribution_reconnect_once_to__1be5335f"); },
        };
      } else if (link.linked && tiered) {
        state = { tone: 'muted', text: firstLinked ? '' : globalThis.PlatformI18n.t("settings:no_extra_credits_51ae57ea") };
        amount = firstLinked ? unlock : null;
      } else if (link.linked) {
        state = { tone: 'muted', text: '' };
      } else if (link.available === false) {
        state = { tone: 'muted', get text() { return globalThis.PlatformI18n.t("settings:not_set_up_on_this_server_c4806ac0"); } };
      } else {
        state = { tone: 'muted', text: tiered && entitlement.verificationRequired ? '' : globalThis.PlatformI18n.t("settings:not_connected_3b3d2796") };
        amount = tiered && entitlement.verificationRequired ? unlock : null;
      }
      const offersConnect = (!link.linked || link.reconnectRequired) && link.available !== false;
      return {
        provider,
        name,
        // #2370: the title is the provider and nothing else, in every state, so
        // the list's left edge reads the same before and after connecting. The
        // handle moved to the second line: beside the badge and the chevron it
        // was the first thing a 390px row truncated.
        heading: name,
        handle: link.linked && link.handle ? `@${link.handle}` : null,
        // The leading mark: ticked once this row counts, an empty ring while
        // it is still something to do. A reconnect-needed link is NOT ticked,
        // for the reason the badge below is not "Connected".
        done: !!link.linked && !link.reconnectRequired,
        amount,
        // #1557: the durable half of "did that work?". The OAuth round trip
        // already writes a one-line result into #github-link-status, but that
        // line is transient, xs, and a sibling of this block — come back to
        // Settings a minute later and the only thing distinguishing a
        // connected account from an unconnected one was a sentence about
        // credit tiers. The badge says the state itself, on the row it is
        // about. A reconnect-required link is deliberately NOT "Connected":
        // it is linked for attribution and not yet credit-eligible, which is
        // the distinction the amber state text spells out.
        badge: link.reconnectRequired
          ? { get text() { return globalThis.PlatformI18n.t("settings:reconnect_needed_2b0211b3"); }, tone: 'amber' }
          : (link.linked ? { get text() { return globalThis.PlatformI18n.t("settings:connected_22965568"); }, tone: 'emerald' } : null),
        state,
        linkedAt: link.linkedAt && Number.isFinite(Date.parse(link.linkedAt))
          ? globalThis.PlatformI18n.t("settings:linked_value1_dac9750f", { value1: new Date(link.linkedAt).toLocaleString(globalThis.PlatformI18n.getLanguage()) })
          : null,
        noToken: link.linked && link.access === 'identity'
          ? (provider === 'github'
            ? globalThis.PlatformI18n.t("settings:homeroom_holds_no_github_access_token_for_your_a_4aa9ad7d")
            : globalThis.PlatformI18n.t("settings:homeroom_stores_no_x_access_token_for_your_accou_36b721ef"))
          : null,
        connect: offersConnect
          ? {
            // The row's own title already says which provider, so the
            // control is the verb alone; `name` keeps the long form for
            // the accessible name (see social-identity.tsx).
            label: link.reconnectRequired ? globalThis.PlatformI18n.t("settings:reconnect_bf8a9eab") : globalThis.PlatformI18n.t("settings:connect_1a2303ed"),
            // A demo fixture gets the control inert rather than absent: the
            // real flow would navigate straight out of the fixture.
            href: actionHref('connect'),
            intent: 'connect',
          }
          : null,
        refresh: link.linked && !link.reconnectRequired && link.available !== false
          ? { get label() { return globalThis.PlatformI18n.t("settings:refresh_handle_d0bc66fe"); }, href: actionHref('refresh'), intent: 'refresh' }
          : null,
        replace: link.linked && !link.reconnectRequired && link.available !== false
          ? { get label() { return globalThis.PlatformI18n.t("settings:change_account_26639e78"); }, href: actionHref('replace'), intent: 'replace' }
          : null,
        visibility: link.linked && !link.reconnectRequired
          ? { checked: link.publicVisible !== false, disabled: !!demo }
          : null,
        pendingReplacement: link.pendingReplacement && link.handle
          ? {
            currentHandle: link.handle,
            replacementHandle: link.pendingReplacement.handle,
            expiresAt: link.pendingReplacement.expiresAt,
            disabled: !!demo,
          }
          : null,
        unlink: link.linked ? { disabled: !!demo } : null,
        strandedNote: link.pendingAttemptAt
          ? globalThis.PlatformI18n.t("settings:your_last_value1_connection_attempt_didn_t_compl_d01aaec3", { value1: name })
            + 'Try Connect again. This can happen if the browser did not reach the sign-in page or the flow was cancelled. '
            + globalThis.PlatformI18n.t("settings:if_value1_reports_a_callback_or_redirect_address_e9aa09e2", { value1: name })
          : null,
        diagnostics: link.diagnostics
          ? this._socialIdentityDiagnosticsView(provider, link.diagnostics, demo)
          : null,
      };
    },

    // The admin-only configuration panel (#1291): the credential pair in use,
    // the callback URL the developer app must register, and a live check of
    // the pair. The transient halves — the Copy control's "Copied" flash and
    // the check's in-flight/verdict line — are ./social-identity.tsx's own
    // state: they were local variables closed over by a listener, and they
    // never leave that subtree.
    _socialIdentityDiagnosticsView(provider, diagnostics, demo) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      let source;
      if (diagnostics.credentialSource === 'waitlist') {
        source = globalThis.PlatformI18n.t("settings:reusing_the_waitlist_value1_app_s_credentials_09bcf31a", { value1: name });
      } else if (diagnostics.credentialSource === 'dedicated') {
        source = diagnostics.sameAppAsWaitlist
          ? globalThis.PlatformI18n.t("settings:dedicated_value1_credentials_same_app_as_the_wai_d425372a", { value1: name })
          : globalThis.PlatformI18n.t("settings:dedicated_value1_app_credentials_474da8b3", { value1: name });
      } else {
        source = globalThis.PlatformI18n.t("settings:no_complete_value1_credential_pair_is_configured_07d36e09", { value1: name });
      }
      return {
        provider,
        name,
        source,
        callbackUrl: diagnostics.callbackUrl || '',
        warning: globalThis.PlatformI18n.t("settings:if_this_address_isn_t_registered_as_a_callback_u_ee244571", { value1: name })
          + `${name} shows "Something went wrong" before sign-in and never redirects back here.`,
        demo: !!demo,
      };
    },

    // `_socialIdentityAuditNote` / `_githubAuditNote` lived here — the
    // "don't take our word for it" line linking to the provider's own list of
    // authorized apps. It is ./social-identity.tsx's `<AuditNote>` now, with
    // the same top-level-link discipline (target=_blank + noopener), because
    // the shell is framed and neither provider allows being framed.

    _socialIdentityCallbackStatus(status) {
      if (!status) return;
      let result = null;
      let provider = null;
      try {
        const hash = String(window.location.hash || '');
        const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
        const params = new URLSearchParams(query);
        result = params.get('identity');
        provider = params.get('provider');
      } catch { return; }
      if (!result) return;
      const name = provider === 'x' ? 'X' : 'GitHub';
      const messages = {
        linked: globalThis.PlatformI18n.t("settings:value1_connected_9504f2e5", { value1: name }),
        refreshed: globalThis.PlatformI18n.t("settings:value1_handle_refreshed_e25229f0", { value1: name }),
        confirm: globalThis.PlatformI18n.t("settings:another_value1_account_was_verified_review_the_r_2828ef50", { value1: name }),
        in_use: globalThis.PlatformI18n.t("settings:that_value1_account_is_already_linked_to_another_9d60ce22", { value1: name }),
        different_account: globalThis.PlatformI18n.t("settings:that_is_a_different_value1_account_use_change_ac_2e848c19", { value1: name }),
        conflict: globalThis.PlatformI18n.t("settings:that_value1_account_could_not_be_used_your_curre_485a4d20", { value1: name }),
        denied: globalThis.PlatformI18n.t("settings:value1_connection_was_cancelled_f1fce5eb", { value1: name }),
        // #3044: the provider bounced the trip before any sign-in page because
        // Homeroom's callback address is not the one registered on its OAuth
        // app. Not something the viewer did, and not fixed by retrying.
        callback_mismatch: globalThis.PlatformI18n.t("settings:value1_did_not_accept_homeroom_s_callback_addres_f896bec8", { value1: name })
          + globalThis.PlatformI18n.t("settings:ask_an_administrator_to_register_this_site_s_cal_ecfa5a84", { value1: window.location.origin, value2: name }),
        get error() { return globalThis.PlatformI18n.t("settings:value1_could_not_be_connected_try_again_bf3932e0", { value1: name }); },
        get account_mismatch() { return globalThis.PlatformI18n.t("settings:this_browser_is_signed_into_a_different_homeroom_0e49f5f5"); },
      };
      status.textContent = messages[result] || '';
      if (!status.textContent) return;
      status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400');
      status.classList.add(...(['linked', 'refreshed', 'confirm'].includes(result)
        ? ['text-emerald-700', 'dark:text-emerald-400']
        : ['text-red-700', 'dark:text-red-400']));
    },

    async _unlinkGithub(button, provider = 'github') {
      const status = document.getElementById('github-link-status');
      const name = provider === 'x' ? 'X' : 'GitHub';
      const confirmed = await PlatformUI.confirm({
        get title() { return globalThis.PlatformI18n.t("settings:disconnect_value1_bfaedb4d", { value1: name }); },
        get message() { return globalThis.PlatformI18n.t("settings:this_removes_value1_from_your_public_profile_and_7cd20b65", { value1: name }); },
        get confirmLabel() { return globalThis.PlatformI18n.t("settings:disconnect_acfc5be7"); },
        danger: true,
      });
      if (!confirmed) return;
      if (button) button.disabled = true;
      try {
        const response = await fetch(`/api/me/social-identities/${encodeURIComponent(provider)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(globalThis.PlatformI18n.t("settings:could_not_disconnect_value1_d1a40299", { value1: name }));
        await this._refreshSocialIdentitySurfaces();
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_disconnect_this_account_a968c528");
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      }
    },

    // The list host's three states are ./cli-tokens-store.js's phases now, so
    // this reaches the bridge rather than the element.
    _publishCliTokens(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsCliTokens : null;
      if (bridge) bridge.publish(next);
    },

    async _loadCliTokens(reset) {
      const section = document.getElementById('cli-tokens-section');
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!section || !more || !status) return;

      // Don't ask for a surface this deployment doesn't serve — the 404
      // would be a console error even though the code below handles it.
      // Staging disables the real CLI surface, but ?demo=1 is a read-only
      // fixture endpoint specifically meant to make this section reviewable.
      // Let that mock path through while still suppressing every real token
      // request when auth/me advertises cliAuthEnabled=false. The surrounding
      // section remains visible because its local-agent guide is useful even
      // when this deployment cannot list or revoke credentials.
      if (!this._cliTokensDemo() && !(await this._cliAuthAvailable())) {
        return;
      }

      // A reset is authoritative (opening Settings or refreshing after a
      // revocation), so let it supersede an older pagination request. The
      // generation check below prevents that older response/finally block
      // from rendering stale credential state or clearing the new load flag.
      if (!reset && this._cliTokensLoading) return;

      if (reset) {
        this._cliTokenLoadId += 1;
        this._cliTokens = [];
        this._cliTokenCursor = null;
        this._publishCliTokens({ phase: 'loading', tokens: [] });
        more.classList.add('hidden');
        status.classList.add('hidden');
      }
      const loadId = this._cliTokenLoadId;
      this._cliTokensLoading = true;
      more.disabled = true;
      try {
        // The page's ?demo=1 is passed through so the (staging:private,
        // therefore always-empty in a staging clone) credential list has
        // something to render — same pattern as _renderLlmGrants and
        // _renderAgentFilesSection. Strictly a no-op in production.
        const query = this._cliTokenCursor
          ? `?limit=50&cursor=${encodeURIComponent(this._cliTokenCursor)}`
          : '?limit=50';
        const demo = this._cliTokensDemoValue();
        const demoQ = demo ? `&demo=${encodeURIComponent(demo)}` : '';
        const response = await fetch(`/api/me/cli-tokens${query}${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._cliTokenLoadId) return;
        if (response.status === 404) {
          return;
        }
        if (!response.ok) throw new Error(globalThis.PlatformI18n.t("settings:could_not_load_cli_credentials_b21cbedc"));
        const data = await response.json();
        if (!data || !Array.isArray(data.tokens)
            || (data.next_cursor != null && typeof data.next_cursor !== 'string')) {
          throw new Error(globalThis.PlatformI18n.t("settings:the_credential_list_response_was_invalid_291ebc36"));
        }
        section.classList.remove('hidden');
        this._cliTokens.push(...data.tokens);
        this._cliTokenCursor = data.next_cursor || null;
        this._renderCliTokens();
      } catch (err) {
        if (loadId !== this._cliTokenLoadId) return;
        if (!this._cliTokens.length) this._publishCliTokens({ phase: 'idle', tokens: [] });
        status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_load_cli_credentials_b21cbedc");
        status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
        status.classList.add('text-red-700', 'dark:text-red-400');
      } finally {
        if (loadId === this._cliTokenLoadId) {
          this._cliTokensLoading = false;
          more.disabled = false;
        }
      }
    },

    _renderCliTokens() {
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!more || !status) return;
      status.classList.add('hidden');
      // The ROWS are ./cli-tokens-list.tsx's — a card each, built here with
      // `document.createElement` until #1191. Every branch it evaluated is
      // resolved here, where the payload and the demo flag live: the two date
      // formats, the status line, and whether a row may be revoked at all (a
      // staging demo row is fabricated server-side and has nothing to revoke).
      this._publishCliTokens({
        phase: 'ready',
        tokens: this._cliTokens.map((token) => {
          const created = Number.isFinite(Date.parse(token.created_at))
            ? new Date(token.created_at).toLocaleString(globalThis.PlatformI18n.getLanguage()) : globalThis.PlatformI18n.t("settings:unknown_date_bced143d");
          const used = token.last_used_at && Number.isFinite(Date.parse(token.last_used_at))
            ? globalThis.PlatformI18n.t("settings:last_used_value1_8867dad3", { value1: new Date(token.last_used_at).toLocaleString(globalThis.PlatformI18n.getLanguage()) }) : '';
          return {
            id: typeof token.id === 'string' ? token.id : null,
            hint: typeof token.token_hint === 'string' ? token.token_hint : globalThis.PlatformI18n.t("settings:cli_credential_fed39a0d"),
            detail: globalThis.PlatformI18n.t("settings:value1_created_value2_value3_ba6d7069", { value1: token.status || globalThis.PlatformI18n.t("settings:message_b23a6a8439c0"), value2: created, value3: used }),
            revocable: token.status === 'valid'
              && typeof token.id === 'string' && !token.demo,
          };
        }),
      });
      // Both SIBLINGS of that host, and both still this module's: the
      // Load-more button follows the keyset cursor, and the status line has
      // three writers (revoke succeeded, revoke failed, demo data).
      more.classList.toggle('hidden', !this._cliTokenCursor);
      if (this._cliTokensDemo() && this._cliTokens.some((t) => t.demo)) {
        status.textContent = globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930");
        status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400');
      }
    },

    async _revokeCliToken(id, button) {
      const status = document.getElementById('cli-tokens-status');
      button.disabled = true;
      try {
        const response = await fetch(`/api/me/cli-tokens/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (response.status !== 204) throw new Error(globalThis.PlatformI18n.t("settings:could_not_revoke_the_credential_6d3c955f"));
        if (status) {
          status.textContent = globalThis.PlatformI18n.t("settings:credential_revoked_fa8d9935");
          status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400');
          status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        }
        await this._loadCliTokens(true);
      } catch (err) {
        if (status) {
          status.textContent = err.message || globalThis.PlatformI18n.t("settings:could_not_revoke_the_credential_6d3c955f");
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
        button.disabled = false;
      }
    },

    async _saveLocale(value) {
      const select = document.getElementById('settings-locale');
      const status = document.getElementById('settings-locale-status');
      const language = globalThis.PlatformI18n;
      const request = this._localeSaveRequest = (this._localeSaveRequest || 0) + 1;
      const show = (key, failed = false) => {
        if (!status || request !== this._localeSaveRequest) return;
        status.textContent = language.t(key);
        status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-red-700', 'dark:text-red-400');
        status.classList.add(...(failed ? ['text-red-700', 'dark:text-red-400'] : ['text-emerald-700', 'dark:text-emerald-400']));
      };
      let saving = false;
      show('language.loading');
      try {
        const changed = await language.changeLanguage(value || null, async preference => {
          saving = true;
          const r = await fetch('/api/me/locale', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin', body: JSON.stringify({ locale: preference }),
          });
          if (!r.ok) throw new Error('language-save');
        });
        if (!changed || request !== this._localeSaveRequest) return;
        this.state.locale = value || null;
        if (typeof App !== 'undefined' && App.user) App.user.locale = this.state.locale;
        if (typeof AppView !== 'undefined') AppView.notifyLocaleChanged?.(this.state.locale);
        this._renderNav();
        show('language.saved');
      } catch {
        if (request !== this._localeSaveRequest) return;
        if (select) select.value = this.state.locale || '';
        show(saving ? 'language.saveFailed' : 'language.loadFailed', true);
      }
    },

    // Same shape as _saveLocale: POST on change, revert the select and paint
    // the status line on failure, mirror onto App.user so anything reading
    // the cached user (the dev-chat picker) sees the new value immediately.
    async _saveDevFlow(value) {
      const select = document.getElementById('settings-dev-flow');
      const status = document.getElementById('settings-dev-flow-status');
      const fail = (msg) => {
        if (select) select.value = this.state.devFlowPreference || '';
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      };
      try {
        const r = await fetch('/api/me/dev-flow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ flow: value || null }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"));
        this.state.devFlowPreference = j.flow || null;
        if (typeof App !== 'undefined' && App.user) App.user.devFlowPreference = this.state.devFlowPreference;
        if (status) {
          status.textContent = globalThis.PlatformI18n.t("settings:saved_45edcc20");
          status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        }
      } catch (err) {
        fail(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }));
      }
    },

    async _saveAiProgressEstimate(enabled) {
      const toggle = document.getElementById('ai-progress-estimate');
      const status = document.getElementById('ai-progress-estimate-status');
      const fail = (msg) => {
        if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      };
      try {
        const r = await fetch('/api/me/ai-progress-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"));
        }
        this.state.aiProgressEstimate = !!enabled;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }));
      }
    },

    // #1281: opt in to the session-CLI bridge. A failed save reverts the
    // checkbox to the stored value rather than leaving it showing a
    // preference the server never took — the venue list is painted from
    // App.user, so a lying checkbox would be a venue that never appears.
    async _saveSessionBridge(enabled) {
      const toggle = document.getElementById('session-bridge-enabled');
      const status = document.getElementById('session-bridge-status');
      const fail = (msg) => {
        if (toggle) toggle.checked = !!this.state.sessionBridgeEnabled;
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      };
      try {
        const r = await fetch('/api/me/session-bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"));
        }
        this.state.sessionBridgeEnabled = !!enabled;
        // The venue pickers read App.user, not Settings.state, so the live
        // object has to move with it or the next sheet opened in this same
        // page load would still be missing the row that was just enabled.
        if (typeof App !== 'undefined' && App.user) App.user.sessionBridgeEnabled = !!enabled;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }));
      }
    },

    // #3624: put this account on the Homeroom bot's DM list, or take it off.
    // A refused save (the list is full: 409) reverts the checkbox and says
    // why, the same as the toggles above. The create dialog asks for a
    // project description from App.user.homeroomBotDm, so the live object
    // moves with it, as the session bridge's does.
    async _saveHomeroomBotDm(enabled) {
      const toggle = document.getElementById('homeroom-bot-dm-enabled');
      const status = document.getElementById('homeroom-bot-dm-status');
      const fail = (msg) => {
        if (toggle) toggle.checked = !!this.state.homeroomBotDm;
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      };
      try {
        const r = await fetch('/api/me/homeroom-bot-dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"));
        }
        this.state.homeroomBotDm = !!enabled;
        if (typeof App !== 'undefined' && App.user) App.user.homeroomBotDm = !!enabled;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }));
      }
    },

    // Show the admin-preview section only when the server reports the
    // user as a *real* admin. App._realIsAdmin is the un-masked value
    // captured in app.js before the localStorage override gets
    // applied; reading App.user.isAdmin here would be wrong because
    // it reflects the masked state, which would hide the toggle
    // forever once flipped on.
    //
    // Fallback: if `_realIsAdmin` is undefined (e.g. a stale-cached
    // app.js from before that flag was added), fall back to the live
    // `App.user.isAdmin`. Safe because a stale app.js can't have
    // applied the mask either, so the live value still reflects the
    // server truth. `??` (not `||`) so an explicit `false` from a
    // current-cache app.js wins over the fallback.
    _renderAdminSection() {
      const section = document.getElementById('settings-admin-section');
      const toggle = document.getElementById('view-as-non-admin');
      if (!section || !toggle) return;
      // Read the bare `App` identifier rather than `window.App` —
      // app.js declares `App` with `const`, which does NOT write to
      // `window` in non-module browser scripts, so `window.App` is
      // undefined. Using the bare identifier matches the rest of the
      // codebase (dev-chat.js etc.). Fallback to `App.user.isAdmin`
      // covers a stale-cached app.js from before `_realIsAdmin` was
      // introduced; safe because a stale app.js can't have applied
      // the mask either, so the live value still reflects the server
      // truth. `??` (not `||`) so an explicit `false` from a current
      // app.js wins over the fallback.
      const realAdmin = (typeof App !== 'undefined' ? App._realIsAdmin : undefined)
        ?? (typeof App !== 'undefined' && !!App.user?.isAdmin);
      if (!realAdmin) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');
      toggle.checked = localStorage.getItem('viewAsNonAdmin') === '1';
    },

    // Called by App._exitSettings once the screen is hidden. No section
    // polls, so there is no per-section teardown to run (the admin
    // console's _teardownActiveSection has no analogue here) — just the two
    // lifecycle timers and the never-persisted key field.
    close() {
      Settings._open = false;
      Settings._pushedFromMenu = false;
      Settings._pendingSection = null;
      const input = document.getElementById('settings-api-key');
      if (input) input.value = '';
      this._stopWalletPolling();
      this._clearAlertsTestCountdown();
      this._clearUsernodeAuthStatusRetry();
      this._mobilePushLoadToken += 1;
    },

    // Clear the "Send a test alert" countdown interval (#138). Idempotent —
    // safe to call when none is running (rapid re-clicks, modal close).
    _clearAlertsTestCountdown() {
      if (this._alertsTestTimer) {
        clearInterval(this._alertsTestTimer);
        this._alertsTestTimer = null;
      }
    },

    _mobilePushRows() {
      return [...document.querySelectorAll(
        '#settings-mobile-push-preferences [data-mobile-push-category]'
      )];
    },

    _setMobilePushPreferences(preferences) {
      if (!Array.isArray(preferences)) throw new Error(globalThis.PlatformI18n.t("settings:invalid_preferences_response_6de55751"));
      const next = {};
      for (const preference of preferences) {
        if (!preference || typeof preference.key !== 'string'
            || typeof preference.enabled !== 'boolean') {
          throw new Error(globalThis.PlatformI18n.t("settings:invalid_preferences_response_6de55751"));
        }
        next[preference.key] = preference.enabled;
      }
      for (const row of this._mobilePushRows()) {
        if (typeof next[row.dataset.mobilePushCategory] !== 'boolean') {
          throw new Error(globalThis.PlatformI18n.t("settings:incomplete_preferences_response_0886bd4d"));
        }
      }
      this._mobilePushPreferences = next;
    },

    _renderMobilePushPreferences(message, error) {
      const disabled = this._mobilePushLoading
        || this._mobilePushSaving
        || !this._mobilePushPreferences;
      for (const row of this._mobilePushRows()) {
        const input = row.querySelector('input[type="checkbox"]');
        if (!input) continue;
        const saved = this._mobilePushPreferences?.[row.dataset.mobilePushCategory];
        if (typeof saved === 'boolean') input.checked = saved;
        input.disabled = disabled;
      }
      const status = document.querySelector(
        '#settings-mobile-push-preferences [data-mobile-push-status]'
      );
      if (!status) return;
      status.textContent = message || (disabled ? globalThis.PlatformI18n.t("settings:loading_mobile_push_preferences_21318fa1") : globalThis.PlatformI18n.t("settings:saved_to_your_account_de0e217a"));
      status.className = 'text-xs mt-3 ' + (error
        ? 'text-red-700 dark:text-red-400'
        : 'text-zinc-500 dark:text-zinc-400');
    },

    async _loadMobilePushPreferences() {
      const token = ++this._mobilePushLoadToken;
      this._mobilePushLoading = true;
      this._renderMobilePushPreferences(globalThis.PlatformI18n.t("settings:loading_mobile_push_preferences_21318fa1"));
      try {
        const response = await fetch('/api/me/mobile-push-preferences', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (token !== this._mobilePushLoadToken) return;
        this._setMobilePushPreferences(body.preferences);
        this._mobilePushLoading = false;
        this._renderMobilePushPreferences(globalThis.PlatformI18n.t("settings:saved_to_your_account_de0e217a"));
      } catch (err) {
        if (token !== this._mobilePushLoadToken) return;
        this._mobilePushLoading = false;
        this._mobilePushPreferences = null;
        this._renderMobilePushPreferences(
          globalThis.PlatformI18n.t("settings:could_not_load_mobile_push_preferences_value1_eb4a3dbc", { value1: err.message }), true
        );
      }
    },

    async _saveMobilePushPreference(category, enabled) {
      if (!this._mobilePushPreferences || this._mobilePushSaving
          || typeof this._mobilePushPreferences[category] !== 'boolean') {
        this._renderMobilePushPreferences();
        return;
      }
      const previous = this._mobilePushPreferences[category];
      this._mobilePushPreferences[category] = !!enabled;
      this._mobilePushSaving = true;
      this._renderMobilePushPreferences('Saving…');
      try {
        const response = await fetch('/api/me/mobile-push-preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ preferences: { [category]: !!enabled } }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        this._setMobilePushPreferences(body.preferences);
        this._mobilePushSaving = false;
        this._renderMobilePushPreferences(globalThis.PlatformI18n.t("settings:saved_to_your_account_de0e217a"));
      } catch (err) {
        this._mobilePushPreferences[category] = previous;
        this._mobilePushSaving = false;
        this._renderMobilePushPreferences(globalThis.PlatformI18n.t("settings:could_not_save_value1_fbc8fcc2", { value1: err.message }), true);
        if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:could_not_save_mobile_push_preferences_7c9cc454"));
      }
    },

    _renderBody() {
      const display = document.getElementById('settings-key-display');
      const last4 = document.getElementById('settings-key-last4');
      const removeBtn = document.getElementById('settings-remove');
      const saveBtn = document.getElementById('settings-save');
      const input = document.getElementById('settings-api-key');

      if (this.state.hasApiKey) {
        display.classList.remove('hidden');
        last4.textContent = this.state.keyLast4 || '••••';
        removeBtn.classList.remove('hidden');
        input.placeholder = globalThis.PlatformI18n.t("settings:paste_a_new_key_to_replace_8a347fdf");
        saveBtn.textContent = globalThis.PlatformI18n.t("settings:replace_95e15439");
      } else {
        display.classList.add('hidden');
        removeBtn.classList.add('hidden');
        input.placeholder = globalThis.PlatformI18n.t("settings:sk_ant_dda59792");
        saveBtn.textContent = globalThis.PlatformI18n.t("settings:save_1509f561");
      }
    },

    // #119 — "Today's spend" breakdown in the API-key section. Fetched
    // fresh on every modal open; the block stays hidden while loading,
    // on fetch failure, or when no key is saved, so it never shows
    // stale or irrelevant figures.
    async _refreshSpend() {
      const block = document.getElementById('settings-spend');
      if (!block) return;
      block.classList.add('hidden');
      if (!this.state.hasApiKey) return;
      try {
        const r = await fetch('/api/budget', { credentials: 'same-origin' });
        if (!r.ok) return;
        const b = await r.json();
        document.getElementById('settings-spend-byok').textContent =
          '$' + ((b.byokSpentCents || 0) / 100).toFixed(2);
        document.getElementById('settings-spend-platform').textContent =
          globalThis.PlatformI18n.t("core:value1_of_value2_4cb1b875", { value1: ((b.spentCents || 0) / 100).toFixed(2), value2: ((b.limitCents || 0) / 100).toFixed(2) });
        // #3230: the weekly reset in the viewer's own clock, UTC on hover.
        const reset = document.getElementById('settings-spend-reset');
        const RT = window.ResetTime;
        if (reset && RT) {
          const cadence = b.capWindow === 'daily' ? 'daily' : 'weekly';
          reset.textContent = globalThis.PlatformI18n.t("settings:resets_value1_21e183c2", { value1: RT.resetWhen(cadence, { at: b.resetsAt }) });
          reset.title = RT.resetUtc(cadence, { at: b.resetsAt });
        }
        block.classList.remove('hidden');
      } catch {}
    },

    _setStatus(text, kind) {
      const el = document.getElementById('settings-status');
      paintStatus(el, text, kind);
    },

    _clearStatus() {
      const el = document.getElementById('settings-status');
      el.classList.add('hidden');
      el.textContent = '';
    },

    async save() {
      const input = document.getElementById('settings-api-key');
      const saveBtn = document.getElementById('settings-save');
      const removeBtn = document.getElementById('settings-remove');
      const key = input.value.trim();
      if (!key) {
        // When replacing but the user hit Save with an empty input,
        // that's almost certainly a misclick — treat as a no-op rather
        // than clearing the existing key.
        this._setStatus(globalThis.PlatformI18n.t("settings:paste_an_api_key_first_448710dc"), 'error');
        return;
      }

      this._setStatus(globalThis.PlatformI18n.t("settings:verifying_with_anthropic_cabd4656"), 'info');
      saveBtn.disabled = true;
      removeBtn.disabled = true;

      try {
        const r = await fetch('/api/me/api-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ key }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_key_2ca6410d"), 'error');
          return;
        }
        this.state.hasApiKey = true;
        this.state.keyLast4 = j.keyLast4 || key.slice(-4);
        this._renderIndicator();
        this._setStatus(globalThis.PlatformI18n.t("settings:saved_your_chats_now_bill_to_your_anthropic_acco_94373a53"), 'ok');
        input.value = '';
        this._renderBody();
        this._refreshSpend();
        // Settings is a screen now, not a modal — a successful save leaves
        // the success status visible in place instead of navigating away.
      } catch (err) {
        this._setStatus(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }), 'error');
      } finally {
        saveBtn.disabled = false;
        removeBtn.disabled = false;
      }
    },

    // ── OpenRouter (BYOK) ──────────────────────────────────────
    _normalizeOpenRouterCopy() {
      const section = document.querySelector('[data-settings-section="openrouter"]');
      if (!section) return;
      const heading = section.querySelector('h3');
      const intro = section.querySelector('p');
      const modelLabel = section.querySelector('label[for="settings-openrouter-model"]');
      if (heading) heading.textContent = globalThis.PlatformI18n.t("settings:openrouter_eb70c3bc");
      if (intro) {
        // #3296: the one worker detail worth naming. The platform runs some
        // OpenRouter models in Claude Code, and the model list tags them; the
        // default runner stays unnamed, like every other implementation
        // detail. sections/openrouter.tsx renders this same text statically.
        intro.textContent = globalThis.PlatformI18n.t("settings:use_any_compatible_model_for_all_chat_and_coding_227eef10");
      }
      if (modelLabel) modelLabel.textContent = globalThis.PlatformI18n.t("settings:openrouter_model_dd24ac61");
    },

    _formatOpenRouterPrice(value) {
      if (value == null || value === '') return null;
      const price = Number(value);
      if (!Number.isFinite(price) || price < 0) return null;
      if (price === 0) return '$0';
      const decimals = price < 0.01 ? 4 : price < 10 ? 2 : price < 100 ? 1 : 0;
      const fixed = price.toFixed(decimals);
      const compact = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
      return `$${compact}`;
    },

    _openRouterModelCostSummary(model) {
      const tier = {
        get free() { return globalThis.PlatformI18n.t("settings:free_f411a1fb"); },
        get low() { return globalThis.PlatformI18n.t("settings:low_cost_607264ad"); },
        get medium() { return globalThis.PlatformI18n.t("settings:medium_cost_7c196404"); },
        get high() { return globalThis.PlatformI18n.t("settings:high_cost_d6d2e413"); },
        get unknown() { return globalThis.PlatformI18n.t("settings:price_unavailable_6a9e657b"); },
      }[model?.costTier] || globalThis.PlatformI18n.t("settings:price_unavailable_6a9e657b");
      const input = this._formatOpenRouterPrice(model?.inputPricePerMillion);
      const output = this._formatOpenRouterPrice(model?.outputPricePerMillion);
      if (!input && !output) return tier;
      return globalThis.PlatformI18n.t("settings:value1_value2_m_input_value3_m_output_13d31257", { value1: tier, value2: input || '?', value3: output || '?' });
    },

    _openRouterModelOptionLabel(model) {
      const badges = [];
      if (model?.isFavorite) badges.push('★');
      if (model?.isRecommended) badges.push(globalThis.PlatformI18n.t("settings:recommended_d70604e8"));
      // #3296: the platform runs some OpenRouter models in Claude Code rather
      // than Codex. Only that exception is named; Codex is every other row.
      if (model?.harness === 'claude') badges.push(globalThis.PlatformI18n.t("settings:claude_code_246ef8c1"));
      if (model?.createdAt) {
        const age = Date.now() - Date.parse(model.createdAt);
        if (Number.isFinite(age) && age >= 0 && age <= 30 * 24 * 60 * 60 * 1000) badges.push(globalThis.PlatformI18n.t("settings:new_18fdd549"));
      }
      const compatibility = model?.compatibility === 'verified'
        ? ' · verified'
        : (model?.compatibility === 'blocked' ? ' · limited' : ' · unverified');
      const badgeText = badges.length ? ` · ${badges.join(' · ')}` : '';
      return `${model?.name || model?.id || globalThis.PlatformI18n.t("settings:unknown_model_38951853")}${badgeText}: ${this._openRouterModelCostSummary(model)}${compatibility}`;
    },

    _openRouterModelsForPicker(models, { query = '', favoritesOnly = false } = {}) {
      const needle = String(query || '').trim().toLocaleLowerCase();
      return (Array.isArray(models) ? models : [])
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => {
          if (favoritesOnly && model?.isFavorite !== true) return false;
          if (!needle) return true;
          return [model?.name, model?.id, model?.provider, model?.canonicalSlug]
            .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
        })
        .sort((a, b) => {
          if (!!a.model?.isFavorite !== !!b.model?.isFavorite) return a.model?.isFavorite ? -1 : 1;
          if (!!a.model?.isRecommended !== !!b.model?.isRecommended) return a.model?.isRecommended ? -1 : 1;
          return a.index - b.index;
        })
        .map(({ model }) => model);
    },

    _openRouterCatalogAgeText(refreshedAt) {
      const refreshed = Date.parse(refreshedAt || '');
      if (!Number.isFinite(refreshed)) return '';
      const seconds = Math.max(0, Math.round((Date.now() - refreshed) / 1000));
      if (seconds < 60) return globalThis.PlatformI18n.t("settings:updated_just_now_c5cb2e53");
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return globalThis.PlatformI18n.t("settings:updated_value1_m_ago_2da5a691", { value1: minutes });
      return globalThis.PlatformI18n.t("settings:updated_value1_h_ago_fdacad77", { value1: Math.round(minutes / 60) });
    },

    _renderOpenRouterModelOptions() {
      const select = document.getElementById('settings-openrouter-model');
      if (!select) return;
      const search = document.getElementById('settings-openrouter-model-search');
      const favoritesOnlyButton = document.getElementById('settings-openrouter-favorites-only');
      const meta = document.getElementById('settings-openrouter-catalog-meta');
      const visibleModels = this._openRouterModelsForPicker(this._openRouterModels, {
        query: search?.value || '',
        favoritesOnly: this._openRouterFavoritesOnly,
      });
      select.innerHTML = '';
      for (const model of visibleModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = this._openRouterModelOptionLabel(model);
        select.appendChild(option);
      }
      if (!visibleModels.some((model) => model.id === this._openRouterSelectedModelId)) {
        const fallback = visibleModels.find((model) => model.id === this._openRouterRecommendedModelId)
          || visibleModels.find((model) => model.isRecommended)
          || visibleModels[0]
          || null;
        if (fallback) this._openRouterSelectedModelId = fallback.id;
      }
      select.value = visibleModels.some((model) => model.id === this._openRouterSelectedModelId)
        ? this._openRouterSelectedModelId
        : '';
      select.disabled = visibleModels.length === 0;
      if (favoritesOnlyButton) {
        favoritesOnlyButton.setAttribute('aria-pressed', String(this._openRouterFavoritesOnly));
        favoritesOnlyButton.textContent = this._openRouterFavoritesOnly ? globalThis.PlatformI18n.t("settings:favorites_68b313bd") : globalThis.PlatformI18n.t("settings:favorites_c2a2f40a");
      }
      if (meta) {
        const age = this._openRouterCatalogAgeText(this._openRouterCatalogRefreshedAt);
        meta.textContent = visibleModels.length
          ? globalThis.PlatformI18n.t("settings:value1_of_value2_models_value3_097ae2d7", { value1: visibleModels.length, value2: this._openRouterCatalogTotal || this._openRouterModels.length, value3: age ? ` · ${age}` : '' })
          : globalThis.PlatformI18n.t("settings:no_models_match_clear_the_search_or_show_all_mod_0a6c4f43", { value1: age ? ` · ${age}` : '' });
      }
      this._syncOpenRouterModelDetails();
    },

    // #2600: the reasoning-effort picker's first choice is a real level, not
    // an absence of one, so name the level the platform runs at when nobody
    // has chosen. The server is the only thing that knows it; if the read
    // fails the option keeps its plain wording rather than inventing a level.
    _labelOpenRouterDefaultEffort(effort) {
      const select = document.getElementById('settings-openrouter-reasoning');
      const option = Array.from(select?.options || []).find((item) => item.value === '');
      if (!option) return;
      const names = {
        get minimal() { return globalThis.PlatformI18n.t("settings:minimal_057b5de4"); }, get low() { return globalThis.PlatformI18n.t("settings:low_f793de20"); }, get medium() { return globalThis.PlatformI18n.t("settings:medium_8e588cd1"); }, get high() { return globalThis.PlatformI18n.t("settings:high_c4ebc6d4"); }, get xhigh() { return globalThis.PlatformI18n.t("settings:extra_high_70eb321d"); },
      };
      const name = names[String(effort || '')] || null;
      option.textContent = name ? globalThis.PlatformI18n.t("settings:default_value1_03afaf7e", { value1: name }) : globalThis.PlatformI18n.t("settings:default_21b111cb");
    },

    _syncOpenRouterModelDetails() {
      const select = document.getElementById('settings-openrouter-model');
      const effort = document.getElementById('settings-openrouter-reasoning');
      const model = this._openRouterModels.find((item) => item.id === select?.value) || null;
      const star = document.getElementById('settings-openrouter-star-model');
      const saveDefault = document.getElementById('settings-openrouter-set-default');
      if (!model) {
        if (select) select.title = globalThis.PlatformI18n.t("settings:models_are_sorted_by_average_input_output_price__8ea7846a");
        if (effort) effort.disabled = true;
        if (star) {
          star.disabled = true;
          star.textContent = '☆';
          star.setAttribute('aria-pressed', 'false');
        }
        if (saveDefault) saveDefault.disabled = true;
        return;
      }
      if (saveDefault) saveDefault.disabled = false;
      if (star) {
        star.disabled = false;
        star.textContent = model.isFavorite ? '★' : '☆';
        star.setAttribute('aria-pressed', String(model.isFavorite === true));
        const label = model.isFavorite
          ? globalThis.PlatformI18n.t("settings:remove_selected_model_from_favorites_af86f296")
          : globalThis.PlatformI18n.t("settings:add_selected_model_to_favorites_a079bd1c");
        star.setAttribute('aria-label', label);
        star.title = label;
      }
      let compatibility = globalThis.PlatformI18n.t("settings:not_yet_verified_for_repository_coding_58297943");
      if (model.compatibility === 'verified') compatibility = globalThis.PlatformI18n.t("settings:verified_for_repository_coding_3e7a6d2a");
      else if (!model.meetsCodexMinimums) {
        compatibility = model.compatibilityNote
          || globalThis.PlatformI18n.t("settings:this_model_may_lack_repository_tools_or_enough_c_7726660c");
      }
      if (select) select.title = globalThis.PlatformI18n.t("settings:value1_value2_actual_spend_depends_on_token_usag_ed219726", { value1: this._openRouterModelCostSummary(model), value2: compatibility });
      if (effort) {
        effort.disabled = model.supportsReasoning !== true;
        if (effort.disabled) effort.value = '';
        effort.title = effort.disabled
          ? globalThis.PlatformI18n.t("settings:this_model_does_not_expose_reasoning_effort_cont_ee224d3d")
          : globalThis.PlatformI18n.t("settings:how_long_this_model_thinks_before_it_answers_def_b8271769");
      }
    },

    _setOrStatus(text, kind) {
      const el = document.getElementById('settings-openrouter-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    async _refreshOpenRouter() {
      const display = document.getElementById('settings-openrouter-key-display');
      const last4 = document.getElementById('settings-openrouter-key-last4');
      const info = document.getElementById('settings-openrouter-key-info');
      const removeBtn = document.getElementById('settings-openrouter-remove');
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const modelsWrap = document.getElementById('settings-openrouter-models-wrap');
      const includedCard = document.getElementById('settings-openrouter-included');
      const includedStatus = document.getElementById('settings-openrouter-included-status');
      const personalControls = document.getElementById('settings-openrouter-personal-controls');
      try {
        // #2568: reading this is also what creates an included key for an
        // account that somehow has none, so it stays ahead of the status
        // line below. `codexAvailable` is a deployment switch now, not a
        // per-account allowlist: off means the whole section has nothing
        // to offer.
        const r = await fetch('/api/me/coding-agent', { credentials: 'same-origin' });
        const prefs = r.ok ? await r.json() : {};
        if (!prefs.codexAvailable) {
          if (includedCard) includedCard.classList.add('hidden');
          if (modelsWrap) modelsWrap.classList.add('hidden');
          return;
        }
        this._labelOpenRouterDefaultEffort(prefs.defaultReasoningEffort);
      } catch {}
      try {
        const r = await fetch('/api/me/credentials/openrouter', { credentials: 'same-origin' });
        const j = r.ok ? await r.json() : {};
        const managed = j.managed || null;
        const provisioning = j.managedProvisioning || {};
        // #2568: a STATUS line, not a claim card. It says whether the key is
        // there, its last four and its allowance — and, when it is not
        // there, what is standing in the way rather than what to press.
        if (includedCard) includedCard.classList.toggle('hidden', !provisioning.available && !managed);
        if (includedStatus) {
          const managedLast4 = managed && j.source === 'usernode_managed' ? j.last4 : null;
          if (managed?.status === 'active') {
            // The key carries the platform's weekly allowance; a key issued
            // before that policy keeps its own limit until it is re-limited.
            const amount = `$${Number(managed.limitUsd || 0).toFixed(2)}`;
            const carries = managed.limitReset === 'weekly'
              ? globalThis.PlatformI18n.t("settings:carries_the_platform_s_value1_weekly_allowance_727b8587", { value1: amount })
              : globalThis.PlatformI18n.t("settings:carries_a_value1_value2_until_it_is_moved_to_the_3c26ce82", { value1: amount, value2: limitNoun(managed.limitReset) });
            const tail = managedLast4 ? ` (sk-or-…${managedLast4})` : '';
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:active_value1_it_value2_and_you_may_choose_any_a_c17c84ca", { value1: tail, value2: carries });
          } else if (managed?.status === 'disabled') {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:an_admin_has_blocked_this_included_key_contact_t_45ec7fb3");
          } else if (managed?.status === 'deleted') {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:your_included_key_was_deleted_by_an_admin_includ_a443323b");
          } else if (managed?.status === 'needs_review' || managed?.status === 'provisioning') {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:this_key_needs_admin_review_homeroom_did_not_ret_923657ec");
          } else if (!provisioning.available) {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:included_keys_are_not_configured_by_the_platform_932b735f");
          } else if (provisioning.reason === 'no_allowance') {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:your_account_has_no_included_weekly_allowance_ri_f5756fb1");
          } else if (provisioning.reason === 'personal_key_configured') {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:you_are_using_your_own_openrouter_key_remove_it__3a795bfd");
          } else {
            includedStatus.textContent = globalThis.PlatformI18n.t("settings:your_included_key_is_being_set_up_it_carries_the_a66b83cc", { value1: Number(provisioning.limitUsd || 0).toFixed(2), value2: limitNoun(provisioning.limitReset, 'allowance') });
          }
        }
        const managedOwnsCredential = !!managed && managed.status !== 'deleted';
        if (personalControls) personalControls.classList.toggle('hidden', managedOwnsCredential);
        if (j.configured) {
          if (display) display.classList.remove('hidden');
          if (last4) last4.textContent = j.last4 || '••••';
          if (removeBtn) removeBtn.classList.toggle('hidden', managedOwnsCredential);
          if (input) { input.placeholder = globalThis.PlatformI18n.t("settings:paste_a_new_key_to_replace_8a347fdf"); input.value = ''; }
          if (saveBtn) saveBtn.textContent = globalThis.PlatformI18n.t("settings:replace_95e15439");
          if (info && (j.keyInfo || managed)) {
            info.classList.remove('hidden');
            const lim = j.keyInfo?.limit != null ? `$${j.keyInfo.limit}` : '';
            const rem = j.keyInfo?.limitRemaining != null ? `$${j.keyInfo.limitRemaining}` : '';
            const owner = managedOwnsCredential ? 'Homeroom-managed' : globalThis.PlatformI18n.t("settings:personal_key_e0ec7d23");
            // The stored managed-key cadence is authoritative; a personal
            // key's comes from OpenRouter's own key-info.
            const noun = limitNoun((managedOwnsCredential && managed.limitReset) || j.keyInfo?.limitReset);
            const label = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
            info.textContent = lim ? globalThis.PlatformI18n.t("settings:value1_value2_value3_remaining_value4_a5e43513", { value1: owner, value2: label, value3: lim, value4: rem }) : `${owner} · ${j.keyInfo?.label || ''}`;
          }
          await this._loadOpenRouterModels();
        } else {
          if (display) display.classList.add('hidden');
          if (removeBtn) removeBtn.classList.add('hidden');
          if (input) input.placeholder = globalThis.PlatformI18n.t("settings:sk_or_51efae34");
          if (saveBtn) saveBtn.textContent = globalThis.PlatformI18n.t("settings:test_save_634dbaab");
          if (info) info.classList.add('hidden');
          if (modelsWrap) modelsWrap.classList.add('hidden');
        }
      } catch {}
    },

    async _loadOpenRouterModels({ forceRefresh = false } = {}) {
      const sel = document.getElementById('settings-openrouter-model');
      const wrap = document.getElementById('settings-openrouter-models-wrap');
      if (!sel) return;
      try {
        const refresh = forceRefresh ? '&refresh=1' : '';
        const r = await fetch(`/api/me/coding-agent/models?backend=codex_openrouter${refresh}`, {
          credentials: 'same-origin', cache: 'no-store',
        });
        const errorBody = r.ok ? null : await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(errorBody?.error || globalThis.PlatformI18n.t("settings:could_not_load_openrouter_models_50eb99bd"));
        const cat = await r.json();
        const models = Array.isArray(cat.models) ? cat.models : [];
        this._openRouterModels = models;
        this._openRouterRecommendedModelId = cat.recommendedModelId || '';
        this._openRouterCatalogRefreshedAt = cat.refreshedAt || null;
        this._openRouterCatalogTotal = Number.isInteger(cat.totalModels) ? cat.totalModels : models.length;
        if (!models.length) {
          this._openRouterSelectedModelId = '';
          this._renderOpenRouterModelOptions();
          if (wrap) wrap.classList.remove('hidden');
          return;
        }
        const recommended = models.some((model) => model.id === cat.recommendedModelId)
          ? cat.recommendedModelId
          : (models.find((model) => model.isRecommended)?.id
            || models.find((model) => model.compatibility === 'verified')?.id
            || models[0].id);
        if (!forceRefresh || !models.some((model) => model.id === this._openRouterSelectedModelId)) {
          this._openRouterSelectedModelId = recommended;
        }
        if (!forceRefresh) {
          // Restore the previously-saved model/effort on the initial load.
          const prefs = await (await fetch('/api/me/coding-agent', {
            credentials: 'same-origin', cache: 'no-store',
          })).json();
          const saved = prefs.backends?.codex_openrouter;
          if (saved?.model && models.some((model) => model.id === saved.model)) {
            this._openRouterSelectedModelId = saved.model;
          }
          const eff = document.getElementById('settings-openrouter-reasoning');
          if (eff) eff.value = saved?.reasoningEffort || '';
        }
        this._renderOpenRouterModelOptions();
        if (wrap) wrap.classList.remove('hidden');
      } catch (err) {
        if (!this._openRouterModels.length && wrap) wrap.classList.add('hidden');
        throw err;
      }
    },

    async _refreshOpenRouterModelsNow() {
      const button = document.getElementById('settings-openrouter-refresh-models');
      if (button) { button.disabled = true; button.textContent = globalThis.PlatformI18n.t("settings:refreshing_1c0def7b"); }
      this._setOrStatus('Refreshing the key-visible catalog from OpenRouter…', 'info');
      try {
        await this._loadOpenRouterModels({ forceRefresh: true });
        this._setOrStatus(globalThis.PlatformI18n.t("settings:loaded_value1_current_openrouter_models_f7631c47", { value1: this._openRouterModels.length }), 'ok');
      } catch (err) {
        this._setOrStatus(err.message || globalThis.PlatformI18n.t("settings:could_not_refresh_openrouter_models_ad5f3aee"), 'error');
      } finally {
        if (button) { button.disabled = false; button.textContent = globalThis.PlatformI18n.t("settings:refresh_0e916101"); }
      }
    },

    async _toggleSelectedOpenRouterFavorite() {
      const button = document.getElementById('settings-openrouter-star-model');
      const model = this._openRouterModels.find(
        (item) => item.id === this._openRouterSelectedModelId,
      );
      if (!model || button?.disabled) return;
      const favorite = model.isFavorite !== true;
      if (button) button.disabled = true;
      try {
        const r = await fetch('/api/me/coding-agent/models/favorite', {
          method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: model.id, favorite }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || globalThis.PlatformI18n.t("settings:could_not_update_that_favorite_288b961b"));
        model.isFavorite = favorite;
        this._renderOpenRouterModelOptions();
        this._setOrStatus(favorite
          ? globalThis.PlatformI18n.t("settings:value1_added_to_favorites_01c10b67", { value1: model.name || model.id })
          : globalThis.PlatformI18n.t("settings:value1_removed_from_favorites_3b784639", { value1: model.name || model.id }), 'ok');
      } catch (err) {
        this._setOrStatus(err.message || globalThis.PlatformI18n.t("settings:could_not_update_that_favorite_288b961b"), 'error');
        if (button) button.disabled = false;
      }
    },

    async _saveOpenRouterKey() {
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const key = input?.value?.trim();
      if (!key) { this._setOrStatus(globalThis.PlatformI18n.t("settings:paste_an_openrouter_api_key_first_9ccff907"), 'error'); return; }
      if (saveBtn) saveBtn.disabled = true;
      this._setOrStatus(globalThis.PlatformI18n.t("settings:verifying_with_openrouter_df6febc8"), 'info');
      try {
        const r = await fetch('/api/me/credentials/openrouter', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key }),
        });
        const j = await r.json();
        if (!r.ok) { this._setOrStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_key_2ca6410d"), 'error'); return; }
        this._setOrStatus(globalThis.PlatformI18n.t("settings:saved_encrypted_and_selected_as_your_default_cod_9358f750"), 'ok');
        if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = true;
        input.value = '';
        await this._refreshOpenRouter();
      } catch (err) {
        this._setOrStatus(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }), 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    },

    async _removeOpenRouterKey() {
      const removeBtn = document.getElementById('settings-openrouter-remove');
      if (removeBtn) removeBtn.disabled = true;
      try {
        const r = await fetch('/api/me/credentials/openrouter', { method: 'DELETE', credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setOrStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_remove_key_4b33ea92"), 'error'); return; }
        const note = j.defaultReset ? globalThis.PlatformI18n.t("settings:key_removed_your_default_agent_was_reset_to_clau_a5679221") : '';
        this._setOrStatus(globalThis.PlatformI18n.t("settings:key_removed_e1d3cae0") + note, 'ok');
        if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = false;
        this._openRouterModels = [];
        this._openRouterSelectedModelId = '';
        this._openRouterRecommendedModelId = '';
        this._openRouterCatalogRefreshedAt = null;
        this._openRouterCatalogTotal = 0;
        await this._refreshOpenRouter();
      } catch {
        this._setOrStatus(globalThis.PlatformI18n.t("settings:failed_to_remove_key_4b33ea92"), 'error');
      } finally {
        if (removeBtn) removeBtn.disabled = false;
      }
    },

    async _saveOpenRouterDefault() {
      const model = document.getElementById('settings-openrouter-model')?.value;
      if (!model) { this._setOrStatus(globalThis.PlatformI18n.t("settings:choose_an_openrouter_model_first_eb5ba7eb"), 'error'); return; }
      const reasoningEffort = document.getElementById('settings-openrouter-reasoning')?.value || null;
      // Preserve the user's existing cost cap across this save (review P3):
      // include it explicitly so an omission can't drop the safety limit,
      // and the server also COALESCEs when omitted.
      let maxTurnCostUsd = null;
      try {
        const prefs = await (await fetch('/api/me/coding-agent', { credentials: 'same-origin' })).json();
        maxTurnCostUsd = prefs.backends?.codex_openrouter?.maxTurnCostUsd ?? null;
      } catch {}
      try {
        const r = await fetch('/api/me/coding-agent', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultBackend: 'codex_openrouter', model, reasoningEffort, maxTurnCostUsd }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); this._setOrStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"), 'error'); return; }
        this._setOrStatus(globalThis.PlatformI18n.t("settings:openrouter_saved_as_your_default_session_ai_cfa500b1"), 'ok');
      } catch { this._setOrStatus(globalThis.PlatformI18n.t("settings:network_error_1bd8a2e6"), 'error'); }
    },

    async _saveClaudeDefault() {
      // Reciprocal default control (review #8): set Claude Code (the
      // legacy backend) as the user's default coding agent. Sends no model
      // so it doesn't pin a Claude model either.
      try {
        const r = await fetch('/api/me/coding-agent', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultBackend: 'claude_code' }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); this._setOrStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"), 'error'); return; }
        this._setOrStatus(globalThis.PlatformI18n.t("settings:claude_code_is_now_your_default_coding_agent_9eab2f92"), 'ok');
      } catch { this._setOrStatus(globalThis.PlatformI18n.t("settings:network_error_1bd8a2e6"), 'error'); }
    },

    // ── Change password (issue #282) ─────────────────────────────
    _setCpStatus(text, kind) {
      const el = document.getElementById('cp-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    // Browser-review state for the native-only password-creation link. It
    // changes availability only: the wallet submit path still requires the
    // real native bridge before it can make a request.
    _passwordCreateDemo() {
      return this._demoParam('shot') === 'password-create';
    },

    // Decide whether the wallet option is even offered, then default to
    // the password form. The "Create one" link only appears in the Homeroom
    // native app (signMessage available) AND when the logged-in account has a
    // linked wallet to prove control of, except for the read-only screenshot
    // state that makes this native-only copy reviewable in a browser.
    _renderChangePasswordSection() {
      const section = document.getElementById('change-password-section');
      if (!section) return;
      const isNative = !!(window.usernode && window.usernode.isNative);
      this._walletChangeAvailable = this._passwordCreateDemo()
        || (isNative && !!this.state.usernodePubkey);
      // Clear any stale field values / status on each open.
      ['cp-current', 'cp-new', 'cp-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const status = document.getElementById('cp-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._setChangePasswordMode('password');
    },

    _setChangePasswordMode(mode) {
      // In password mode (or when wallet isn't available) show the
      // current-password field + the normal submit, and offer the
      // password-creation link only if the wallet-backed path is available. In
      // wallet mode hide the current-password field, swap the submit, and offer
      // the way back.
      const wallet = mode === 'wallet' && this._walletChangeAvailable;
      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
      };
      show('cp-current-row', !wallet);
      show('cp-save', !wallet);
      show('cp-wallet-save', wallet);
      // Offer the password-creation link only in password mode and only when
      // wallet change is available; offer the way back in wallet mode.
      show('cp-wallet-mode', !wallet && this._walletChangeAvailable);
      show('cp-password-mode', wallet);
    },

    async changePasswordWithWallet() {
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-wallet-save');
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (newPassword.length < 8) { this._setCpStatus(globalThis.PlatformI18n.t("settings:new_password_must_be_at_least_8_characters_46d36027"), 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus(globalThis.PlatformI18n.t("settings:new_passwords_do_not_match_653fbc41"), 'error'); return; }
      if (!(window.usernode && window.usernode.isNative) || typeof window.signMessage !== 'function') {
        this._setCpStatus(globalThis.PlatformI18n.t("settings:wallet_signing_is_only_available_in_the_homeroom_7a847aa1"), 'error');
        return;
      }

      btn.disabled = true;
      this._setCpStatus(globalThis.PlatformI18n.t("settings:verifying_identity_258749e2"), 'info');
      try {
        const pubkey = this.state.usernodePubkey || (window.getNodeAddress ? await window.getNodeAddress() : null);
        if (!pubkey) { this._setCpStatus(globalThis.PlatformI18n.t("settings:could_not_read_your_wallet_address_d3e2e848"), 'error'); return; }

        // Fresh single-use challenge from the shared wallet-check endpoint.
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pubkey }),
        });
        const checkData = await checkRes.json().catch(() => ({}));
        const challenge = checkData.challenge;
        if (!challenge) { this._setCpStatus(globalThis.PlatformI18n.t("settings:could_not_get_a_challenge_from_the_server_5cff7bdd"), 'error'); return; }

        const sig = await window.signMessage(challenge);
        const r = await fetch('/api/me/wallet-change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ publicKey: sig.publicKey, challenge, signature: sig.signature, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_change_password_bfaea7c8"), 'error'); return; }
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus(globalThis.PlatformI18n.t("settings:password_changed_a768c77b"), 'ok');
      } catch (err) {
        if (err && err.message && err.message.includes('denied')) {
          this._setCpStatus(globalThis.PlatformI18n.t("settings:signature_request_was_denied_1431f4c6"), 'error');
        } else {
          this._setCpStatus(globalThis.PlatformI18n.t("settings:wallet_change_failed_value1_6d5fe570", { value1: err.message || err }), 'error');
        }
      } finally {
        btn.disabled = false;
      }
    },

    _setCuStatus(text, kind) {
      const el = document.getElementById('cu-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    // Paint the current handle. Called from _renderAllSections on every
    // open, so the row is right even after a rename made somewhere else in
    // this tab (or in another one, once /api/auth/me is re-read).
    _renderChangeUsernameSection() {
      const cur = document.getElementById('cu-current');
      if (!cur) return;
      const name = (typeof App !== 'undefined' && App.user && App.user.username) || '';
      cur.textContent = name ? `@${name}` : '—';
    },

    // POST /api/me/username. The server is the authority on every rule
    // here (charset, reserved names, availability against the retired
    // ledger, the cooldown, the password); this only avoids a round-trip
    // for the two states the form can see on its own.
    async changeUsername() {
      const nameEl = document.getElementById('cu-new');
      const pwEl = document.getElementById('cu-password');
      const btn = document.getElementById('cu-save');
      if (!nameEl || !pwEl || !btn) return;

      const username = nameEl.value.trim();
      const currentPassword = pwEl.value;

      if (!username) { this._setCuStatus(globalThis.PlatformI18n.t("settings:enter_a_new_username_355c82f8"), 'error'); return; }
      if (!currentPassword) { this._setCuStatus(globalThis.PlatformI18n.t("settings:enter_your_current_password_cf4d205e"), 'error'); return; }

      // Everything that can throw goes INSIDE the try, so `finally` is the
      // only exit and the button cannot be stranded disabled under a
      // "Saving…" that never resolves — the shape of the reported bug, when
      // painting that very line was what threw. `btn.disabled = true` is a
      // property write and cannot.
      btn.disabled = true;
      try {
        this._setCuStatus('Saving…', 'info');
        const r = await fetch('/api/me/username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, currentPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCuStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_change_username_073750be"), 'error'); return; }

        nameEl.value = '';
        pwEl.value = '';

        // The handle is on the drawer row, the identity card and every
        // link this tab is about to build, so App.user has to move with
        // it — a stale copy would keep deep-linking the OLD name, which
        // now resolves through the retired ledger and would quietly
        // redirect on every click.
        if (typeof App !== 'undefined' && App.user) {
          App.user.username = j.username;
          if (typeof App.saveSessionSnapshot === 'function') App.saveSessionSnapshot(App.user);
          try { App.resyncCurrentView(); } catch (_) { /* best effort */ }
        }
        this._renderChangeUsernameSection();

        this._setCuStatus(
          j.unchanged
            ? globalThis.PlatformI18n.t("settings:that_is_already_your_username_b33a96a4")
            : globalThis.PlatformI18n.t("settings:you_are_now_value1_46b169bc", { value1: j.username }),
          'ok',
        );
      } catch (err) {
        this._setCuStatus(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }), 'error');
      } finally {
        btn.disabled = false;
      }
    },

    async changePassword() {
      const currentEl = document.getElementById('cp-current');
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-save');
      const currentPassword = currentEl.value;
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (!currentPassword) { this._setCpStatus(globalThis.PlatformI18n.t("settings:enter_your_current_password_cf4d205e"), 'error'); return; }
      if (newPassword.length < 8) { this._setCpStatus(globalThis.PlatformI18n.t("settings:new_password_must_be_at_least_8_characters_46d36027"), 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus(globalThis.PlatformI18n.t("settings:new_passwords_do_not_match_653fbc41"), 'error'); return; }

      btn.disabled = true;
      this._setCpStatus('Saving…', 'info');
      try {
        const r = await fetch('/api/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_change_password_bfaea7c8"), 'error'); return; }
        currentEl.value = '';
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus(globalThis.PlatformI18n.t("settings:password_changed_a768c77b"), 'ok');
      } catch (err) {
        this._setCpStatus(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }), 'error');
      } finally {
        btn.disabled = false;
      }
    },

    async logout({ accountDeleted = false } = {}) {
      const btn = document.getElementById('settings-logout');
      if (btn) btn.disabled = true;

      const fail = (error) => {
        if (btn) btn.disabled = false;
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(
            globalThis.PlatformI18n.t("settings:could_not_sign_out_check_your_connection_and_try_0632a485"),
            { error: true }
          );
        }
        console.warn('[settings] logout failed:', error);
        return false;
      };

      // Close native admission before any asynchronous work, including probes.
      let preflight = { nativeTerminal: false };
      try {
        if (window.NativeChrome && NativeChrome.prepareWebLogout) {
          preflight = NativeChrome.prepareWebLogout() || preflight;
        }
      } catch (error) {
        return fail(error);
      }

      // Older apps cannot delete the HttpOnly cookie locally. Only opt into
      // offline logout when native explicitly guarantees that cleanup.
      let offlineLogout = false;
      if (preflight.nativeTerminal) {
        try {
          const info = await NativeChrome.getInfo();
          offlineLogout = info?.degraded !== true &&
            info?.sessionLifecycleProtocol === 2 &&
            info?.capabilities?.includes('offlineLogout') === true;
        } catch (_) {}
      }
      let webRevoked = false;
      let timeout;
      let controller;
      try {
        if (preflight.webRecoverySettled) await preflight.webRecoverySettled;
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        const request = accountDeleted ? Promise.resolve({ ok: true }) : fetch('/api/auth/logout', {
          method: 'POST', credentials: 'same-origin',
          ...(controller ? { signal: controller.signal } : {}),
        });
        // #2078: BOTH paths are bounded now. The capable-phone budget is
        // short because native owns the cookie, so giving up early still
        // ends in a real sign-out. The ordinary web path has to reach the
        // server — only the server can revoke a web session — so it gets a
        // generous budget instead, one no working request is near. What it
        // must not be is ABSENT: this await used to be bare, with the
        // button already disabled, so a request that never settled left the
        // screen frozen with nothing to press. Running out here throws into
        // the catch below, which for the web path is `fail()` — the toast
        // and the button back, not a sign-out nobody performed.
        const budgetMs = offlineLogout
          ? OFFLINE_LOGOUT_TIMEOUT_MS
          : WEB_LOGOUT_TIMEOUT_MS;
        const response = await Promise.race([
          request,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              if (controller) controller.abort();
              reject(new Error('Remote sign-out timed out'));
            }, budgetMs);
          }),
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        webRevoked = true;
      } catch (error) {
        if (!offlineLogout) return fail(error);
        // Native owns deletion of the cookie and durable credential. Remote
        // revocation remains best effort when the API cannot be reached.
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      // Offline mode (#487): the service worker caches GET /api/* responses
      // per-URL, not per-user — wipe them so the next account on this
      // device can't see this user's cached feed. Belt-and-braces: the SW
      // also clears the API cache when it sees the logout POST above.
      try { await this._clearSwApiCache(); } catch (_) {}
      // Same reasoning for the offline session snapshot (#1021): it is the
      // record that says "this device is signed in", so leaving it behind
      // would let the next offline boot paint the signed-in shell for an
      // account that just logged out. _dropCachedSession is the wider sweep
      // (#1524): it also clears the shell snapshot and the remembered Improve
      // target, which main.tsx re-applies UNCONDITIONALLY at boot, before the
      // session is known — so leaving them behind paints the previous
      // session's header title and Improve button on the landing page.
      try { window.App?._dropCachedSession?.(); } catch (_) {}

      // Normalise the address BEFORE the terminal native call (#1524). A
      // native sign-out replaces the WebView but the platform keeps whatever
      // URL it was on, so a logout from `#settings` (or from `/app/<slug>`)
      // leaves an address that restoreFromHash reads as a remembered deep
      // link and answers with the sign-in form on the next restore. This runs
      // after remote revocation or an offline-capable native hand-off has
      // been selected.
      //
      // replaceState is safe on both counts that matter here. NATIVE-BRIDGE.md's
      // trust model binds the privileged capability to the executing JS realm,
      // and a same-document History API change retains it; and replaceState
      // fires neither popstate nor hashchange, so no router runs off it.
      try { window.history?.replaceState?.(null, '', LANDING_URL); } catch (_) {}

      // Back into a signed-in document restored whole from the BFCache would
      // otherwise repaint the signed-in shell from memory (#1524). One-shot:
      // this document is on its way out either way.
      try {
        window.addEventListener('pageshow', (event) => {
          if (event && event.persisted) window.location.replace(LANDING_URL);
        }, { once: true });
      } catch (_) {}

      // This must remain the final call on the native path: successful native
      // logout replaces the WebView, so the old document normally runs no
      // continuation work at all. The ONE relaxation (#1524) is navigation to
      // the landing page, on both outcomes below. It cannot re-admit anyone:
      // App.user is gone, so NativeChrome._webParticipantId() is null and
      // establishCurrentSession() returns without asking the bridge for
      // anything. Nothing else may be added here.
      if (preflight.nativeTerminal) {
        return NativeChrome.commitNativeLogout().then((result) => {
          // The WebView should already be gone. If it is not, land this
          // document on the public landing page rather than leave a
          // signed-out user on the Settings screen.
          const timer = setTimeout(() => {
            window.location.replace(LANDING_URL);
          }, NATIVE_LOGOUT_SAFETY_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
          return result;
        }, (error) => {
          // If neither boundary completed, do not reload a possibly live
          // cookie or claim the user is signed out. Allow cleanup to retry.
          if (!webRevoked) return fail(error);
          // A rejection leaves the native realm closed and server authority
          // revoked, but this document alive and signed out. Carry the
          // advisory across the navigation (the toast itself would not
          // survive it) and go to the landing page like every other surface.
          try {
            window.sessionStorage?.setItem?.(LOGOUT_NOTICE_KEY, NATIVE_SHUTDOWN_NOTICE);
          } catch (_) {}
          console.warn('[settings] local native shutdown failed:', error);
          window.location.replace(LANDING_URL);
          return false;
        });
      }

      // Hard navigation on purpose: enterAuthed is one-shot per document
      // in a regular browser. `/` boots
      // the anonymous shell on the landing screen — the public app
      // directory a guest normally sees — instead of the bare sign-in
      // form (#1159); the landing header's Sign in CTA keeps re-login one
      // tap away. REPLACE, not assign (#1524): a pushed entry lets Back
      // restore the signed-in document from the BFCache.
      window.location.replace(LANDING_URL);
    },

    // Ask the active service worker to drop its API cache; resolves on ack
    // or after a short timeout so logout never hangs on a wedged worker.
    _clearSwApiCache() {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        try {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
          sw.postMessage({ type: 'clear-api-cache' }, [channel.port2]);
        } catch (_) {
          clearTimeout(timer);
          resolve();
        }
      });
    },

    async remove() {
      if (!await PlatformUI.confirm({ get title() { return globalThis.PlatformI18n.t("settings:remove_your_api_key_1ee469e4"); }, get message() { return globalThis.PlatformI18n.t("settings:future_chats_will_fall_back_to_the_shared_daily__cafee8d0"); }, get confirmLabel() { return globalThis.PlatformI18n.t("settings:remove_c3812fc4"); }, danger: true })) return;
      const removeBtn = document.getElementById('settings-remove');
      removeBtn.disabled = true;
      try {
        const r = await fetch('/api/me/api-key', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_remove_key_4b33ea92"), 'error');
          return;
        }
        this.state.hasApiKey = false;
        this.state.keyLast4 = null;
        this._renderIndicator();
        this._renderBody();
        this._refreshSpend();
        this._setStatus('Removed.', 'ok');
        setTimeout(() => this.close(), 700);
      } catch (err) {
        this._setStatus(globalThis.PlatformI18n.t("settings:network_error_value1_28b4e24a", { value1: err.message }), 'error');
      } finally {
        removeBtn.disabled = false;
      }
    },

    // ── App AI permissions (issue #34) ───────────────────────────
    //
    // Fetched fresh on every modal open. Each active grant renders as
    // a row: app name, $spent / $cap today, a cap editor, the BYOK
    // spillover toggle (only when a key is on file), and Revoke.
    // Revoked grants show a muted badge and Re-enable (#1957), which
    // re-grants through the consent dialog's own POST with the cap and
    // BYOK choice the row still carries — before it, the only way back
    // was that dialog, which an app that never asks again never opens.
    // In staging previews the page's ?demo=1 is passed through so the
    // (always-empty, staging:private) grant tables still produce a
    // reviewable list.

    async _renderLlmGrants() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsGrants : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', grants: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      try {
        const r = await fetch('/api/me/llm-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(globalThis.PlatformI18n.t("settings:fetch_failed_e2c73a8f"));
        const j = await r.json();
        grants = j.grants || [];
      } catch {
        publish({ phase: 'error', grants: [] });
        return;
      }
      publish({ phase: 'ready', grants: grants.map((g) => this._grantView(g)) });
    },

    // One grant, as DATA. Every branch the row template used to evaluate
    // inline is decided here, where `this.state.hasApiKey` and the demo flag
    // already live — see the note in ./grants-store.js. The money is
    // pre-formatted for the same reason: cents-to-dollars is this module's
    // rule, not the component's. `appSlug` and `capCents` ride along for
    // Re-enable (#1957): the re-grant endpoint is keyed on slug, and the
    // previous cap is what it restores.
    _grantView(g) {
      const spent = ((g.spentTodayCents || 0) + (g.byokSpentTodayCents || 0)) / 100;
      const cap = (g.dailyCapCents || 0) / 100;
      return {
        appId: g.appId,
        appName: String(g.appName ?? ''),
        appSlug: String(g.appSlug ?? ''),
        revoked: g.status !== 'active',
        spent: spent.toFixed(2),
        cap: cap.toFixed(2),
        capValue: cap.toFixed(2),
        capCents: Number(g.dailyCapCents) || 0,
        showByok: !!(this.state.hasApiKey || g.allowByok),
        allowByok: !!g.allowByok,
      };
    },

    // A fabricated staging row. The demo grant tables are staging:private and
    // always empty, so ?demo=1 stands in for them — and those rows must never
    // reach the API.
    _isDemoGrant(appId) { return appId < 0; },

    // ── The row handlers ─────────────────────────────────────────
    //
    // The first three were closures inside the row builder, wired with
    // addEventListener to nodes it had just created. They are methods now,
    // called by name from ./grants-list.tsx, because the component owns the
    // markup and this module owns the writes. Each still reports through
    // _setLlmGrantsStatus and re-renders on success, exactly as before.
    // _onGrantReenable (#1957) is the fourth, written the same way.

    async _onGrantCapChange(appId, value) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      const cents = Math.round(parseFloat(value) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        status(globalThis.PlatformI18n.t("settings:enter_a_valid_cap_at_least_0_01_5eac2deb"), 'error');
        return;
      }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ dailyCapCents: cents }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_update_cap_7839e655"), 'error'); return; }
        status(globalThis.PlatformI18n.t("settings:cap_updated_43414f3c"), 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    async _onGrantByokChange(appId, checked) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ allowByok: checked }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_update_9eac1d3f"), 'error'); return; }
        status(checked ? globalThis.PlatformI18n.t("settings:spillover_enabled_88ee2719") : globalThis.PlatformI18n.t("settings:spillover_disabled_2195cfc4"), 'ok');
        // The checkbox is CONTROLLED by the store now, so the failure paths
        // above leave it showing the old value on their own — where the DOM
        // version had to flip `byokInput.checked` back by hand. On success the
        // re-render is what makes the new value stick.
        this._renderLlmGrants();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
        this._renderLlmGrants();
      }
    },

    async _onGrantRevoke(appId, appName) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      const ok = await ConfirmModal.show({
        get title() { return globalThis.PlatformI18n.t("settings:revoke_ai_access_for_value1_086f60a2", { value1: appName }); },
        get message() { return globalThis.PlatformI18n.t("settings:its_next_ai_call_will_fail_immediately_the_app_c_920d8141"); },
        get confirmLabel() { return globalThis.PlatformI18n.t("settings:revoke_87e6d00b"); },
        danger: true,
      });
      if (!ok) return;
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_revoke_1f13652b"), 'error'); return; }
        status('Revoked.', 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    // The way back from Revoke (#1957). The consent dialog's POST is an
    // upsert keyed on slug that re-activates a revoked row, so re-enabling
    // re-sends the cap and BYOK choice the row still carries and the grant
    // comes back as it was; the active row's controls take over from there.
    // No confirm dialog: this is not destructive, and the row's copy already
    // says what the click restores.
    //
    // If the old cap no longer fits the user's allowance (the ceiling moved
    // since the grant was made), the server refuses it with a 400 that
    // carries no `code` — credit_required and byok_required both do — so
    // retry once at the server's default cap rather than strand the row
    // with no way back, and say so. Anything else is reported verbatim,
    // as the cap editor's errors are.
    async _onGrantReenable(grant) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(grant.appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      const post = (body) => fetch('/api/me/llm-grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ appSlug: grant.appSlug, allowByok: !!grant.allowByok, ...body }),
      });
      try {
        const withCap = grant.capCents > 0;
        let r = await post(withCap ? { dailyCapCents: grant.capCents } : {});
        let j = await r.json().catch(() => ({}));
        let atDefault = false;
        if (withCap && r.status === 400 && !j.code) {
          r = await post({});
          j = await r.json().catch(() => ({}));
          atDefault = true;
        }
        if (!r.ok) { status(j.error || 'Failed to re-enable.', 'error'); return; }
        const cap = ((j.grant && j.grant.dailyCapCents) || 0) / 100;
        status(atDefault ? `Re-enabled at the default $${cap.toFixed(2)} daily cap.` : 'Re-enabled.', 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    _setLlmGrantsStatus(text, kind) {
      const el = document.getElementById('llm-grants-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── App device permissions (#2219) ───────────────────────────
    //
    // The sibling of the AI-permissions block above, against
    // /api/me/permission-grants. Grants are per (app, capability), so the
    // rows are GROUPED by app here rather than in the component: which
    // shape the list takes is this module's call, and the component
    // renders the answer (see ./app-permissions-list.tsx).
    //
    // Like the AI grants, the table is staging:private and therefore always
    // empty in a clone, so ?demo=1 is passed through for the preview.

    async _renderAppPermissions() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsAppPermissions : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', apps: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      try {
        const r = await fetch('/api/me/permission-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(globalThis.PlatformI18n.t("settings:fetch_failed_e2c73a8f"));
        const j = await r.json();
        grants = j.grants || [];
      } catch {
        publish({ phase: 'error', apps: [] });
        return;
      }
      publish({ phase: 'ready', apps: this._permissionAppViews(grants) });
    },

    // Grants as DATA, one entry per app. Insertion order is the server's
    // (active apps first, then by name), and the capability order inside an
    // app is the catalogue's, because that is the order the API returns.
    _permissionAppViews(grants) {
      const byApp = new Map();
      for (const g of grants) {
        const appId = g.appId;
        if (!byApp.has(appId)) {
          byApp.set(appId, {
            appId,
            appName: String(g.appName ?? g.appSlug ?? ''),
            appSlug: String(g.appSlug ?? ''),
            items: [],
          });
        }
        byApp.get(appId).items.push({
          capability: String(g.capability ?? ''),
          label: String(g.label ?? g.capability ?? ''),
          revoked: g.status !== 'active',
        });
      }
      return [...byApp.values()];
    },

    _setAppPermissionsStatus(text, kind) {
      const el = document.getElementById('app-permissions-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── What apps tell you about (#1374) ─────────────────────────────
    //
    // Two layers, one fetch: the account-wide defaults and every per-app
    // exception. GET /api/me/notification-preferences returns both, because
    // an exception is meaningless without the default it departs from.
    //
    // Like the AI grants above, the table is staging:private and therefore
    // always empty in a clone, so ?demo=1 is passed through for the preview.

    async _renderNotificationPrefs() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsNotificationPrefs : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', categories: [], apps: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      try {
        const r = await fetch('/api/me/notification-preferences' + (demo ? '?demo=1' : ''),
          { credentials: 'same-origin' });
        if (!r.ok) throw new Error(globalThis.PlatformI18n.t("settings:fetch_failed_e2c73a8f"));
        const j = await r.json();
        publish({
          phase: 'ready',
          categories: j.categories || [],
          apps: j.apps || [],
        });
      } catch {
        publish({ phase: 'error', categories: [], apps: [] });
      }
    },

    _setNotificationPrefsStatus(text, kind) {
      const el = document.getElementById('notification-prefs-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // Change the account-wide default for one category. Every app that has
    // no exception of its own follows this immediately; the ones that do
    // keep theirs, which is the whole point of the two layers.
    async _onNotificationDefaultChange(category, enabled) {
      const status = (t, k) => this._setNotificationPrefsStatus(t, k);
      try {
        const r = await fetch('/api/me/notification-preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ preferences: { [category]: enabled } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_55ac3cfb"), 'error'); return; }
        status('Saved.', 'ok');
        this._renderNotificationPrefs();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    // Drop one app's exceptions so it follows the defaults again.
    //
    // A DELETE rather than writing each category to the default's current
    // value: the app goes back to INHERITING, so it keeps following if a
    // default changes later. Writing the values would freeze them.
    async _onNotificationAppReset(appId, appSlug) {
      const status = (t, k) => this._setNotificationPrefsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      if (!appSlug) { status(globalThis.PlatformI18n.t("settings:this_app_could_not_be_identified_48efbb97"), 'error'); return; }
      try {
        const r = await fetch(
          `/api/apps/${encodeURIComponent(appSlug)}/notification-preferences`,
          { method: 'DELETE', credentials: 'same-origin' }
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_reset_534cc8a2"), 'error'); return; }
        status(globalThis.PlatformI18n.t("settings:following_your_defaults_again_79e4dcaa"), 'ok');
        this._renderNotificationPrefs();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    // Revoke one capability from one app.
    //
    // The confirm copy says NEXT TIME IT OPENS rather than "immediately",
    // and that difference is not hedging: a frame's Permissions Policy is
    // computed from its `allow` attribute at navigation and cannot be
    // narrowed afterwards, so a running app keeps what it already holds
    // until it is reopened. The AI section can honestly promise immediate
    // because its gate is a server-side check on every call.
    async _onPermissionRevoke(appId, capability) {
      const status = (t, k) => this._setAppPermissionsStatus(t, k);
      const ok = await ConfirmModal.show({
        get title() { return globalThis.PlatformI18n.t("settings:revoke_this_permission_421e06bf"); },
        get message() { return globalThis.PlatformI18n.t("settings:the_app_loses_it_the_next_time_it_opens_it_can_a_7c569ed0"); },
        get confirmLabel() { return globalThis.PlatformI18n.t("settings:revoke_87e6d00b"); },
        danger: true,
      });
      if (!ok) return;
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      try {
        const r = await fetch(
          `/api/me/permission-grants/${appId}/${encodeURIComponent(capability)}`,
          { method: 'DELETE', credentials: 'same-origin' }
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || globalThis.PlatformI18n.t("settings:failed_to_revoke_1f13652b"), 'error'); return; }
        status(globalThis.PlatformI18n.t("settings:revoked_it_stops_the_next_time_the_app_opens_6720ad68"), 'ok');
        this._renderAppPermissions();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    // The way back from Revoke, for the same reason the AI rows grew one
    // (#1957): re-approving otherwise depends on the app asking again, and
    // an app that never asks again never opens the prompt. The grant POST is
    // an upsert keyed on (slug, capability) that re-activates the row, and
    // it re-checks the declaration server-side — so an app that has since
    // dropped the capability from its dapp.json is refused here too, which
    // is the answer we want to show.
    //
    // No confirm dialog: this is not destructive, and the row's copy already
    // says what the click restores.
    async _onPermissionReenable(appId, appSlug, capability) {
      const status = (t, k) => this._setAppPermissionsStatus(t, k);
      if (!appSlug) { status(globalThis.PlatformI18n.t("settings:this_app_could_not_be_identified_48efbb97"), 'error'); return; }
      // The fabricated ?demo=1 rows name apps that do not exist, so the POST
      // would 404. Same guard the revoke path above has.
      if (this._isDemoGrant(appId)) { status(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info'); return; }
      try {
        const r = await fetch('/api/me/permission-grants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ appSlug, capability }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          status(j.code === 'not_declared'
            ? globalThis.PlatformI18n.t("settings:this_app_no_longer_asks_for_that_permission_1670cd76")
            : (j.error || 'Failed to re-enable.'), 'error');
          return;
        }
        status('Re-enabled. It applies the next time the app opens.', 'ok');
        this._renderAppPermissions();
      } catch (err) {
        status(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    // ── Agent instructions & skills (#460) ───────────────────────
    // Per-user global files the coding agent loads on every build/scout
    // run this user dispatches. List/upload/delete against
    // /api/me/agent-files; in staging the (staging:private, always empty)
    // table is stood in for by ?demo=1 fabricated rows, passed through
    // from the page URL exactly like the AI-permissions section above.

    _renderAgentFilesSection() {
      this._wireAgentFiles();
      this._hideAgentFilesForm();
      this._loadAgentFiles();
    },

    _agentFilesDemo() {
      return new URLSearchParams(window.location.search).get('demo') === '1';
    },

    // One-time event wiring (the section markup is static in index.html;
    // open() re-runs this, so guard against double-binding).
    _wireAgentFiles() {
      if (this._agentFilesWired) return;
      this._agentFilesWired = true;

      const input = document.getElementById('agent-files-input');
      document.querySelectorAll('[data-agent-files-upload]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._pendingAgentKind = btn.dataset.agentFilesUpload;
          input.value = '';
          input.click();
        });
      });

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 48 * 1024) {
          this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:value1_is_too_large_the_limit_is_48_kb_per_file_018a27ba", { value1: file.name }), 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          this._pendingAgentFile = {
            kind: this._pendingAgentKind,
            content: String(reader.result || ''),
          };
          this._showAgentFilesForm(file.name);
        };
        reader.onerror = () => this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:could_not_read_that_file_66cc390c"), 'error');
        reader.readAsText(file);
      });

      document.getElementById('agent-files-cancel').addEventListener('click', () => {
        this._hideAgentFilesForm();
      });
      document.getElementById('agent-files-save').addEventListener('click', () => {
        this._saveAgentFile();
      });
    },

    // Client-side twin of the server's normalizeName — purely a
    // convenience prefill; the server re-normalizes and is authoritative.
    _slugifyAgentFileName(raw) {
      return String(raw || '')
        .trim()
        .replace(/\.(md|txt)$/i, '')
        .toLowerCase()
        .replace(/[\s_.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    },

    _showAgentFilesForm(filename) {
      const form = document.getElementById('agent-files-form');
      const title = document.getElementById('agent-files-form-title');
      const nameInput = document.getElementById('agent-files-name');
      const descWrap = document.getElementById('agent-files-desc-wrap');
      const descInput = document.getElementById('agent-files-desc');
      const kind = this._pendingAgentFile?.kind || 'instruction';
      title.textContent = kind === 'skill'
        ? globalThis.PlatformI18n.t("settings:new_skill_from_value1_a7666cbe", { value1: filename })
        : globalThis.PlatformI18n.t("settings:new_instruction_file_from_value1_07a97668", { value1: filename });
      nameInput.value = this._slugifyAgentFileName(filename);
      descWrap.classList.toggle('hidden', kind !== 'skill');
      // Return in the name goes on to the description when there is one and
      // saves when there is not (#3907); the key says which.
      nameInput.enterKeyHint = kind === 'skill' ? 'next' : 'done';
      descInput.value = '';
      form.classList.remove('hidden');
      this._setAgentFilesStatus('', 'clear');
    },

    _hideAgentFilesForm() {
      this._pendingAgentFile = null;
      const form = document.getElementById('agent-files-form');
      if (form) form.classList.add('hidden');
    },

    async _saveAgentFile() {
      const pending = this._pendingAgentFile;
      if (!pending) return;
      if (this._agentFilesDemo()) {
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info');
        this._hideAgentFilesForm();
        return;
      }
      const name = document.getElementById('agent-files-name').value.trim();
      if (!name) {
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:give_the_file_a_name_3febfed6"), 'error');
        return;
      }
      const description = document.getElementById('agent-files-desc').value.trim();
      try {
        const r = await fetch('/api/me/agent-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ kind: pending.kind, name, description, content: pending.content }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setAgentFilesStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_save_the_file_65aa9a34"), 'error');
          return;
        }
        this._hideAgentFilesForm();
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:saved_value1_it_applies_from_your_next_run_5b58abdd", { value1: j.file?.name || name }), 'ok');
        this._loadAgentFiles();
      } catch (err) {
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    async _loadAgentFiles() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsAgentFiles : null;
      if (!bridge) return;
      const demo = this._agentFilesDemo();
      bridge.publish({ phase: 'loading', files: [], demo });
      let files = [];
      try {
        const r = await fetch('/api/me/agent-files' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(globalThis.PlatformI18n.t("settings:fetch_failed_e2c73a8f"));
        const j = await r.json();
        files = j.files || [];
      } catch {
        bridge.publish({ phase: 'error', files: [], demo });
        return;
      }
      bridge.publish({ phase: 'ready', demo, files: files.map((f) => this._agentFileView(f)) });
    },

    // One file, as DATA. The KB rounding is this module's rule — the same
    // reason the grant rows arrive with their dollars already formatted.
    _agentFileView(f) {
      return {
        kind: String(f.kind ?? ''),
        name: String(f.name ?? ''),
        description: String(f.description ?? ''),
        kb: Math.max(1, Math.round((f.size_bytes || 0) / 1024)),
      };
    },

    // Delete was a closure inside the row builder, wired with
    // addEventListener to a node it had just created. It is a method now,
    // called by name from ./agent-files-list.tsx — the component owns the
    // markup, this module owns the confirm dialog, the write and the reload.
    async _onAgentFileDelete(kind, name) {
      const ok = await ConfirmModal.show({
        get title() { return globalThis.PlatformI18n.t("settings:delete_value1_6c7e0193", { value1: name }); },
        get message() { return globalThis.PlatformI18n.t("settings:the_coding_agent_stops_using_it_from_your_next_r_7f67889a"); },
        get confirmLabel() { return globalThis.PlatformI18n.t("settings:delete_e2d0a549"); },
        danger: true,
      });
      if (!ok) return;
      if (this._agentFilesDemo()) {
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:demo_data_changes_are_not_saved_364f1930"), 'info');
        return;
      }
      try {
        const r = await fetch('/api/me/agent-files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ kind, name }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setAgentFilesStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_delete_7e2e87f1"), 'error'); return; }
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:deleted_value1_49d5a596", { value1: name }), 'ok');
        this._loadAgentFiles();
      } catch (err) {
        this._setAgentFilesStatus(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    _setAgentFilesStatus(text, kind) {
      const el = document.getElementById('agent-files-status');
      if (!el) return;
      if (kind === 'clear' || !text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── Wallet linking ───────────────────────────────────────────

    _renderWalletSection() {
      const section = document.getElementById('wallet-section');
      if (!section) return;
      if (!this.state.walletLinkEnabled) { section.classList.add('hidden'); return; }
      section.classList.remove('hidden');

      const unlinked = document.getElementById('wallet-unlinked');
      const linking = document.getElementById('wallet-linking');
      const linked = document.getElementById('wallet-linked');
      unlinked.classList.add('hidden');
      linking.classList.add('hidden');
      linked.classList.add('hidden');

      if (this.state.usernodePubkey) {
        linked.classList.remove('hidden');
        const display = document.getElementById('wallet-pubkey-display');
        const pk = this.state.usernodePubkey;
        display.textContent = pk.length > 20 ? pk.slice(0, 10) + '…' + pk.slice(-6) : pk;
        display.title = pk;
      } else if (this._walletPollTimer) {
        linking.classList.remove('hidden');
      } else {
        unlinked.classList.remove('hidden');
      }
    },

    async _startWalletLink() {
      const btn = document.getElementById('wallet-link-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/me/wallet-link', {
          method: 'POST', credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setWalletStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_start_linking_455b3330"), 'error');
          btn.disabled = false;
          return;
        }
        const qrPayload = JSON.stringify(j.qr);
        this._walletExpiresAt = new Date(j.expiresAt).getTime();

        const container = document.getElementById('wallet-qr-canvas');
        container.innerHTML = '';
        if (window.QRCode) {
          new QRCode(container, {
            text: qrPayload,
            width: 180,
            height: 180,
            colorDark: '#1a1a30',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L,
          });
        }

        this._startWalletPolling();
        this._startWalletCountdown();
        this._renderWalletSection();
      } catch (err) {
        this._setWalletStatus(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
        btn.disabled = false;
      }
    },

    _startWalletPolling() {
      this._stopWalletPolling();
      const check = async () => {
        try {
          const r = await fetch('/api/me/wallet-link/status', { credentials: 'same-origin' });
          const j = await r.json();
          if (j.linked) {
            this.state.usernodePubkey = j.pubkey;
            this._stopWalletPolling();
            this._renderWalletSection();
            this._setWalletStatus(globalThis.PlatformI18n.t("settings:wallet_linked_d90e1dc4"), 'ok');
          }
        } catch {}
      };
      check();
      this._walletPollTimer = setInterval(check, 2000);
    },

    _stopWalletPolling() {
      if (this._walletPollTimer) { clearInterval(this._walletPollTimer); this._walletPollTimer = null; }
      if (this._walletCountdownTimer) { clearInterval(this._walletCountdownTimer); this._walletCountdownTimer = null; }
      this._walletExpiresAt = null;
    },

    _startWalletCountdown() {
      if (this._walletCountdownTimer) clearInterval(this._walletCountdownTimer);
      const label = document.getElementById('wallet-link-timer');
      const tick = () => {
        if (!this._walletExpiresAt) { label.textContent = ''; return; }
        const remaining = Math.max(0, this._walletExpiresAt - Date.now());
        if (remaining <= 0) {
          this._cancelWalletLink();
          this._setWalletStatus(globalThis.PlatformI18n.t("settings:qr_code_expired_try_again_603d556d"), 'error');
          return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        label.textContent = globalThis.PlatformI18n.t("settings:expires_in_0ba8cea3") + m + ':' + String(s).padStart(2, '0');
      };
      tick();
      this._walletCountdownTimer = setInterval(tick, 1000);
    },

    _cancelWalletLink() {
      this._stopWalletPolling();
      const btn = document.getElementById('wallet-link-btn');
      if (btn) btn.disabled = false;
      this._renderWalletSection();
    },

    async _unlinkWallet() {
      if (!await PlatformUI.confirm({ get title() { return globalThis.PlatformI18n.t("settings:unlink_your_homeroom_wallet_dc7c8139"); }, get confirmLabel() { return globalThis.PlatformI18n.t("settings:unlink_b90108da"); }, danger: true })) return;
      try {
        const r = await fetch('/api/me/wallet-link', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setWalletStatus(j.error || globalThis.PlatformI18n.t("settings:failed_to_unlink_df68c822"), 'error');
          return;
        }
        this.state.usernodePubkey = null;
        this._renderWalletSection();
        this._setWalletStatus(globalThis.PlatformI18n.t("settings:wallet_unlinked_9c955cd9"), 'ok');
      } catch (err) {
        this._setWalletStatus(globalThis.PlatformI18n.t("settings:network_error_c16d4022") + err.message, 'error');
      }
    },

    _setWalletStatus(text, kind) {
      const el = document.getElementById('wallet-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── "Homeroom app" sections (profile-and-settings-to-web migration) ──
    //
    // The mobile app's native App Settings absorbed into this modal,
    // rendered from the bridge's getSettingsState snapshot (bridge v3,
    // NATIVE-BRIDGE.md). Capability-gated: hidden on desktop, in child-app
    // iframes, and on old app builds. Every setter resolves the refreshed
    // snapshot, so the section re-renders from a single source of truth.
    // Device benchmark / HTTP debug logs stay native and are reached via
    // openNativeScreen deep-links; terms render in a web sheet backed by
    // the session-authed /challenges-api terms twins (thin-shell
    // migration).

    _usernodeState: null,
    // Bumped per read attempt so only the NEWEST one writes to the DOM:
    // open() can re-render while an earlier 12s read is still in flight,
    // and the manual retry / auth-status retry can overlap with either.
    _usernodeRenderToken: 0,
    _usernodeAuthStatusListener: null,
    // The auth-status re-attempt is once per mount, not a loop.
    _usernodeAuthRetryUsed: false,

    // ── Notification-permission tap state ─────────────────────────────
    // `{ tone, title, text, settings }` — the visible explanation for a
    // tap that could not open an OS prompt. A dead end MUST leave one of
    // these behind; a silent return is the bug this section is fixing.
    _unNotifNotice: null,
    // The pre-render iOS push probe runs once per section mount, so the
    // row decides from the real permission rather than from the
    // `exactAlarmGranted` proxy — and so re-rendering can never loop.
    _unPushProbed: false,
    // Re-entrancy guard: the row and the chip both drive the same ask.
    _unRequestInFlight: false,
    // Tri-state, from NativeChrome.supports(): null = the probe could not
    // say (degraded handshake / no advertised list — issue #978), and an
    // inconclusive answer must never render a dead "Open notification
    // settings" button.
    _unCanOpenNotifSettings: null,

    // Plain-language reason per bridge failure `kind` (the record from
    // usernode.getLastNativeReadError). Without this the section could only
    // ever say "something went wrong": the bridge's chrome reads resolve
    // null on a timeout, on a native rejection and on a refused privileged
    // handshake alike, which is exactly what made issue #978 impossible to
    // diagnose from the device.
    USERNODE_READ_ERROR_REASONS: {
      get 'timeout'() { return globalThis.PlatformI18n.t("settings:the_homeroom_app_didn_t_respond_in_time_it_may_s_831a2fb6"); },
      get 'rejected'() { return globalThis.PlatformI18n.t("settings:the_homeroom_app_reported_an_error_1d0b7e72"); },
      get 'probe-inconclusive'() { return globalThis.PlatformI18n.t("settings:the_homeroom_app_hasn_t_re_established_its_secur_cbad4624"); },
      get 'no-transport'() { return globalThis.PlatformI18n.t("settings:this_screen_can_t_reach_the_homeroom_app_from_he_6c093b9d"); },
      get 'not-native'() { return globalThis.PlatformI18n.t("settings:this_screen_can_t_reach_the_homeroom_app_from_he_6c093b9d"); },
      get 'page-changed'() { return globalThis.PlatformI18n.t("settings:the_request_was_cancelled_because_this_page_chan_b80faf3f"); },
      get 'privileged-unavailable'() { return globalThis.PlatformI18n.t("settings:the_homeroom_app_refused_this_screen_s_secure_co_25aa701e"); },
    },
    get USERNODE_READ_ERROR_FALLBACK() { return globalThis.PlatformI18n.t("settings:the_homeroom_app_returned_no_settings_37784f6a"); },

    // ── The connection panel ──────────────────────────────────────────
    //
    // Plain-language reason per privileged-handshake `state` (the record
    // from usernode.getBridgeDiagnostics). The remedies are ordered the
    // way the report that prompted this was: force-close and reopen
    // FIRST, reinstall only if that doesn't clear it.
    PRIVILEGED_STATE_LABELS: {
      get 'ready'() { return globalThis.PlatformI18n.t("settings:connected_22965568"); },
      get 'blocked-frame'() { return globalThis.PlatformI18n.t("settings:refused_66b87354"); },
      get 'unsupported'() { return globalThis.PlatformI18n.t("settings:not_in_this_app_build_c05d68ab"); },
      get 'inconclusive'() { return globalThis.PlatformI18n.t("settings:unconfirmed_3229d16c"); },
      get 'unattached'() { return globalThis.PlatformI18n.t("settings:no_answer_7e49c68d"); },
      get 'unknown'() { return globalThis.PlatformI18n.t("settings:not_needed_yet_f3ad7cf4"); },
    },
    PRIVILEGED_STATE_REASONS: {
      get 'ready'() { return globalThis.PlatformI18n.t("settings:this_screen_can_manage_the_app_s_settings_805d49b7"); },
      get 'blocked-frame'() { return globalThis.PlatformI18n.t("settings:the_app_is_refusing_this_screen_s_secure_connect_9e92a4bf"); },
      get 'unsupported'() { return globalThis.PlatformI18n.t("settings:this_app_build_predates_the_secure_connection_th_89697727"); },
      get 'inconclusive'() { return globalThis.PlatformI18n.t("settings:the_app_hasn_t_answered_yet_so_we_can_t_tell_whe_a66334fb"); },
      get 'unattached'() { return globalThis.PlatformI18n.t("settings:the_app_never_answered_this_screen_s_secure_conn_df1e0013"); },
      get 'unknown'() { return globalThis.PlatformI18n.t("settings:this_screen_hasn_t_needed_the_app_s_secure_conne_612de212"); },
    },

    // Staging/screenshot hook: `?bridgediag=demo`, in the fragment query
    // (#settings?bridgediag=demo) or the ordinary query string. READ-ONLY
    // — it renders a fixed synthetic snapshot and disables both actions,
    // so it can never touch a real bridge, a real session or any state.
    DEMO_BRIDGE_DIAGNOSTICS: {
      isNative: true,
      isTopFrame: true,
      inIframe: false,
      usesIframeRelay: false,
      hasNativeChannel: true,
      origin: 'https://staging.demo.invalid',
      bridgeVersion: 5,
      capabilities: ['getBridgeInfo', 'getSettingsState', 'logout'],
      appVersion: '0.0.0-demo',
      buildNumber: '0',
      privileged: {
        state: 'blocked-frame',
        code: 'privileged_frame_unauthorized',
        kind: 'privileged-unavailable',
        get message() { return globalThis.PlatformI18n.t("settings:staging_demo_privileged_bridge_is_unavailable_fo_4214b616"); },
        at: 0,
        attempts: 3,
      },
      lastErrors: {
        getSettingsState: {
          method: 'getSettingsState',
          kind: 'privileged-unavailable',
          get message() { return globalThis.PlatformI18n.t("settings:staging_demo_privileged_bridge_is_unavailable_fo_4214b616"); },
          at: 0,
        },
      },
      collectedAt: 0,
    },

    _bridgeDiagDemo() {
      return this._demoParam('bridgediag') === 'demo';
    },

    // ── `?bridgediag=wallet` ──────────────────────────────────────────
    //
    // Screenshot-state deep link for the connection panel's OTHER refusal:
    // the secure connection is fine, but native admission reported
    // `native_session_wallet_pool_exhausted` — no seeded wallet is left for
    // this account. That state used to announce itself as a pop-up (the
    // "Connect your existing wallet" dialog opened on every admission
    // retry); it is a button on this panel now, and this link is how a
    // browser can reach it. Same rules as `?bridgediag=demo`: a fixed
    // snapshot, no bridge call, no writes, and the button renders disabled
    // because there is no real session for it to recover.
    _walletRecoveryDemo() {
      return this._demoParam('bridgediag') === 'wallet';
    },

    DEMO_BRIDGE_DIAGNOSTICS_WALLET: {
      isNative: true,
      isTopFrame: true,
      inIframe: false,
      usesIframeRelay: false,
      hasNativeChannel: true,
      origin: 'https://staging.demo.invalid',
      bridgeVersion: 5,
      capabilities: ['getBridgeInfo', 'getSettingsState', 'logout',
        'establishNativeSession'],
      appVersion: '0.0.0-demo',
      buildNumber: '0',
      privileged: {
        state: 'ready',
        code: null,
        kind: null,
        get message() { return globalThis.PlatformI18n.t("settings:staging_demo_no_seeded_wallet_is_available_for_t_4fd5641e"); },
        at: 0,
        attempts: 1,
      },
      lastErrors: {},
      collectedAt: 0,
    },

    // ── `?widgeticons=demo` ───────────────────────────────────────────
    //
    // Screenshot-state deep link for the widget-icon diagnostics box,
    // same reasoning as `?usernodedemo=ios` above: every value the box
    // reports comes from the iOS widget registry, so on a browser the
    // whole thing is empty and the row cannot be reviewed or captured
    // from any URL. Fixed snapshot — no bridge call, no writes.
    //
    // The snapshot is deliberately the interesting state rather than the
    // healthy one: the capability list "couldn't say" (a degraded
    // getBridgeInfo, which is the failure that made the released shell
    // fix invisible), overridden by a behavioural verdict of `supported`
    // bound to a demo build, with one entry still missing its dark face
    // and one whose marker doesn't match what SV last recorded.
    _widgetIconsDemo() {
      return this._demoParam('widgeticons') === 'demo';
    },

    // Both demo links accept their param in the hash query or the search
    // string, because a hash route carries its own query
    // (`/#settings/usernode?usernodedemo=ios`) while a plain capture URL
    // may put it before the fragment.
    _demoParam(name) {
      try {
        const hash = String(window.location.hash || '');
        const q = hash.indexOf('?');
        if (q !== -1) {
          const inHash = new URLSearchParams(hash.slice(q + 1)).get(name);
          if (inHash) return inHash;
        }
        return new URLSearchParams(window.location.search).get(name) || null;
      } catch (_) {
        return null;
      }
    },

    // ── `?usernodedemo=ios` / `=ios-denied` ───────────────────────────
    //
    // Screenshot-state deep link for the device-permissions rows, which
    // otherwise exist ONLY inside the native app: a browser has no
    // `usernode.isNative`, so the whole section is hidden and the row
    // this link exists to pin was unreachable from any URL. Pure UI
    // state — a fixed snapshot, no bridge call, no writes — so it is
    // ungated for the same reason as `?shot=menu-nav` in public/js/app.js.
    //
    // The snapshot deliberately reports `exactAlarmGranted: true` with an
    // un-determined push status, because that combination IS the bug: iOS
    // has no exact alarms, the boolean is a lagging proxy, and a screen
    // that trusts it renders "Granted" with no control at all — which is
    // precisely "tapping it does nothing". The row must still offer the
    // ask. `ios-denied` renders the other dead end (determined-denied,
    // where iOS presents no prompt however often it is asked).
    _unDemoMode() {
      const v = this._demoParam('usernodedemo');
      return (v === 'ios' || v === 'ios-denied') ? v : null;
    },

    DEMO_USERNODE_STATE: {
      buildInfo: { appVersion: '0.0.0-demo', buildNumber: '0' },
      debugMode: false,
      facematchStrict: true,
      authStatus: 'authenticated',
      permissions: {
        platform: 'ios',
        exactAlarmGranted: true,
        batteryOptDisabled: null,
        deviceManufacturer: null,
      },
    },

    DEMO_WIDGET_ICON_DIAGNOSTICS: {
      mechanism: 'widget',
      registryLoaded: true,
      scheme: 'dark',
      capability: null,
      verdict: 'supported',
      resolved: true,
      build: { appVersion: '0.0.0-demo', buildNumber: '0' },
      confirmTried: true,
      lastHealAt: 0,
      lastHealOutcome: 'sent 1',
      readError: {
        method: 'getBridgeInfo',
        kind: 'timeout',
        get message() { return globalThis.PlatformI18n.t("settings:staging_demo_the_capability_probe_did_not_answer_c4831317"); },
        at: 0,
      },
      entries: [
        {
          id: 'demo-1', name: 'Weather', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: true,
          recorded: 'tile:5:dual:🌤', desired: 'tile:5:dual:🌤', matches: true,
        },
        {
          id: 'demo-2', name: 'Ledger', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: false,
          recorded: 'tile:5:dual:', desired: 'tile:5:dual:', matches: true,
        },
        {
          id: 'demo-3', name: 'Notes', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: null,
          recorded: 'tile:5:light:📝', desired: 'tile:5:dual:📝', matches: false,
        },
      ],
    },

    // The snapshot Home keeps of the icon path. Read-only and synchronous
    // — the "Re-check" button below is what performs bridge I/O.
    //
    // Reached through `window.Home` rather than an import: home.js and
    // settings.js are both bundle modules, but Home is the owner of this
    // state and publishes itself as a global for exactly this kind of
    // cross-screen read (see the note above its publication).
    _widgetIconDiagnostics() {
      // The demo's heal timestamp is stamped at read time, not frozen in
      // the literal: a fixed `lastHealAt` would print as "never", and a
      // box that says "never checked" beside "sent 1" reads as a bug in
      // the box rather than a sample of a healthy pass.
      if (this._widgetIconsDemo()) {
        return Object.assign({}, this.DEMO_WIDGET_ICON_DIAGNOSTICS, {
          lastHealAt: Date.now() - 42000,
        });
      }
      const home = window.Home;
      if (!home || typeof home.widgetIconDiagnostics !== 'function') return null;
      try {
        return home.widgetIconDiagnostics();
      } catch (err) {
        console.warn('[settings] widgetIconDiagnostics failed:', err);
        return null;
      }
    },

    // ── Settings → "Homeroom app: widget icons" ──────────────────────
    //
    // Gated on being in the app (or the demo link), NEVER on the
    // capability or the mechanism: this box exists to explain why the
    // widget looks wrong, and every interesting case is one where some
    // part of that chain answered "no". Hiding it on a "no" would hide it
    // exactly when it is wanted — the same mistake the connection panel
    // above was written to undo.

    // #1808: the WHOLE instant, not a time of day. This stamps one
    // diagnostics line ("Last icon check: …") whose only reader is somebody
    // working out whether the widget's icon verdict is stale — and "02:41 PM"
    // with no day cannot answer that. It is a plain `toLocaleString()` rather
    // than the shared helper because a diagnostics line elides nothing and
    // this module cannot import (see _localAgentView).
    _widgetIconTime(ms) {
      try { return new Date(ms).toLocaleString(globalThis.PlatformI18n.getLanguage()); } catch (_) { return String(ms); }
    },

    // One line per pinned entry: what the widget says it holds, and
    // whether that matches what SV believes it last sent. A mismatch here
    // is the difference between "SV never sent it" and "SV sent it and
    // the app didn't keep it" — which are different bugs in different
    // repositories, and were previously indistinguishable from outside.

    _bridgeDiagnostics() {
      if (this._bridgeDiagDemo()) return this.DEMO_BRIDGE_DIAGNOSTICS;
      if (this._walletRecoveryDemo()) return this.DEMO_BRIDGE_DIAGNOSTICS_WALLET;
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getBridgeDiagnostics !== 'function') {
        return null;
      }
      try {
        return bridge.getBridgeDiagnostics();
      } catch (err) {
        console.warn('[settings] getBridgeDiagnostics failed:', err);
        return null;
      }
    },

    _hasNativeCapability(name) {
      const diag = this._bridgeDiagnostics();
      return !!diag && Array.isArray(diag.capabilities) &&
        diag.capabilities.includes(name);
    },

    // The copyable report. Deliberately assembled from the diagnostics
    // snapshot only — it carries no capability token, no session cookie
    // and no user data, so it is safe to paste into an issue.
    _bridgeDiagnosticsText(diag) {
      const at = (ms) => {
        if (!ms) return 'never';
        try { return new Date(ms).toISOString(); } catch (_) { return String(ms); }
      };
      const lines = [
        globalThis.PlatformI18n.t("settings:homeroom_bridge_diagnostics_c4463115"),
        globalThis.PlatformI18n.t("settings:collected_value1_37428f18", { value1: at(diag.collectedAt) }),
        globalThis.PlatformI18n.t("settings:origin_value1_39955c32", { value1: diag.origin || globalThis.PlatformI18n.t("settings:message_b23a6a8439c0") }),
        globalThis.PlatformI18n.t("settings:native_value1_topframe_value2_f85dc2f0", { value1: diag.isNative, value2: diag.isTopFrame }) +
          globalThis.PlatformI18n.t("settings:relay_value1_channel_value2_4f36343b", { value1: diag.usesIframeRelay, value2: diag.hasNativeChannel }),
        globalThis.PlatformI18n.t("settings:bridge_version_value1_e006514f", { value1: diag.bridgeVersion }),
        globalThis.PlatformI18n.t("settings:app_value1_value2_3d4577fb", { value1: diag.appVersion || globalThis.PlatformI18n.t("settings:message_b23a6a8439c0"), value2: diag.buildNumber || '?' }),
        globalThis.PlatformI18n.t("settings:capabilities_value1_c46d70d9", { value1: (diag.capabilities || []).join(', ') || globalThis.PlatformI18n.t("settings:message_140bedbf9c3f") }),
        globalThis.PlatformI18n.t("settings:privileged_state_value1_2c912d7a", { value1: diag.privileged.state }) +
          (diag.privileged.code ? globalThis.PlatformI18n.t("settings:code_value1_f9d508fd", { value1: diag.privileged.code }) : '') +
          (diag.privileged.kind ? globalThis.PlatformI18n.t("settings:kind_value1_531b9156", { value1: diag.privileged.kind }) : ''),
        globalThis.PlatformI18n.t("settings:privileged_attempts_value1_136a81ea", { value1: diag.privileged.attempts }) +
          globalThis.PlatformI18n.t("settings:last_value1_62fb2447", { value1: at(diag.privileged.at) }),
      ];
      if (diag.privileged.message) {
        lines.push(globalThis.PlatformI18n.t("settings:privileged_message_value1_865bee77", { value1: diag.privileged.message }));
      }
      const methods = Object.keys(diag.lastErrors || {});
      lines.push(methods.length
        ? globalThis.PlatformI18n.t("settings:last_read_errors_7fbdaa26")
        : globalThis.PlatformI18n.t("settings:last_read_errors_none_f90ea298"));
      methods.forEach((method) => {
        const rec = diag.lastErrors[method];
        lines.push(`  ${method}: ${rec.kind}, ${rec.message || globalThis.PlatformI18n.t("settings:no_message_20bb545a")} ` +
          `(${at(rec.at)})`);
      });
      const readiness = (window.SocialPush &&
        typeof SocialPush.readinessState === 'function')
        ? SocialPush.readinessState()
        : null;
      if (readiness) {
        lines.push(globalThis.PlatformI18n.t("settings:push_readiness_ready_value1_a9a86df3", { value1: readiness.ready }) +
          globalThis.PlatformI18n.t("settings:attempts_value1_exhausted_value2_3e9ad721", { value1: readiness.attempts, value2: readiness.exhausted }) +
          (readiness.lastError ? globalThis.PlatformI18n.t("settings:last_value1_b8001577", { value1: readiness.lastError }) : ''));
      }
      const session = (window.NativeChrome &&
        typeof NativeChrome.lastSessionFailure === 'function')
        ? NativeChrome.lastSessionFailure()
        : null;
      if (session) {
        lines.push(globalThis.PlatformI18n.t("settings:last_session_failure_value1_d013ca79", { value1: session.stage }) +
          `${session.message || globalThis.PlatformI18n.t("settings:no_message_20bb545a")} (${at(session.at)})`);
      }
      return lines.join('\n');
    },

    // Rendered FIRST inside the Homeroom app section and independent of
    // the settings snapshot: when the handshake is refused there is no
    // snapshot, and this panel is the only thing that can say why.

    // Everything a stuck device can retry from here, in one press: a fresh
    // capability probe, a fresh admission attempt, a fresh readiness
    // budget, then a re-read of the settings snapshot.
    async _retryUsernodeConnection() {
      if (window.NativeChrome) {
        NativeChrome._infoPromise = null;
        try {
          if (typeof NativeChrome.getInfo === 'function') {
            await NativeChrome.getInfo();
          }
          if (typeof NativeChrome.recoverSessionAdmission === 'function') {
            await NativeChrome.recoverSessionAdmission();
          }
        } catch (err) {
          console.warn('[settings] connection retry failed:', err);
        }
      }
      if (window.SocialPush &&
          typeof SocialPush.retryBridgeReadiness === 'function') {
        try { SocialPush.retryBridgeReadiness(); } catch (_) {}
      }
      this._usernodeState = null;
      await this._renderUsernodeSection();
    },

    async _renderUsernodeSection() {
      // Gated on BEING IN THE APP, not on the getSettingsState capability.
      // That probe is itself a casualty of the failures this section now
      // diagnoses — a degraded getBridgeInfo answers "no capabilities", so
      // the section used to disappear exactly when the user needed it most.
      // getBridgeInfo is unprivileged, so `isNative` stays readable on a
      // device whose privileged handshake is refused.
      const bridge = window.usernode;
      const demo = this._unDemoMode();
      const gated = this._bridgeDiagDemo() || this._walletRecoveryDemo() ||
        this._widgetIconsDemo() || !!demo ||
        (!!bridge && bridge.isNative === true);
      // The gate resolves asynchronously downstream, so the "Homeroom app"
      // menu row is only settled here — re-render the nav either way.
      if (!gated) {
        this._usernodeGated = false;
        this._publishUsernode();
        this._renderNavIfOpen();
        return;
      }
      this._usernodeGated = true;
      this._publishUsernode();
      this._renderNavIfOpen();
      const token = ++this._usernodeRenderToken;
      // A fresh mount re-probes the real notification permission (below)
      // and drops the previous visit's dead-end notice.
      this._unPushProbed = false;
      this._unNotifNotice = null;
      if (demo) {
        // Fixed snapshot, no bridge call: this link exists to make the
        // notification row reachable from a browser.
        this._usernodeState = this.DEMO_USERNODE_STATE;
        this._unPushStatus = demo === 'ios-denied' ? 'denied' : 'undetermined';
        this._unPushProbed = true;
        this._unCanOpenNotifSettings = true;
        this._usernodeLoading = false;
      this._publishUsernode();
        return;
      }
      if (!this._usernodeState) {
        // The in-place progress line, which a retry swaps in while leaving
        // the rest of the section up.
        this._usernodeLoading = true;
        this._publishUsernode();
      }
      let state = null;
      try {
        state = (window.usernode &&
          typeof window.usernode.getSettingsState === 'function')
          ? await window.usernode.getSettingsState()
          : null;
      } catch (err) {
        // Defensive only: the bridge read resolves a fallback rather than
        // rejecting, so the reason arrives through the record below.
        console.warn('[settings] getSettingsState failed:', err);
      }
      // A later attempt already painted — its result is the fresher one.
      if (token !== this._usernodeRenderToken) return;
      if (state) this._usernodeState = state;
      if (!this._usernodeState) {
        // The app may simply still be booting; retry itself once it reports
        // a ready identity, so the section fills in without a tap.
        this._armUsernodeAuthStatusRetry();
        this._usernodeLoading = false;
        this._publishUsernode();
        return;
      }
      this._clearUsernodeAuthStatusRetry();
      this._usernodeLoading = false;
      this._publishUsernode();
      // Both used to be renderers that fetched into their own host and
      // repainted it through a local closure. They fill their slice of the
      // model instead, so the rest of the body never waits on either.
      this._initSocialPush();
      this._initBlockProduction();
      this._probeUnNotifPermission(token);
    },

    // The row's truth, read BEFORE it can mislead.
    //
    // `permissions.exactAlarmGranted` is a lagging proxy on iOS — there
    // are no exact alarms there — and a build that reports it `true`
    // painted "Notifications — Granted" with no control whatsoever, which
    // is exactly the reported "nothing happens at all when I tap it".
    // public/js/native-chrome.js's first-run sheet has always overridden
    // that boolean with the real push status before deciding; this screen
    // never did, which is why #1192 (which only settles the status AFTER a
    // request) did not reach the in-app Settings case.
    //
    // Runs once per mount and only re-renders on a real change, so it
    // cannot loop. Token-guarded like every other write to this section.
    async _probeUnNotifPermission(token) {
      if (this._unPushProbed) return;
      this._unPushProbed = true;
      const nc = window.NativeChrome;
      if (!nc) return;
      let status = this._unPushStatus;
      let canOpen = this._unCanOpenNotifSettings;
      try {
        if (typeof nc.iosPushPermissionStatus === 'function') {
          status = await nc.iosPushPermissionStatus();
        }
        if (typeof nc.supports === 'function') {
          canOpen = await nc.supports('openNotificationSettings');
        }
      } catch (err) {
        // Never fatal: an unreadable probe leaves the row tappable and the
        // ask routed through the bridge, which is the safe default.
        console.warn('[settings] notification permission probe failed:', err);
        return;
      }
      if (token !== this._usernodeRenderToken) return;
      const changed = status !== this._unPushStatus ||
        canOpen !== this._unCanOpenNotifSettings;
      this._unCanOpenNotifSettings = canOpen;
      if (status != null) this._unPushStatus = status;
      if (changed) this._usernodeLoading = false;
      this._publishUsernode();
    },

    // Why the snapshot came back empty, straight from the bridge's
    // out-of-band record. null when the bridge is too old to keep one.
    _usernodeReadError() {
      if (this._bridgeDiagDemo()) {
        return this.DEMO_BRIDGE_DIAGNOSTICS.lastErrors.getSettingsState;
      }
      return (window.NativeChrome &&
        typeof NativeChrome.lastReadError === 'function')
        ? NativeChrome.lastReadError('getSettingsState')
        : null;
    },

    // One re-attempt per mount when the app reports a ready identity: a
    // Settings screen opened during app start-up is the common way to see
    // the read fail, and the app announces readiness on this event
    // (native-chrome.js listens to the same one to start the node).
    _armUsernodeAuthStatusRetry() {
      if (this._usernodeAuthStatusListener) return;
      if (this._usernodeAuthRetryUsed) return;
      const listener = (e) => {
        const d = e && e.detail;
        if (!d || d.phase !== 'ready') return;
        this._usernodeAuthRetryUsed = true;
        this._clearUsernodeAuthStatusRetry();
        this._renderUsernodeSection();
      };
      this._usernodeAuthStatusListener = listener;
      window.addEventListener('usernode:auth-status', listener);
    },

    _clearUsernodeAuthStatusRetry() {
      if (!this._usernodeAuthStatusListener) return;
      window.removeEventListener(
        'usernode:auth-status', this._usernodeAuthStatusListener
      );
      this._usernodeAuthStatusListener = null;
    },





    // `opts.onActivate` turns the row itself into a real control.
    //
    // Without it the row is a plain `div` with no listener, so tapping it
    // is a no-op BY CONSTRUCTION — and the only control was a small chip
    // rendered underneath, conditionally. On a phone the row is what a
    // thumb lands on, so the notifications row now carries the tap and the
    // chip is a second affordance rather than the only one.

    _openNativeScreen(screen, failMsg) {
      if (!window.usernode ||
          typeof window.usernode.openNativeScreen !== 'function') return;
      window.usernode.openNativeScreen(screen).catch((err) => {
        console.warn('[settings] openNativeScreen failed:', err);
        if (window.PlatformUI) {
          PlatformUI.toast(this._nativeActionMessage(err, failMsg));
        }
      });
    },

    // A refused privileged handshake is not "action failed" — nothing the
    // user does on this screen will work until the app re-establishes it,
    // so say that instead of a message that invites another tap. The
    // bridge tags those rejections; see usernodePrivileged in
    // public/usernode-bridge.js.
    _nativeActionMessage(err, fallback) {
      if (err && err.usernodePrivileged === true) {
        return globalThis.PlatformI18n.t("settings:the_homeroom_app_isn_t_accepting_changes_from_th_2b7bf898");
      }
      return fallback;
    },

    // iOS only: the settled notification-permission status, once this
    // screen has asked for it. Null means "no answer of our own yet", and
    // the row falls back to the snapshot boolean.
    _unPushStatus: null,

    // "Allow notifications" / "Request permissions".
    //
    // Android's returned snapshot IS the answer, so it re-renders straight
    // from it. iOS's is not: the native permission caches settle
    // asynchronously after the OS dialog and some builds resolve
    // requestPermissions() before the user has even answered, so trusting
    // that one read repainted the row as "Not granted" moments after a
    // real grant — and nothing started push registration. Defer to
    // NativeChrome.settleIosPushGrant, which polls for a determined status
    // and kicks SocialPush, so this screen and the first-run sheet
    // complete a grant identically.
    async _unRequestPermissions(isAndroid) {
      if (this._unRequestInFlight) return;
      this._unRequestInFlight = true;
      // Visible acknowledgement BEFORE anything can block: whatever the
      // rest of this does, the tap is never again silent.
      this._unNotifNotice = {
        tone: 'info',
        text: isAndroid
          ? globalThis.PlatformI18n.t("settings:opening_the_permission_prompt_64c1477f")
          : globalThis.PlatformI18n.t("settings:opening_the_notification_prompt_729279cc"),
      };
      this._usernodeLoading = false;
      this._publishUsernode();
      try {
        await this._runNotifPermissionTap(isAndroid);
      } finally {
        this._unRequestInFlight = false;
        this._usernodeLoading = false;
      this._publishUsernode();
      }
    },

    // Route the tap through the pure decision functions in
    // public/js/native-chrome.js, then route the ANSWER through the second
    // one. Every branch either opens something or leaves a visible notice
    // plus a console.error — there is no path back out of here that looks
    // like nothing happened.
    async _runNotifPermissionTap(isAndroid) {
      const nc = window.NativeChrome;
      const bridge = window.usernode;
      const hasRequest = !!bridge &&
        typeof bridge.requestPermissions === 'function';
      if (this._unDemoMode()) {
        // The browser demo link has no app behind it. Still answers
        // visibly — but this is a preview, not a dead end, so it does not
        // log the diagnostic error the real branches do.
        this._unNotifNotice = {
          tone: 'info',
          get text() { return globalThis.PlatformI18n.t("settings:this_is_a_preview_of_the_in_app_row_the_notifica_13054966"); },
        };
        return;
      }
      if (!nc || typeof nc.decideNotificationTap !== 'function') {
        // Old bundle: fall back to the plain ask rather than refusing.
        if (!hasRequest) {
          this._unNotifDeadEnd('no-bridge', {
            get text() { return globalThis.PlatformI18n.t("settings:notification_permission_is_only_available_inside_e7162b45"); },
            settings: false,
          });
          return;
        }
        await this._applyNotifAnswer(isAndroid,
          await bridge.requestPermissions());
        return;
      }
      const plan = nc.decideNotificationTap({
        isNative: !!bridge && bridge.isNative === true,
        hasRequestMethod: hasRequest,
        supported: typeof nc.supports === 'function'
          ? await nc.supports('requestPermissions')
          : null,
        isAndroid,
        pushStatus: this._unPushStatus,
        canOpenSettings: this._unCanOpenNotifSettings === true,
      });
      if (plan.verdict !== 'request') {
        if (plan.verdict === 'already') {
          // Not a failure — say so and stop, rather than calling a method
          // that resolves instantly and shows nothing.
          this._unNotifNotice = {
            tone: 'ok',
            get text() { return globalThis.PlatformI18n.t("settings:notifications_are_already_allowed_for_homeroom_59a91e71"); },
          };
          return;
        }
        this._unNotifDeadEnd(plan.verdict, {
          text: this._notifDeadEndText(plan, isAndroid),
          settings: plan.settings === true,
          reason: plan.reason,
        });
        return;
      }
      let next = null;
      try {
        next = await this._unRaceNativeAnswer(bridge.requestPermissions());
      } catch (err) {
        this._unNotifDeadEnd(err && err.usernodeNoAnswer ? 'no-answer' : 'failed', {
          text: err && err.usernodeNoAnswer
            ? globalThis.PlatformI18n.t("settings:the_homeroom_app_didn_t_respond_to_the_permissio_c14ed244")
            : this._nativeActionMessage(err,
                globalThis.PlatformI18n.t("settings:the_permission_request_could_not_be_started_7251d65f")),
          settings: this._unCanOpenNotifSettings === true,
          reason: err && err.message,
        });
        return;
      }
      await this._applyNotifAnswer(isAndroid, next);
    },

    // What the tap ended up as, once the app answered. `settleIosPushGrant`
    // stays the authority on iOS: the native permission caches settle
    // asynchronously after the OS dialog and some builds resolve
    // requestPermissions() before the user has even answered, so trusting
    // that one read repainted the row as "Not granted" moments after a real
    // grant — and nothing started push registration. It polls for a
    // determined status and kicks SocialPush, so this screen and the
    // first-run sheet complete a grant identically.
    async _applyNotifAnswer(isAndroid, next) {
      if (next && typeof next === 'object') this._usernodeState = next;
      const granted = !!(next && next.granted === true);
      const nc = window.NativeChrome;
      if (!isAndroid && nc && typeof nc.settleIosPushGrant === 'function') {
        const settled = await nc.settleIosPushGrant(granted);
        this._unPushStatus = settled.status || this._unPushStatus;
      }
      const outcome = (nc && typeof nc.decideNotificationOutcome === 'function')
        ? nc.decideNotificationOutcome({
            isAndroid,
            granted: granted || this._unPushStatus === 'granted',
            pushStatus: this._unPushStatus,
            canOpenSettings: this._unCanOpenNotifSettings === true,
          })
        : { verdict: granted ? 'granted' : 'declined', settings: false };
      if (outcome.verdict === 'granted') {
        this._unNotifNotice = {
          tone: 'ok',
          text: isAndroid
            ? globalThis.PlatformI18n.t("settings:permission_granted_63895f3e")
            : globalThis.PlatformI18n.t("settings:notifications_are_now_allowed_for_homeroom_29f715c7"),
        };
        this._usernodeLoading = false;
      this._publishUsernode();
        return;
      }
      this._unNotifDeadEnd(outcome.verdict, {
        text: this._notifDeadEndText(outcome, isAndroid),
        settings: outcome.settings === true,
        reason: outcome.reason,
      });
      this._usernodeLoading = false;
      this._publishUsernode();
    },

    // The bridge's own ceiling for requestPermissions is two minutes,
    // which is the right ceiling for a prompt a user has to read but a
    // terrible one for a native side that never answers: two minutes of a
    // disabled control and no explanation reads as a dead tap. Surface the
    // silence at 20s; a late real answer still applies through the
    // section's normal re-render.
    _UN_NATIVE_ANSWER_MS: 20000,

    _unRaceNativeAnswer(promise) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error(globalThis.PlatformI18n.t("settings:the_homeroom_app_did_not_answer_in_time_920d792b"));
          err.usernodeNoAnswer = true;
          reject(err);
        }, this._UN_NATIVE_ANSWER_MS);
        Promise.resolve(promise).then((value) => {
          clearTimeout(timer);
          if (settled) {
            // The app answered after we gave up — honour it anyway.
            this._applyNotifAnswer(
              (this._usernodeState && this._usernodeState.permissions &&
                this._usernodeState.permissions.platform) === 'android',
              value
            ).catch(() => {});
            return;
          }
          settled = true;
          resolve(value);
        }, (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(err);
        });
      });
    },

    _notifDeadEndText(plan, isAndroid) {
      switch (plan.verdict) {
        case 'no-bridge':
          return globalThis.PlatformI18n.t("settings:notification_permission_is_only_available_inside_e7162b45");
        case 'unsupported':
          return globalThis.PlatformI18n.t("settings:this_version_of_the_homeroom_app_can_t_open_the__d8939172");
        case 'settings':
          return isAndroid
            ? globalThis.PlatformI18n.t("settings:permission_was_denied_allow_notifications_in_the_6bececd1")
            : globalThis.PlatformI18n.t("settings:notifications_are_turned_off_for_homeroom_ios_on_561ae5ff");
        case 'declined':
          return globalThis.PlatformI18n.t("settings:permission_was_not_granted_ea5e3780");
        case 'silent':
          return globalThis.PlatformI18n.t("settings:the_homeroom_app_closed_without_showing_the_noti_975826ec");
        default:
          return globalThis.PlatformI18n.t("settings:the_notification_prompt_could_not_be_opened_36ea1087");
      }
    },

    // Every dead end lands here: a visible notice AND a console error, so
    // the next report of a dead tap comes with a line in the dev console
    // saying which branch swallowed it.
    _unNotifDeadEnd(kind, opts) {
      const reason = (opts && opts.reason) || globalThis.PlatformI18n.t("settings:no_reason_recorded_e79ca98b");
      console.error(
        `[settings] notification permission dead end (${kind}): ${reason}`
      );
      this._unNotifNotice = {
        tone: 'warn',
        text: (opts && opts.text) || globalThis.PlatformI18n.t("settings:the_notification_prompt_could_not_be_opened_36ea1087"),
        settings: !!(opts && opts.settings),
      };
    },

    // The notice, plus — only when the app positively advertises the
    // capability — a way out of a determined-denied permission. A button
    // that cannot work is worse than no button, so an inconclusive
    // capability probe (null) renders the manual instructions instead.

    // Awaits a bridge setter and re-renders the section from the refreshed
    // snapshot it resolves with.
    async _unApply(promise) {
      const state = await promise;
      if (state && typeof state === 'object') {
        this._usernodeState = state;
        this._usernodeLoading = false;
      this._publishUsernode();
      }
    },

    // ── Terms (thin-shell migration) ──────────────────────────────────
    // The native terms screen is gone; the current published terms and
    // the consent write now live on the session-authed /challenges-api
    // twins of the v4 terms endpoints (src/routes/topochain/mobile.js).
    // Shared by the About & legal section below, profile.js's gated
    // token-allocation notice, and the first-run prompt (issue #1297,
    // ./terms-first-run.js + app.js's ?shot=terms-consent). `onAccepted`
    // fires after a successful accept so callers can refresh their own
    // terms-gated UI.
    //
    // opts (all optional):
    //   firstRun — first-arrival framing: an intro line explaining why
    //     the sheet appeared, plus a Decline button that records
    //     status 'refused' (the upsert on (user, version) means a later
    //     accept from the profile notice still works). A backdrop
    //     dismissal / Close records nothing, so an unanswered prompt
    //     comes back on the next page load.
    //   blocking — the native-app gate (#1328): present a NON-dismissible
    //     centered modal instead of the sheet — no backdrop tap, no
    //     Escape, no Close button. Accept and Decline are the only exits;
    //     a failed POST re-enables them with the overlay still up. Falls
    //     back to the dismissible sheet when the kit modal is unavailable
    //     (better than presenting nothing), and is ignored when the
    //     current version is already accepted (there would be no exit).
    //   onAnswered(status) — fires after ANY successful consent POST
    //     ('accepted' or 'refused'); the first-run trigger uses it to
    //     stop re-checking this document.
    //   onClosed — fires when the overlay is torn down (answered or
    //     quietly dismissed); the trigger uses it to allow a later
    //     re-offer.
    //   payload — a pre-fetched (or fixed) /terms/current data object;
    //     skips the fetch. The first-run trigger passes the payload it
    //     already fetched, and the ?shot=terms-consent /
    //     ?shot=terms-consent-blocking screenshot states pass a fixed one
    //     so the shots do no fetch and no writes.
    _termsSheetOpen: false,
    async showTermsSheet(onAccepted, opts) {
      opts = opts || {};
      // Reentrancy guard (#1361): never lift a second terms overlay over
      // an open one. Return-early, not dismiss-and-replace, so a blocking
      // native modal can never be displaced by a later plain open. The
      // flag clears in the wrapped onClosed below — the kit fires
      // onDismiss on every teardown, programmatic dismiss included.
      if (this._termsSheetOpen) return;
      const firstRun = opts.firstRun === true;
      let payload = opts.payload || null;
      if (!payload) {
        try {
          const res = await fetch('/challenges-api/terms/current', {
            credentials: 'same-origin',
          });
          const body = await res.json().catch(() => ({}));
          if (res.status === 404) {
            // No published terms version — nothing to accept.
            if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:no_terms_to_review_right_now_836ccd73"));
            return;
          }
          if (!res.ok || !body.success) {
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          payload = body.data;
        } catch (err) {
          console.warn('[settings] terms fetch failed:', err);
          if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:could_not_load_the_terms_d7d4499d"));
          return;
        }
      }

      // A local element helper. This panel is handed to the kit
      // (PlatformUI.sheet reparents it), so it stays imperative — it was
      // borrowing the usernode section's `_unEl`, which converted with it.
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };
      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3',
        payload.title || globalThis.PlatformI18n.t("settings:terms_ede54899")));
      if (firstRun) {
        panel.appendChild(el('p',
          'text-sm text-zinc-600 dark:text-zinc-400 mb-2',
          globalThis.PlatformI18n.t("settings:reviewing_the_terms_is_part_of_joining_the_platf_2fc352b8")));
      }
      const meta = [];
      if (payload.version) meta.push(globalThis.PlatformI18n.t("settings:version_value1_d0f3aa75", { value1: payload.version }));
      if (payload.published_at) {
        try {
          meta.push('published ' +
            new Date(payload.published_at).toLocaleDateString(globalThis.PlatformI18n.getLanguage()));
        } catch (_) {}
      }
      if (meta.length) {
        panel.appendChild(el('p',
          'text-xs text-zinc-500 dark:text-zinc-400 mb-2', meta.join(' · ')));
      }
      if (payload.terms_link) {
        const a = el('a',
          'block text-sm text-violet-700 dark:text-violet-400 underline mb-3',
          globalThis.PlatformI18n.t("settings:read_the_full_terms_05e37a9b"));
        a.href = payload.terms_link;
        a.target = '_blank';
        a.rel = globalThis.PlatformI18n.t("settings:noopener_noreferrer_ec0f84cc");
        panel.appendChild(a);
      }

      const accepted = !!(payload.consent && payload.consent.accepted);
      // Blocking gate (#1328): meaningless once this version is accepted —
      // a non-dismissible overlay with no consent buttons has no exit.
      const blocking = opts.blocking === true && !accepted;
      const statusEl = el('p', 'text-sm mb-3 ' + (accepted
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-zinc-600 dark:text-zinc-400'),
      accepted
        ? globalThis.PlatformI18n.t("settings:you_accepted_this_version_aff9403e") +
          (payload.consent.responded_at
            ? ' on ' + new Date(payload.consent.responded_at).toLocaleDateString(globalThis.PlatformI18n.getLanguage())
            : '') + '.'
        : globalThis.PlatformI18n.t("settings:you_have_not_accepted_this_version_yet_737bfca8"));
      panel.appendChild(statusEl);

      let sheet = null;
      if (!accepted) {
        // Both buttons post through here so a double-click (or a tap on
        // Decline while Accept is in flight) can't file two answers —
        // the endpoint upserts on (user, version) anyway, but disabled
        // buttons are the honest UI. No app_version is sent: that field
        // belongs to the mobile client.
        const consentButtons = [];
        const postConsent = async (status, onOk) => {
          consentButtons.forEach((b) => { b.disabled = true; });
          try {
            const res = await fetch('/challenges-api/terms/consent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                terms_version_id: payload.id,
                status,
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
              throw new Error(body.error || `HTTP ${res.status}`);
            }
            if (sheet && sheet.dismiss) sheet.dismiss();
            if (typeof opts.onAnswered === 'function') opts.onAnswered(status);
            onOk();
          } catch (err) {
            console.warn('[settings] terms consent failed:', err);
            if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:could_not_record_your_consent_dd2f3591"));
            consentButtons.forEach((b) => { b.disabled = false; });
          }
        };

        const acceptBtn = el('button',
          'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 ' +
          'text-sm font-medium text-white', globalThis.PlatformI18n.t("settings:accept_the_terms_04ef5261"));
        acceptBtn.addEventListener('click', () => postConsent('accepted',
          () => {
            if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:terms_accepted_af982c8c"));
            if (typeof onAccepted === 'function') onAccepted();
          }));
        consentButtons.push(acceptBtn);
        panel.appendChild(acceptBtn);

        if (firstRun) {
          // A recorded refusal is what stops the prompt from nagging:
          // status becomes non-null so ./terms-first-run.js never asks
          // again for this version, while the profile notice remains the
          // way back to accepting later.
          const declineBtn = el('button',
            'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 ' +
            'px-4 py-2 mt-2 text-sm font-medium text-zinc-700 ' +
            'dark:text-zinc-200', globalThis.PlatformI18n.t("settings:decline_a2d285b3"));
          declineBtn.addEventListener('click', () => postConsent('refused',
            () => {
              if (window.PlatformUI) {
                PlatformUI.toast(
                  globalThis.PlatformI18n.t("settings:you_can_accept_the_terms_later_from_your_profile_8757d0f9"));
              }
            }));
          consentButtons.push(declineBtn);
          panel.appendChild(declineBtn);
        }
      }
      if (!blocking) {
        const closeBtn = el('button',
          'w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400',
        globalThis.PlatformI18n.t("settings:close_7d9eb7ac"));
        closeBtn.addEventListener('click', () => {
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        panel.appendChild(closeBtn);
      }

      // Re-check after the awaits above: a concurrent call could have
      // presented while this one was still fetching /terms/current.
      if (this._termsSheetOpen) return;
      const onClosed = () => {
        Settings._termsSheetOpen = false;
        if (typeof opts.onClosed === 'function') opts.onClosed();
      };
      if (blocking && window.PlatformUI &&
          typeof PlatformUI.modal === 'function') {
        // Non-dismissible modal (#1328): no backdrop tap, no Escape, no
        // Close — Accept/Decline are the only exits, and a failed POST
        // re-enables them with the overlay still up. The programmatic
        // dismiss() in postConsent (on success) is the one way out.
        sheet = PlatformUI.modal({
          contentEl: panel,
          dismissible: false,
          onDismiss: onClosed,
        });
      }
      if (!sheet) {
        // Web — and the degraded-kit fallback for a blocking ask, where
        // the dismissible sheet still beats presenting nothing.
        sheet = window.PlatformUI && PlatformUI.sheet
          ? PlatformUI.sheet({ contentEl: panel, onDismiss: onClosed })
          : null;
      }
      // Only an actually-presented overlay latches — a kit-less boot
      // (sheet null) must keep later opens working.
      this._termsSheetOpen = !!sheet;
    },

    // `readError` / `loading` only matter when there is NO snapshot: the
    // blocks that need one give way to the error box (or a loading line
    // during a retry), while everything the snapshot has no say over —
    // activity notifications, block production, Terms, the FAQ, the native
    // diagnostics screens — still renders. A failed read used to blank the
    // whole section, turning a transient app hiccup into a dead end.
    // ── Homeroom app section: view builders ────────────────────────────
    //
    // #1079: `_renderUsernodeBody` and eight sibling renderers built ~800
    // lines of `document.createElement` into #settings-usernode-section.
    // They are sections/usernode.tsx now, and what is left here is the
    // reading: every bridge call, every fetch, every retry ladder and every
    // staleness token stays exactly where it was, and ends in a publish.

    _publishUsernode() {
      const react = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsUsernode : null;
      if (!react || !react.publish) return;
      react.publish(this._usernodeView());
    },

    /** The whole section, as one plain serialisable model. */
    _usernodeView() {
      const s = this._usernodeState;
      const perms = (s && s.permissions) || {};
      const isAndroid = perms.platform === 'android';
      const demo = this._unDemoMode();
      const canOpenZkIdentity = this._hasNativeCapability('zkIdentityFlow');
      return {
        gated: this._usernodeGated === true,
        connection: this._usernodeConnectionView(),
        body: this._usernodeBodyView(),
        // The demo link renders the permission rows and stops: everything
        // below reads the live bridge, which a browser does not have.
        belowDemoCut: !demo,
        socialPush: this._socialPushView(),
        blockProduction: this._bpView(),
        privacy: s ? {
          facematch: {
            get label() { return globalThis.PlatformI18n.t("settings:strict_facematch_db9e96be"); },
            checked: s.facematchStrict !== false,
            action: '_setFacematchStrict',
          },
          open: canOpenZkIdentity ? {
            id: 'settings-usernode-open-zk-identity',
            get label() { return globalThis.PlatformI18n.t("settings:open_zk_identity_fb902228"); },
            action: '_openZkIdentityScreen',
          } : null,
          reset: { get label() { return globalThis.PlatformI18n.t("settings:restart_zk_challenge_8444b0af"); }, action: '_resetZkChallenge', danger: true },
        } : null,
        widgetIcons: this._widgetIconsView(),
        diagnostics: {
          debugMode: s ? {
            get label() { return globalThis.PlatformI18n.t("settings:debug_mode_166f2195"); }, checked: s.debugMode === true, action: '_setDebugMode',
          } : null,
          actions: [
            { get label() { return globalThis.PlatformI18n.t("settings:device_benchmark_706d2708"); }, action: '_openBenchmarkScreen' },
            { get label() { return globalThis.PlatformI18n.t("settings:http_debug_logs_2f45ced2"); }, action: '_openHttpLogsScreen' },
          ],
        },
        about: { notes: this._usernodeBuildNotes(), actions: [{
          label: (s && s.termsAccepted === false)
            ? globalThis.PlatformI18n.t("settings:review_terms_not_yet_accepted_cb5d7293") : globalThis.PlatformI18n.t("settings:terms_ede54899"),
          action: '_openTermsFromUsernode',
        }] },
        account: (s && s.authStatus !== 'authenticated') ? { rows: [], actions: [] } : null,
        isAndroid,
      };
    },

    _usernodeBuildNotes() {
      const bi = (this._usernodeState && this._usernodeState.buildInfo) || {};
      const bits = [];
      if (bi.appVersion) {
        bits.push(globalThis.PlatformI18n.t("settings:app_value1_3d48d7d8", { value1: bi.appVersion }) + (bi.buildNumber ? ` (${bi.buildNumber})` : ''));
      }
      if (bi.nodeVersion) bits.push(globalThis.PlatformI18n.t("settings:node_value1_bc3904a6", { value1: bi.nodeVersion }));
      if (bi.commitHash) bits.push(bi.commitHash);
      return bits.length ? [{ text: bits.join(' · '), tone: 'mono' }] : [];
    },

    _usernodeConnectionView() {
      const diag = this._bridgeDiagnostics();
      if (!diag) return null;
      const state = (diag.privileged && diag.privileged.state) || 'unknown';
      const bits = [];
      if (diag.appVersion) {
        bits.push(globalThis.PlatformI18n.t("settings:app_value1_3d48d7d8", { value1: diag.appVersion }) +
          (diag.buildNumber ? ` (${diag.buildNumber})` : ''));
      }
      bits.push(globalThis.PlatformI18n.t("settings:bridge_v_value1_e110c6fa", { value1: diag.bridgeVersion }));
      const demo = !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo();
      return {
        demo: !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo(),
        row: {
          get label() { return globalThis.PlatformI18n.t("settings:secure_app_connection_2feb90ba"); },
          ok: state === 'ready',
          text: state === 'ready'
            ? this.PRIVILEGED_STATE_LABELS.ready
            : (this.PRIVILEGED_STATE_LABELS[state] || globalThis.PlatformI18n.t("settings:unavailable_ca184496")),
        },
        reason: this.PRIVILEGED_STATE_REASONS[state] ||
          this.PRIVILEGED_STATE_REASONS.unknown,
        build: bits.join(' · '),
        message: (diag.privileged && diag.privileged.message) || null,
        // Read-only hook: the buttons render so the screenshot shows the real
        // panel, but they must not touch a bridge or a session.
        retryDisabled: !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo(),
        // The pre-merge wallet recovery, offered HERE and nowhere else. It
        // was a dialog that opened itself whenever admission failed with
        // `native_session_wallet_pool_exhausted` — several times a session,
        // since admission retries on every online / pageshow /
        // visibilitychange — for what is a minor feature. Now the failure is
        // only recorded (NativeChrome.lastSessionFailure) and this button is
        // the one way in.
        walletRecovery: this._walletRecoveryAvailable() ? {
          id: 'settings-usernode-connect-wallet',
          get label() { return globalThis.PlatformI18n.t("settings:connect_existing_wallet_0b6aca1e"); },
          action: '_openWalletRecovery',
          disabled: demo,
        } : null,
      };
    },

    WALLET_POOL_EXHAUSTED: 'native_session_wallet_pool_exhausted',

    // True when the LAST native admission attempt was refused because no
    // seeded wallet is left for this account and the session is still not
    // admitted — the one state the recovery dialog can do anything about.
    // Clears itself: a successful admission nulls _lastSessionFailure, and
    // `usernode:native-session-admission` (bound in init) republishes the
    // panel so the button goes away without a navigation.
    _walletRecoveryAvailable() {
      if (this._walletRecoveryDemo()) return true;
      const nc = window.NativeChrome;
      if (!nc || typeof nc.lastSessionFailure !== 'function' ||
          typeof nc.isSessionAdmitted !== 'function') return false;
      if (nc.isSessionAdmitted()) return false;
      const failure = nc.lastSessionFailure();
      if (!failure || failure.code !== this.WALLET_POOL_EXHAUSTED) return false;
      const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
      return !!(dialogs && dialogs.walletRecovery &&
        typeof dialogs.walletRecovery.open === 'function');
    },

    // The button's action. Opens features/dialogs/wallet-recovery.tsx for the
    // signed-in user; the dialog replays the same admission attempt once the
    // wallet is claimed, and the admission event above repaints this panel.
    _openWalletRecovery() {
      if (this._walletRecoveryDemo()) {
        throw new Error(globalThis.PlatformI18n.t("settings:staging_demo_there_is_no_session_to_recover_here_de2726f2"));
      }
      const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
      const dialog = dialogs && dialogs.walletRecovery;
      if (!dialog || typeof dialog.open !== 'function') {
        throw new Error(globalThis.PlatformI18n.t("settings:wallet_recovery_is_not_available_on_this_screen_a93ea447"));
      }
      const raw = window.App && App.user ? App.user.id : null;
      const userId = raw == null ? '' : String(raw);
      if (!/^[1-9][0-9]*$/.test(userId)) {
        throw new Error(globalThis.PlatformI18n.t("settings:sign_in_before_connecting_a_wallet_7959bdda"));
      }
      dialog.open({ userId });
    },

    _usernodeBodyView() {
      const s = this._usernodeState;
      if (!s) {
        if (this._usernodeLoading) return { kind: 'loading' };
        const readError = this._usernodeReadError();
        const kind = readError && readError.kind;
        return {
          kind: 'error',
          reason: this.USERNODE_READ_ERROR_REASONS[kind] ||
            this.USERNODE_READ_ERROR_FALLBACK,
          message: (readError && readError.message) || null,
        };
      }
      const perms = s.permissions || {};
      const isAndroid = perms.platform === 'android';
      // iOS row truth: `exactAlarmGranted` is a lagging proxy for the
      // notification permission (there are no exact alarms on iOS), so once a
      // request has settled through NativeChrome.settleIosPushGrant that
      // answer is the authority — the same rule the first-run sheet applies.
      const notifOk = !isAndroid && this._unPushStatus != null
        ? this._unPushStatus === 'granted'
        : !!perms.exactAlarmGranted;
      const n = this._unNotifNotice;
      return {
        kind: 'permissions',
        demo: !!this._unDemoMode(),
        get heading() { return globalThis.PlatformI18n.t("settings:homeroom_app_device_permissions_68127650"); },
        description: isAndroid
          ? globalThis.PlatformI18n.t("settings:block_production_needs_the_app_to_wake_your_devi_fae4d315")
          : globalThis.PlatformI18n.t("settings:notifications_let_homeroom_alert_you_about_node__8e24f2de"),
        // The row IS the control. It used to be an inert div whose only
        // affordance was a chip below, rendered only when the (iOS-meaningless)
        // exactAlarmGranted boolean said "not granted" — so on a build
        // reporting it `true` there was nothing to tap at all.
        row: {
          id: 'settings-notif-row',
          label: isAndroid ? globalThis.PlatformI18n.t("settings:exact_alarms_b39f0e41") : globalThis.PlatformI18n.t("settings:notifications_78801183"),
          ok: notifOk,
          text: notifOk ? globalThis.PlatformI18n.t("settings:granted_62026a42") : globalThis.PlatformI18n.t("settings:not_granted_352a5b4c"),
          hint: isAndroid ? globalThis.PlatformI18n.t("settings:request_permissions_52480b6c") : globalThis.PlatformI18n.t("settings:allow_notifications_8637f38c"),
          action: '_requestUsernodePermissions',
        },
        button: notifOk ? null : {
          label: isAndroid ? globalThis.PlatformI18n.t("settings:request_permissions_db910d2c") : globalThis.PlatformI18n.t("settings:allow_notifications_001559c8"),
          action: '_requestUsernodePermissions',
        },
        notice: n ? {
          text: n.text,
          tone: n.tone === 'warn' ? 'warn' : (n.tone === 'ok' ? 'ok' : 'plain'),
          settings: !!(n.settings && this._unCanOpenNotifSettings === true),
        } : null,
        android: isAndroid ? {
          row: {
            get label() { return globalThis.PlatformI18n.t("settings:battery_optimization_e2c2b8ef"); },
            ok: perms.batteryOptDisabled === true,
            text: perms.batteryOptDisabled === true ? globalThis.PlatformI18n.t("settings:unrestricted_ea72a231") : globalThis.PlatformI18n.t("settings:restricted_a00571bc"),
          },
          button: perms.batteryOptDisabled === true ? null : {
            get label() { return globalThis.PlatformI18n.t("settings:open_battery_settings_3163b5dd"); }, action: '_openBatterySettings',
          },
          device: perms.deviceManufacturer ? globalThis.PlatformI18n.t("settings:device_value1_2f4b7f85", { value1: perms.deviceManufacturer }) : null,
        } : null,
      };
    },

    _socialPushView() {
      if (!window.SocialPush || this._socialPushSupported === false) {
        return { kind: 'absent' };
      }
      const state = this._socialPushState;
      if (state === undefined) return { kind: 'checking' };
      if (!state) {
        const admissionPending = window.NativeChrome &&
          typeof NativeChrome.isSessionAdmitted === 'function' &&
          !NativeChrome.isSessionAdmitted();
        // "Finishing secure app sign-in…" is a lie once the handshake has been
        // refused — nothing is finishing. Name the state and point at the
        // panel that explains it.
        const diag = this._bridgeDiagnostics();
        const stuck = !!diag && diag.privileged &&
          (diag.privileged.state === 'blocked-frame' ||
           diag.privileged.state === 'unattached');
        const failure = (window.NativeChrome &&
          typeof NativeChrome.lastSessionFailure === 'function')
          ? NativeChrome.lastSessionFailure() : null;
        return {
          kind: 'unavailable',
          reason: stuck
            ? globalThis.PlatformI18n.t("settings:the_homeroom_app_isn_t_accepting_this_screen_s_s_9b74ef87")
            : (admissionPending
              ? 'Finishing secure app sign-in before enabling notifications…'
              : globalThis.PlatformI18n.t("settings:notification_settings_are_temporarily_unavailabl_92460ef6")),
          failure: (failure && failure.message) || null,
          retry: !!(admissionPending && window.NativeChrome &&
            typeof NativeChrome.recoverSessionAdmission === 'function'),
        };
      }
      let status = globalThis.PlatformI18n.t("settings:off_on_this_device_78e679b9");
      if (state.deliveryActive) {
        status = globalThis.PlatformI18n.t("settings:on_this_device_is_registered_for_activity_notifi_4555ec03");
      } else if (state.permissionStatus === 'denied') {
        status = globalThis.PlatformI18n.t("settings:notification_permission_is_denied_in_the_device__7c0a8c1e");
      } else if (state.enabled && state.registrationStatus === 'registering') {
        status = globalThis.PlatformI18n.t("settings:enabling_notifications_24721556");
      } else if (state.enabled) {
        status = globalThis.PlatformI18n.t("settings:enabled_but_delivery_is_not_active_yet_6ad33231");
      }
      return { kind: 'ready', enabled: !!state.enabled, status };
    },

    _bpView() {
      const state = this._bpState;
      if (state === undefined) return { kind: 'checking' };
      if (!state) return { kind: 'note', get text() { return globalThis.PlatformI18n.t("settings:could_not_check_block_production_status_right_no_e64e7832"); } };
      if (state.bp_released) return { kind: 'note', get text() { return globalThis.PlatformI18n.t("settings:released_your_node_produces_blocks_when_it_wins__adf35d7a"); } };
      if (state.bp_requested) return { kind: 'note', get text() { return globalThis.PlatformI18n.t("settings:request_pending_you_ll_start_producing_automatic_077e16d0"); } };
      if (!state.has_platform_access) return { kind: 'note', get text() { return globalThis.PlatformI18n.t("settings:available_once_your_account_has_platform_access_03256d37"); } };
      return { kind: 'ask' };
    },

    _widgetIconsView() {
      const diag = this._widgetIconDiagnostics();
      if (!diag) return null;
      const sending = diag.resolved === true
        ? globalThis.PlatformI18n.t("settings:light_dark_pair_fc06e4cb")
        : (diag.resolved === false
          ? globalThis.PlatformI18n.t("settings:single_face_value1_01e5c9b7", { value1: diag.scheme })
          : globalThis.PlatformI18n.t("settings:undecided_single_face_for_now_2e8ab8ee"));
      const build = diag.build
        ? `${diag.build.appVersion} (${diag.build.buildNumber || '?'})`
        : 'unknown, the verdict is re-confirmed each time';
      const healedAt = diag.lastHealAt ? this._widgetIconTime(diag.lastHealAt) : 'never';
      const notes = [
        { get text() { return globalThis.PlatformI18n.t("settings:verdict_bound_to_app_version_value1_a893cb05", { value1: build }); }, tone: 'muted' },
        { text: globalThis.PlatformI18n.t("settings:last_icon_check_value1_919fc939", { value1: healedAt }) +
          (diag.lastHealOutcome ? `: ${diag.lastHealOutcome}` : ''), tone: 'muted' },
      ];
      if (diag.readError) {
        notes.push({
          text: `${diag.readError.method}: ` +
            (this.USERNODE_READ_ERROR_REASONS[diag.readError.kind] ||
              this.USERNODE_READ_ERROR_FALLBACK),
          tone: 'warn',
        });
      }
      return {
        demo: !!this._widgetIconsDemo(),
        rows: [
          { id: 'settings-widget-mechanism-row', get label() { return globalThis.PlatformI18n.t("settings:widget_shortcuts_5f28cf1a"); },
            ok: diag.mechanism === 'widget',
            text: diag.mechanism === 'widget' ? globalThis.PlatformI18n.t("settings:available_e6744473")
              : (diag.mechanism ? globalThis.PlatformI18n.t("settings:not_this_device_value1_9ef5a054", { value1: diag.mechanism }) : globalThis.PlatformI18n.t("settings:not_available_67a926f7")) },
          { id: 'settings-widget-registry-row', get label() { return globalThis.PlatformI18n.t("settings:pinned_registry_c9ea4eb5"); },
            ok: diag.registryLoaded === true,
            text: diag.registryLoaded === true
              ? globalThis.PlatformI18n.t("settings:loaded_value1_pinned_b1b35924", { value1: diag.entries.length }) : globalThis.PlatformI18n.t("settings:could_not_be_read_51a02791") },
          // Tri-state, and the third state is the point: `has()` used to
          // collapse "couldn't say" into "no".
          { id: 'settings-widget-capability-row', get label() { return globalThis.PlatformI18n.t("settings:dark_icon_capability_a688ec86"); },
            ok: diag.capability === true,
            text: diag.capability === true ? globalThis.PlatformI18n.t("settings:advertised_by_the_app_ea028841")
              : (diag.capability === false ? globalThis.PlatformI18n.t("settings:not_advertised_bbcd905d") : globalThis.PlatformI18n.t("settings:the_app_couldn_t_say_2b23bea4")) },
          { id: 'settings-widget-verdict-row', get label() { return globalThis.PlatformI18n.t("settings:confirmed_by_the_widget_f36e9669"); },
            ok: diag.verdict === 'supported',
            text: diag.verdict === 'supported' ? globalThis.PlatformI18n.t("settings:stores_both_faces_ef5d1b3d")
              : (diag.verdict === 'unsupported' ? globalThis.PlatformI18n.t("settings:single_face_only_fe4f3ad5") : globalThis.PlatformI18n.t("settings:not_confirmed_yet_96584d78")) },
          { id: 'settings-widget-sending-row', get label() { return globalThis.PlatformI18n.t("settings:sending_e595f17f"); },
            ok: diag.resolved === true, text: sending },
        ],
        notes,
        entries: this._widgetIconEntryViews(diag),
        recheck: !this._widgetIconsDemo(),
      };
    },

    /** Widget entry rows: dot + name + note, as data. */
    _widgetIconEntryViews(diag) {
      if (!diag.entries.length) {
        return [{ key: 'none', ok: true, name: '', note: '',
          get empty() { return globalThis.PlatformI18n.t("settings:no_shortcuts_are_pinned_to_the_widget_30503d43"); } }];
      }
      const flag = (v) => (v === true ? 'yes' : (v === false ? 'no' : '—'));
      return diag.entries.map((entry, i) => ({
        key: String(entry.name || i),
        ok: entry.foreign ? true : (entry.hasIcon !== false && entry.matches),
        name: entry.name,
        note: entry.foreign
          ? globalThis.PlatformI18n.t("settings:pinned_by_another_app_d419f6db")
          : (entry.unknownApp
            ? globalThis.PlatformI18n.t("settings:app_not_loaded_304cae45")
            : globalThis.PlatformI18n.t("settings:icon_value1_dark_value2_0a4d2c56", { value1: flag(entry.hasIcon), value2: flag(entry.hasIconDark) }) +
              globalThis.PlatformI18n.t("settings:sent_value1_f03445f4", { value1: entry.matches ? globalThis.PlatformI18n.t("settings:message_97b0560280ed") : globalThis.PlatformI18n.t("settings:message_a03f2386ae06") })),
        empty: null,
      }));
    },

    // ── Homeroom app section: the named actions the components dispatch ──
    //
    // Each was an inline closure passed to `_unButton` / `_unToggle` /
    // `_unStatusRow`. They are named methods so the view model stays plain
    // serialisable data — the components carry an action STRING, never a
    // function. The disable/toast/re-enable wrapper each one used to repeat
    // lives in sections/usernode-ui.tsx's `useAction`, once.

    async _copyUsernodeDiagnostics() {
      const diag = this._bridgeDiagnostics();
      const text = this._bridgeDiagnosticsText(diag);
      const ok = window.PlatformUI && PlatformUI.copyText
        ? await PlatformUI.copyText(text) : false;
      if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(ok ? globalThis.PlatformI18n.t("settings:diagnostics_copied_2c8618c0") : globalThis.PlatformI18n.t("settings:could_not_copy_d5cb934f"),
          ok ? {} : { error: true });
      }
    },

    /** Swap the failure box for the progress line and re-read. */
    async _retryUsernodeRead() {
      this._usernodeLoading = true;
      this._publishUsernode();
      await this._renderUsernodeSection();
    },

    _requestUsernodePermissions() {
      const perms = (this._usernodeState && this._usernodeState.permissions) || {};
      return this._unRequestPermissions(perms.platform === 'android');
    },

    _openBatterySettings() { return window.usernode.openBatterySettings(); },
    _openNotifSettings() { return window.usernode.openNotificationSettings(); },
    _setFacematchStrict(v) { return this._unApply(window.usernode.setFacematchStrict(v)); },
    _setDebugMode(v) { return this._unApply(window.usernode.setDebugMode(v)); },
    _openZkIdentityScreen() {
      return this._openNativeScreen('zkIdentity', globalThis.PlatformI18n.t("settings:could_not_open_zk_identity_23e1f16a"));
    },
    _openBenchmarkScreen() {
      return this._openNativeScreen('benchmark', globalThis.PlatformI18n.t("settings:could_not_open_the_benchmark_4c4308fa"));
    },
    _openHttpLogsScreen() {
      return this._openNativeScreen('httpLogs', globalThis.PlatformI18n.t("settings:could_not_open_the_logs_e8ec5a4c"));
    },
    _openTermsFromUsernode() {
      return this.showTermsSheet(() => this._renderUsernodeSection());
    },

    async _resetZkChallenge() {
      const ok = await PlatformUI.confirm({
        get title() { return globalThis.PlatformI18n.t("settings:restart_the_zk_challenge_0e089820"); },
        get message() { return globalThis.PlatformI18n.t("settings:your_in_progress_identity_registration_will_be_d_4da2517c"); },
        get confirmLabel() { return globalThis.PlatformI18n.t("settings:restart_6b983a81"); },
        danger: true,
      });
      if (!ok) return;
      await window.usernode.resetZkChallenge();
      if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:challenge_state_reset_a73eb1a1"));
    },

    async _recheckWidgetIcons() {
      const home = window.Home;
      if (home && typeof home._refreshWidgetItems === 'function') {
        // Clears the one-attempt-per-load cap so the pass this triggers
        // actually re-sends anything it finds wrong.
        home._iconHealTried = null;
        await home._refreshWidgetItems();
      }
      this._publishUsernode();
    },

    // ── activity notifications ─────────────────────────────────────────
    //
    // The listener and the support probe stay here. What went away is the
    // `box.isConnected` guard on every event and the `box.remove()` on an
    // unsupported build: a publish to an unmounted component is a no-op, and
    // "unsupported" is a model state the rest of the screen can read.

    _initSocialPush() {
      if (this._socialPushStateListener) {
        window.removeEventListener(
          'usernode:social-push-state', this._socialPushStateListener);
        this._socialPushStateListener = null;
      }
      if (!window.SocialPush) { this._socialPushSupported = false; return; }
      const onState = (event) => {
        this._socialPushState = (event && event.detail) || null;
        this._publishUsernode();
      };
      this._socialPushStateListener = onState;
      window.addEventListener('usernode:social-push-state', onState);
      SocialPush.isSupported().then((supported) => {
        this._socialPushSupported = !!supported;
        if (!supported) {
          window.removeEventListener('usernode:social-push-state', onState);
          this._socialPushStateListener = null;
          this._publishUsernode();
          return null;
        }
        return SocialPush.getState();
      }).then((state) => {
        if (this._socialPushSupported) this._socialPushState = state || null;
        this._publishUsernode();
      }).catch((err) => {
        console.warn('[settings] social push state failed:', err);
        this._socialPushState = null;
        this._publishUsernode();
      });
    },

    async _retrySocialPush() {
      await NativeChrome.recoverSessionAdmission();
      if (window.SocialPush &&
          typeof SocialPush.retryBridgeReadiness === 'function') {
        try { SocialPush.retryBridgeReadiness(); } catch (_) {}
      }
      this._socialPushState = await SocialPush.getState();
      this._publishUsernode();
    },

    async _setSocialPushEnabled(enabled) {
      this._socialPushState = await SocialPush.setEnabled(enabled);
      this._publishUsernode();
    },

    // ── block production queue ─────────────────────────────────────────
    //
    // State comes from the session-authed /challenges-api twins; the async
    // load fills its slice in place so the rest of the body never waits on it.

    _initBlockProduction() {
      this._bpState = undefined;
      fetch('/challenges-api/bp/state', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { this._bpState = (data && data.success !== false) ? data.data : null; })
        .catch(() => { this._bpState = null; })
        .then(() => this._publishUsernode());
    },

    async _askForBlockProduction() {
      try {
        const res = await fetch('/challenges-api/bp/request', {
          method: 'POST', credentials: 'same-origin',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.success === false) {
          throw new Error((data && data.error) || globalThis.PlatformI18n.t("settings:request_failed_cfce761b"));
        }
        if (window.PlatformUI) PlatformUI.toast(globalThis.PlatformI18n.t("settings:request_sent_an_admin_will_release_your_keys_ac5d16ce"));
        this._bpState = Object.assign({}, this._bpState || {}, { bp_requested: true });
        this._publishUsernode();
        // #2960: the Android "Set up your device" sheet (exact alarms +
        // unrestricted background) waits for exactly this moment. Re-run the
        // first-run trigger now that the account has asked to produce; it
        // re-reads the queue, and on iOS or an already-answered device it
        // presents nothing.
        // `force`: the user just asked, so skip the once-a-day wait.
        if (window.NativeChrome &&
            typeof NativeChrome.maybeShowFirstRunPermissions === 'function') {
          NativeChrome.maybeShowFirstRunPermissions({ force: true });
        }
      } catch (e) {
        if (window.PlatformUI) PlatformUI.toast(e.message || globalThis.PlatformI18n.t("settings:request_failed_cfce761b"), { error: true });
      }
    },

    // The snapshot-failure box: the unchanged headline (so existing reports
    // stay recognisable), the mapped reason, the app's own message, and a
    // retry that stays on this screen. `loading` renders the in-place
    // progress line a retry swaps in, leaving the rest of the section up.


    // Block production queue (onboarding flow alignment). State comes
    // from the session-authed /challenges-api twins; the async load
    // fills the section in place so the rest of the usernode body never
    // waits on it.

    // Static port of the native FaqSection copy (Help & Info tiles).
  };

  // Published at module scope, not from the island's effect: app.js,
  // app-view.js, dev-chat.js and credit-options.js call window.Settings
  // unguarded, and the bundle's entry runs before any of their init()s. The
  // typeof guard is for the SSG prerender pass, which evaluates this whole
  // module graph in Node (#1081 chunk D).
  //
  // Since the module became a lazy chunk, ./facade.js has been window.Settings
  // from the shell's boot: it read /api/auth/me into its `state` and answered
  // isOpen()/close() while this file was still on its way. Take over SHARING
  // that state object — a read still in flight lands in it — and its primed
  // CLI-auth answer, so nothing that consulted the façade observes a reset.
  if (typeof window !== 'undefined') {
    const facade = window.Settings;
    if (facade && facade.__facade) {
      Settings.state = facade.state;
      Settings._cliAuthPromise = facade._cliAuthPromise || null;
    }
    window.Settings = Settings;
  }

  // The first-entry terms prompt lives in ./terms-first-run.js — the ONE
  // boot trigger that auto-presents showTermsSheet (issue #1361 was two
  // parallel implementations of #1297 both riding sv:authed, stacking two
  // sheets at login; the settings.js copy was removed in its fix).

  // init() is called from SettingsScreen's layout effect (../index.tsx), not
  // from DOMContentLoaded. Same moment in practice — the React entry is a
  // deferred module, so it hydrates before DOMContentLoaded fires — but it now
  // happens after the island's own markup is in the document, which is the
  // ordering every id-bound listener below depends on.
})();

// Recompute translated view models from cached data without resetting forms.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => { if (window.Settings?._open) { window.Settings._renderNav(); window.Settings._syncChrome(); } });
}
