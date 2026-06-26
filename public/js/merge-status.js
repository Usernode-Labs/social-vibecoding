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
    }
    return d;
  }

  // Canonical 11-state derivation. Precedence is highest-signal-first: an
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

    var majority = num(
      opts.majority != null ? opts.majority
        : (p.majority != null ? p.majority : p.votes_required)
    ) || 1;
    var hasVotes = p.yes_count !== null && p.yes_count !== undefined;
    var yes = num(p.yes_count);
    var reached = hasVotes && yes >= majority;
    var locked = opts.locked != null ? opts.locked : p.locked;
    var votes = hasVotes ? { yes: yes, majority: majority, reached: reached } : null;

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
        title: 'The last automatic conflict resolution failed — the owner needs to resolve manually.',
      });
    }
    // 5 — checks blocked the merge (a test broke, or the run itself errored).
    if (check === 'failing' || check === 'error') {
      var n = Array.isArray(p.test_results)
        ? p.test_results.filter(function (r) { return r && r.status !== 'pass'; }).length
        : 0;
      var label = (check === 'failing' && n) ? 'Checks failing · ' + n : 'Checks failing';
      return descriptor('checks_failing', label, 'amber', false, {
        glyph: '⚠', votes: votes,
        title: 'Automated tests are not passing on the staging build — merge is blocked until they pass.',
      });
    }
    // 6 — checks still running (not yet a verdict). Grey, not amber: it's
    // "not started" rather than "broken".
    if (check === 'pending') {
      return descriptor('checks_running', 'Checks running…', 'neutral', true, {
        votes: votes,
        title: 'Automated tests are still running on the staging build — merge is blocked until they pass.',
      });
    }
    // 7 — behind main (or a fresh conflict snapshot, which always carries
    // behind_main ≥ 1 while the auto-resolver runs).
    if (behind > 0 || mcs === 'behind' || mcs === 'conflict') {
      return descriptor('behind', behind ? 'Behind main · ' + behind : 'Behind main', 'amber', false, {
        votes: votes,
        title: 'This proposal is behind main — syncing automatically, then it will retry the merge.',
      });
    }
    // 8 — locked app: majority reached but still needs an admin yes. (Only
    // fires where the caller supplies `locked`; the admin-yes is verified
    // server-side, so this is the "still needs admin" hint, not a guarantee.)
    if (status === 'promoted' && reached && locked) {
      return descriptor('awaiting_admin', 'Awaiting admin approval', 'amber', false, {
        votes: votes,
        title: 'App is locked — this also needs at least one admin yes before it merges.',
      });
    }
    // 9 — passed the vote, checks green, not behind: eligible and queued to
    // merge (one proposal per app merges at a time). The new explicit state.
    if (status === 'promoted' && reached && check === 'passing') {
      return descriptor('ready', 'Passed — merging shortly', 'green', false, {
        votes: votes,
        title: 'Votes passed and checks are green — this is queued to merge.',
      });
    }
    // 10 — proposed, still collecting votes.
    if (status === 'promoted') {
      return descriptor('in_vote', 'In vote', 'violet', false, { votes: votes });
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
    if (includeVotes && life.key === 'in_vote' && life.votes) {
      label += ' · ' + life.votes.yes + '/' + life.votes.majority;
    }
    return (life.spinner ? spinnerHtml() : '')
      + (life.glyph ? esc(life.glyph) + ' ' : '')
      + esc(label);
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
    STATE_BADGE_KEYS: ['merged', 'merging', 'resolving', 'conflict_failed', 'behind', 'ready'],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MergeStatus;
  if (typeof window !== 'undefined') window.MergeStatus = MergeStatus;
  if (root && typeof root === 'object') root.MergeStatus = MergeStatus;
})(typeof globalThis !== 'undefined' ? globalThis : this);
