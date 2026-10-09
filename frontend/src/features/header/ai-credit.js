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

  // One part of the meter, read as a whole message. The catalog entry marks
  // each coloured run with a numbered tag ("<0>limit </0><1>{{spent}}</1>…")
  // and `tones` names the colour for each number, so a translator sees the
  // part as one line and the runs come out exactly as they were. Text a
  // translation leaves outside a tag is drawn dim.
  function runs(id, values, tones) {
    var text = PlatformI18n.t(id, values);
    var out = [];
    var pattern = /<(\d+)>([\s\S]*?)<\/\1>/g;
    var at = 0;
    var match;
    while ((match = pattern.exec(text))) {
      if (match.index > at) out.push({ tone: 'dim', text: text.slice(at, match.index) });
      out.push({ tone: tones[Number(match[1])] || 'dim', text: match[2] });
      at = match.index + match[0].length;
    }
    if (at < text.length) out.push({ tone: 'dim', text: text.slice(at) });
    return out;
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

      // #2598: figures the SERVER volunteered, after a model call's cost was
      // recorded against this user's weekly pool (services/budget-live.js →
      // the `budget_updated` case in public/js/app.js). Render them and
      // nothing else: the throttle above exists to bound POLLING, so holding
      // back a push would be throttling the thing the throttle was protecting
      // against. `_lastFetchAt` is deliberately left alone for the same
      // reason — a push is not a fetch, and must not defer the next one.
      //
      // The payload is limits.getBudgetSnapshot, which is what
      // /api/me/ai-budget answers with, so it replaces `state` wholesale
      // rather than merging: this row reads no field that route does not send.
      applyPush: function (budget) {
        if (!budget || typeof budget.limitCents !== 'number') return;
        // ?demo=1 is showing a fixture on purpose — see the refresh above.
        if (typeof location !== 'undefined'
            && String(location.search || '').indexOf('demo=1') > -1) return;
        AiCredit.Budget.state = budget;
        AiCredit.Budget._render();
      },

      // Publishes the meter's view model; ./ai-budget.tsx draws it. Every
      // decision below — the thresholds, the wording, whether a "your key"
      // figure appears — stays here; only the colours are names the
      // component resolves.
      _render: function () {
        var s = AiCredit.Budget.state;
        if (!s || typeof s.limitCents !== 'number') {
          aiBudgetStore.set({ view: null, hidden: true, figures: null });
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
        // this row and the dev chat cannot describe it differently. #3230:
        // in the viewer's own clock, with the exact UTC instant in brackets,
        // because this text is itself the tooltip.
        var RT = (typeof window !== 'undefined' && window.ResetTime) || null;
        var weeklyReset = s.capWindow === 'weekly';
        var resetText = state ? CO.resetSentence(state)
          : RT ? PlatformI18n.t('wallet:credit.tip.resets', {
            when: RT.resetWhen(weeklyReset ? 'weekly' : 'daily', { at: s.resetsAt }),
          })
            : weeklyReset ? PlatformI18n.t('wallet:credit.tip.resetsWeeklyUtc')
              : PlatformI18n.t('wallet:credit.tip.resetsDailyUtc');
        var resetUtc = state && CO.resetTitle ? CO.resetTitle(state) : null;
        if (resetUtc) resetText = resetText.replace(/\.$/, ' (' + resetUtc + ').');
        // The raw figures ride along for a reader that draws them itself
        // (the agent-session composer's "$ left" ring): the same numbers the
        // words below are built from, so the two cannot disagree.
        var figures = {
          limitCents: limit,
          remainingCents: remaining,
          spentCents: spent,
          byokCents: byok,
          weekly: (state ? state.capWindow : s.capWindow) === 'weekly',
          level: state ? state.level : null,
        };
        var show = function (view) { aiBudgetStore.set({ view: view, hidden: false, figures: figures }); };

        // A zero tier is a real state, not an unknown cap. Render the
        // unlock action without doing spend/limit division (which used to
        // produce a misleading $0/$0 meter and NaN percentages).
        if (state && state.level === 'locked') {
          var lockedParts = [
            { bare: true, runs: [{ tone: 'warn', text: PlatformI18n.t('wallet:credit.meter.locked') }] },
          ];
          if (s.hasByokKey) {
            lockedParts.push({
              runs: runs('wallet:credit.meter.lockedKeyAvailable', {}, ['dim', 'byok']),
            });
          }
          show({
            title: s.hasByokKey ? PlatformI18n.t('wallet:credit.tip.lockedWithKey')
              : PlatformI18n.t('wallet:credit.tip.locked'),
            parts: lockedParts,
          });
          return;
        }
        if (state && state.level === 'unavailable') {
          show({
            title: PlatformI18n.t('wallet:credit.tip.unavailable'),
            tone: 'warn',
            parts: [{ bare: true, runs: [{ tone: 'none', text: PlatformI18n.t('wallet:credit.meter.unavailable') }] }],
          });
          return;
        }

        // "limit $spent/$limit" — spend-first, exactly like the dev chat.
        var pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
        var spentTone = pct > 80 ? 'high' : pct > 50 ? 'mid' : 'low';

        // #1788: the figures above describe whichever cap is BINDING —
        // daily or weekly — so the words around them follow the server's
        // window rather than assuming "daily"/"today".
        var weeklyWindow = (state ? state.capWindow : s.capWindow) === 'weekly';

        // Each sentence of the tooltip is a whole message: what the
        // allowance stands at (worded for the week or for the day), when it
        // comes back, and the own-key figure. `sentences` puts one after
        // another the way the language does.
        var amounts = { limit: money(limit), spent: money(spent), remaining: money(remaining) };
        var allowance;
        if (exhausted && s.hasByokKey) {
          allowance = weeklyWindow ? PlatformI18n.t('wallet:credit.tip.keyBilledWeekly', amounts)
            : PlatformI18n.t('wallet:credit.tip.keyBilledDaily', amounts);
        } else if (exhausted) {
          allowance = weeklyWindow ? PlatformI18n.t('wallet:credit.tip.usedAllWeekly', amounts)
            : PlatformI18n.t('wallet:credit.tip.usedAllDaily', amounts);
        } else {
          allowance = weeklyWindow ? PlatformI18n.t('wallet:credit.tip.usedWeekly', amounts)
            : PlatformI18n.t('wallet:credit.tip.usedDaily', amounts);
        }
        var sentences = function (first, second) {
          return PlatformI18n.t('wallet:credit.tip.sentences', { first: first, second: second });
        };
        var tip = sentences(allowance, resetText);
        if (byok > 0) {
          // Still today's figure: the BYOK tally is the day row's, not the
          // week's, whichever window the cap above is measuring.
          tip = sentences(tip, PlatformI18n.t('wallet:credit.tip.ownKeyToday', { amount: money(byok) }));
        }

        var parts = [{
          runs: runs('wallet:credit.meter.spend', amounts, ['dim', spentTone]),
        }];
        // #593: what is LEFT, rendered rather than tooltip-only. The whole
        // point of the row is to answer "can I start another dev session?"
        // before opening one, and a tooltip answers that for nobody on a
        // phone — which is where the drawer is used most.
        if (!(exhausted && s.hasByokKey)) {
          var leftTone = exhausted ? 'high' : (state && state.level === 'low') ? 'mid' : 'dim';
          parts.push({
            remaining: true,
            runs: exhausted ? runs('wallet:credit.meter.noneLeft', {}, ['dim', leftTone])
              : runs('wallet:credit.meter.left', amounts, ['dim', leftTone]),
          });
        }
        if (byok > 0) {
          // Its own part so the two figures break apart at the "·" rather
          // than either of them splitting mid-number — and the separator
          // travels WITH the BYOK figure, so a wrapped value reads
          // "· your key $4.50" instead of leaving a dangling "·" above.
          parts.push({
            runs: runs('wallet:credit.meter.ownKey', { amount: money(byok) }, ['dim', 'byok']),
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
  // The view model holds worded text, so it is built again from the same
  // figures when the language changes. Nothing to do before the first answer:
  // the row is still empty then.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('homeroom:language-changed', function () {
      if (AiCredit.Budget.state) AiCredit.Budget._render();
    });
  }
})();
