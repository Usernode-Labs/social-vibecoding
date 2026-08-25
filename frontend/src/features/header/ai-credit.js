// MOVED in #1079 chunk B (this was public/js/ai-credit.js), and it PUBLISHES
// rather than paints now: the row it used to write markup into is
// ./ai-budget.tsx, and this module builds the view model for it.
//
// The AI-credit row (#555) — the viewer's own daily LLM allowance. It lives
// in Settings → Anthropic API key, which is already the page about what
// happens when that allowance runs out; the fetch and the throttle here are
// unchanged from when it was a hamburger-drawer row.
//
// The row ships visible and EMPTY, and hides itself only once the me-scoped
// fetch has answered with nothing to show — so a signed-out visitor never
// sees a stub, and a document that has not fetched yet still resolves the
// slot a declared check selects. The value is never a link.
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
import { aiBudgetStore } from './ai-budget-store.js';

(function () {
  'use strict';

  var BUDGET_THROTTLE_MS = 3 * 60 * 1000;

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

  // The figure is rendered EXACTLY as the dev chat renders its own meter
  // (see DevChat.renderBudget) — "limit $13.60/$20.00 · your key $129.11"
  // — so the two places a user reads their AI spend agree glyph for
  // glyph instead of offering two different mental models of the same
  // number. No pill: .drawer-meter is nowrap mono text, and the row's
  // `flex-wrap` drops an over-wide value onto its own line intact rather
  // than splitting it mid-figure.
  //
  // Spend colouring matches the dev chat's thresholds too: >80% of the
  // daily limit is red, >50% amber, otherwise emerald. The BYOK figure
  // never takes threshold colouring — no cap applies to it. The THRESHOLDS
  // are here; the four class strings they resolve to are in
  // ./ai-budget.tsx, because Tailwind's extractor is a regex over source
  // text and a palette carried through the store would compile to nothing.

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

      // Publishes the meter's view model; ./ai-budget.tsx draws it. Every
      // decision below — the thresholds, the wording, whether a "your key"
      // figure appears — stays here; only the colours are names the
      // component resolves.
      _render: function () {
        var s = AiCredit.Budget.state;
        if (!s || typeof s.limitCents !== 'number') {
          aiBudgetStore.set({ view: null, hidden: true });
          return;
        }

        var limit = s.limitCents;
        var remaining = Math.max(0, Number(s.remainingCents) || 0);
        var spent = Number(s.spentCents) || 0;
        var byok = Number(s.byokCents) || 0;
        var exhausted = remaining <= 0;

        // #593: the same normalised state the composer's meter and the
        // low-balance banner read, resolved lazily (credit-options.js is a
        // classic script; this module is in the bundle that runs after it,
        // but a bare unit sandbox may have neither). Everything below
        // degrades to the pre-#593 rendering when it is absent.
        var CO = (typeof window !== 'undefined' && window.CreditOptions) || null;
        var state = CO ? CO.creditState(s) : null;
        // The reset boundary, worded once (CreditOptions.resetSentence) so
        // this row and the dev chat cannot describe it differently.
        var resetText = state ? CO.resetSentence(state) : 'Free credits reset at midnight UTC.';
        var show = function (view) { aiBudgetStore.set({ view: view, hidden: false }); };

        // A zero tier is a real state, not an unknown cap. Render the
        // unlock action without doing spend/limit division (which used to
        // produce a misleading $0/$0 meter and NaN percentages).
        if (state && state.level === 'locked') {
          var lockedParts = [
            { bare: true, runs: [{ tone: 'warn', text: 'verify account · unlock $10/day' }] },
          ];
          if (s.hasByokKey) {
            lockedParts.push({
              runs: [{ tone: 'dim', text: '· ' }, { tone: 'byok', text: 'your key available' }],
            });
          }
          show({
            title: 'Connect GitHub or X in Settings to unlock $10/day. '
              + (s.hasByokKey ? 'Your own Anthropic key remains available.' : ''),
            parts: lockedParts,
          });
          return;
        }
        if (state && state.level === 'unavailable') {
          show({
            title: 'Credit eligibility could not be verified. Try again shortly.',
            tone: 'warn',
            parts: [{ bare: true, runs: [{ tone: 'none', text: 'credits temporarily unavailable' }] }],
          });
          return;
        }

        // "limit $spent/$limit" — spend-first, exactly like the dev chat.
        var pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
        var spentTone = pct > 80 ? 'high' : pct > 50 ? 'mid' : 'low';

        var tip;
        if (exhausted && s.hasByokKey) {
          tip = 'Your ' + money(limit) + ' daily allowance is used up — AI turns are now '
            + 'billed to the Anthropic key you saved in Settings. ' + resetText;
        } else if (exhausted) {
          tip = 'You have used all ' + money(limit) + ' of today’s AI allowance. ' + resetText;
        } else {
          tip = money(spent) + ' of your ' + money(limit) + ' daily AI allowance used ('
            + money(remaining) + ' left). ' + resetText;
        }
        if (byok > 0) {
          tip += ' A further ' + money(byok)
            + ' today was billed to your own Anthropic key and does not count against the allowance.';
        }

        var parts = [{
          runs: [
            { tone: 'dim', text: 'limit ' },
            { tone: spentTone, text: money(spent) },
            { tone: 'dim', text: '/' + money(limit) },
          ],
        }];
        // #593: what is LEFT, rendered rather than tooltip-only. The whole
        // point of the row is to answer "can I start another dev session?"
        // before opening one, and a tooltip answers that for nobody on a
        // phone — which is where the drawer is used most.
        var leftLabel = exhausted
          ? (s.hasByokKey ? '' : 'none left')
          : money(remaining) + ' left';
        if (leftLabel) {
          parts.push({
            remaining: true,
            runs: [
              { tone: 'dim', text: '· ' },
              {
                tone: exhausted ? 'high' : (state && state.level === 'low') ? 'mid' : 'dim',
                text: leftLabel,
              },
            ],
          });
        }
        if (byok > 0) {
          // Its own part so the two figures break apart at the "·" rather
          // than either of them splitting mid-number — and the separator
          // travels WITH the BYOK figure, so a wrapped value reads
          // "· your key $4.50" instead of leaving a dangling "·" above.
          parts.push({
            runs: [
              { tone: 'dim', text: '· ' },
              { tone: 'byok', text: 'your key ' + money(byok) },
            ],
          });
        }

        show({ title: tip, parts: parts });
      },
    },

    // Called from App.HeaderMenu.open() — the moment the row becomes
    // visible. Throttled inside refresh(), so this is cheap to call on
    // every open.
    refreshAll: function () {
      AiCredit.Budget.refresh();
    },
  };

  // `typeof window` guard: the shell's markup is PRERENDERED in Node
  // (frontend/scripts/build-shell.mjs), which imports this island's module
  // graph. Same guard as features/notifications/notifications.js.
  if (typeof window !== 'undefined') window.AiCredit = AiCredit;
})();
