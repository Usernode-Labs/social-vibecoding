/* The six places work can be built — and the one question that picks
 * between them.
 *
 * Before this module the same decision was scattered across nine controls:
 * a backend picker in the composer footer, a model dropdown beside it, the
 * dev-flow card at the top of an empty session, two rows in the "…" menu,
 * two more in the out-of-credits card, a "Propose with Claude Code or
 * Codex" door in the "+" menu, and the PR-import modal. Each named its own
 * mechanism, none named the others, and two of them said "Claude Code"
 * about two different products — the platform backend
 * (chat_sessions.agent_backend = 'claude_code', billed to Usernode) and
 * the web hand-off (users.dev_flow_preference = 'claude-code', billed to
 * the user's own Claude plan). Picking the wrong one cost real money.
 *
 * So: ONE list, named venue-first — WHERE the work happens, then what runs
 * it. Every surface that offers the choice reads it from here, and
 * tests/venue-labels.test.js pins the vocabulary across every module that
 * still owns a copy of a label.
 *
 * What this module is NOT:
 *
 *   • It is not a schema change. `id` here is a presentation key. The
 *     persisted values are untouched — 'claude_code' / 'codex_openrouter'
 *     in chat_sessions.agent_backend, 'claude-code' / 'codex' in
 *     users.dev_flow_preference and external_agent, 'imported' in
 *     chat_sessions.source. `mechanism` on each row is the mapping, and
 *     it is the only place the two vocabularies meet.
 *   • It is not an allowlist. Nothing here is sent to a server as a
 *     venue id; callers translate through `preselect()` first.
 *
 * Two groups, because the honest first question is not "which agent" but
 * "does this happen in this chat or somewhere else":
 *
 *   in-chat   — usernode-claude, usernode-openrouter, local
 *   elsewhere — web-claude-code, web-codex, own-tools-pr
 *
 * Gating is by OMISSION, never `disabled: true` — the kit's touch idiom is
 * an action sheet, which drops disabled rows entirely, so a disabled entry
 * is invisible on a phone and inert-but-present on a desktop. Same rule as
 * public/js/session-options.js; see its header.
 *
 * `own-tools-pr` is the one venue with two hard exceptions, both enforced
 * server-side and merely REPORTED here: it has no Usernode chat (the
 * imported-proposal guard refuses dev-chat turns on a session with
 * source='imported'), and it cannot be anyone's default (there is nothing
 * for a default to do — the work arrives as a pull request or not at all).
 * `defaultableVenues()` exists so no caller has to remember that.
 */
(function () {
  'use strict';

  // Reconciled from the two copies that existed before this module
  // (credit-options.js had three keys, session-options.js had two). Every
  // value is a real Settings section — see Settings.SECTIONS in
  // public/js/settings.js — so following one is an ordinary hash
  // navigation and the device back gesture returns to the chat.
  var SETTINGS_HASHES = {
    apiKey: '#settings/api-key',
    localTool: '#settings/cli',
    connector: '#settings/connectors',
  };

  var GROUPS = [
    { id: 'in-chat', label: 'In this chat' },
    { id: 'elsewhere', label: 'Somewhere else' },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // The list. Order is menu order, and group order is question order.
  //
  // `mechanism` is the mapping to what is actually stored, and is the
  // reason a venue id never travels to the server: a caller takes the
  // venue the user picked and reads the mechanism off it.
  //
  //   backend  → POST /api/apps/:slug/sessions { backend } and
  //              chat_sessions.agent_backend
  //   flow     → users.dev_flow_preference + external_agent_tasks
  //   lease    → session_agent_leases (#907), set up from the CLI card
  //   import   → POST /api/apps/:slug/pr-import → source='imported'
  //
  // `requires` is the single state flag that has to be truthy for the row
  // to be offered at all. null means always available.
  var VENUES = [
    {
      id: 'usernode-claude',
      label: 'Usernode · Claude',
      group: 'in-chat',
      mechanism: { kind: 'backend', backend: 'claude_code' },
      requires: null,
      defaultable: true,
      chat: true,
      blurb: 'Usernode runs the turns right here, on your daily AI credits — or your own Anthropic key once they run out.',
      cta: 'Build it here',
    },
    {
      id: 'usernode-openrouter',
      label: 'Usernode · OpenRouter',
      group: 'in-chat',
      mechanism: { kind: 'backend', backend: 'codex_openrouter' },
      // The OpenRouter backend is a flagged, allowlisted beta and needs a
      // stored credential; the server is the authority on all three, so
      // the browser only offers the row when GET /api/auth/me said yes.
      requires: 'openrouterAvailable',
      defaultable: true,
      chat: true,
      blurb: 'The same chat, driven through your own OpenRouter key — you pick the model and how hard it thinks.',
      cta: 'Use OpenRouter',
    },
    {
      id: 'local',
      label: 'Your computer · Usernode session',
      group: 'in-chat',
      mechanism: { kind: 'lease', hash: SETTINGS_HASHES.localTool },
      requires: 'cliAuthEnabled',
      defaultable: true,
      chat: true,
      blurb: 'The Usernode CLI runs this session’s turns on your machine and your own Claude plan. Same chat, same branch, same proposal — the work just executes locally.',
      cta: 'Set up the Usernode CLI',
    },
    {
      id: 'web-claude-code',
      label: 'Claude Code on the web',
      group: 'elsewhere',
      mechanism: { kind: 'flow', flow: 'claude-code', hash: SETTINGS_HASHES.connector },
      requires: 'externalFlowsAvailable',
      defaultable: true,
      chat: false,
      blurb: 'Usernode writes the work order; Claude Code on the web builds it on your own Claude plan and pushes to your fork. Usernode opens the pull request and imports it as a proposal. No credits, no API key.',
      cta: 'Use Claude Code',
    },
    {
      id: 'web-codex',
      label: 'Codex on the web',
      group: 'elsewhere',
      mechanism: { kind: 'flow', flow: 'codex', hash: SETTINGS_HASHES.connector },
      requires: 'externalFlowsAvailable',
      defaultable: true,
      chat: false,
      blurb: 'The same hand-off for Codex on the web and the ChatGPT plan you already pay for. Usernode guides you through linking GitHub, forking and submitting.',
      cta: 'Use Codex',
    },
    {
      id: 'own-tools-pr',
      label: 'Your computer · your own tools',
      group: 'elsewhere',
      mechanism: { kind: 'import', hash: SETTINGS_HASHES.localTool },
      // Importing writes to the app's branches, so it is collaborator-only
      // — the same gate the "+" menu's Import row already carries.
      requires: 'canCollaborate',
      // Both exceptions, stated once. See the header.
      defaultable: false,
      chat: false,
      blurb: 'Build it however you like — Cursor, Zed, vim, any agent — push a branch, then bring the pull request in with “Import Feature from a PR”.',
      cta: 'How importing a PR works',
    },
  ];

  var BY_ID = {};
  VENUES.forEach(function (v) { BY_ID[v.id] = v; });

  function venue(id) {
    return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
  }

  // The venue this session is ALREADY building in.
  //
  // `source === 'imported'` short-circuits everything else: an imported
  // proposal has an agent_backend column like any other row (the insert
  // defaults it), but no turn ever ran through it and none ever will, so
  // reading the backend here would report a venue that is not merely
  // unused but structurally unreachable.
  function currentVenue(state) {
    var s = state || {};
    if (s.source === 'imported') return 'own-tools-pr';
    if (s.localAgent) return 'local';
    if (s.externalAgent === 'claude-code') return 'web-claude-code';
    if (s.externalAgent === 'codex') return 'web-codex';
    if (s.agentBackend === 'codex_openrouter') return 'usernode-openrouter';
    return 'usernode-claude';
  }

  // Which venues can be somebody's saved default. `own-tools-pr` is not
  // one of them — see the header.
  function defaultableVenues() {
    return VENUES.filter(function (v) { return v.defaultable; });
  }

  // ── Per-mode copy ──────────────────────────────────────────────────
  //
  // Three modes, because the same six venues answer three different
  // questions and the verbs are not interchangeable:
  //
  //   'start'   — a session with nothing in it yet. "Where should this be
  //               built?" Every answer is still open.
  //   'switch'  — a session under way. "Where should the REST of this be
  //               built?" The in-chat venues continue the transcript; the
  //               elsewhere ones hand the code over and the conversation
  //               continues in the other tool.
  //   'blocked' — the credits ran out. Same list, but usernode-claude is
  //               shown struck through with the reason, because deleting
  //               the row someone was already using makes the menu look
  //               like it lost an option rather than like one is
  //               temporarily out of reach.
  var MODES = ['start', 'switch', 'blocked'];

  // ── What a web hand-off does from HERE (#1071) ─────────────────────
  //
  // Moved in from session-options.js, which used to own it alone — the
  // venue sheet asks the same question from four more surfaces now, and
  // three copies of "what does continuing actually do" is how the two
  // Claude Codes happened in the first place.
  //
  // Three states, and only one applies at a time. Derived here rather
  // than taken as a pre-computed flag, so the one place that decides is
  // the one place the tests drive.
  //
  //   'session'  — an `active` or `paused` session WITH a branch of its own.
  //                The agent starts from that branch's head and its commits
  //                land back on it. Paused is included because pausing is
  //                bookkeeping, not a decision about the work: the platform
  //                auto-pauses idle sessions on the user's behalf, so
  //                refusing here would be arbitrary.
  //   'proposal' — `promoted`: the session IS the proposal the group is
  //                voting on, and the agent's commits move it — clearing the
  //                votes it has already collected.
  //   'new'      — anywhere else: archived (an explicit put-away, which a
  //                push must not silently reopen), merging/merged (frozen by
  //                definition), or a session with no branch at all.
  //
  // `archived` deliberately falls through to "start new work" rather than
  // being hidden: starting new work IS available there, it is just not a
  // continuation.
  function webTargetKind(state) {
    var s = state || {};
    var status = s.sessionStatus ? String(s.sessionStatus) : '';
    if (status === 'promoted') return 'proposal';
    if ((status === 'active' || status === 'paused') && s.hasBranch) return 'session';
    return 'new';
  }

  function webVerb(kind) {
    if (kind === 'session') return 'Continue this session with ';
    if (kind === 'proposal') return 'Continue this proposal with ';
    return 'Start new work with ';
  }

  // The consequence sentence behind the verb. `paused` changes ONLY this
  // tooltip: the labels are byte-identical for `active` and `paused` on
  // purpose, so one selector assertion covers both fixtures and the two
  // cases cannot drift apart in the menu.
  function webNote(kind, paused) {
    if (kind === 'session') {
      return paused
        ? 'It starts from this session\'s latest commit and pushes its work back onto this session\'s own branch — '
          + 'the code lands on this session\'s branch, and its preview and checks catch up when you reopen the '
          + 'session. The agent\'s own conversation happens there, not in this transcript.'
        : 'It starts from this session\'s latest commit and pushes its work back onto this session\'s own branch — '
          + 'the code lands here, and its preview and checks rebuild. The agent\'s own conversation happens there, '
          + 'not in this transcript.';
    }
    if (kind === 'proposal') {
      return 'It starts from this proposal\'s latest commit and pushes back onto the same proposal — submitting '
        + 'clears the votes it has already collected and re-runs its checks. The agent\'s own conversation happens '
        + 'there, not in this transcript.';
    }
    return 'Usernode prepares a task for the web agent; what it builds comes back as its own proposal, not as more '
      + 'turns in this session.';
  }

  // What picking this venue does to THIS chat, in one clause. The
  // distinction the old copy kept losing: only the in-chat group keeps
  // the transcript.
  function consequence(id, mode, state) {
    var v = venue(id);
    if (!v) return '';
    var s = state || {};
    if (id === 'own-tools-pr') {
      if (mode === 'switch') {
        return 'Starts separate work — this chat stays where it is, and what you import comes back as its own proposal. It can’t be your default.';
      }
      if (mode === 'blocked') {
        return 'Costs no credits: you build it yourself and import the pull request. There is no Usernode chat for this one, and it can’t be your default.';
      }
      return 'No Usernode chat for this one — you build it, then import the pull request. It can’t be your default.';
    }
    if (v.group === 'in-chat') {
      return mode === 'switch'
        ? 'Keeps this chat, this branch and this proposal — only where the turns run changes.'
        : 'The work happens in this chat.';
    }
    // Web hand-off: what it does depends on where this session is, which
    // is the whole of #1071.
    return webNote(webTargetKind(s), String(s.sessionStatus || '') === 'paused');
  }

  // The row verb. Single-line by construction — the kit sets labels with
  // textContent — so everything else goes in the row's `title`.
  function rowLabel(id, mode, state) {
    var v = venue(id);
    if (!v) return '';
    if (mode !== 'switch') return v.label;
    // The row you are already in is a statement, not an instruction —
    // "Move to Usernode · Claude ✓" reads as a contradiction, and this is
    // the one row whose job is to confirm rather than offer.
    if (state && state.current === id) return v.label;
    // In a session already under way, "start new work with Codex" and
    // "continue this proposal with Codex" are different promises, and the
    // label is the only place a phone user sees the difference.
    if (v.group === 'elsewhere' && v.mechanism.kind === 'flow') {
      return webVerb(webTargetKind(state || {})) + v.label;
    }
    return 'Move to ' + v.label;
  }

  // The offered rows, filtered and in group order. `state`:
  //   mode                    — one of MODES; anything else reads as 'start'
  //   openrouterAvailable     — GET /api/auth/me: flag + beta + credential
  //   cliAuthEnabled          — deployment offers /api/cli/* at all
  //   externalFlowsAvailable  — deployment can offer the web hand-offs
  //   canCollaborate          — viewer may push branches to this app
  //   blockedReason           — 'blocked' mode: why usernode-claude is out
  //   current                 — the venue id this session is already in
  //
  // A venue whose `requires` flag is falsy is ABSENT, not disabled.
  function venuesFor(state) {
    var s = state || {};
    var mode = MODES.indexOf(s.mode) === -1 ? 'start' : s.mode;
    var current = s.current || null;
    return VENUES.filter(function (v) {
      if (!v.requires) return true;
      return !!s[v.requires];
    }).map(function (v) {
      // In 'blocked' mode the platform-billed venue is the one that just
      // refused the turn. It stays visible and struck through: the user
      // needs to see that the option still exists and why it can't be
      // used right now, which is exactly what removing it would hide.
      var because = consequence(v.id, mode, s);
      // #1071: a web hand-off in an under-way session pushes back onto
      // THIS session's branch, so it carries the session id. `null` means
      // the hand-off genuinely starts something separate.
      var targetKind = webTargetKind(s);
      var out = {
        id: v.id,
        group: v.group,
        label: rowLabel(v.id, mode, s),
        title: v.blurb + ' ' + because,
        blurb: v.blurb,
        consequence: because,
        cta: v.cta,
        mechanism: v.mechanism,
        defaultable: v.defaultable,
        chat: v.chat,
        targetKind: targetKind,
        targetId: (v.mechanism.kind === 'flow' && targetKind !== 'new' && s.sessionId != null)
          ? s.sessionId
          : null,
        current: current === v.id,
        unavailable: false,
        reason: null,
      };
      if (mode === 'blocked' && v.id === 'usernode-claude') {
        out.unavailable = true;
        out.reason = s.blockedReason
          || 'Today’s AI credits are spent. They reset at midnight UTC.';
      }
      return out;
    });
  }

  // Venue → the mechanism a caller has to drive, with the persisted value
  // spelled out. Returns null for an unknown id rather than guessing —
  // a venue id that reached here from a URL or a stale preference must
  // not silently become "the first backend in the list".
  function preselect(venueId) {
    var v = venue(venueId);
    if (!v) return null;
    return {
      venue: v.id,
      label: v.label,
      kind: v.mechanism.kind,
      backend: v.mechanism.backend || null,
      flow: v.mechanism.flow || null,
      hash: v.mechanism.hash || null,
      chat: v.chat,
      defaultable: v.defaultable,
    };
  }

  // ── The one-line venue statement ───────────────────────────────────
  //
  // Rendered above the composer on a session's FIRST paint and never
  // hidden behind a preference: the whole reason the old "Propose with
  // Claude Code or Codex" door could be removed is that this line is
  // always there to replace it. It is a statement with a change control,
  // not a question — the question is only asked when the user opens it.
  function lineHtml(state) {
    var s = state || {};
    var id = s.current || currentVenue(s);
    var v = venue(id);
    if (!v) return '';
    var note = s.fallbackReason ? fallbackNote(s.fallbackReason) : '';
    return ''
      + '<div class="dc-venue-line" data-venue-line="' + escapeHtml(v.id) + '">'
      + '<span class="dc-venue-line-text">Building in <span class="dc-venue-name">'
      + escapeHtml(v.label) + '</span></span>'
      + '<button type="button" class="dc-venue-change" data-venue-change="1">Change how this is built</button>'
      + (note ? '<div class="dc-venue-note">' + escapeHtml(note) + '</div>' : '')
      + '</div>';
  }

  // The compact chip for a session card / the composer footer.
  function chipHtml(venueId) {
    var v = venue(venueId);
    if (!v) return '';
    return '<span class="dc-venue-chip" title="' + escapeHtml(v.label + ' — ' + v.blurb) + '">'
      + escapeHtml(v.label) + '</span>';
  }

  // Why the venue you asked for isn't the venue you got.
  //
  // resolveDefaultAgentPreference (src/routes/sessions.js) is deliberately
  // LENIENT — a session that runs beats a 4xx — but until now the fallback
  // was a server log line and nothing else, so a user whose saved default
  // was Usernode · OpenRouter got a Usernode · Claude session with no
  // explanation. One sentence, naming the fix.
  var FALLBACK_NOTES = {
    flag_off: 'Your default is Usernode · OpenRouter, but this deployment has it turned off, so this session is building in Usernode · Claude.',
    not_in_beta: 'Your default is Usernode · OpenRouter, which is still in a limited beta you’re not in yet — this session is building in Usernode · Claude.',
    model_unavailable: 'Your default is Usernode · OpenRouter but no model is set for it, so this session is building in Usernode · Claude. Pick a model in Settings and the next one will use it.',
    no_credential: 'Your default is Usernode · OpenRouter but your OpenRouter key is missing or no longer valid, so this session is building in Usernode · Claude. Re-save the key in Settings.',
  };

  // hasOwnProperty, not a bare lookup: `reason` arrives on the 201 body, so
  // it is server data, and a bare lookup would answer `fallbackNote` with
  // Object.prototype's own members — `toString` renders a function into the
  // note. Same rule as venue() above.
  function fallbackNote(reason) {
    return Object.prototype.hasOwnProperty.call(FALLBACK_NOTES, reason)
      ? FALLBACK_NOTES[reason]
      : '';
  }

  // ── The sheet ──────────────────────────────────────────────────────
  //
  // Built imperatively, and deliberately NOT as a React island: this sheet's
  // content element is handed to the kit, which moves it into its own shell,
  // so a React subtree here would reconcile against a parent that no longer
  // holds its child. The nine dialogs solve that by owning the lift from
  // inside React (frontend/src/lib/static-modal.ts); this venue sheet has no
  // static root to own, so it stays as it is. See AGENTS.md.
  //
  // `opts`: { anchorEl, state, onPick(preselect), onUnavailable(row) }.
  // Resolves whatever the kit's menu resolves; null when there is no kit.
  function open(opts) {
    var o = opts || {};
    var state = o.state || {};
    var rows = venuesFor(state);
    if (!rows.length) return Promise.resolve(null);
    var kit = (typeof window !== 'undefined' && window.PlatformUI) || null;
    if (!kit || !kit.hasKit()) return Promise.resolve(null);

    // The kit's menu takes a flat action list with no heading primitive,
    // so each group announces itself with a non-interactive separator
    // row. NOT a `disabled: true` row — the touch action sheet drops
    // those, which would silently delete the headings on exactly the
    // platform where the grouping matters most.
    var actions = [];
    GROUPS.forEach(function (group) {
      var inGroup = rows.filter(function (r) { return r.group === group.id; });
      if (!inGroup.length) return;
      actions.push({ label: '— ' + group.label + ' —', handler: function () {} });
      inGroup.forEach(function (row) {
        actions.push({
          label: row.label + (row.current ? ' ✓' : '') + (row.unavailable ? ' (unavailable)' : ''),
          title: row.unavailable ? row.reason : row.title,
          handler: function () {
            if (row.unavailable) {
              if (typeof o.onUnavailable === 'function') o.onUnavailable(row);
              return;
            }
            if (typeof o.onPick === 'function') o.onPick(preselect(row.id), row);
          },
        });
      });
    });

    return kit.menu({
      anchorEl: o.anchorEl || undefined,
      title: state.mode === 'switch' ? 'Where should the rest of this be built?' : 'Where should this be built?',
      items: actions,
    });
  }

  var BuildVenues = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    GROUPS: GROUPS,
    MODES: MODES,
    VENUES: VENUES,
    venue: venue,
    venuesFor: venuesFor,
    currentVenue: currentVenue,
    defaultableVenues: defaultableVenues,
    preselect: preselect,
    consequence: consequence,
    rowLabel: rowLabel,
    webTargetKind: webTargetKind,
    webVerb: webVerb,
    webNote: webNote,
    lineHtml: lineHtml,
    chipHtml: chipHtml,
    fallbackNote: fallbackNote,
    open: open,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BuildVenues;
  }
  if (typeof window !== 'undefined') {
    window.BuildVenues = BuildVenues;
  }
}());
