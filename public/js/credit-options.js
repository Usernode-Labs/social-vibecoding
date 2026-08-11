/* Out-of-credits routes — the single source of truth for "your daily AI
 * credits ran out; here is how to keep building".
 *
 * Three surfaces render the same three options and must never drift:
 *   1. the in-chat card DevChat pushes when POST /chat answers
 *      429 { code: 'budget_exceeded' }  (public/js/dev-chat.js),
 *   2. the red credits banner above the dev-chat body (same file), and
 *   3. the Generate-proposal modal when the headless route 429s the same
 *      way (public/js/app-view.js).
 *
 * So the copy, the destinations and the markup all live here. Adding a
 * fourth route later (a paid tier, say) is one edit in this file and the
 * three call sites pick it up for free — which is the whole reason this
 * module exists instead of three inlined strings.
 *
 * Every destination is a real Settings hash route (Settings.SECTIONS in
 * public/js/settings.js declares the same keys), so clicking one is an
 * ordinary hash navigation and the device back gesture returns to the
 * chat. tests/credit-options.test.js asserts the hashes correspond to
 * declared sections, so a renamed section can't silently produce a dead
 * link.
 */
(function () {
  'use strict';

  // The six build venues, loaded as a classic script ahead of this one in
  // the browser and required directly under node. Resolved lazily rather
  // than captured at definition time so load order inside a test harness
  // (which may seed window.BuildVenues after evaluating this file) cannot
  // freeze a null.
  function venues() {
    if (typeof window !== 'undefined' && window.BuildVenues) return window.BuildVenues;
    if (typeof require === 'function') {
      try { return require('./build-venues.js'); } catch (err) { /* browser */ }
    }
    return null;
  }

  var SETTINGS_HASHES = (venues() && venues().SETTINGS_HASHES) || {
    apiKey: '#settings/api-key',
    localTool: '#settings/cli',
    connector: '#settings/connectors',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // The ways out. `hasApiKey` flips the API-key entry: limits.loadUserApiKey
  // treats a decrypt failure as "no key on file", so a user WITH a saved key
  // can still be refused — telling them to "add a key" they already added is
  // the wrong advice.
  //
  // #1049 changed the ORDER and added two entries. Running out of credits is
  // the moment someone is most willing to try another route, and the two
  // routes that need no new account and no card — hand the work to the Claude
  // or ChatGPT subscription they already pay for — used to be listed last as
  // "connect a connector", which reads like plumbing rather than an answer.
  // They lead now, and each one carries a `flow` so the surface can start the
  // guided walkthrough in place instead of bouncing the user to Settings.
  // `hash` stays on every entry as the fallback for a surface that wires no
  // flow handler (and so every destination remains a real Settings section).
  //
  // `state.externalFlowsAvailable` comes from GET /api/auth/me — a deployment
  // with no GitHub-link support cannot offer them, and then this is exactly
  // the pre-#1049 list.
  function options(state) {
    var s = state || {};
    var hasApiKey = !!s.hasApiKey;
    var apiKey = {
      id: 'api-key',
      title: hasApiKey
        ? "Your saved key couldn't be used"
        : 'Use your own Anthropic API key',
      blurb: hasApiKey
        ? 'Usernode has a key on file but could not use it for this turn. Open Settings → API key, check it and re-save it — the daily allowance is bypassed entirely while a working key is on file.'
        : 'Paste a key in Settings → API key and Usernode keeps working exactly as it does now, billed to your Anthropic account instead of your daily allowance.',
      cta: hasApiKey ? 'Check API key' : 'Add API key',
      hash: SETTINGS_HASHES.apiKey,
    };
    // Every route out of here except the API key IS a build venue, so the
    // list comes from public/js/build-venues.js in `blocked` mode rather
    // than being retyped here. That is what stopped "use a coding tool on
    // your computer" from covering two different products: the CLI lease
    // keeps THIS session (Usernode drives, your machine executes, same
    // transcript and proposal), while your own tools mean you working
    // alone and bringing the result back as a pull request with no
    // Usernode chat at all. They are two rows now because they are two
    // answers.
    //
    // `usernode-claude` comes back marked unavailable in this mode — it is
    // the venue that just refused the turn. It is not a way to keep
    // building, so it is not in this list and not in the count; the card's
    // own lead sentence is where the refusal is stated.
    var BV = venues();
    var venueRows = BV
      ? BV.venuesFor({
        mode: 'blocked',
        openrouterAvailable: s.openrouterAvailable,
        cliAuthEnabled: s.cliAuthEnabled !== false,
        externalFlowsAvailable: s.externalFlowsAvailable,
        canCollaborate: s.canCollaborate !== false,
        blockedReason: s.error || null,
      }).filter(function (row) { return !row.unavailable; })
      : [];
    var asOption = function (row) {
      return {
        id: row.id,
        title: row.label,
        blurb: row.blurb + ' ' + row.consequence,
        cta: row.cta,
        flow: row.mechanism.flow || null,
        hash: row.mechanism.hash || SETTINGS_HASHES.localTool,
      };
    };
    // Running out of credits is the moment someone is most willing to try
    // another route (#1049), so the two that need no new account and no
    // card — the Claude or ChatGPT plan they already pay for, reachable in
    // one guided walkthrough without leaving the chat — lead. Everything
    // else keeps the original order behind the API key. When the
    // deployment cannot offer the web hand-offs at all this is exactly the
    // pre-#1049 shape, with the local pair split in two.
    var handoffs = venueRows.filter(function (r) { return r.mechanism.kind === 'flow'; });
    var rest = venueRows.filter(function (r) { return r.mechanism.kind !== 'flow'; });

    var out = handoffs.map(asOption);
    out.push(apiKey);
    rest.forEach(function (row) { out.push(asOption(row)); });
    if (!s.externalFlowsAvailable) {
      out.push({
        id: 'connector',
        title: 'Use your Claude.ai or ChatGPT subscription',
        blurb: 'Connect Usernode to Claude or ChatGPT and let Claude Code on the web or Codex do the work on the plan you already pay for.',
        cta: 'Connect Claude or ChatGPT',
        hash: SETTINGS_HASHES.connector,
      });
    }
    return out;
  }

  // "Three ways to keep building right now:" — the count moves with the
  // deployment (#1049) and now with the venue gating too, so it is spelled
  // from the list rather than frozen into the string. The ceiling is the
  // six venues plus the API key and the connector row.
  var NUMERALS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

  function introFor(list) {
    var n = list.length;
    var word = NUMERALS[n] || String(n);
    return word.charAt(0).toUpperCase() + word.slice(1)
      + (n === 1 ? ' way' : ' ways') + ' to keep building right now:';
  }

  // Lead sentence. `globalOut` means the PLATFORM's shared daily budget is
  // spent rather than this user's own allowance — all three routes bypass
  // it either way, so only the explanation changes.
  function lead(state) {
    var s = state || {};
    return s.globalOut
      ? "The platform's shared daily AI budget is used up."
      : "You're out of today's free AI credits.";
  }

  // The in-chat card. Rendered INSTEAD of an assistant markdown bubble by
  // DevChat.renderMessages when a message carries `creditsCard`.
  //
  // `state.error` is the platform's own billing message (limits.checkBudget
  // → "Daily limit reached ($20.00). Resets at midnight UTC."). It is
  // escaped, never injected — it is server text, but the card must not be
  // an HTML sink regardless.
  function cardHtml(state) {
    var s = state || {};
    var list = options(s);
    var rows = list.map(function (opt) {
      return ''
        + '<div class="dc-credits-option">'
        + '<div class="dc-credits-option-text">'
        + '<div class="dc-credits-option-title">' + escapeHtml(opt.title) + '</div>'
        + '<div class="dc-credits-option-blurb">' + escapeHtml(opt.blurb) + '</div>'
        + '</div>'
        + '<button type="button" class="dc-pr-btn dc-credits-go"'
        + (opt.flow ? ' data-credits-flow="' + escapeHtml(opt.flow) + '"' : '')
        + ' data-credits-hash="' + escapeHtml(opt.hash) + '">'
        + escapeHtml(opt.cta) + '</button>'
        + '</div>';
    }).join('');
    return ''
      + '<div class="dc-credits-card" data-credits-card="1">'
      + '<div class="dc-credits-card-lead">' + escapeHtml(lead(s)) + '</div>'
      + (s.error
        ? '<div class="dc-credits-card-detail">' + escapeHtml(s.error) + '</div>'
        : '')
      + '<div class="dc-credits-card-intro">' + escapeHtml(introFor(list)) + '</div>'
      + '<div class="dc-credits-options">' + rows + '</div>'
      + '</div>';
  }

  // Compact button row for the existing red banner. The first button keeps
  // the historical `dc-credits-add-key` id so anything already selecting it
  // (and the banner's own wiring) keeps resolving.
  function bannerActionsHtml(state) {
    var s = state || {};
    return '<div class="dc-credits-banner-actions">'
      + options(s).map(function (opt, index) {
        return '<button type="button"'
          + (index === 0 ? ' id="dc-credits-add-key"' : '')
          + ' class="dc-credits-banner-btn' + (index === 0 ? ' dc-credits-banner-btn-primary' : '')
          + '"' + (opt.flow ? ' data-credits-flow="' + escapeHtml(opt.flow) + '"' : '')
          + ' data-credits-hash="' + escapeHtml(opt.hash) + '">'
          + escapeHtml(opt.cta) + '</button>';
      }).join('')
      + '</div>';
  }

  // One delegated click handler per mounted node. A real hash navigation
  // (not history.pushState) so the browser / device back gesture returns
  // the user to the chat they were refused in.
  //
  // `handlers.onFlow(flow)` (#1049) lets a surface handle the Claude Code /
  // Codex entries IN PLACE — the dev chat starts its walkthrough right there
  // rather than sending the user to Settings and back. A surface that wires
  // no handler falls through to the hash, which is why every option still
  // carries one.
  function wire(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__creditOptionsWired) return;
    root.__creditOptionsWired = true;
    var h = handlers || {};
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-credits-flow],[data-credits-hash]')
        : null;
      if (!target || !root.contains(target)) return;
      var flow = target.getAttribute('data-credits-flow');
      if (flow && typeof h.onFlow === 'function') {
        event.preventDefault();
        h.onFlow(flow);
        return;
      }
      var hash = target.getAttribute('data-credits-hash');
      if (!hash) return;
      event.preventDefault();
      window.location.hash = hash;
    });
  }

  var CreditOptions = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    options: options,
    introFor: introFor,
    lead: lead,
    cardHtml: cardHtml,
    bannerActionsHtml: bannerActionsHtml,
    wire: wire,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CreditOptions;
  }
  if (typeof window !== 'undefined') {
    window.CreditOptions = CreditOptions;
  }
})();
