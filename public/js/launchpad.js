/* The launchpad — what a session shows when the work is NOT happening in
 * this chat (#1281).
 *
 * Three of the six venues in public/js/build-venues.js build somewhere
 * else: `web-claude-code` and `web-codex` hand a work order to an agent on
 * the vendor's own site, and `own-tools-pr` is you, on your machine, with
 * whatever tools you like. For all three, a chat composer is the wrong
 * primary control — there is nothing on the other end of it, because no
 * turn will run here. The spec's wireframes draw that literally: types 2
 * and 3 have no composer at all, just the steps.
 *
 * So this module owns the panel that stands in its place, and dev-chat.js
 * swaps the composer for it whenever `isLaunchpad(venue)` is true. The
 * venue line above it stays exactly where it was, which is the way back:
 * "Change how this is built" is the persistent control the spec asks for,
 * and picking an in-chat venue restores the composer.
 *
 * Division of labour with public/js/dev-flow-select.js:
 *
 *   web-claude-code / web-codex → DevFlowSelect.wizardHtml(). That
 *     walkthrough already resolves five steps from the server's status
 *     payload and has done since #1049; it is the type 2 launchpad and did
 *     not need rewriting, only re-siting and a vendor toggle.
 *   own-tools-pr                → ownToolsHtml() here. This one had no
 *     launchpad at all: picking it opened the import modal, which asks for
 *     a pull request the user has not built yet.
 *
 * Pure render + wire, no fetching — the same split as build-venues.js and
 * credit-options.js, and the reason tests/launchpad.test.js can exercise
 * every branch in node with no DOM and no server.
 */
(function () {
  'use strict';

  // The venues with no Usernode chat. Kept as a list rather than derived
  // from `chat: false` in build-venues.js so this module still answers
  // correctly when it is loaded without that one (the test harness does
  // exactly that), and asserted against it in tests/launchpad.test.js so
  // the two cannot drift.
  var LAUNCHPAD_VENUES = ['web-claude-code', 'web-codex', 'own-tools-pr'];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isLaunchpad(venueId) {
    return LAUNCHPAD_VENUES.indexOf(String(venueId || '')) !== -1;
  }

  // ── Step 1: connecting an agent ─────────────────────────────────────
  //
  // The connector is the platform's own hosted MCP server, mounted at /mcp
  // (src/routes/mcp-remote.js) and spoken over Streamable HTTP. The origin
  // is taken from the page rather than hardcoded, so a self-hosted fork
  // prints its own — the same derivation the Settings → Connectors field
  // uses, and the reason neither has to know the deployment's domain.
  function connectorUrl(origin) {
    var base = String(origin == null ? '' : origin).replace(/\/+$/, '');
    return base + '/mcp';
  }

  // Claude Code's own syntax for an HTTP MCP server. Any MCP-capable agent
  // can use the URL above; this is the one-liner for the common case, and
  // the URL is printed beside it precisely so an agent with different
  // syntax is not stuck.
  function mcpCommand(origin) {
    return 'claude mcp add --transport http usernode ' + connectorUrl(origin);
  }

  // ── Step 2: what to tell it ─────────────────────────────────────────
  //
  // The block the user copies into their own agent. It is deliberately
  // instructions for an AGENT rather than a description for a person: the
  // whole point of this venue is that the next thing to read it is a
  // coding agent with the Usernode connector attached, and what it needs is
  // the two tool calls that bracket the job.
  //
  // `issueNumber` is chat_sessions.created_from_issue_number — the request
  // this session was opened from, when there was one. With it, the agent
  // can pull the request's own title and body through prepare_work and
  // needs nothing else; without it, the session's title is the brief.
  function prefillText(state) {
    var s = state || {};
    var slug = String(s.slug || '').trim();
    var issue = Number(s.issueNumber);
    var hasIssue = Number.isFinite(issue) && issue > 0;
    var title = String(s.sessionTitle || '').trim();

    var lines = [];
    lines.push('Build a change to the Usernode app `' + (slug || '<app slug>') + '`.');
    lines.push('');
    if (hasIssue) {
      lines.push('What to build: request #' + issue
        + (title ? ' — ' + title : '')
        + '. Read it in full before you start; prepare_work returns its title and body.');
    } else if (title) {
      lines.push('What to build: ' + title);
    } else {
      lines.push('What to build: <describe the change here>');
    }
    lines.push('');
    lines.push('Use the Usernode MCP connector, in this order:');
    lines.push('1. Call `prepare_work` with slug `' + (slug || '<app slug>') + '`'
      + (hasIssue ? ' and requestNumber ' + issue : '') + '.');
    lines.push('2. Follow the work order it returns EXACTLY — it names the repository, the');
    lines.push('   fork to push to, the branch, and the 40-character base commit to start');
    lines.push('   from. Do not substitute the fork’s default branch for that commit.');
    lines.push('3. Implement and test the change, then push your branch to your own fork.');
    lines.push('4. Call `submit_work` with the task id and the branch you pushed, plus');
    lines.push('   `testingPaths` naming the screens you changed. Usernode opens the pull');
    lines.push('   request and puts it to the group’s vote.');
    return lines.join('\n');
  }

  function stepHtml(n, title, body) {
    return ''
      + '<div class="dc-launchpad-step">'
      + '<div class="dc-launchpad-step-mark" aria-hidden="true">' + escapeHtml(String(n)) + '</div>'
      + '<div class="dc-launchpad-step-body">'
      + '<div class="dc-launchpad-step-title">' + escapeHtml(title) + '</div>'
      + body
      + '</div>'
      + '</div>';
  }

  // A copyable block. The text is carried in a data attribute as well as
  // rendered, so the copy button hands over exactly what is on screen and
  // never a re-derived string that could have drifted from it.
  function copyBlockHtml(text, label, key) {
    return ''
      + '<div class="dc-launchpad-copy" data-launchpad-copy-block="' + escapeHtml(key) + '">'
      + '<pre class="dc-launchpad-pre">' + escapeHtml(text) + '</pre>'
      + '<button type="button" class="dc-launchpad-copy-btn" data-launchpad-copy="'
      + escapeHtml(key) + '" data-launchpad-text="' + escapeHtml(text) + '">'
      + escapeHtml(label) + '</button>'
      + '</div>';
  }

  // ── The `own-tools-pr` launchpad ────────────────────────────────────
  //
  // `state`:
  //   origin        – window.location.origin; the connector URL is derived
  //   slug          – the app slug, for the prefill
  //   issueNumber   – created_from_issue_number, when the session has one
  //   sessionTitle  – the brief when there is no issue
  //   canImport     – false for a viewer who cannot push branches to the
  //                   app; the final step then explains instead of offering
  //                   a button that would be refused
  function ownToolsHtml(state) {
    var s = state || {};
    var connect = mcpCommand(s.origin);
    var prefill = prefillText(s);

    var importStep = s.canImport === false
      ? '<div class="dc-launchpad-step-detail">Importing a pull request needs push access to this app, '
        + 'which this account does not have. Your agent can still submit through the connector — '
        + '<code>submit_work</code> opens the pull request for you.</div>'
      : '<div class="dc-launchpad-step-detail">If your agent submitted through the connector it is '
        + 'already a proposal and there is nothing to do here. Import is the manual door, for a '
        + 'branch you pushed yourself.</div>'
        + '<div class="dc-launchpad-actions">'
        + '<button type="button" class="dc-launchpad-btn" data-launchpad-action="import">'
        + 'Import Feature from a PR</button>'
        + '</div>';

    return ''
      + '<div class="dc-launchpad" data-launchpad="own-tools-pr">'
      + '<div class="dc-launchpad-lead">Building with your own tools</div>'
      + '<div class="dc-launchpad-sub">There is no Usernode chat for this one — the conversation '
      + 'happens in your own agent. Usernode still opens the pull request, builds the preview '
      + 'and runs the checks.</div>'
      + '<div class="dc-launchpad-steps">'
      + stepHtml(1, 'Connect your agent to Usernode',
        '<div class="dc-launchpad-step-detail">Adds the Usernode MCP connector, so your agent can '
        + 'read this app and submit work as you. Any MCP-capable agent can use the same URL.</div>'
        + copyBlockHtml(connect, 'Copy command', 'connect'))
      + stepHtml(2, 'Tell your agent what to build',
        '<div class="dc-launchpad-step-detail">Paste this into your agent. It carries this '
        + 'session’s brief and the two connector calls that bracket the job.</div>'
        + copyBlockHtml(prefill, 'Copy instructions', 'prefill'))
      + stepHtml(3, 'Bring the result back', importStep)
      + '</div>'
      + '</div>';
  }

  // One delegated click handler per mounted node, idempotent so repeated
  // renders never stack handlers — the same guard CreditOptions and
  // DevFlowSelect use.
  //
  // `handlers`:
  //   onCopy(key, text, button) – a copy button; the module does not touch
  //                               the clipboard itself, because the caller
  //                               owns the toast and the "Copied." swap
  //   onAction(action, button)  – 'import'
  function wire(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__launchpadWired) return;
    root.__launchpadWired = true;
    var h = handlers || {};
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-launchpad-copy],[data-launchpad-action]')
        : null;
      if (!target || !root.contains(target)) return;

      var copy = target.getAttribute('data-launchpad-copy');
      if (copy) {
        event.preventDefault();
        if (typeof h.onCopy === 'function') {
          h.onCopy(copy, target.getAttribute('data-launchpad-text') || '', target);
        }
        return;
      }
      var action = target.getAttribute('data-launchpad-action');
      if (!action) return;
      event.preventDefault();
      if (typeof h.onAction === 'function') h.onAction(action, target);
    });
  }

  var Launchpad = {
    LAUNCHPAD_VENUES: LAUNCHPAD_VENUES,
    isLaunchpad: isLaunchpad,
    connectorUrl: connectorUrl,
    mcpCommand: mcpCommand,
    prefillText: prefillText,
    ownToolsHtml: ownToolsHtml,
    wire: wire,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Launchpad;
  }
  if (typeof window !== 'undefined') {
    window.Launchpad = Launchpad;
  }
}());
