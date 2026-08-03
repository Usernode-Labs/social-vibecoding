// AI-credit rows in the drawer's status pane (#555).
//
// Two independent renderers, both modelled on Kudos.Budget in kudos.js —
// poll an endpoint, paint a pill into a slot the shell already owns:
//
//   AiCredit.Budget            → #ai-budget-slot, every signed-in user.
//                                Their own daily LLM allowance.
//   AiCredit.AnthropicCredits  → #anthropic-credits-slot, admins only.
//                                The org's remaining Anthropic credit.
//
// Both rows ship `hidden` in the shell and are revealed only once their
// audience is confirmed — the budget row when the me-scoped fetch
// answers, the credits row by App.renderAdminButton(). Neither pill is a
// link except the credits row's "not configured" state, which is the one
// case where there IS somewhere useful to go.
//
// Refresh cadence: once at authed boot, then on every drawer open,
// throttled per-object. The drawer is the only place either renders, so
// "open the drawer" is exactly the moment the number matters.
(function () {
  'use strict';

  var BUDGET_THROTTLE_MS = 3 * 60 * 1000;
  var CREDITS_THROTTLE_MS = 5 * 60 * 1000;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // Cents → "$12.34". Fractional cents exist in the ledger (NUMERIC(10,4)),
  // so always round to the nearest cent for display.
  function money(cents) {
    var n = Number(cents);
    if (!isFinite(n)) return '$0.00';
    return '$' + (Math.round(n) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Whole dollars for the big org figure — "$1,284" reads faster than
  // "$1,284.50" in a 15rem drawer, and the exact number is in the tooltip.
  function moneyRound(cents) {
    var n = Number(cents);
    if (!isFinite(n)) return '$0';
    return '$' + Math.round(n / 100).toLocaleString('en-US');
  }

  function setRowVisible(id, visible) {
    var row = document.getElementById(id);
    if (!row) return;
    // The rows ship with Tailwind's `hidden`, which would fight the
    // `flex` in their own class list — toggle `hidden` only.
    row.classList.toggle('hidden', !visible);
  }

  // `whitespace-nowrap` matters here in a way it doesn't for the kudos
  // badge: "$6.40 of $20.00 left" is wider than the 15rem drawer leaves
  // beside a row label, and a pill that breaks mid-figure reads as two
  // numbers. Both rows carry `flex-wrap` instead, so an over-wide pill
  // drops onto its own line intact rather than splitting.
  var PILL_BASE = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap';

  var TONE = {
    ok: 'border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300',
    warn: 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300',
    bad: 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-300',
    off: 'border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
  };

  // Short "6 minutes ago" for the credits tooltip. Deliberately coarse —
  // the underlying data lags ~5 minutes anyway.
  function agoText(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return 'just now';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins <= 0) return 'just now';
    if (mins === 1) return '1 minute ago';
    if (mins < 60) return mins + ' minutes ago';
    var hours = Math.round(mins / 60);
    return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  }

  function timeText(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return 'earlier';
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  // "1 Jul 2026" — the balance's as-of date, rendered from the plain
  // YYYY-MM-DD string without dragging it through a timezone.
  function dayText(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return String(ymd || '');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
  }

  var AiCredit = {

    // ── The viewer's own daily AI allowance ────────────────────────────
    Budget: {
      state: null,
      _lastFetchAt: 0,
      _refreshTimer: null,

      init: function () {
        AiCredit.Budget.refresh({ force: true });
        // Long-tab safety net, same reasoning as Kudos.Budget: a tab left
        // open across midnight UTC should see the bucket reset without a
        // manual reload.
        if (AiCredit.Budget._refreshTimer) return;
        AiCredit.Budget._refreshTimer = setInterval(function () {
          AiCredit.Budget.refresh({ force: true });
        }, 60 * 60 * 1000);
      },

      refresh: async function (opts) {
        var force = !!(opts && opts.force);
        var now = Date.now();
        if (!force && now - AiCredit.Budget._lastFetchAt < BUDGET_THROTTLE_MS) return;
        AiCredit.Budget._lastFetchAt = now;
        try {
          var res = await fetch('/api/me/ai-budget' + (location.search.indexOf('demo=1') > -1 ? '?demo=1' : ''));
          // 401 on an anonymous / waiting-room document is expected —
          // leave the row hidden and say nothing.
          if (!res.ok) return;
          AiCredit.Budget.state = await res.json();
          AiCredit.Budget._render();
        } catch (err) {
          console.warn('[ai-credit] budget refresh failed', err);
        }
      },

      _render: function () {
        var slot = document.getElementById('ai-budget-slot');
        if (!slot) return;
        var s = AiCredit.Budget.state;
        if (!s || typeof s.limitCents !== 'number') {
          slot.innerHTML = '';
          setRowVisible('drawer-row-ai-budget', false);
          return;
        }

        var limit = s.limitCents;
        var remaining = Math.max(0, Number(s.remainingCents) || 0);
        var spent = Number(s.spentCents) || 0;
        var byok = Number(s.byokCents) || 0;
        var exhausted = remaining <= 0;
        // ≤20% left is the "start thinking about it" band.
        var low = !exhausted && limit > 0 && remaining / limit <= 0.2;

        var label;
        var tone;
        var tip;
        if (exhausted && s.hasByokKey) {
          label = 'Using your own key';
          tone = TONE.off;
          tip = 'Your ' + money(limit) + ' daily allowance is used up — AI turns are now '
            + 'billed to the Anthropic key you saved in Settings. Resets at midnight UTC.';
        } else if (exhausted) {
          label = 'Daily limit reached';
          tone = TONE.off;
          tip = 'You have used all ' + money(limit) + ' of today’s AI allowance. '
            + 'Resets at midnight UTC.';
        } else {
          label = money(remaining) + ' of ' + money(limit) + ' left';
          tone = low ? TONE.warn : TONE.ok;
          tip = money(spent) + ' of your ' + money(limit)
            + ' daily AI allowance used. Resets at midnight UTC.';
        }
        if (byok > 0) {
          tip += ' A further ' + money(byok)
            + ' today was billed to your own Anthropic key and does not count against the allowance.';
        }

        slot.innerHTML =
          '<span class="ai-budget-pill ' + PILL_BASE + ' ' + tone + '" title="' + escapeAttr(tip) + '">'
          + '<span aria-hidden="true">\u{1F916}</span>'
          + '<span>' + escapeHtml(label) + '</span>'
          + '</span>';
        setRowVisible('drawer-row-ai-budget', true);
      },
    },

    // ── The organisation's remaining Anthropic credit (admins) ─────────
    AnthropicCredits: {
      state: null,
      _lastFetchAt: 0,

      init: function () {
        AiCredit.AnthropicCredits.refresh({ force: true });
      },

      refresh: async function (opts) {
        // Gate on `isAdmin`, which BOTH full and view-only admins carry.
        // Reading App.user here also means the "View as non-admin"
        // preview (which masks isAdmin) hides this row for free.
        if (!(window.App && App.user && App.user.isAdmin)) {
          setRowVisible('drawer-row-anthropic-credits', false);
          return;
        }
        var force = !!(opts && opts.force);
        var now = Date.now();
        if (!force && now - AiCredit.AnthropicCredits._lastFetchAt < CREDITS_THROTTLE_MS) return;
        AiCredit.AnthropicCredits._lastFetchAt = now;
        try {
          var res = await fetch('/api/admin/anthropic-credits'
            + (location.search.indexOf('demo=1') > -1 ? '?demo=1' : ''));
          if (!res.ok) return;
          AiCredit.AnthropicCredits.state = await res.json();
          AiCredit.AnthropicCredits._render();
        } catch (err) {
          console.warn('[ai-credit] anthropic credits refresh failed', err);
        }
      },

      _render: function () {
        var slot = document.getElementById('anthropic-credits-slot');
        if (!slot) return;
        if (!(window.App && App.user && App.user.isAdmin)) {
          slot.innerHTML = '';
          setRowVisible('drawer-row-anthropic-credits', false);
          return;
        }
        var s = AiCredit.AnthropicCredits.state;
        if (!s) {
          slot.innerHTML = '';
          return;
        }

        // Nothing recorded yet — the one state that links somewhere,
        // because the fix is a form two taps away.
        if (!s.configured) {
          slot.innerHTML =
            '<a href="#admin/limits" class="' + PILL_BASE + ' ' + TONE.off
            + ' hover:bg-zinc-50 dark:hover:bg-zinc-800" '
            + 'title="' + escapeAttr('No credit balance recorded yet. Record one in '
              + 'Admin & moderation → Limits and this row starts tracking it.') + '">'
            + '<span>Not set up</span></a>';
          setRowVisible('drawer-row-anthropic-credits', true);
          return;
        }

        // Configured but we have no figure at all (upstream failed and
        // nothing was cached) — say so rather than rendering a zero.
        if (typeof s.remainingCents !== 'number') {
          slot.innerHTML =
            '<span class="' + PILL_BASE + ' ' + TONE.off + '" title="'
            + escapeAttr('Couldn’t reach Anthropic to work out the remaining credit. '
              + 'It will retry the next time this menu opens.') + '">'
            + '<span>Unavailable</span></span>';
          setRowVisible('drawer-row-anthropic-credits', true);
          return;
        }

        var remaining = Number(s.remainingCents);
        var balance = Number(s.balanceCents) || 0;
        var frac = balance > 0 ? remaining / balance : 1;
        var tone = TONE.ok;
        if (remaining <= 0 || frac <= 0.1) tone = TONE.bad;
        else if (frac <= 0.25) tone = TONE.warn;

        var estimated = s.source === 'local-estimate';
        var label = (estimated ? '≈' : '') + moneyRound(remaining) + ' left';

        var tip = money(remaining) + ' remaining of the ' + money(balance)
          + ' credit balance recorded on ' + dayText(s.asOf) + '. '
          + money(s.spentCents) + ' billed by Anthropic since then.';
        if (estimated) {
          tip = money(remaining) + ' left (estimated from platform spend records — no '
            + 'Anthropic admin key configured), against the ' + money(balance)
            + ' balance recorded on ' + dayText(s.asOf) + '.';
        }
        if (s.partial) {
          tip += ' Spend history was truncated, so the real figure is lower.';
        }
        if (s.stale) {
          tip += ' Couldn’t refresh — showing the figure from ' + timeText(s.fetchedAt) + '.';
        } else {
          tip += ' Updated ' + agoText(s.fetchedAt) + '.';
        }

        slot.innerHTML =
          '<span class="anthropic-credits-pill ' + PILL_BASE + ' ' + tone + '" title="'
          + escapeAttr(tip) + '">'
          + '<span aria-hidden="true">\u{1F4B3}</span>'
          + '<span>' + escapeHtml(label) + '</span>'
          + '</span>';
        setRowVisible('drawer-row-anthropic-credits', true);
      },
    },

    // Called from App.HeaderMenu.open() — the moment both rows become
    // visible. Throttled inside each refresh(), so this is cheap to call
    // on every open.
    refreshAll: function () {
      AiCredit.Budget.refresh();
      AiCredit.AnthropicCredits.refresh();
    },
  };

  window.AiCredit = AiCredit;
})();
