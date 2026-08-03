// The AI-credit row in the drawer's status pane (#555).
//
// One renderer, modelled on Kudos.Budget in kudos.js — poll an endpoint,
// paint a pill into a slot the shell already owns:
//
//   AiCredit.Budget → #ai-budget-slot, every signed-in user.
//                     Their own daily LLM allowance.
//
// The row ships `hidden` in the shell and is revealed only once its
// audience is confirmed — i.e. when the me-scoped fetch answers — so a
// signed-out visitor never sees an empty row. The pill is never a link.
//
// (A sibling "Anthropic credits" row for admins shipped alongside this
// one and was removed again: on this deployment it could only ever read
// "Not set up", because Anthropic publishes no credit balance and the
// figure has to be recorded by hand. The balance now lives solely in
// Admin & moderation → Spend limits, which still reads and writes it via
// /api/admin/anthropic-credits.)
//
// Refresh cadence: once at authed boot, then on every drawer open,
// throttled. The drawer is the only place it renders, so "open the
// drawer" is exactly the moment the number matters.
(function () {
  'use strict';

  var BUDGET_THROTTLE_MS = 3 * 60 * 1000;

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

  function setRowVisible(id, visible) {
    var row = document.getElementById(id);
    if (!row) return;
    // The row ships with Tailwind's `hidden`, which would fight the
    // `flex` in its own class list — toggle `hidden` only.
    row.classList.toggle('hidden', !visible);
  }

  // `whitespace-nowrap` matters here in a way it doesn't for the kudos
  // badge: "$6.40 of $20.00 left" is wider than the 15rem drawer leaves
  // beside a row label, and a pill that breaks mid-figure reads as two
  // numbers. The row carries `flex-wrap` instead, so an over-wide pill
  // drops onto its own line intact rather than splitting.
  var PILL_BASE = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap';

  var TONE = {
    ok: 'border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300',
    warn: 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300',
    off: 'border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400',
  };

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

    // Called from App.HeaderMenu.open() — the moment the row becomes
    // visible. Throttled inside refresh(), so this is cheap to call on
    // every open.
    refreshAll: function () {
      AiCredit.Budget.refresh();
    },
  };

  window.AiCredit = AiCredit;
})();
