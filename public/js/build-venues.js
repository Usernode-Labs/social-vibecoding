/* Where a change was built, as a name.
 *
 * A change card says where its work happened: on Homeroom with Claude or
 * with an OpenRouter model, on the author's own machine, handed to a web
 * agent, or with the author's own tools and a pull request
 * (app-view.js `_sessionVenueChipSpec`). The six venues and the rule that
 * picks one from a change's columns live here.
 *
 * `id` is a presentation key. The persisted values are 'claude_code' /
 * 'codex_openrouter' in chat_sessions.agent_backend, 'claude-code' /
 * 'codex' in external_agent, 'imported' and 'cli_handoff' in
 * chat_sessions.source, and chat_sessions.build_venue, which stores one of
 * these ids verbatim. That column and its CHECK are the other copy of this
 * id list.
 */
(function () {
  'use strict';

  // Every word a person reads comes from the language catalog
  // (session.json). The table below is evaluated before the language
  // runtime exists, so `label` and `blurb` are getters: each reads its
  // message when a caller asks, in the language of that moment.
  function t(id, values) { return PlatformI18n.t(id, values); }

  // The list, named venue-first: WHERE the work happens, then what runs it.
  var VENUES = [
    {
      id: 'usernode-openrouter',
      get label() { return t('session:venue.usernodeOpenrouter.label'); },
      get blurb() { return t('session:venue.usernodeOpenrouter.blurb'); },
    },
    {
      id: 'usernode-claude',
      get label() { return t('session:venue.usernodeClaude.label'); },
      get blurb() { return t('session:venue.usernodeClaude.blurb'); },
    },
    {
      id: 'local',
      get label() { return t('session:venue.local.label'); },
      get blurb() { return t('session:venue.local.blurb'); },
    },
    {
      id: 'web-claude-code',
      get label() { return t('session:venue.webClaudeCode.label'); },
      get blurb() { return t('session:venue.webClaudeCode.blurb'); },
    },
    {
      id: 'web-codex',
      get label() { return t('session:venue.webCodex.label'); },
      get blurb() { return t('session:venue.webCodex.blurb'); },
    },
    {
      id: 'own-tools-pr',
      get label() { return t('session:venue.ownToolsPr.label'); },
      get blurb() { return t('session:venue.ownToolsPr.blurb'); },
    },
  ];

  var BY_ID = {};
  VENUES.forEach(function (v) { BY_ID[v.id] = v; });

  function venue(id) {
    return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
  }

  // The venue this change was built in.
  //
  // `source === 'imported'` short-circuits everything else: an imported
  // proposal has an agent_backend column like any other row (the insert
  // defaults it), but no turn ever ran through it and none ever will, so
  // reading the backend here would report a venue that is not merely
  // unused but structurally unreachable.
  // Order is: structural facts, then the stored choice, then derivation.
  //
  //   imported    — structural, so nothing overrides it.
  //   buildVenue  — #1281: the owner's stored CHOICE, from
  //                 chat_sessions.build_venue. It sits above the derived
  //                 cases because it is the only one that can say "handed
  //                 to Claude Code, not submitted yet" — external_agent is
  //                 stamped at submission.
  //   the rest    — derived from the columns, which is what keeps every
  //                 pre-#1281 row correct with no backfill.
  //
  // An unrecognised stored value is IGNORED rather than trusted: the column
  // has a CHECK, but a row written by an older or newer deployment must
  // degrade to the derivation rather than paint a venue this build has
  // never heard of.
  function currentVenue(state) {
    var s = state || {};
    if (s.source === 'imported') return 'own-tools-pr';
    if (s.buildVenue && venue(s.buildVenue)) return s.buildVenue;
    if (s.source === 'cli_handoff') return 'local';
    if (s.externalAgent === 'claude-code') return 'web-claude-code';
    if (s.externalAgent === 'codex') return 'web-codex';
    if (s.agentBackend === 'codex_openrouter') return 'usernode-openrouter';
    return 'usernode-claude';
  }

  // Local proposal provenance is independent of the backend available for
  // later platform turns. Unknown older handoffs must not claim Claude.
  function sessionVenue(state) {
    var s = state || {};
    var v = venue(currentVenue(s));
    if (!v || s.source !== 'cli_handoff'
        || (s.buildVenue && venue(s.buildVenue))) return v;
    // Codex and Claude Code are product names and are not translated.
    var label = s.externalAgent === 'codex' ? 'Codex'
      : s.externalAgent === 'claude-code' ? 'Claude Code' : t('session:venue.handoff.externalAgent');
    return Object.assign({}, v, {
      label: label,
      blurb: s.externalAgent === 'codex' ? t('session:venue.handoff.authoredWithCodex')
        : s.externalAgent === 'claude-code' ? t('session:venue.handoff.authoredWithClaudeCode')
          : t('session:venue.handoff.authoredWithExternalAgent'),
    });
  }

  var BuildVenues = {
    sessionVenue: sessionVenue,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BuildVenues;
  }
  if (typeof window !== 'undefined') {
    window.BuildVenues = BuildVenues;
  }
}());
