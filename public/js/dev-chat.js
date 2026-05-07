// localStorage key for the user's last-chosen model. Single global
// key (not per-app/per-session) so the preference is sticky wherever
// the user goes — nobody wants "I set Opus here, but the next app
// reset me back to Sonnet".
const MODEL_STORAGE_KEY = 'usernode:dc:model';

function loadStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

const DevChat = {
  sessions: [],
  currentSession: null,
  messages: [],
  isStreaming: false,
  selectedModel: loadStoredModel() || 'claude-sonnet-4-6',
  _staleTimer: null,
  _abortController: null,
  // Most recent event _seq we've processed across any channel (POST SSE,
  // resumable EventSource, global WS). Used as the replay cursor when we
  // (re)open the resumable GET /events stream so the server's ring
  // buffer can backfill anything we missed during a disconnect.
  _lastSeenSeq: null,
  // Handle to the resumable EventSource, if open.
  _eventSource: null,

  budget: null,

  MODELS: {
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-opus-4-6': 'Opus 4.6',
  },

  // Guard against a persisted model id that's no longer in MODELS
  // (e.g. we removed an old model). Without this the dropdown would
  // fall back to the first option visually while `selectedModel` held
  // the stale id — so the user would see "Haiku" on screen but send
  // some ancient slug on submit. Called right after module load.
  _sanitizeStoredModel() {
    if (!DevChat.MODELS[DevChat.selectedModel]) {
      DevChat.selectedModel = 'claude-sonnet-4-6';
    }
  },

  // Clears all per-app state. Called when the user leaves an app (via
  // `AppView.close()`), so that opening another app and switching to the
  // dev chat tab shows a fresh session list instead of re-rendering the
  // previous app's session.
  reset() {
    DevChat.sessions = [];
    DevChat.currentSession = null;
    DevChat.messages = [];
    DevChat.isStreaming = false;
    DevChat._staleTimer = null;
    DevChat._lastSeenSeq = null;
    if (DevChat._abortController) {
      try { DevChat._abortController.abort(); } catch {}
      DevChat._abortController = null;
    }
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  async refreshBudget() {
    try {
      const res = await fetch('/api/budget');
      if (res.ok) DevChat.budget = await res.json();
    } catch {}
    DevChat.renderBudget();
  },

  renderBudget() {
    const el = document.getElementById('dc-budget');
    if (!el) return;
    // BYOK (#30): when the user has supplied their own Anthropic key,
    // show that instead of the shared daily cap — it's irrelevant to
    // them, and the indicator doubles as a reminder that the shared
    // budget no longer applies to this session's cost.
    if (window.Settings?.state?.hasApiKey) {
      const last4 = window.Settings.state.keyLast4 || '••••';
      el.innerHTML = `<span class="text-emerald-400" title="Using your Anthropic API key">your key · ${last4}</span>`;
      return;
    }
    if (!DevChat.budget) return;
    const spent = (DevChat.budget.spentCents / 100).toFixed(2);
    const limit = (DevChat.budget.limitCents / 100).toFixed(2);
    const pct = Math.min(100, (DevChat.budget.spentCents / DevChat.budget.limitCents) * 100);
    const color = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-400' : 'text-emerald-400';
    el.innerHTML = `<span class="${color}">$${spent}</span><span class="text-zinc-600">/$${limit}</span>`;
  },

  async loadSessions(appSlug) {
    try {
      const res = await fetch(`/api/apps/${appSlug}/sessions`);
      if (!res.ok) return;
      const { sessions } = await res.json();
      DevChat.sessions = sessions;
    } catch {}
  },

  async createSession(appSlug) {
    try {
      const res = await fetch(`/api/apps/${appSlug}/sessions`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create session');
        return null;
      }
      DevChat.sessions.unshift(data.session);
      return data.session;
    } catch {
      alert('Network error');
      return null;
    }
  },

  async openSession(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return;
      const { session, messages } = await res.json();
      DevChat.currentSession = session;
      DevChat.messages = messages.map((m) => {
        if (m.metadata) {
          if (m.metadata.stagingUrl) m.stagingUrl = m.metadata.stagingUrl;
          if (m.metadata.ccLog) m.ccLog = m.metadata.ccLog;
          if (m.metadata.ccOutput) m.ccOutput = m.metadata.ccOutput;
          if (m.metadata.ccSummary) m.ccSummary = m.metadata.ccSummary;
          if (m.metadata.progressLog) m.progressLog = m.metadata.progressLog;
        }
        return m;
      });

      // Check if Claude Code is running for this session
      try {
        const statusRes = await fetch(`/api/sessions/${sessionId}/status`);
        if (statusRes.ok) {
          const { busy, progress, phase } = await statusRes.json();
          if (busy) {
            DevChat.isStreaming = true;
            DevChat._setStreamingUI(true, phase || null);
            // Reuse the most recent persisted progress message as the live
            // append target so the polling fallback updates IT instead of
            // creating a second "Claude Code output (N lines)" collapsible.
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role === 'system' && m.progressLog) { m._progress = true; break; }
            }
            // `_active` is a client-only flag that swaps the static gear
            // glyph for the arc spinner, so on refresh mid-run the latest
            // status line ("Claude Code is making changes…") needs it
            // re-applied. Pick the newest system message that isn't a
            // finalized artefact (ccOutput / progressLog / stagingUrl /
            // ccLog) — those are terminal, not in-flight.
            for (let i = DevChat.messages.length - 1; i >= 0; i--) {
              const m = DevChat.messages[i];
              if (m.role !== 'system') continue;
              if (m.ccOutput || m.progressLog || m.stagingUrl || m.ccLog) continue;
              m._active = true;
              break;
            }
            // Hook into the resumable event stream so we get *live*
            // updates from this tab (tokens, status transitions, PR
            // created, etc.) instead of only what the 3s polling can
            // reconstruct from the DB. Polling stays on as a safety net.
            DevChat._openResumableStream(sessionId);
            DevChat._startProgressPolling(sessionId, progress);
          }
        }
      } catch {}
    } catch {}
  },

  // ── Streaming + send ─────────────────────────────────────

  async sendMessage(message) {
    if (!DevChat.currentSession || DevChat.isStreaming) return;
    const model = DevChat.selectedModel;
    DevChat.isStreaming = true;
    DevChat._setStreamingUI(true);
    DevChat._seenSeqs = new Set();

    // A previous turn's progress message may still be flagged as the live
    // append target. Clear it so this turn's cc_progress events create a
    // fresh collapsible instead of appending to the prior turn's log.
    for (const m of DevChat.messages) {
      if (m._progress) m._progress = false;
    }

    DevChat.messages.push({ role: 'user', content: message, created_at: new Date().toISOString() });
    // `let`, not `const`: the `assistant_message_end` handler reassigns this
    // to a fresh object when the Mayor seals phase-1 so the phase-2 wrap-up
    // lands in its own bubble. A `const` here used to throw silently inside
    // the per-event try/catch, leaving the phase-2 tokens appended onto the
    // phase-1 object and causing the second bubble to show phase-1 text.
    let assistantMsg = { role: 'assistant', content: '', created_at: null };
    let assistantPushed = false;
    DevChat.renderMessages();
    DevChat._showSpinner();
    DevChat.scrollToBottom();

    DevChat._abortController = new AbortController();

    try {
      const res = await fetch(`/api/sessions/${DevChat.currentSession.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model }),
        signal: DevChat._abortController.signal,
      });

      if (res.status === 429) {
        const data = await res.json();
        DevChat._removeSpinner();
        DevChat.messages.push({ role: 'assistant', content: `**Rate limit reached.** ${data.error || 'Try again later.'}`, created_at: new Date().toISOString() });
        DevChat.renderMessages();
        DevChat._finishStreaming();
        return;
      }

      // Any other non-2xx response (404 missing/archived session, 400 bad
      // input, 500 server error, …) returns JSON, not SSE. Surface it as
      // an assistant error message and tear down the streaming UI so we
      // don't sit on the spinner forever or kick off resumable-SSE +
      // status polling against a session that was never going to stream.
      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errText = data.error;
        } catch {}
        DevChat._removeSpinner();
        // Drop the optimistic user message — it was never persisted, and
        // leaving it in the list while the spinner disappears is what the
        // user perceived as "my message disappears".
        const lastIdx = DevChat.messages.length - 1;
        if (lastIdx >= 0 && DevChat.messages[lastIdx].role === 'user' && !DevChat.messages[lastIdx].id) {
          DevChat.messages.splice(lastIdx, 1);
        }
        DevChat.messages.push({
          role: 'assistant',
          content: `**Couldn't send message:** ${errText}`,
          created_at: new Date().toISOString(),
        });
        DevChat.renderMessages();
        DevChat._finishStreaming();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotFirstToken = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data._seq && DevChat._seenSeqs?.has(data._seq)) continue;
            if (data._seq) { DevChat._seenSeqs?.add(data._seq); DevChat._lastSeenSeq = data._seq; }
            switch (data.type) {
              case 'token':
                if (!gotFirstToken) { DevChat._removeSpinner(); gotFirstToken = true; }
                assistantMsg.content += data.text;
                if (!assistantPushed) {
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                  DevChat.renderMessages();
                } else {
                  // Update in place — don't re-render entire list on each token
                  const displayContent = assistantMsg.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
                  const msgEls = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
                  const lastEl = msgEls[msgEls.length - 1];
                  if (lastEl) lastEl.innerHTML = DevChat.renderMarkdown(displayContent);
                }
                DevChat.scrollToBottom();
                break;
              case 'done':
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'phase':
                DevChat._setStreamingUI(true, data.phase);
                break;
              case 'stopped':
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.renderMessages();
                DevChat._finishStreaming();
                reader.cancel();
                break;
              case 'assistant_message_end':
                // Mayor's first turn just finished (typically followed by
                // a tool dispatch → CC progress → Mayor wrap-up). Seal
                // the current bubble so the wrap-up tokens land in a
                // fresh one below the status/progress system messages.
                if (assistantMsg) assistantMsg._finalized = true;
                assistantPushed = false;
                assistantMsg = { role: 'assistant', content: '', created_at: new Date().toISOString() };
                break;
              case 'status':
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'staging_ready':
                DevChat._removeSpinner();
                DevChat._deactivateLastStatus();
                DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                if (data.url) {
                  DevChat.currentSession.staging_url = data.url;
                }
                break;
              case 'pr_created':
              case 'pr_updated':
                if (DevChat.currentSession) {
                  if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
                  if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
                  if (data.prTitle) DevChat.currentSession.pr_title = data.prTitle;
                  // Re-render so the new title shows up in the PR card / header
                  // immediately (these only re-render on renderChatView / message
                  // pushes, not on raw event arrival).
                  DevChat.renderChatView();
                }
                break;
              
              case 'mayor_reasoning': {
                // Server sends the full raw Mayor output after the token
                // stream completes. This is authoritative: even if individual
                // token events were lost in transit (e.g. an older WS-dedup
                // race), we recover the full text here. The raw content —
                // including any [CHAT_ONLY] prefix — is stored on the live
                // assistant message so renderMessages() can show a "Mayor
                // reasoning" collapsible both during streaming and after
                // refresh.
                if (!data.text) break;
                if (!assistantPushed) {
                  assistantMsg.content = data.text;
                  assistantMsg.created_at = new Date().toISOString();
                  DevChat.messages.push(assistantMsg);
                  assistantPushed = true;
                } else if (assistantMsg.content.length < data.text.length) {
                  assistantMsg.content = data.text;
                }
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              }
              case 'cc_progress': {
                DevChat._appendProgressLine(data.text);
                DevChat.scrollToBottom();
                // Start /status polling as a fallback in case the SSE stream
                // or the global WS drops before we receive the 'done' event.
                // The first cc_progress tells us a worker is actually running
                // (vs. a CHAT_ONLY reply that never dispatches one), so we
                // only arm the fallback here to avoid prematurely concluding
                // a chat-only turn is "finished".
                if (!DevChat._progressPollTimer && DevChat.currentSession) {
                  DevChat._startProgressPolling(DevChat.currentSession.id, []);
                }
                break;
              }
              case 'cc_log':
                DevChat.messages.push({ role: 'system', ccLog: data.log, content: 'Claude Code log', created_at: new Date().toISOString() });
                DevChat.renderMessages();
                DevChat.scrollToBottom();
                break;
              case 'error':
                DevChat._removeSpinner();
                assistantMsg.content += `\n\n> **Error:** ${data.error}`;
                DevChat.renderMessages();
                break;
              case 'usage':
                assistantMsg.model = data.model;
                assistantMsg.costCents = data.costCents;
                DevChat.refreshBudget();
                break;
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        DevChat._removeSpinner();
      }
    }

    // The primary POST SSE either drained to 'done' (which already called
    // _finishStreaming and set isStreaming = false) or it died early.
    // In the latter case, recover via two parallel fallbacks:
    //
    //   1. The resumable GET /events SSE — same server, replays from our
    //      last seen _seq via EventSource's built-in Last-Event-Id retry.
    //      This is the *live* recovery path; it keeps the UI feeling
    //      real-time across network blips, proxy idle-kills, and WS
    //      reconnect churn.
    //
    //   2. /status polling — covers the worst case where the Node
    //      process restarted and the in-memory ring buffer is gone. The
    //      on-disk progressLog is still authoritative, and the poll
    //      flips busy=false to finalize the UI when the run completes.
    if (DevChat.isStreaming && DevChat.currentSession) {
      DevChat._openResumableStream(DevChat.currentSession.id);
      if (!DevChat._progressPollTimer) {
        DevChat._startProgressPolling(DevChat.currentSession.id, []);
      }
    }
  },

  _finishStreaming() {
    DevChat.isStreaming = false;
    DevChat._abortController = null;
    DevChat._stopProgressPolling();
    DevChat._closeResumableStream();
    DevChat._lastSeenSeq = null;
    DevChat._setStreamingUI(false);
    DevChat.renderMessages();
    DevChat.refreshBudget();
  },

  // Open (or reopen) the resumable GET /events SSE for the active session.
  // EventSource handles reconnect automatically and sends Last-Event-Id on
  // each retry, which the server uses to replay missed events from its
  // per-session ring buffer. On the first connect we also pass `?since=`
  // explicitly so we can replay events that were already delivered over
  // the primary POST SSE but lost mid-stream.
  _openResumableStream(sessionId) {
    if (typeof EventSource === 'undefined') return;
    if (DevChat._eventSource) return;
    const since = DevChat._lastSeenSeq;
    const url = since
      ? `/api/sessions/${sessionId}/events?since=${encodeURIComponent(since)}`
      : `/api/sessions/${sessionId}/events`;
    let es;
    try { es = new EventSource(url); } catch { return; }
    DevChat._eventSource = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        DevChat._handleResumedEvent(data);
      } catch {}
    };
    es.onerror = () => {
      // EventSource silently auto-retries. If the browser closes it for
      // good (readyState === CLOSED), drop our reference so a later
      // cc_progress or drop-detection can open a fresh one. Progress
      // polling is the last-resort fallback in that window.
      if (es.readyState === 2 /* CLOSED */ && DevChat._eventSource === es) {
        DevChat._eventSource = null;
      }
    };
  },

  _closeResumableStream() {
    if (DevChat._eventSource) {
      try { DevChat._eventSource.close(); } catch {}
      DevChat._eventSource = null;
    }
  },

  // Handle an event arriving on the *resumable* channel (either the
  // GET /events EventSource opened after a POST SSE drop, or a later
  // retry of same). The closure-local state from sendMessage's POST SSE
  // loop (assistantMsg / assistantPushed / gotFirstToken) is no longer
  // reachable here — instead we locate the live assistant message by
  // scanning DevChat.messages, and create one if the run ended up with
  // no tokens before the drop.
  _handleResumedEvent(data) {
    if (data._seq) {
      if (DevChat._seenSeqs?.has(data._seq)) return;
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      DevChat._lastSeenSeq = data._seq;
    }
    const lastAssistantMsg = () => {
      for (let i = DevChat.messages.length - 1; i >= 0; i--) {
        if (DevChat.messages[i].role === 'assistant') return DevChat.messages[i];
      }
      return null;
    };
    switch (data.type) {
      case 'token': {
        DevChat._removeSpinner();
        let am = lastAssistantMsg();
        // No assistant message yet for this turn → push a fresh one.
        // The user message is already in DevChat.messages so insertion
        // order is correct.
        if (!am || am._finalized) {
          am = { role: 'assistant', content: '', created_at: new Date().toISOString() };
          DevChat.messages.push(am);
          DevChat.renderMessages();
        }
        am.content += data.text;
        const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
        const els = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
        const el = els[els.length - 1];
        if (el) el.innerHTML = DevChat.renderMarkdown(displayContent);
        DevChat.scrollToBottom();
        break;
      }
      case 'mayor_reasoning': {
        if (!data.text) break;
        let am = lastAssistantMsg();
        // Once an assistant bubble is sealed (_finalized, via
        // assistant_message_end), a fresh mayor_reasoning belongs to
        // the *next* bubble — otherwise we'd overwrite phase-1's text
        // with phase-2's wrap-up when replaying on reconnect.
        if (!am || am._finalized) {
          DevChat.messages.push({ role: 'assistant', content: data.text, created_at: new Date().toISOString() });
        } else if (am.content.length < data.text.length) {
          am.content = data.text;
        }
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      }
      case 'done':
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        break;
      case 'phase':
        // Server announces which phase of the turn we're in so the UI
        // can toggle between stop-button (interruptible) and spinner
        // (wrap-up). The `_setStreamingUI(true, …)` call is cheap and
        // idempotent — it just swaps the button glyph.
        DevChat._setStreamingUI(true, data.phase);
        break;
      case 'stopped': {
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        // The status system-message ("Stopped by @user.") was already
        // persisted and emitted server-side via sendStatus, so no need
        // to add another row here — just tear down the streaming UI.
        DevChat._finishStreaming();
        break;
      }
      case 'assistant_message_end': {
        // Seal the current assistant bubble so a subsequent `token`
        // event starts a fresh one (matches the primary POST-SSE path).
        const am = lastAssistantMsg();
        if (am) am._finalized = true;
        break;
      }
      case 'status':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8), _active: true });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'staging_ready':
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2, 8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url && DevChat.currentSession) DevChat.currentSession.staging_url = data.url;
        break;
      case 'pr_created':
      case 'pr_updated':
        if (DevChat.currentSession) {
          if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) DevChat.currentSession.pr_title = data.prTitle;
          DevChat.renderChatView();
        }
        break;
      case 'cc_progress':
        DevChat._appendProgressLine(data.text);
        DevChat.scrollToBottom();
        break;
      case 'cc_log':
        DevChat.messages.push({ role: 'system', ccLog: data.log, content: 'Claude Code log', created_at: new Date().toISOString() });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'error': {
        DevChat._removeSpinner();
        const am = lastAssistantMsg();
        if (am) am.content += `\n\n> **Error:** ${data.error}`;
        else DevChat.messages.push({ role: 'assistant', content: `> **Error:** ${data.error}`, created_at: new Date().toISOString() });
        DevChat.renderMessages();
        break;
      }
      case 'usage': {
        const am = lastAssistantMsg();
        if (am) { am.model = data.model; am.costCents = data.costCents; }
        DevChat.refreshBudget();
        break;
      }
    }
  },

  // Phase-aware button state (#28):
  //   - idle: "Send"
  //   - mayor1 / cc: red "Stop" button (clickable, aborts the turn)
  //   - mayor2: spinner (the wrap-up cannot be stopped because CC
  //             already pushed a commit + opened the PR)
  // A `null` phase while streaming means the client hasn't received a
  // `phase` event yet (older turn before this feature, or reconnect
  // before the first phase emit). Default to the stop affordance so the
  // user always has a way out; the server rejects the /stop request if
  // it's already in phase-2 anyway.
  _streamingPhase: null,

  _setStreamingUI(streaming, phase = null) {
    if (streaming) DevChat._streamingPhase = phase;
    else DevChat._streamingPhase = null;

    const btn = document.getElementById('dc-send-btn');
    if (!btn) return;
    if (streaming) {
      const isWrapUp = phase === 'mayor2';
      if (isWrapUp) {
        btn.disabled = true;
        btn.classList.remove('dc-btn-stop');
        btn.classList.add('dc-btn-streaming');
        btn.setAttribute('aria-label', 'Finishing up');
        btn.title = 'Finishing up…';
        btn.innerHTML = '<span class="dc-send-spinner"></span>';
      } else {
        btn.disabled = false;
        btn.classList.remove('dc-btn-streaming');
        btn.classList.add('dc-btn-stop');
        btn.setAttribute('aria-label', 'Stop');
        btn.title = 'Stop';
        btn.innerHTML = '<span class="dc-stop-icon" aria-hidden="true"></span>';
      }
    } else {
      btn.disabled = false;
      btn.classList.remove('dc-btn-streaming');
      btn.classList.remove('dc-btn-stop');
      btn.setAttribute('aria-label', 'Send');
      btn.title = 'Send';
      btn.textContent = 'Send';
    }

    const input = document.getElementById('dc-input');
    if (input) input.disabled = streaming;
  },

  async _stopCurrentTurn() {
    if (!DevChat.isStreaming || !DevChat.currentSession) return;
    if (DevChat._streamingPhase === 'mayor2') return;
    const sessionId = DevChat.currentSession.id;

    // Restore the message the user was stopping into the input so they
    // can edit + resend without retyping. We pull from the in-memory
    // messages array (most recent user row is the one they just sent)
    // rather than plumbing it through from sendMessage so this also
    // works when stop is pressed after a cross-tab reconnect.
    try {
      const input = document.getElementById('dc-input');
      if (input && !input.value.trim()) {
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          const m = DevChat.messages[i];
          if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
            input.value = m.content;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            DevChat._setDraft(sessionId, m.content);
            break;
          }
        }
      }
    } catch {}

    // Optimistically disable the stop button so double-clicks don't
    // fire two POSTs. Keep isStreaming true until the server emits
    // `stopped` — we want the status bubble to show up before the UI
    // unwinds.
    const btn = document.getElementById('dc-send-btn');
    if (btn) btn.disabled = true;
    try {
      await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    } catch (err) {
      console.warn('[dc] stop request failed', err);
      if (btn) btn.disabled = false;
    }
  },

  _showSpinner() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.id = 'dc-spinner';
    el.className = 'px-3 py-2';
    el.innerHTML = '<div class="dc-streaming-dots"><span></span><span></span><span></span></div>';
    container.appendChild(el);
  },

  _removeSpinner() {
    const el = document.getElementById('dc-spinner');
    if (el) el.remove();
  },

  _progressPollTimer: null,

  _startProgressPolling(sessionId, initialProgress) {
    DevChat._stopProgressPolling();

    // Show initial progress if any. Use replace (not append per-line) because
    // the persisted message loaded by openSession already contains these
    // lines — appending would double them up.
    if (initialProgress?.length) {
      DevChat._replaceProgressLog(initialProgress);
    }

    DevChat._progressPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const { busy, progress } = await res.json();

        if (progress?.length) {
          DevChat._replaceProgressLog(progress);
        }

        if (!busy) {
          DevChat._stopProgressPolling();
          DevChat.isStreaming = false;
          DevChat._setStreamingUI(false);
          // Reload messages to get final state
          await DevChat.openSession(sessionId);
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
      } catch {}
    }, 3000);
  },

  _stopProgressPolling() {
    if (DevChat._progressPollTimer) {
      clearInterval(DevChat._progressPollTimer);
      DevChat._progressPollTimer = null;
    }
  },

  // Live progress updates. We keep a single progress message per run, stored
  // in DevChat.messages with `_progress: true`, whose progressLog array drives
  // the "Claude Code output (N lines)" collapsible in renderMessages(). We
  // used to also inject a DOM-only "Claude Code live output" <details> via
  // _appendProgressLine, but that caused TWO collapsibles for the same turn
  // whenever SSE dropped and we fell back to polling (or the user refreshed
  // mid-run), because by then the persisted log had already been rendered
  // from the server.
  // Returns the message we should append live progress lines to. Only
  // matches messages flagged `_progress: true` so that prior turns'
  // persisted "Claude Code output (N lines)" collapsibles don't get
  // accidentally re-used as the target for a new run.
  _currentProgressMsg() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      const m = DevChat.messages[i];
      if (m.role === 'system' && m._progress) return m;
    }
    return null;
  },

  _appendProgressLine(text) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    msg.progressLog.push(text);
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  _replaceProgressLog(lines) {
    let msg = DevChat._currentProgressMsg();
    const isNew = !msg;
    if (!msg) {
      msg = {
        role: 'system',
        content: 'Claude Code progress',
        progressLog: [],
        _progress: true,
        created_at: new Date().toISOString(),
        _slug: Math.random().toString(36).slice(2, 8),
      };
      DevChat.messages.push(msg);
    }
    msg.progressLog = lines.slice();
    if (isNew) DevChat.renderMessages();
    else DevChat._patchProgressDom(msg);
  },

  // Targeted DOM update so we don't rebuild the whole message list on every
  // streamed line (which would flicker and reset scroll). Falls back to a
  // full renderMessages() if the collapsible hasn't been rendered yet.
  _patchProgressDom(msg) {
    const pid = DevChat._detailsId(msg, 'progress');
    const details = document.querySelector(`#dc-messages [data-persist-id="${CSS.escape(pid)}"]`);
    if (!details) {
      DevChat.renderMessages();
      return;
    }
    const summary = details.querySelector('.dc-cc-log-toggle');
    const pre = details.querySelector('.dc-cc-log-content');
    if (summary) summary.textContent = `Claude Code output (${msg.progressLog.length} lines)`;
    if (pre) {
      pre.textContent = msg.progressLog.join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
  },

  _deactivateLastStatus() {
    for (let i = DevChat.messages.length - 1; i >= 0; i--) {
      if (DevChat.messages[i]._active) {
        DevChat.messages[i]._active = false;
        break;
      }
    }
  },

  

  async promotePR() {
    if (!DevChat.currentSession?.id) return;
    try {
      const res = await fetch(`/api/sessions/${DevChat.currentSession.id}/promote`, { method: 'POST' });
      if (res.ok) {
        DevChat.currentSession.status = 'promoted';
        DevChat.renderMessages();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to promote');
      }
    } catch {
      alert('Network error');
    }
  },

  // ── Rendering ─────────────────────────────────────────────

  

  renderMessages() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const session = DevChat.currentSession;
    container.innerHTML = DevChat.messages.map((msg) => {
      // System messages — each is a single immutable status line
      if (msg.role === 'system') {
        if (msg.ccLog) {
          const pid = DevChat._detailsId(msg, 'cclog');
          return `<details class="dc-cc-log" data-persist-id="${pid}"><summary class="dc-cc-log-toggle">Claude Code log</summary><pre class="dc-cc-log-content">${msg.ccLog.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></details>`;
        }
        if (msg.progressLog?.length) {
          const logText = msg.progressLog.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const pid = DevChat._detailsId(msg, 'progress');
          // Live streaming updates target this same element via
          // _patchProgressDom(). Previously we rendered a second,
          // DOM-only "Claude Code live output" <details> on top of this
          // one, which showed up twice whenever the persisted log was
          // already on screen (refresh mid-run, polling fallback).
          return `<details class="dc-cc-log" data-persist-id="${pid}"><summary class="dc-cc-log-toggle">Claude Code output (${msg.progressLog.length} lines)</summary><pre class="dc-cc-log-content">${logText}</pre></details>`;
        }
        if (msg.stagingUrl) {
          const stgTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
          const stgId = msg.id || msg._slug || '';
          return `
            <div class="dc-status-line"><span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span> ${msg.content} <span style="font-size:9px;opacity:0.4;margin-left:auto">${stgId} ${stgTs}</span></div>
            <div class="dc-pr-card" id="dc-pr-card">
              <div class="dc-pr-card-header">
                ${session?.pr_url ? `<a href="${session.pr_url}" target="_blank" class="dc-pr-link">PR #${session.pr_number}</a>` : '<span style="color:var(--text-muted)">Changes ready</span>'}
                ${session?.pr_title ? `<span class="dc-pr-title">${escapeHtml(session.pr_title)}</span>` : ''}
                <span style="font-size:9px;opacity:0.4;margin-left:8px">${stgId} ${stgTs}</span>
              </div>
              <div class="dc-pr-card-actions">
                <button class="dc-pr-btn dc-pr-btn-preview" onclick="AppView.swapToStaging('${msg.stagingUrl}')">Preview staging</button>
                ${session?.pr_url ? `<a href="${session.pr_url}" target="_blank" class="dc-pr-btn dc-pr-btn-preview" style="text-decoration:none">View on GitHub</a>` : ''}
                ${session?.pr_number && session?.status === 'active' ? `<button class="dc-pr-btn dc-pr-btn-promote" onclick="DevChat.promotePR()">Propose to group</button>` : ''}
                ${session?.status === 'promoted' ? '<span class="text-xs" style="color:var(--accent)">Proposed!</span>' : ''}
              </div>
            </div>`;
        }
        const sTs = msg.created_at ? new Date(msg.created_at).getTime() : '';
        const sId = msg.id || msg._slug || '';
        // While `_active`, show a CSS arc spinner (clearly rotating, unlike
        // the near-symmetric gear glyph). Once done, swap to a check mark
        // so the user can see at a glance which steps have completed.
        const iconHtml = msg._active
          ? '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>'
          : '<span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span>';
        const ccDetail = msg.ccOutput
          ? `<details class="dc-cc-log" style="margin-top:4px" data-persist-id="${DevChat._detailsId(msg, 'ccout')}"><summary class="dc-cc-log-toggle">Full Claude Code output</summary><div class="dc-msg-content" style="padding:8px 10px">${DevChat.renderMarkdown(msg.ccOutput)}</div></details>`
          : '';
        return `<div class="dc-status-line">${iconHtml} ${msg.content} <span style="font-size:9px;opacity:0.4;margin-left:auto">${sId} ${sTs}</span></div>${ccDetail}`;
      }

      // Skip truly empty assistant placeholders that exist only as the
      // streaming-target before any tokens arrived. Once content is present
      // (even if just a [CHAT_ONLY] marker with no body) we always render so
      // the user can see the reasoning collapsible.
      if (msg.role === 'assistant' && !msg.content) return '';

      const isUser = msg.role === 'user';
      const isCCOutput = (msg.model || '').startsWith('claude-code/');
      const costLabel = msg.costCents ? ` · $${(msg.costCents).toFixed(3)}` : '';
      const ts = msg.created_at ? new Date(msg.created_at).getTime() : '';
      const idLabel = msg.id ? `#${msg.id}` : '';
      const rawContent = msg.content || '';
      const hadChatOnly = /^\[CHAT_ONLY\]/i.test(rawContent);
      const content = rawContent.replace(/^\[CHAT_ONLY\]\s*/i, '');
      const displayContent = content.trim()
        ? DevChat.renderMarkdown(content)
        : `<span style="color:var(--text-muted);font-style:italic">(no visible reply — see reasoning below)</span>`;
      // For any assistant message that carried a [CHAT_ONLY] tag, surface the
      // raw output in a collapsible so nothing is ever invisibly swallowed.
      const reasoningDetail = hadChatOnly
        ? `<details class="dc-cc-log" style="margin-top:6px" data-persist-id="${DevChat._detailsId(msg, 'mayorraw')}"><summary class="dc-cc-log-toggle">Mayor reasoning (raw)</summary><pre class="dc-cc-log-content">${rawContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></details>`
        : '';

      if (isCCOutput) {
        // Extract summary (first line or paragraph) vs full details
        const lines = content.replace(/^\*\*Claude Code output:\*\*\n?/i, '').trim();
        const firstPara = lines.split('\n\n')[0] || lines.split('\n')[0];
        const hasMore = lines.length > firstPara.length + 10;
        return `
          <div class="dc-msg dc-msg-assistant">
            <div class="dc-msg-header">
              <span class="text-emerald-400">Claude Code</span>
              <span style="color:var(--text-muted);font-size:9px;opacity:0.5">${idLabel} ${ts}</span>
            </div>
            <div class="dc-msg-content">${DevChat.renderMarkdown(firstPara)}</div>
            ${hasMore ? `<details class="dc-cc-log" style="margin-top:6px" data-persist-id="${DevChat._detailsId(msg, 'ccfull')}"><summary class="dc-cc-log-toggle">Full output</summary><div class="dc-msg-content" style="padding:8px 10px">${DevChat.renderMarkdown(lines)}</div></details>` : ''}
          </div>`;
      }

      return `
        <div class="dc-msg ${isUser ? 'dc-msg-user' : 'dc-msg-assistant'}">
          <div class="dc-msg-header">
            <span class="${isUser ? 'text-violet-400' : 'text-emerald-400'}">${isUser ? 'You' : 'AI'}</span>
            ${msg.model ? `<span style="color:var(--text-muted)">${msg.model.split('-').slice(0, 2).join('-')}${costLabel}</span>` : ''}
            <span style="color:var(--text-muted);font-size:9px;opacity:0.5">${idLabel} ${ts}</span>
          </div>
          <div class="dc-msg-content">${isUser ? DevChat.renderMarkdown(content) : displayContent}</div>
          ${isUser ? '' : reasoningDetail}
        </div>`;
    }).join('');

    DevChat._applyDetailsPersistence();
  },

  // ── <details> open/closed persistence ─────────────────────
  //
  // renderMessages() blows away the DOM on every re-render, so native <details>
  // elements forget their open state. We tag each one with a stable
  // data-persist-id (scoped per-session) and round-trip its open flag through
  // localStorage so refreshing / tab-switching preserves what the user had
  // expanded (e.g. "Full Claude Code output").

  _DETAILS_KEY_PREFIX: 'dc-details-v1:',

  _detailsId(msg, kind) {
    const base = msg.id || msg._slug || (msg.created_at ? new Date(msg.created_at).getTime() : '');
    return `${base}:${kind}`;
  },

  _readDetailsState(sessionId) {
    try { return JSON.parse(localStorage.getItem(DevChat._DETAILS_KEY_PREFIX + sessionId) || '{}'); }
    catch { return {}; }
  },

  _writeDetailsState(sessionId, state) {
    try { localStorage.setItem(DevChat._DETAILS_KEY_PREFIX + sessionId, JSON.stringify(state)); }
    catch {}
  },

  _applyDetailsPersistence() {
    const sid = DevChat.currentSession?.id;
    if (!sid) return;
    const state = DevChat._readDetailsState(sid);
    document.querySelectorAll('#dc-messages [data-persist-id]').forEach((el) => {
      const key = el.dataset.persistId;
      if (state[key]) el.open = true;
      el.addEventListener('toggle', () => {
        const s = DevChat._readDetailsState(sid);
        if (el.open) s[key] = 1; else delete s[key];
        DevChat._writeDetailsState(sid, s);
      });
    });
  },

  renderMarkdown(text) {
    if (!text) return '';

    let html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks with optional filepath
    html = html.replace(/```(\w*)?:?([\w/._-]*)\n([\s\S]*?)```/g, (_, lang, path, code) => {
      const header = path
        ? `<div class="dc-code-header">${path}</div>`
        : (lang ? `<div class="dc-code-header">${lang}</div>` : '');
      return `${header}<pre class="dc-code-block"><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="dc-inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h4 class="dc-h4">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="dc-h3">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h3 class="dc-h3">$1</h3>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<div class="dc-blockquote">$1</div>');

    // Numbered lists
    html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s*/, '')}</li>`).join('');
      return `<ol class="dc-ol">${items}</ol>`;
    });

    // Bullet lists
    html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*]\s*/, '')}</li>`).join('');
      return `<ul class="dc-ul">${items}</ul>`;
    });

    // Paragraphs and line breaks
    html = html.replace(/\n\n/g, '</p><p class="dc-p">');
    html = html.replace(/\n/g, '<br>');

    return html;
  },

  _lockedToBottom: true,
  // Per-session scroll memory so that leaving the dev-chat tab and coming
  // back lands the user where they left off. Keyed by session id; each
  // entry is `{ scrollTop, lockedToBottom }`. `lockedToBottom === true`
  // means "keep following the conversation" (restore to bottom on return
  // regardless of saved scrollTop).
  _savedScrollBySession: {},

  initScrollTracking() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      DevChat._lockedToBottom = atBottom;
      if (DevChat.currentSession) {
        DevChat._savedScrollBySession[DevChat.currentSession.id] = {
          scrollTop: container.scrollTop,
          lockedToBottom: atBottom,
        };
      }
    });
    // Watch for DOM changes (collapsibles expanding, new content) and auto-scroll
    const observer = new MutationObserver(() => {
      if (DevChat._lockedToBottom) {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
  },

  // Apply a previously saved scroll position for the current session, if
  // any. Falls back to scrolling to the bottom (which is the desired
  // behavior on first entry into a session).
  //
  // We use scrollTo({ behavior: 'instant' }) rather than assigning
  // .scrollTop directly because .dc-messages-container has CSS
  // `scroll-behavior: smooth` set (so streaming messages glide nicely).
  // That CSS rule applies to .scrollTop assignments too, which would
  // otherwise turn the tab-switch restore into a multi-second animated
  // scroll from 0 → scrollHeight. 'instant' overrides the CSS just for
  // this one programmatic jump.
  restoreSessionScroll() {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    const saved = DevChat.currentSession
      ? DevChat._savedScrollBySession[DevChat.currentSession.id]
      : null;
    if (saved && !saved.lockedToBottom) {
      container.scrollTo({ top: saved.scrollTop, behavior: 'instant' });
      DevChat._lockedToBottom = false;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
      DevChat._lockedToBottom = true;
    }
  },

  scrollToBottom(force) {
    const container = document.getElementById('dc-messages');
    if (!container) return;
    if (force || DevChat._lockedToBottom) {
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
  },

  // ── Session list ──────────────────────────────────────────

  renderSessionList() {
    const container = document.getElementById('dc-session-list');
    if (!container) return;

    if (DevChat.sessions.length === 0) {
      container.innerHTML = `
        <div class="text-center px-6 py-12">
          <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-1">No dev sessions yet.</p>
          <p class="text-xs text-zinc-500 dark:text-zinc-500">
            Hit <span class="font-medium text-emerald-600 dark:text-emerald-400">+ New Session</span>
            above to ask Claude to make changes.
          </p>
        </div>`;
      return;
    }

    container.innerHTML = DevChat.sessions.map((s) => {
      const statusColor = s.status === 'active' ? 'text-emerald-400' : s.status === 'promoted' ? 'text-violet-400' : 'text-zinc-500';
      const isActive = s.status === 'active' || s.status === 'promoted';
      const date = new Date(s.created_at).toLocaleDateString();
      return `
        <div class="dc-session-item px-3 py-2 cursor-pointer hover:bg-zinc-800/50 flex items-center gap-2" data-id="${s.id}">
          <span class="text-xs ${statusColor} font-mono">${s.status}</span>
          <span class="text-sm text-zinc-300 flex-1 truncate" title="${escapeHtml(s.branch_name || '')}">${escapeHtml(s.pr_title || s.branch_name || 'Session')}</span>
          ${s.pr_url ? `<a href="${s.pr_url}" target="_blank" class="text-xs text-violet-400 hover:text-violet-300" onclick="event.stopPropagation()">PR#${s.pr_number}</a>` : ''}
          ${isActive ? `<button class="dc-archive-btn text-xs text-zinc-500 hover:text-red-400" data-id="${s.id}" onclick="event.stopPropagation()">Archive</button>` : ''}
          <span class="text-xs text-zinc-600">${date}</span>
        </div>`;
    }).join('');

    container.querySelectorAll('.dc-session-item').forEach((el) => {
      el.addEventListener('click', async () => {
        await DevChat.openSession(parseInt(el.dataset.id));
        DevChat.renderChatView();
        App.updateHash();
      });
    });

    container.querySelectorAll('.dc-archive-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.textContent = '...';
        await fetch(`/api/sessions/${btn.dataset.id}/archive`, { method: 'POST' });
        if (AppView.appData) {
          await DevChat.loadSessions(AppView.appData.slug);
          DevChat.renderSessionList();
        }
      });
    });
  },

  // ── Chat view ─────────────────────────────────────────────

  renderChatView() {
    const content = document.getElementById('dc-view');
    if (!content) return;

    // The dev-chat tab's meta strip (Edit shortcuts + sessions header)
    // takes up vertical space we want to reclaim once the user is
    // inside a chat. Hide it on session open; show it again on back.
    // Lookup is best-effort because some test harnesses mount
    // renderChatView without the surrounding tab shell.
    const meta = document.getElementById('dc-meta');

    if (!DevChat.currentSession) {
      if (meta) meta.classList.remove('hidden');
      content.innerHTML = `
        <div id="dc-session-list" class="divide-y divide-zinc-800" style="flex:1;overflow-y:auto;min-height:0"></div>`;
      DevChat.renderSessionList();
      return;
    }

    if (meta) meta.classList.add('hidden');

    const modelOptions = Object.entries(DevChat.MODELS)
      .map(([id, label]) => `<option value="${id}" ${id === DevChat.selectedModel ? 'selected' : ''}>${label}</option>`)
      .join('');

    content.innerHTML = `
      <div class="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <button id="dc-back" class="text-zinc-400 hover:text-zinc-200 text-sm">&larr;</button>
        <span class="text-xs text-zinc-400 truncate flex-1" title="${escapeHtml(DevChat.currentSession.branch_name || '')}">${escapeHtml(DevChat.currentSession.pr_title || DevChat.currentSession.branch_name || 'Session')}</span>
        ${DevChat.currentSession.pr_number ? `<button id="dc-pr-header-link" class="text-xs text-violet-400 hover:text-violet-300">PR #${DevChat.currentSession.pr_number}</button>` : ''}
      </div>
      <div id="dc-messages" class="dc-messages-container flex-1 overflow-y-auto py-2"></div>
      <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2">
        <div class="flex items-center gap-2 mb-2">
          <label class="text-xs text-zinc-500">Model:</label>
          <select id="dc-model-select" class="rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500">
            ${modelOptions}
          </select>
          <span class="flex-1"></span>
          <span id="dc-budget" class="text-xs font-mono"></span>
        </div>
        <form id="dc-form" class="flex gap-2 items-end">
          <textarea
            id="dc-input"
            rows="1"
            placeholder="Ask the AI to make changes..."
            autocomplete="off"
            class="dc-textarea flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-none"
          ></textarea>
          <button type="submit" id="dc-send-btn" class="dc-send-btn rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors shrink-0">
            Send
          </button>
        </form>
        <div class="text-xs text-zinc-600 mt-1 text-right" id="dc-shortcut-hint">
          <kbd class="dc-kbd">Ctrl</kbd>+<kbd class="dc-kbd">Enter</kbd> to send
        </div>
      </div>`;

    DevChat.renderMessages();
    DevChat.refreshBudget();
    // Attach tracker first so the scroll set below is observed, then
    // restore the session's last known position (or fall through to
    // scroll-to-bottom for a brand-new session / follow-along view).
    DevChat.initScrollTracking();
    DevChat.restoreSessionScroll();
    DevChat._setupTextareaResize();
    DevChat._setupKeyboardShortcuts();
    DevChat._restoreDraft();
    if (DevChat.isStreaming) DevChat._setStreamingUI(true);

    document.getElementById('dc-model-select').addEventListener('change', (e) => {
      DevChat.selectedModel = e.target.value;
      // Persist across refreshes + new sessions (fixes #31). Wrapped
      // in try/catch so private-mode browsers or quota errors don't
      // break the selector.
      try { localStorage.setItem(MODEL_STORAGE_KEY, e.target.value); } catch {}
    });

    const prHeaderLink = document.getElementById('dc-pr-header-link');
    if (prHeaderLink) {
      prHeaderLink.addEventListener('click', () => {
        const card = document.getElementById('dc-pr-card');
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('dc-pr-card-highlight');
          setTimeout(() => card.classList.remove('dc-pr-card-highlight'), 1500);
        }
      });
    }

    document.getElementById('dc-back').addEventListener('click', () => {
      DevChat.currentSession = null;
      DevChat.messages = [];
      DevChat.renderChatView();
      App.updateHash();
    });

    document.getElementById('dc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      // When streaming, the same button is the "Stop" affordance — so
      // a submit event means "stop this turn" rather than "send a new
      // message" (the input is disabled while streaming anyway).
      if (DevChat.isStreaming) {
        DevChat._stopCurrentTurn();
        return;
      }
      DevChat._submitFromInput();
    });
  },

  _submitFromInput() {
    const input = document.getElementById('dc-input');
    const msg = input.value.trim();
    if (!msg || DevChat.isStreaming) return;
    input.value = '';
    input.style.height = 'auto';
    if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, '');
    DevChat.sendMessage(msg);
  },

  _setupTextareaResize() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      // Persist the draft per-session so it survives both tab switches
      // (which rebuild the textarea DOM) and full page refreshes.
      if (DevChat.currentSession) DevChat._setDraft(DevChat.currentSession.id, textarea.value);
    });
  },

  // Per-session draft helpers, backed by localStorage.
  _draftKey(sessionId) {
    return `usernode:dc-draft:${sessionId}`;
  },
  _getDraft(sessionId) {
    if (!sessionId) return '';
    try { return localStorage.getItem(DevChat._draftKey(sessionId)) || ''; }
    catch { return ''; }
  },
  _setDraft(sessionId, value) {
    if (!sessionId) return;
    try {
      if (value) localStorage.setItem(DevChat._draftKey(sessionId), value);
      else localStorage.removeItem(DevChat._draftKey(sessionId));
    } catch {}
  },

  _restoreDraft() {
    if (!DevChat.currentSession) return;
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;
    const draft = DevChat._getDraft(DevChat.currentSession.id);
    if (!draft) return;
    textarea.value = draft;
    // Re-run the height calculation so the textarea opens at the right
    // size instead of collapsed.
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  },

  _setupKeyboardShortcuts() {
    const textarea = document.getElementById('dc-input');
    if (!textarea) return;

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        DevChat._submitFromInput();
      }
    });
  },
};

DevChat._sanitizeStoredModel();
