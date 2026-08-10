/* Session and billing options — the "…" beside the credit meter (#1055).
 *
 * The dev-chat composer used to show a bare number ("limit $0.42/$20.00",
 * or "your key · 7f2c") and nothing you could do about it. Two things
 * people actually want at that moment had no entry point anywhere near it:
 *
 *   1. setting an Anthropic key when they haven't set one — the meter says
 *      the allowance is finite, but the only route to a key was the
 *      out-of-credits banner, which appears once the allowance is ALREADY
 *      spent; and
 *   2. moving this session somewhere else — onto Claude Code running on
 *      their own machine, or handing fresh work to Claude Code / Codex on
 *      the web.
 *
 * Those two are genuinely different mechanisms and the copy here must keep
 * them apart:
 *
 *   • the local CLI lease (#907) CONTINUES THIS SESSION, conversation and
 *     all. The transcript, the branch and the proposal stay exactly where
 *     they are; the turns just execute on the user's machine and their own
 *     Claude plan.
 *   • the web walkthrough (#1049 + #1071) continues this session's CODE, or
 *     starts separate work, depending on where the session is. With a
 *     target it pushes the agent's commits back onto this session's own
 *     branch (or onto the proposal the group is voting on); without one it
 *     writes an app-scoped work order that returns as its own proposal.
 *     Either way the agent's own conversation happens in Claude Code or
 *     Codex — only the local option continues the transcript.
 *
 * Everything user-visible lives in this module so the menu, its header and
 * the instructions card cannot drift from each other, exactly like
 * public/js/credit-options.js owns the out-of-credits copy. The pure
 * functions (items / headerHtml / commands / instructionsHtml) take a plain
 * state object and return data or markup, so tests/session-options.test.js
 * can pin the gating and the copy without a DOM.
 *
 * Gating is by OMISSION, never `disabled: true`: the kit's touch idiom is
 * an action sheet, which drops disabled rows entirely, so a disabled entry
 * is invisible on a phone and inert-but-present on a desktop — two
 * different products. An option this deployment can't offer is simply not
 * in the list.
 */
(function () {
  'use strict';

  var SETTINGS_HASHES = {
    apiKey: '#settings/api-key',
    localTool: '#settings/cli',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ui() {
    return (typeof window !== 'undefined' && window.PlatformUI) || null;
  }

  // ── What a web hand-off does from HERE (#1071) ─────────────────────
  //
  // Three states, and only one pair of rows shows at a time. The module
  // derives this itself rather than taking a pre-computed flag, so the one
  // place that decides is the one place the tests drive — and so the copy
  // and the target id cannot disagree.
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

  // The two web products, in menu order. Each row's tooltip is its own
  // product sentence plus the shared consequence sentence for the state the
  // session is in — the label is single-line by construction (the kit sets
  // it with textContent), so every nuance has to live in the tooltip.
  var WEB_AGENTS = [
    {
      id: 'claude-code',
      agent: 'claude-code',
      noun: 'Claude Code on the web',
      lead: 'Claude Code on the web does the work on your own Claude plan.',
    },
    {
      id: 'codex',
      agent: 'codex',
      noun: 'Codex',
      lead: 'Codex does the work on the ChatGPT plan you already pay for.',
    },
  ];

  // The verb, and the consequence sentence behind it. Keyed on the three-way
  // state above plus — for a session — whether it is paused, which changes
  // ONLY the tooltip: the labels are byte-identical for `active` and
  // `paused` on purpose, so one selector assertion covers both fixtures and
  // the two cases cannot drift apart in the menu.
  function webVerb(kind) {
    if (kind === 'session') return 'Continue this session with ';
    if (kind === 'proposal') return 'Continue this proposal with ';
    return 'Start new work with ';
  }

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

  // The menu rows, in order. `state`:
  //   hasApiKey, keyLast4          — GET /api/auth/me, mirrored on Settings
  //   cliAuthEnabled               — deployment offers /api/cli/* at all
  //   externalFlowsAvailable       — deployment can offer the web hand-offs
  //   localAgent {label, leaseId, demo}  — a machine holds this session's lease
  //   sessionId, repoUrl           — interpolated into the instructions card
  //   sessionStatus, hasBranch     — DevChat.currentSession's status and
  //                                  branch_name: what the web rows say and
  //                                  whether they carry a target (#1071)
  //
  // Each row carries `kind`, which is what the caller switches on:
  //   'navigate'      → go to `hash` (a real Settings section, so the device
  //                     back gesture returns to the chat)
  //   'instructions'  → open the CLI card (openInstructions below)
  //   'hand-back'     → release the lease, turns come back to Usernode
  //   'flow'          → start the #1049 walkthrough for `agent`, against
  //                     `targetId` when there is something to continue
  function items(state) {
    var s = state || {};
    var out = [];

    // Always offered, both ways round. limits.loadUserApiKey treats a
    // decrypt failure as "no key on file", so someone WITH a saved key can
    // still be billed against the allowance — "Set" vs "Change" is the only
    // honest way to label it, and the last-4 proves which key is on file.
    var last4 = s.keyLast4 ? String(s.keyLast4) : null;
    out.push({
      id: 'api-key',
      kind: 'navigate',
      hash: SETTINGS_HASHES.apiKey,
      label: s.hasApiKey
        ? (last4 ? 'Change your API key (…' + last4 + ')' : 'Change your API key')
        : 'Set your Anthropic API key',
      title: s.hasApiKey
        ? 'Billing is limit-first: your daily platform allowance is spent before anything reaches your own key. Open Settings → API key to replace or remove the key on file.'
        : 'Add your own Anthropic API key and work carries on past the daily allowance, billed to your Anthropic account. The allowance is still spent first.',
    });

    if (s.localAgent) {
      // The lease exists, so the CLI instructions would be advice for a
      // thing already done. Offer the way OUT instead — and from the
      // browser, because the machine holding the lease may be the one that
      // was closed without detaching.
      var machine = s.localAgent.label || 'your machine';
      out.push({
        id: 'hand-back',
        kind: 'hand-back',
        destructive: true,
        label: 'Stop running on ' + machine,
        title: machine + ' stops receiving turns for this session and Usernode takes them again. Anything it already committed stays on the branch.',
      });
    } else if (s.cliAuthEnabled !== false) {
      out.push({
        id: 'local-cli',
        kind: 'instructions',
        label: 'Run this session on your computer',
        title: 'Keep this session exactly where it is — same transcript, same branch, same proposal — but run its turns through Claude Code on your own machine and your own Claude plan.',
      });
    }

    // #1049 + #1071. What the walkthrough DOES depends on where this session
    // is, so the labels change with it — in a session still being built, or
    // a proposal the group is voting on, "start new work" is almost never
    // what someone means, so the continue pair REPLACES it rather than
    // sitting beside it. `targetId` is the session the agent's commits land
    // on, or null when the hand-off genuinely starts something separate.
    if (s.externalFlowsAvailable) {
      var kind = webTargetKind(s);
      var paused = String(s.sessionStatus || '') === 'paused';
      var verb = webVerb(kind);
      var note = webNote(kind, paused);
      var targetId = kind === 'new' ? null : (s.sessionId == null ? null : s.sessionId);
      WEB_AGENTS.forEach(function (web) {
        out.push({
          id: web.id,
          kind: 'flow',
          agent: web.agent,
          targetKind: kind,
          targetId: targetId,
          label: verb + web.noun,
          title: web.lead + ' ' + note,
        });
      });
    }

    return out;
  }

  // The popover's rich header (the touch action sheet falls back to the
  // plain title — same split as home.js's card menu). Item labels are set
  // with textContent by the kit, so they are single-line by construction;
  // anything that needs a second sentence goes here or in the row's title.
  function headerHtml(state) {
    var s = state || {};
    var lines = [];
    if (s.hasApiKey) {
      lines.push(
        'Your daily platform allowance is spent first; your own key ('
        + escapeHtml('…' + (s.keyLast4 || '••••'))
        + ') takes over once it runs out.'
      );
    } else {
      lines.push('Work is billed to your daily platform allowance, which resets at midnight UTC.');
    }
    if (s.localAgent) {
      lines.push('Turns are running on ' + escapeHtml(s.localAgent.label || 'your machine') + '.');
    }
    return '<div class="dc-options-title">Session and billing options</div>'
      + lines.map(function (line) {
        return '<div class="dc-options-line">' + line + '</div>';
      }).join('');
  }

  // ── The "run it on your computer" card ────────────────────────────
  //
  // Three commands, in the order they are run. The repo URL is the app's
  // own; with none known the clone line names the checkout generically
  // rather than emitting a broken command.
  function commands(state) {
    var s = state || {};
    var sessionId = s.sessionId == null ? '<session-id>' : String(s.sessionId);
    var repoUrl = s.repoUrl ? String(s.repoUrl) : null;
    return [
      repoUrl ? 'git clone ' + repoUrl : '# clone this app’s repository, then cd into it',
      'node ./tools/social-vibecoding login',
      'node ./tools/social-vibecoding agent run --session ' + sessionId,
    ];
  }

  function instructionsHtml(state) {
    var s = state || {};
    var cmdText = commands(s).join('\n');
    return ''
      + '<div class="dc-options-card w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col max-h-[85vh]">'
      + '  <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">'
      + '    <h2 class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Run this session on your computer</h2>'
      + '    <button type="button" id="dc-options-close" class="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-500/10" aria-label="Close">'
      + '      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
      + '    </button>'
      + '  </div>'
      + '  <div class="px-4 py-3 overflow-y-auto">'
      + '    <p class="text-xs text-zinc-600 dark:text-zinc-300">This session stays right here — same transcript, same branch, same proposal. Its turns just run through Claude Code on your machine, on your own Claude plan, and each one asks in your terminal before it starts.</p>'
      + '    <pre id="dc-options-commands" class="mt-3 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-3 text-[0.7rem] leading-relaxed font-mono whitespace-pre-wrap break-words select-text text-zinc-700 dark:text-zinc-300">'
      + escapeHtml(cmdText)
      + '</pre>'
      + '    <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Usernode still opens the pull request, builds the preview and runs the checks. Hand the turns back to Usernode at any time from the same ⋯ menu.</p>'
      + '  </div>'
      + '  <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">'
      + '    <button type="button" id="dc-options-copy" class="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-500/10">Copy commands</button>'
      + '  </div>'
      + '</div>';
  }

  // Present the card. Kit path draws the modal chrome (fade + scale,
  // backdrop tap / Escape dismiss); without a kit we mount our own
  // overlay, the same two-path shape public/js/build-log.js uses.
  function openInstructions(opts) {
    var o = opts || {};
    if (typeof document === 'undefined') return null;
    var state = o.state || {};
    var overlay = document.createElement('div');
    overlay.id = 'dc-options-overlay';
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4';
    overlay.innerHTML = instructionsHtml(state);
    var panel = overlay.firstElementChild;
    var kit = ui();
    var handle = null;
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      if (handle && typeof handle.dismiss === 'function') handle.dismiss();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      if (typeof o.onClose === 'function') o.onClose();
    }

    var keyHandler = null;
    if (kit && kit.hasKit()) {
      panel.classList.add('platform-modal-card');
      handle = kit.modal({
        contentEl: panel,
        onDismiss: function () {
          handle = null;
          close();
        },
      });
      if (handle && handle.el) handle.el.style.width = 'min(576px, calc(100vw - 32px))';
    }
    if (!handle) {
      overlay.addEventListener('pointerdown', function (event) {
        if (event.target === overlay) close();
      });
      document.body.appendChild(overlay);
      keyHandler = function (event) { if (event.key === 'Escape') close(); };
      document.addEventListener('keydown', keyHandler);
    }

    var closeBtn = panel.querySelector('#dc-options-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var copyBtn = panel.querySelector('#dc-options-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = commands(state).join('\n');
        var done = function (ok) {
          copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
          setTimeout(function () { copyBtn.textContent = 'Copy commands'; }, 1500);
        };
        if (kit && typeof kit.copyText === 'function') {
          kit.copyText(text).then(done);
          return;
        }
        done(false);
      });
    }

    return { dismiss: close, el: panel };
  }

  // ── The menu itself ───────────────────────────────────────────────
  //
  // `opts`: { anchorEl, state, onNavigate, onInstructions, onHandBack,
  //           onFlow }. Returns the kit's menu promise (with .dismiss())
  //           or null when there is nothing to show / no kit to show it in.
  function open(opts) {
    var o = opts || {};
    var state = o.state || {};
    var list = items(state);
    if (!list.length) return null;
    var kit = ui();
    if (!kit || !kit.hasKit()) {
      // No kit means no menu idiom at all. Falling back to the API-key
      // section keeps the button from being a dead control — that is the
      // row the issue is really about, and it is the only one that is
      // always present.
      if (typeof o.onNavigate === 'function') o.onNavigate(SETTINGS_HASHES.apiKey);
      return null;
    }

    var headerEl = null;
    if (typeof document !== 'undefined') {
      headerEl = document.createElement('div');
      headerEl.className = 'dc-options-header';
      headerEl.innerHTML = headerHtml(state);
    }

    function run(item) {
      if (item.kind === 'navigate') {
        if (typeof o.onNavigate === 'function') o.onNavigate(item.hash);
        else if (typeof window !== 'undefined') window.location.hash = item.hash;
        return;
      }
      if (item.kind === 'instructions') {
        if (typeof o.onInstructions === 'function') o.onInstructions(state);
        else openInstructions({ state: state });
        return;
      }
      if (item.kind === 'hand-back') {
        if (typeof o.onHandBack === 'function') o.onHandBack();
        return;
      }
      if (item.kind === 'flow') {
        if (typeof o.onFlow === 'function') o.onFlow(item.agent, item.targetId);
      }
    }

    return kit.menu({
      anchorEl: o.anchorEl || undefined,
      title: 'Session and billing options',
      headerEl: headerEl || undefined,
      items: list.map(function (item) {
        return {
          label: item.label,
          destructive: !!item.destructive,
          title: item.title,
          handler: function () { run(item); },
        };
      }),
    });
  }

  var SessionOptions = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    items: items,
    webTargetKind: webTargetKind,
    headerHtml: headerHtml,
    commands: commands,
    instructionsHtml: instructionsHtml,
    openInstructions: openInstructions,
    open: open,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionOptions;
  }
  if (typeof window !== 'undefined') {
    window.SessionOptions = SessionOptions;
  }
}());
