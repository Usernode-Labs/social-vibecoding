'use strict';

// #297: the "Ask AI" proposal advisor panel — a private, per-user,
// read-only conversation scoped to ONE proposal ("the Mayor in advisor
// mode"). It opens as a slide-over over the topic view, deliberately
// SEPARATE from the shared human discussion thread (_mountTopicThread)
// so the two never intermingle. It reuses the dev-chat message styling
// (dc-msg* classes) and DevChat.renderMarkdown for a consistent feel,
// and streams each turn via a one-shot SSE fetch POST (no resumable
// EventSource — these turns are short and the panel is ephemeral).
const ProposalDiscuss = {
  _kind: null,        // 'proposal' | 'gov'  (UI topic kind)
  _id: null,
  _proposal: null,
  _slug: null,
  _models: [],
  _model: null,
  _messages: [],      // { role, content, model }
  _streaming: false,
  _abort: null,

  // Map the UI topic kind to the server's proposal_kind.
  _serverKind() { return this._kind === 'gov' ? 'gov' : 'pr'; },

  async open(kind, id, proposal) {
    this._kind = kind;
    this._id = id;
    this._proposal = proposal || {};
    this._slug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug) || null;
    if (!this._slug) return;

    this._render();
    await this._loadModels();
    await this._loadHistory();
    this._renderMessages();
    this._renderModelSelect();
    const input = document.getElementById('pd-input');
    if (input) input.focus();
  },

  close() {
    if (this._abort) { try { this._abort.abort(); } catch {} this._abort = null; }
    this._streaming = false;
    const root = document.getElementById('proposal-discuss-overlay');
    if (root) root.remove();
  },

  _render() {
    const existing = document.getElementById('proposal-discuss-overlay');
    if (existing) existing.remove();

    const title = (this._proposal && (this._proposal.pr_title || this._proposal.title)) || 'this proposal';
    const root = document.createElement('div');
    root.id = 'proposal-discuss-overlay';
    root.className = 'fixed inset-0 z-[70] flex flex-col bg-black/40';
    root.innerHTML = `
      <div data-pd-backdrop class="absolute inset-0"></div>
      <div class="relative ml-auto h-full w-full max-w-xl flex flex-col bg-white dark:bg-zinc-900 shadow-2xl border-l border-zinc-200 dark:border-zinc-800">
        <div class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">✨ Ask AI</div>
            <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate">Private read-only chat about “${escapeHtml(title)}”</div>
          </div>
          <button id="pd-close" class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xl leading-none px-2" title="Close">&times;</button>
        </div>
        <div class="px-4 py-2 text-[11px] text-zinc-500 dark:text-zinc-400 bg-violet-500/5 border-b border-violet-500/10">
          This advisor can explain the proposal and weigh in — but it can't build, vote, or change anything. Only you can see this conversation.
        </div>
        <div id="pd-messages" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-3"></div>
        <div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-3">
          <div class="flex items-end gap-2">
            <textarea id="pd-input" rows="2" placeholder="Ask about this proposal…"
              class="flex-1 resize-none rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"></textarea>
            <button id="pd-send" class="shrink-0 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium disabled:opacity-50">Send</button>
          </div>
          <div class="flex items-center justify-between mt-2">
            <select id="pd-model" class="rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500"></select>
            <span class="text-[11px] text-zinc-400">Counts against your daily AI allowance</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('[data-pd-backdrop]').addEventListener('click', () => this.close());
    document.getElementById('pd-close').addEventListener('click', () => this.close());
    document.getElementById('pd-send').addEventListener('click', () => this._send());
    const input = document.getElementById('pd-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
      if (e.key === 'Escape') this.close();
    });
    const sel = document.getElementById('pd-model');
    sel.addEventListener('change', (e) => { this._model = e.target.value; });
  },

  async _loadModels() {
    if (this._models.length) return;
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        this._models = Array.isArray(data.models) ? data.models : [];
        this._model = this._model || data.default || (this._models[0] && this._models[0].id) || null;
      }
    } catch {}
  },

  _renderModelSelect() {
    const sel = document.getElementById('pd-model');
    if (!sel) return;
    sel.innerHTML = this._models.map((m) =>
      `<option value="${escapeAttr(m.id)}"${m.id === this._model ? ' selected' : ''}>${escapeHtml(m.label || m.id)}</option>`
    ).join('');
  },

  async _loadHistory() {
    this._messages = [];
    try {
      const res = await fetch(`/api/apps/${this._slug}/proposals/${this._id}/discuss?kind=${this._serverKind()}`);
      if (res.ok) {
        const data = await res.json();
        this._messages = Array.isArray(data.messages) ? data.messages : [];
      }
    } catch {}
  },

  _renderMessages() {
    const list = document.getElementById('pd-messages');
    if (!list) return;
    if (!this._messages.length) {
      list.innerHTML = `
        <div class="text-sm text-zinc-500 dark:text-zinc-400 px-1 py-6 text-center">
          Ask anything about this proposal — for example:
          <div class="mt-2 space-y-1 text-violet-500 dark:text-violet-300">
            <div>“Explain this change in plain terms.”</div>
            <div>“What could break?”</div>
            <div>“Should I vote yes?”</div>
          </div>
        </div>`;
      return;
    }
    list.innerHTML = this._messages.map((m) => this._msgHtml(m)).join('');
    this._scrollToBottom();
  },

  _msgHtml(m) {
    const isUser = m.role === 'user';
    const content = isUser
      ? escapeHtml(m.content || '').replace(/\n/g, '<br>')
      : (typeof DevChat !== 'undefined' && DevChat.renderMarkdown
          ? DevChat.renderMarkdown(m.content || '')
          : escapeHtml(m.content || '').replace(/\n/g, '<br>'));
    const who = isUser ? 'You' : 'AI advisor';
    const whoColor = isUser ? 'text-violet-400' : 'text-emerald-400';
    return `
      <div class="dc-msg ${isUser ? 'dc-msg-user' : 'dc-msg-assistant'}">
        <div class="dc-msg-header"><span class="${whoColor}">${who}</span></div>
        <div class="dc-msg-content">${content}</div>
      </div>`;
  },

  _scrollToBottom() {
    const list = document.getElementById('pd-messages');
    if (list) list.scrollTop = list.scrollHeight;
  },

  async _send() {
    if (this._streaming) return;
    const input = document.getElementById('pd-input');
    const sendBtn = document.getElementById('pd-send');
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    this._messages.push({ role: 'user', content: message });
    // Optimistic assistant bubble we stream tokens into.
    const assistant = { role: 'assistant', content: '' };
    this._messages.push(assistant);
    this._renderMessages();

    this._streaming = true;
    if (sendBtn) sendBtn.disabled = true;
    this._abort = new AbortController();

    try {
      const res = await fetch(`/api/apps/${this._slug}/proposals/${this._id}/discuss?kind=${this._serverKind()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model: this._model }),
        signal: this._abort.signal,
      });

      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try { const d = await res.json(); if (d?.error) errText = d.error; } catch {}
        assistant.content = `**Couldn't send:** ${errText}`;
        this._renderMessages();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const lastEl = () => {
        const els = document.querySelectorAll('#pd-messages .dc-msg-assistant .dc-msg-content');
        return els[els.length - 1] || null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (data.type === 'token') {
            assistant.content += data.text || '';
            const el = lastEl();
            if (el && typeof DevChat !== 'undefined' && DevChat.renderMarkdown) {
              el.innerHTML = DevChat.renderMarkdown(assistant.content);
            } else if (el) {
              el.textContent = assistant.content;
            }
            this._scrollToBottom();
          } else if (data.type === 'error') {
            assistant.content += (assistant.content ? '\n\n' : '') + `_${data.error || 'Something went wrong.'}_`;
            this._renderMessages();
          } else if (data.type === 'done') {
            reader.cancel();
            break;
          }
          // 'usage' is ignored here — spend already lands in /api/budget.
        }
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        assistant.content = assistant.content || `**Couldn't send:** ${err.message || 'network error'}`;
        this._renderMessages();
      }
    } finally {
      this._streaming = false;
      this._abort = null;
      if (sendBtn) sendBtn.disabled = false;
      this._renderMessages();
      const inp = document.getElementById('pd-input');
      if (inp) inp.focus();
    }
  },
};
