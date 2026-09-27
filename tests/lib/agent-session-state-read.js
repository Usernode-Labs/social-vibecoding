'use strict';

// The agent-session store reads a conversation in ONE consistent snapshot,
// GET /api/agent-sessions/:id/state (routes/agent-sessions.js), where it used
// to read the session, its messages and its cards separately. The screen
// tests fake those three reads, each for its own case; this answers the one
// read from them, as the server does: the whole conversation (`full`), with
// no version, so every read the store makes is a whole one.
//
//   globalThis.fetch = withStateRead(async (url, init) => { ... });

function withStateRead(fetch) {
  return async (url, init = {}) => {
    const match = /^\/api\/agent-sessions\/(\d+)\/state(?:\?.*)?$/.exec(String(url));
    if (!match || (init.method && init.method !== 'GET')) return fetch(url, init);
    const id = match[1];
    const read = async (path) => {
      const response = await fetch(path, {});
      return { response, body: response && response.ok ? await response.json() : null };
    };
    const head = await read(`/api/agent-sessions/${id}`);
    if (!head.response || !head.response.ok) return head.response;
    const messages = await read(`/api/agent-sessions/${id}/messages?after=0&limit=200`);
    const actions = await read(`/api/agent-sessions/${id}/actions`);
    const session = head.body.session;
    const turn = head.body.turn || null;
    const body = {
      unchanged: false,
      version: typeof session.version === 'number' ? session.version : null,
      busy: !!session.busy || !!turn,
      turn,
      session,
      messages: (messages.body && messages.body.messages) || [],
      full: true,
      nextAfter: (messages.body && messages.body.nextAfter) || null,
      rev: null,
      actions: (actions.body && actions.body.actions) || [],
    };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  };
}

module.exports = { withStateRead };
