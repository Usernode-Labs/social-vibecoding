/* The guided walkthrough for the two web hand-off venues (#1049).
 *
 * Usernode has always had two ways to build a proposal: here on the
 * platform with the Usernode agent and your daily AI credits, or by handing
 * a work order to the coding agent you already pay for — Claude Code
 * (claude.ai/code) or Codex (chatgpt.com/codex) — which pushes a branch to
 * your own fork that Usernode turns into an ordinary proposal. The second
 * route existed only behind the MCP connector, so essentially nobody found
 * it.
 *
 * This module used to be BOTH doors: a picker card at the top of every
 * untouched session asking "how do you want to build this change?", plus
 * the walkthrough behind it. The picker is gone. It was one of three
 * prompts asking the venue question before a word had been typed, and it
 * could only offer three of the six venues that exist. The question is
 * asked once now, by public/js/build-venues.js, from the venue line above
 * the composer. What is left here is the part that has no other home: once
 * a hand-off is chosen, five steps run in place in the transcript and
 * watch the user's progress through them.
 *
 * Pure render + wire, no fetching. The caller (public/js/dev-chat.js) owns
 * the state, calls GET /api/apps/:slug/dev-flow/status, and re-renders; the
 * same split as public/js/credit-options.js, and the reason
 * tests/dev-flow-select.test.js can exercise every branch in node with no
 * DOM and no server.
 *
 * The step model is deliberately derived from the SERVER's status payload
 * rather than from anything the client remembers: closing the tab
 * mid-walkthrough and coming back must resume at the same step, and the
 * only thing that survives that is what the server can see (is GitHub
 * linked, is there a fork, is there an open task, has the branch been
 * pushed).
 */
(function () {
  'use strict';

  // Where the two hosted agents live. Same URLs the work order names in
  // services/external-agent-tasks.js — a person cannot follow "open Claude
  // Code" without them.
  var AGENT_URLS = {
    'claude-code': 'https://claude.ai/code',
    codex: 'https://chatgpt.com/codex',
  };

  // Same allowlist as DEV_FLOWS in src/routes/auth.js and the CHECK on
  // users.dev_flow_preference. tests/dev-flow-preference.test.js pins the
  // three together so a fourth flow cannot land in one place only.
  //
  // Id and venue label only. The blurbs and CTAs that used to live here
  // belonged to the PICKER card, and the picker is gone — public/js/
  // build-venues.js is the one place a venue is described to the user now,
  // and it covers three more venues than this list ever could. What stays
  // here is the allowlist, because these three ids are a persisted column's
  // domain and this module is one of the three copies that must agree.
  var FLOWS = [
    { id: 'platform', title: 'Usernode · Claude' },
    { id: 'claude-code', title: 'Claude Code on the web' },
    { id: 'codex', title: 'Codex on the web' },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function agentLabel(agent) {
    if (agent === 'claude-code') return 'Claude Code';
    if (agent === 'codex') return 'Codex';
    return 'your coding agent';
  }

  function agentUrl(agent) {
    return AGENT_URLS[agent] || '';
  }

  // Why the external flows are not on offer, in the user's words. The
  // server sends the reason code; this is the only place it becomes copy.
  function unavailableNote(reason) {
    if (reason === 'no_repository') {
      return 'This app has no GitHub repository yet, so it can only be built here on Usernode.';
    }
    if (reason === 'platform_unavailable' || reason === 'link_unavailable' || reason === 'unavailable') {
      return 'Handing work to Claude Code or Codex is unavailable on this deployment right now.';
    }
    return '';
  }

  // ── The walkthrough ──────────────────────────────────────────────────
  //
  // Five steps, each resolved to 'done' | 'current' | 'todo' from the
  // server's status payload. Exactly one step is 'current': the first one
  // that is not done. That single rule is what makes the walkthrough
  // resumable — nothing is remembered on this side.

  function steps(status, agent) {
    var st = status || {};
    var gh = st.github || {};
    var fork = st.fork || null;
    var task = st.task || null;
    var branch = st.branch || null;
    var label = agentLabel(agent || (task && task.agent));
    // #1054 + #1071. When the prepared task carries a target, this run is a
    // CONTINUATION and the last two steps say something different: the branch
    // goes back onto something that already exists, and the final press is an
    // update, not a new pull request. `targetKind` distinguishes the proposal
    // the group is voting on from the session still being built.
    var target = (task && task.targetProposal) || null;
    var targetKind = target ? (target.targetKind || 'proposal') : null;

    var list = [
      {
        key: 'github',
        title: 'Link your GitHub account',
        done: !!gh.linked,
        detail: gh.linked
          ? 'Linked as ' + (gh.login || 'your GitHub account') + '.'
          : 'Identity only — Usernode asks for no access to your repositories and stores no token. It just needs to know which GitHub account is yours, so the work comes back under your name.',
        actions: gh.linked ? [] : [{ action: 'link-github', label: 'Link GitHub', primary: true }],
      },
      {
        key: 'fork',
        title: 'Fork the app repository',
        // 'unknown' means the read failed, not that there is no fork. Treat
        // it as not-done but say so honestly rather than asserting.
        done: !!(fork && fork.state === 'ready'),
        detail: forkDetail(fork),
        actions: forkActions(fork),
      },
      {
        key: 'prepare',
        title: 'Prepare the work order',
        done: !!task,
        detail: task
          ? prepareDetail(task, target, targetKind)
          : 'Describe the change in the message box below, then Usernode writes the work order — the repository, the branch, the exact base commit and the platform rules your agent has to follow.',
        actions: task ? [] : [{ action: 'prepare', label: 'Prepare work order', primary: true }],
      },
      {
        key: 'handoff',
        title: 'Hand it to ' + label,
        done: !!(branch && branch.pushed),
        detail: handoffDetail(branch, task, label, targetKind),
        actions: task ? handoffActions(agent || task.agent) : [],
      },
      {
        key: 'submit',
        title: target ? 'Submit the update' : 'Submit for review',
        done: false,
        detail: branch && branch.pushed
          ? submitDetail(targetKind)
          : 'Available once your branch is pushed.',
        actions: branch && branch.pushed
          ? [target
            ? { action: 'submit-update', label: 'Submit the update', primary: true }
            : { action: 'submit', label: 'Submit for review', primary: true }]
          : [],
      },
    ];

    var currentSeen = false;
    return list.map(function (step) {
      var state = 'todo';
      if (step.done) {
        state = 'done';
      } else if (!currentSeen) {
        state = 'current';
        currentSeen = true;
      }
      return {
        key: step.key,
        title: step.title,
        state: state,
        detail: step.detail,
        // Only the step you are on offers buttons: three live "Check again"
        // buttons down the card is noise, and acting on a later step out of
        // order just produces an error the user did not need to see.
        actions: state === 'current' ? step.actions : [],
      };
    });
  }

  function shortSha(sha) {
    return String(sha || '').slice(0, 7) || 'the base commit';
  }

  function forkDetail(fork) {
    if (!fork) return 'Your agent needs somewhere to push. Usernode checks GitHub for your fork of this app.';
    if (fork.state === 'ready') return 'Found ' + fork.owner + '/' + fork.repo + '.';
    if (fork.state === 'name_conflict') {
      return 'You already own a repository called ' + fork.repo.replace(/-usernode$/, '')
        + ' that is not a fork of this app, so fork it as ' + fork.repo + ' instead.';
    }
    if (fork.state === 'unknown') return 'Usernode could not read GitHub just now, so it cannot tell whether you have a fork. Carry on and check again in a moment.';
    return 'No fork yet. Fork the app on GitHub, then come back and check again.';
  }

  function forkActions(fork) {
    if (!fork || fork.state === 'ready') return [];
    var actions = [];
    if (fork.pageUrl) {
      actions.push({ action: 'open-fork', label: 'Fork on GitHub', href: fork.pageUrl, primary: true });
    }
    actions.push({ action: 'refresh', label: 'Check again' });
    return actions;
  }

  // Step 3's detail. The branch and base commit are the same facts either
  // way; what changes is that a continuation names WHAT it is continuing,
  // because "starting from 4f2a1c9" on its own gives no clue that this run
  // will move an existing session or proposal rather than open a new one.
  function prepareDetail(task, target, targetKind) {
    var line = 'Branch ' + (task.branch || '') + ', starting from ' + shortSha(task.baseSha) + '.';
    if (!target) return line;
    var title = target.title ? '"' + target.title + '"' : (targetKind === 'session' ? 'this session' : 'this proposal');
    return (targetKind === 'session' ? 'Continuing ' : 'Updating ') + title + '. ' + line;
  }

  // Step 5's detail. Three sentences for three consequences — the vote
  // clearing is the one people most need warning about, and a continuation of
  // an unpromoted session has no votes to clear, so saying so there would be
  // false.
  function submitDetail(targetKind) {
    if (targetKind === 'session') {
      return 'Usernode moves this session onto the commit your agent pushed. No new proposal, no new pull request — the same session, further along.';
    }
    if (targetKind === 'proposal') {
      return 'Usernode moves this proposal onto the commit your agent pushed. Its existing votes are cleared and its checks re-run, because the group would otherwise be approving code it never saw.';
    }
    return 'Usernode opens the pull request for you and imports it as a proposal you can put to a vote.';
  }

  function handoffDetail(branch, task, label, targetKind) {
    if (!task) return 'Paste the work order into ' + label + ' and let it build.';
    if (branch && branch.pushed) return 'Branch ' + task.branch + ' is pushed and ready to submit.';
    if (branch && branch.unpushed) {
      return 'Branch ' + task.branch + ' exists on your fork but is still on the base commit — it looks like the commits were made locally and never pushed.';
    }
    var base = 'Copy the work order, paste it into ' + label
      + ', and let it push branch ' + task.branch + ' to your fork. Usernode checks for the branch when you come back to this tab.';
    // The one thing that trips people up on a continuation: the agent gets
    // its own conversation over there, and this transcript will not grow.
    if (targetKind === 'session' || targetKind === 'proposal') {
      base += ' The agent talks to you in ' + label + ', not here — this transcript stays where it is until the update lands.';
    }
    return base;
  }

  function handoffActions(agent) {
    var actions = [{ action: 'copy', label: 'Copy work order', primary: true }];
    var url = agentUrl(agent);
    if (url) actions.push({ action: 'open-agent', label: 'Open ' + agentLabel(agent), href: url });
    actions.push({ action: 'refresh', label: 'Check again' });
    return actions;
  }

  function actionHtml(action, busy) {
    var cls = 'dc-pr-btn dc-flow-action' + (action.primary ? ' dc-flow-action-primary' : '');
    var attrs = ' data-flow-action="' + escapeHtml(action.action) + '"'
      + (action.href ? ' data-flow-href="' + escapeHtml(action.href) + '"' : '')
      + (busy ? ' disabled' : '');
    return '<button type="button" class="' + cls + '"' + attrs + '>'
      + escapeHtml(action.label) + '</button>';
  }

  // The walkthrough card.
  //
  // `state`:
  //   agent   – 'claude-code' | 'codex'
  //   status  – the GET /api/apps/:slug/dev-flow/status payload (null while
  //             the first request is in flight)
  //   busy    – a request is running: buttons disable, nothing re-orders
  //   error   – a failed action's message, shown in place, never a toast
  //             the user can miss
  //   notice  – transient success text ("Copied.")
  function wizardHtml(state) {
    var s = state || {};
    var agent = s.agent || (s.status && s.status.task && s.status.task.agent) || 'claude-code';
    var label = agentLabel(agent);

    if (!s.status) {
      return '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
        + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
        + '<div class="dc-flow-card-detail">Checking where you are&hellip;</div>'
        + '</div>';
    }

    if (s.status.available === false) {
      return '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
        + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
        + '<div class="dc-flow-card-detail">'
        + escapeHtml(unavailableNote(s.status.reason) || 'This flow is unavailable right now.')
        + '</div>'
        + '<div class="dc-flow-actions">'
        + actionHtml({ action: 'cancel', label: 'Build here instead', primary: true }, false)
        + '</div>'
        + '</div>';
    }

    var list = steps(s.status, agent);
    var rows = list.map(function (step, index) {
      var mark = step.state === 'done' ? '✓' : String(index + 1);
      var actions = step.actions.length
        ? '<div class="dc-flow-actions">'
          + step.actions.map(function (a) { return actionHtml(a, !!s.busy); }).join('')
          + '</div>'
        : '';
      return ''
        + '<div class="dc-flow-step dc-flow-step-' + step.state + '" data-flow-step="'
        + escapeHtml(step.key) + '" data-flow-step-state="' + step.state + '">'
        + '<div class="dc-flow-step-mark" aria-hidden="true">' + escapeHtml(mark) + '</div>'
        + '<div class="dc-flow-step-body">'
        + '<div class="dc-flow-step-title">' + escapeHtml(step.title) + '</div>'
        + '<div class="dc-flow-step-detail">' + escapeHtml(step.detail) + '</div>'
        + actions
        + '</div>'
        + '</div>';
    }).join('');

    var task = s.status.task;
    var order = task && task.workOrder
      ? '<details class="dc-flow-order"><summary>Work order</summary>'
        + '<pre class="dc-flow-order-text" data-flow-order="1">' + escapeHtml(task.workOrder) + '</pre>'
        + '</details>'
      : '';

    var connectors = s.status.connectors && s.status.connectors.count
      ? '<div class="dc-flow-card-hint">You already have ' + escapeHtml(String(s.status.connectors.count))
        + ' Claude / ChatGPT connector' + (s.status.connectors.count === 1 ? '' : 's')
        + ' connected — you can also just ask it to pick this task up.</div>'
      : '';

    return ''
      + '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
      + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
      + (s.error ? '<div class="dc-flow-error">' + escapeHtml(s.error) + '</div>' : '')
      + (s.notice ? '<div class="dc-flow-notice">' + escapeHtml(s.notice) + '</div>' : '')
      + '<div class="dc-flow-steps">' + rows + '</div>'
      + order
      + connectors
      + '<div class="dc-flow-actions dc-flow-actions-footer">'
      + actionHtml({ action: 'cancel', label: 'Build on Usernode instead' }, !!s.busy)
      + '</div>'
      + '</div>';
  }

  // One delegated click handler per mounted node, idempotent so repeated
  // renders never stack handlers (the same guard CreditOptions uses).
  //
  // `handlers`:
  //   onAction(action, button)  – a walkthrough button; 'open-fork' and
  //                               'open-agent' are handled here (they are
  //                               just links) and still reported, so the
  //                               caller can re-poll after the trip out.
  function wire(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__devFlowWired) return;
    root.__devFlowWired = true;
    var h = handlers || {};
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-flow-action]')
        : null;
      if (!target || !root.contains(target)) return;

      var action = target.getAttribute('data-flow-action');
      if (!action) return;
      event.preventDefault();
      var href = target.getAttribute('data-flow-href');
      if (href && typeof window !== 'undefined' && window.open) {
        window.open(href, '_blank', 'noopener');
      }
      if (typeof h.onAction === 'function') h.onAction(action, target);
    });
  }

  var DevFlowSelect = {
    FLOWS: FLOWS,
    AGENT_URLS: AGENT_URLS,
    agentLabel: agentLabel,
    agentUrl: agentUrl,
    unavailableNote: unavailableNote,
    steps: steps,
    wizardHtml: wizardHtml,
    wire: wire,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DevFlowSelect;
  }
  if (typeof window !== 'undefined') {
    window.DevFlowSelect = DevFlowSelect;
  }
})();
