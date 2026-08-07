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

  var SETTINGS_HASHES = {
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

  // The three ways out, in the order they should be offered. `hasApiKey`
  // flips the first entry: limits.loadUserApiKey treats a decrypt failure
  // as "no key on file", so a user WITH a saved key can still be refused —
  // telling them to "add a key" they already added is the wrong advice.
  function options(state) {
    var s = state || {};
    var hasApiKey = !!s.hasApiKey;
    return [
      {
        id: 'api-key',
        title: hasApiKey
          ? "Your saved key couldn't be used"
          : 'Use your own Anthropic API key',
        blurb: hasApiKey
          ? 'Usernode has a key on file but could not use it for this turn. Check it in Settings and re-save it.'
          : 'Paste a key and Usernode keeps working exactly as it does now, billed to your Anthropic account.',
        cta: hasApiKey ? 'Check API key' : 'Add API key',
        hash: SETTINGS_HASHES.apiKey,
      },
      {
        id: 'local-tool',
        title: 'Use a coding tool on your computer',
        blurb: 'Claude Code, Codex, Cursor or the Usernode CLI, running on your machine and your plan. Usernode hands it the task and turns the result into a proposal.',
        cta: 'Set up a coding tool',
        hash: SETTINGS_HASHES.localTool,
      },
      {
        id: 'connector',
        title: 'Use your Claude.ai or ChatGPT subscription',
        blurb: 'Connect Usernode to Claude or ChatGPT and let Claude Code on the web or Codex do the work on the plan you already pay for.',
        cta: 'Connect Claude or ChatGPT',
        hash: SETTINGS_HASHES.connector,
      },
    ];
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
    var rows = options(s).map(function (opt) {
      return ''
        + '<div class="dc-credits-option">'
        + '<div class="dc-credits-option-text">'
        + '<div class="dc-credits-option-title">' + escapeHtml(opt.title) + '</div>'
        + '<div class="dc-credits-option-blurb">' + escapeHtml(opt.blurb) + '</div>'
        + '</div>'
        + '<button type="button" class="dc-pr-btn dc-credits-go" data-credits-hash="'
        + escapeHtml(opt.hash) + '">' + escapeHtml(opt.cta) + '</button>'
        + '</div>';
    }).join('');
    return ''
      + '<div class="dc-credits-card" data-credits-card="1">'
      + '<div class="dc-credits-card-lead">' + escapeHtml(lead(s)) + '</div>'
      + (s.error
        ? '<div class="dc-credits-card-detail">' + escapeHtml(s.error) + '</div>'
        : '')
      + '<div class="dc-credits-card-intro">Three ways to keep building right now:</div>'
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
          + '" data-credits-hash="' + escapeHtml(opt.hash) + '">'
          + escapeHtml(opt.cta) + '</button>';
      }).join('')
      + '</div>';
  }

  // One delegated click handler per mounted node. A real hash navigation
  // (not history.pushState) so the browser / device back gesture returns
  // the user to the chat they were refused in.
  function wire(root) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__creditOptionsWired) return;
    root.__creditOptionsWired = true;
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-credits-hash]')
        : null;
      if (!target || !root.contains(target)) return;
      var hash = target.getAttribute('data-credits-hash');
      if (!hash) return;
      event.preventDefault();
      window.location.hash = hash;
    });
  }

  var CreditOptions = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    options: options,
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
