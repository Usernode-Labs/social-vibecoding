// merge-status.js — single source of truth for a proposal's merge
// lifecycle state (#405). A proposal (dev session) moves through several
// distinct stages — draft, in vote, checks running, behind main, resolving
// conflicts, queued/ready, merging, merged — and before this module each
// surface (the proposal feed card, the home "Your proposals" strip, the dev
// session view) derived and labelled those states with its own ad-hoc code,
// so the same proposal could read differently depending on where you looked.
//
// `MergeStatus.lifecycle(p, opts)` maps the raw fields the API already
// returns (status, check_state, merge_conflict_state, behind_main, and —
// when available — the vote tally) onto ONE canonical state, with a fixed
// precedence so the highest-signal stage always wins. `badgeHtml` / `pillHtml`
// render that state consistently everywhere.
//
// Loaded as a plain <script> before dev-chat.js / app-view.js / home.js
// (window.MergeStatus); also exported via module.exports so the derivation
// can be unit-tested under Node.
(function (root) {
  'use strict';

  function num(v) {
    var n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Build a lifecycle descriptor. `tone` ∈ {neutral, violet, amber, green, red}
  // maps to the .ms-badge-* / .ms-pill-* colour classes in app.css. `spinner`
  // requests the rotating arc glyph for in-flight stages. `extra` carries
  // optional `glyph`, `title` (tooltip) and `votes` ({yes, majority, reached}).
  function descriptor(key, label, tone, spinner, extra) {
    var d = { key: key, label: label, tone: tone, spinner: !!spinner };
    if (extra) {
      if (extra.glyph) d.glyph = extra.glyph;
      if (extra.title) d.title = extra.title;
      if (extra.votes) d.votes = extra.votes;
      // #788: not a state of its own — a modifier on the state, so
      // callers can render the "Explicit approval" chip alongside.
      if (extra.explicitApproval) d.explicitApproval = true;
    }
    return d;
  }

  // Canonical lifecycle derivation. Precedence is highest-signal-first: an
  // active merge/conflict outranks a checks verdict, which outranks the
  // vote/eligibility states. States 8–10 ("Awaiting admin", "Passed —
  // merging shortly", "In vote") need the vote tally; 1–7 + 11 need only the
  // columns every session payload carries. `opts.majority` / `opts.locked`
  // override per-row values (the feed passes the app-level majority + lock).
  function lifecycle(p, opts) {
    p = p || {};
    opts = opts || {};

    var status = p.status;
    var mcs = p.merge_conflict_state;
    var behind = num(p.behind_main);
    var check = p.check_state;

    // #695: the per-row votes_required — the governed gate's
    // electorate-based requirement on live rows, the merge-time snapshot
    // (#58) on merged rows — beats any app-level majority, matching
    // voteCountPill's precedence. On invited-approver apps the app-level
    // majority counts the wrong electorate entirely, so it's the last
    // resort. An "at least N" target comes next (#646); equal to
    // votes_required whenever both are serialized.
    var snap = parseInt(p.votes_required, 10);
    var majority = (Number.isFinite(snap) && snap > 0) ? snap
      : num(
        p.approvals_required != null ? p.approvals_required
          : opts.majority != null ? opts.majority
            : p.majority
      ) || 1;
    var hasVotes = p.yes_count !== null && p.yes_count !== undefined;
    var yes = num(p.qualified_yes_count != null ? p.qualified_yes_count : p.yes_count);
    var reached = hasVotes && yes >= majority;
    var locked = opts.locked != null ? opts.locked : p.locked;
    var votes = hasVotes ? { yes: yes, majority: majority, reached: reached } : null;
    // #695: on invited-approver apps the non-approver surplus is advisory —
    // shown beside the tally, never inside it.
    if (votes && p.approval_policy === 'invited' && p.qualified_yes_count != null) {
      votes.advisory = Math.max(0, num(p.yes_count) - num(p.qualified_yes_count));
    }

    // 1 — terminal: merged.
    if (status === 'merged') {
      return descriptor('merged', 'Merged', 'violet', false, { glyph: '✓', votes: votes });
    }
    // 2 — actively merging (GitHub merge + prod rebuild in flight).
    if (status === 'merging') {
      return descriptor('merging', 'Merging…', 'amber', true, {
        votes: votes,
        title: 'This change is being merged into the app and production is rebuilding.',
      });
    }
    // 3 — auto-resolver reconciling conflicts (persisted snapshot, or the
    // feed's process-local `resolving` flag) then retrying the merge.
    if (mcs === 'resolving' || p.resolving === true) {
      return descriptor('resolving', 'Resolving conflicts…', 'amber', true, {
        votes: votes,
        title: 'Reconciling conflicts with main automatically, then retrying the merge.',
      });
    }
    // 4 — auto-resolve gave up; a human must sync/resolve.
    if (mcs === 'failed') {
      return descriptor('conflict_failed', 'Conflict resolution failed', 'red', false, {
        glyph: '⚠', votes: votes,
        title: 'The last automatic conflict resolution failed. The owner needs to resolve manually.',
      });
    }
    // 4b — a real merge attempt hit a GitHub conflict ('conflict' is written
    // ONLY by the merge-time 405 path in routes/votes.js). The auto-resolver
    // may pick it up (state 3 takes over while it runs), but it only touches
    // vote-eligible proposals — so without this state a failed merge could
    // sit silently behind a reassuring "Behind main · syncing automatically"
    // badge forever. Red: the reliable way out is the proposal's creator
    // finishing the merge from their session.
    if (mcs === 'conflict') {
      return descriptor('merge_conflict', 'Merge failed: conflict', 'red', false, {
        glyph: '⚠', votes: votes,
        title: 'A merge was attempted but this proposal conflicts with main. '
          + 'The proposal\u2019s creator needs to finish the merge from their dev session ("Sync with main").',
      });
    }
    // 5a — the staging preview itself couldn't boot, so checks never ran
    // (#237). Distinct from a test failure: nothing was even exercised. Red,
    // with the captured crash reason in the tooltip so the owner knows what
    // to fix rather than facing an unexplained "couldn't run".
    if (check === 'error') {
      return descriptor('preview_failed', "Preview won't boot", 'red', false, {
        glyph: '⚠', votes: votes,
        title: p.check_error_detail
          ? ('The staging preview failed to start, so automated checks can\u2019t run. Merge is blocked. Reason: ' + p.check_error_detail)
          : 'The staging preview failed to start, so automated checks couldn\u2019t run. Merge is blocked until it boots cleanly.',
      });
    }
    // 5b — checks blocked the merge (a test broke).
    if (check === 'failing') {
      // BLOCKING failures only. Advisory rows are checks that have never
      // been observed passing on this app — they report but do not block,
      // so counting them here would tell a reviewer the merge is held up by
      // failures that are not holding it up. Rows written before advisory
      // existed carry no flag and count, which is the old behaviour.
      var n = Array.isArray(p.test_results)
        ? p.test_results.filter(function (r) { return r && r.status !== 'pass' && !r.advisory; }).length
        : 0;
      var label = n ? 'Checks failing · ' + n : 'Checks failing';
      return descriptor('checks_failing', label, 'amber', false, {
        glyph: '⚠', votes: votes,
        title: 'Automated tests are not passing on the staging build. Merge is blocked until they pass.',
      });
    }
    // 6 — checks still running (not yet a verdict). Grey, not amber: it's
    // "not started" rather than "broken".
    if (check === 'pending') {
      return descriptor('checks_running', 'Checks running…', 'neutral', true, {
        votes: votes,
        title: 'Automated tests are still running on the staging build. Merge is blocked until they pass.',
      });
    }
    // 6a (#607) — a promoted proposal with NO verdict recorded at all: the
    // first run hasn't stamped 'pending' yet (e.g. the promote-time staging
    // build is still going). Same in-progress treatment as 'pending'.
    // Rows carrying a console snapshot are genuine pre-#47 legacy and keep
    // falling through to the vote states.
    if (!check && status === 'promoted' && !p.console_check_state) {
      return descriptor('checks_running', 'Checks starting…', 'neutral', true, {
        votes: votes,
        title: 'The staging preview is being prepared and automated tests are about to run. Merge is blocked until they pass.',
      });
    }
    // 6b — checks explicitly skipped (#461): there was genuinely nothing to
    // test (branch level with main, or no GitHub wired up). Terminal and
    // NON-blocking — the gate treats it like 'passing' — so grey, no
    // spinner, with the recorded reason in the tooltip.
    if (check === 'skipped') {
      return descriptor('checks_skipped', 'Checks skipped', 'neutral', false, {
        votes: votes,
        title: p.check_error_detail
          ? ('Automated checks were skipped: ' + p.check_error_detail + '. This does not block the merge.')
          : 'Automated checks were skipped: there was nothing to test. This does not block the merge.',
      });
    }
    // 7 — behind main. ('conflict' no longer falls through here — it has its
    // own red state 4b above, since "syncing automatically" was a false
    // promise for proposals the gate-filtered auto-resolver never picks up.)
    if (behind > 0 || mcs === 'behind') {
      return descriptor('behind', behind ? 'Behind main · ' + behind : 'Behind main', 'amber', false, {
        votes: votes,
        title: 'This proposal is behind main. It is syncing automatically, then it will retry the merge.',
      });
    }
    // 8 — locked app: majority reached but still needs an admin yes. (Only
    // fires where the caller supplies `locked`; the admin-yes is verified
    // server-side, so this is the "still needs admin" hint, not a guarantee.)
    if (status === 'promoted' && reached && locked) {
      return descriptor('awaiting_admin', 'Awaiting admin approval', 'amber', false, {
        votes: votes,
        title: 'App is locked, so this also needs at least one admin yes before it merges.',
      });
    }
    // 9 — passed the vote, checks green, not behind: eligible and queued to
    // merge (one proposal per app merges at a time). The new explicit state.
    if (status === 'promoted' && reached && check === 'passing') {
      return descriptor('ready', 'Passed: merging shortly', 'green', false, {
        votes: votes,
        title: 'Votes passed and checks are green, so this is queued to merge.',
      });
    }
    // 10 — proposed, still collecting votes. #788: a proposal that
    // changes the app's admins keeps this ordinary state — its threshold
    // is unchanged — but carries an explanatory tooltip and the
    // `explicitApproval` flag so callers can render the amber chip.
    if (status === 'promoted') {
      return descriptor('in_vote', 'In vote', 'violet', false, {
        votes: votes,
        title: p.requires_explicit_approval
          ? 'This changes who can administer the app, so it won’t merge on a timer. It needs real Yes votes to reach the app’s normal threshold.'
          : undefined,
        explicitApproval: !!p.requires_explicit_approval,
      });
    }
    // 10b — an active draft whose pre-promotion checks finished cleanly.
    // Active sessions used to fall all the way through to the generic
    // "Draft" state here, hiding the successful checks run that made the
    // draft ready to propose. The merge-conflict / behind-main states above
    // retain precedence, and promoted rows already resolved through their
    // vote state.
    if (status === 'active' && check === 'passing') {
      return descriptor('checks_passed', 'Checks passed', 'green', false, {
        glyph: '✓',
        title: 'Automated checks passed on the staging build. This draft is ready to propose.',
      });
    }
    // 11 — building; not yet proposed.
    if (status === 'active') {
      return descriptor('draft', 'Draft', 'neutral', false, {});
    }
    // Unknown / non-merge lifecycle (paused, archived, …): no badge.
    return descriptor('none', '', 'neutral', false, {});
  }

  function spinnerHtml() {
    return '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>';
  }

  function inner(life, includeVotes) {
    var label = life.label;
    var advisory = '';
    if (includeVotes && life.key === 'in_vote' && life.votes) {
      label += ' · ' + life.votes.yes + '/' + life.votes.majority;
      // #695: muted "+N" for advisory (non-approver) votes on
      // invited-approver apps — recorded, but not in the headline tally.
      if (life.votes.advisory > 0) {
        advisory = ' <span class="ms-advisory" title="'
          + life.votes.advisory + ' advisory vote' + (life.votes.advisory === 1 ? '' : 's')
          + ' from non-approvers. They don’t count toward merging">+'
          + life.votes.advisory + '</span>';
      }
    }
    return (life.spinner ? spinnerHtml() : '')
      + (life.glyph ? esc(life.glyph) + ' ' : '')
      + esc(label) + advisory;
  }

  // Text-style badge (colour only) — for the proposal feed card's state slot
  // and the home strip, where a separate vote pill already shows the tally.
  function badgeHtml(life) {
    if (!life || !life.label) return '';
    var title = life.title ? ' title="' + esc(life.title) + '"' : '';
    return '<span class="ms-badge ms-badge-' + (life.tone || 'neutral') + '"' + title + '>'
      + inner(life, false) + '</span>';
  }

  // Filled pill — for the dev session header, which has no vote pill of its
  // own, so the in-vote tally rides along in the label.
  function pillHtml(life) {
    if (!life || !life.label) return '';
    var title = life.title ? ' title="' + esc(life.title) + '"' : '';
    return '<span class="ms-pill ms-pill-' + (life.tone || 'neutral') + '"' + title + '>'
      + inner(life, true) + '</span>';
  }

  var MergeStatus = {
    lifecycle: lifecycle,
    badgeHtml: badgeHtml,
    pillHtml: pillHtml,
    // Keys whose canonical badge belongs in the feed card's "state" slot.
    // In-vote / draft are conveyed by the vote pill; checks states keep their
    // own detailed badge (with per-test counts), so they're excluded here.
    STATE_BADGE_KEYS: ['merged', 'merging', 'resolving', 'conflict_failed', 'merge_conflict', 'behind', 'ready'],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MergeStatus;
  if (typeof window !== 'undefined') window.MergeStatus = MergeStatus;
  if (root && typeof root === 'object') root.MergeStatus = MergeStatus;
})(typeof globalThis !== 'undefined' ? globalThis : this);
