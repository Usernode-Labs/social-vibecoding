'use strict';

// An in-memory stand-in for src/services/requests.js, for unit tests of the
// routes and services that file and read requests.
//
// Requests were GitHub issues until GitHub suspended the account that filed
// them (25 Oct 2026), and these tests faked GitHub's issue API with a
// stubbed fetch. Requests are rows now; services/github.js's issue helpers
// call services/requests.js, and this replaces that module's functions with
// ones that keep everything in memory, in the same shapes.
//
//   const fake = installFakeRequests(t, { 'o/r': [{ number: 3, title: 'x' }] });
//   ... fake.filed  // every create, as { owner, repo, title, body, labels, createdBy }
//   ... fake.board('o', 'r')

const requests = require('../../src/services/requests');

const NAMES = ['appFor', 'listOpen', 'getOne', 'getRaw', 'comments', 'findByMarker', 'create',
  'setTitle', 'setBody', 'setContent', 'close', 'reopen', 'comment'];

function key(owner, repo) {
  return `${owner}/${String(repo || '').replace(/\.git$/, '')}`.toLowerCase();
}

function installFakeRequests(t, boards = {}, { firstNumber = 1, slugFor = (o, r) => r } = {}) {
  const saved = {};
  for (const n of NAMES) saved[n] = requests[n];
  const repos = new Map();
  const filed = [];
  const commented = [];
  const closed = [];
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const now = () => new Date(clock += 1000).toISOString();

  function repoState(owner, repo, create = true) {
    const k = key(owner, repo);
    if (!repos.has(k) && create) repos.set(k, { owner, repo, rows: new Map(), comments: new Map(), next: firstNumber });
    return repos.get(k) || null;
  }
  for (const [name, rows] of Object.entries(boards)) {
    const [owner, repo] = name.split('/');
    const st = repoState(owner, repo);
    for (const r of rows) {
      const at = r.updatedAt || r.createdAt || now();
      st.rows.set(r.number, {
        number: r.number, title: r.title || '', body: r.body || '', labels: r.labels || [],
        state: r.state || 'open', state_reason: null, user: r.user || null,
        createdAt: r.createdAt || at, updatedAt: at, closedAt: r.closedAt || null,
      });
      st.next = Math.max(st.next, r.number + 1);
    }
  }
  const url = (owner, repo, n) => `https://app.example.test/#app/${slugFor(owner, repo)}/dev/issues/${n}`;
  const normalized = (owner, repo, r) => ({
    number: r.number, title: r.title, body: r.body, labels: [...r.labels], createdAt: r.createdAt,
    updatedAt: r.updatedAt, htmlUrl: url(owner, repo, r.number), user: r.user, state: r.state, closedAt: r.closedAt,
  });
  const raw = (owner, repo, r) => ({
    number: r.number, title: r.title, body: r.body, state: r.state, state_reason: r.state_reason,
    labels: r.labels.map((name) => ({ name })), user: r.user ? { login: r.user } : null,
    created_at: r.createdAt, updated_at: r.updatedAt, closed_at: r.closedAt, html_url: url(owner, repo, r.number),
  });
  const missing = (n) => Object.assign(new Error(`Request #${n} not found`), { status: 404 });
  const rowOr404 = (owner, repo, n) => {
    const st = repoState(owner, repo, false);
    const r = st && st.rows.get(Number(n));
    if (!r) throw missing(n);
    return r;
  };

  Object.assign(requests, {
    async appFor(owner, repo) { return repoState(owner, repo, false) ? { id: 1, slug: slugFor(owner, repo) } : null; },
    async listOpen(owner, repo) {
      const st = repoState(owner, repo, false);
      if (!st) return { issues: [], truncatedList: false, note: 'issues unavailable' };
      const open = [...st.rows.values()].filter((r) => r.state === 'open')
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.number - a.number);
      return { issues: open.map((r) => normalized(owner, repo, r)), truncatedList: false };
    },
    async getOne(owner, repo, n) {
      const st = repoState(owner, repo, false);
      const r = st && st.rows.get(Number(n));
      return r ? { issue: normalized(owner, repo, r) } : { issue: null, note: 'not found' };
    },
    async getRaw(owner, repo, n) { return raw(owner, repo, rowOr404(owner, repo, n)); },
    async comments(owner, repo, n, { max = 300 } = {}) {
      const st = repoState(owner, repo, false);
      const list = (st && st.comments.get(Number(n))) || [];
      return { comments: list.slice(0, max), truncated: list.length > max };
    },
    async findByMarker(owner, repo, marker) {
      const st = repoState(owner, repo, false);
      const hit = st && [...st.rows.values()].reverse().find((r) => r.body.includes(marker));
      return hit ? { number: hit.number } : null;
    },
    async create(owner, repo, { title, body = '', labels = [], createdBy = null } = {}) {
      const st = repoState(owner, repo);
      const number = st.next++;
      const at = now();
      const r = { number, title, body, labels: [...labels], state: 'open', state_reason: null, user: null, createdAt: at, updatedAt: at, closedAt: null };
      st.rows.set(number, r);
      filed.push({ owner, repo, number, title, body, labels: [...labels], createdBy });
      return raw(owner, repo, r);
    },
    async setTitle(owner, repo, n, title) { const r = rowOr404(owner, repo, n); r.title = title; r.updatedAt = now(); return raw(owner, repo, r); },
    async setBody(owner, repo, n, body) { const r = rowOr404(owner, repo, n); r.body = body; r.updatedAt = now(); return raw(owner, repo, r); },
    async setContent(owner, repo, n, { title, body }) {
      const r = rowOr404(owner, repo, n); r.title = title; r.body = body; r.updatedAt = now(); return raw(owner, repo, r);
    },
    async close(owner, repo, n, { reason = null } = {}) {
      const r = rowOr404(owner, repo, n);
      r.state = 'closed'; r.state_reason = reason === 'not_planned' ? 'not_planned' : 'completed'; r.closedAt = now(); r.updatedAt = r.closedAt;
      closed.push({ owner, repo, number: Number(n), reason: r.state_reason });
      return raw(owner, repo, r);
    },
    async reopen(owner, repo, n) {
      const r = rowOr404(owner, repo, n);
      r.state = 'open'; r.state_reason = 'reopened'; r.closedAt = null; r.updatedAt = now();
      return raw(owner, repo, r);
    },
    async comment(owner, repo, n, body) {
      rowOr404(owner, repo, n);
      const st = repoState(owner, repo);
      const list = st.comments.get(Number(n)) || [];
      const c = { author: 'homeroom', body, createdAt: now(), id: commented.length + 1 };
      list.push(c);
      st.comments.set(Number(n), list);
      commented.push({ owner, repo, number: Number(n), body });
      return { id: c.id, body, user: { login: 'homeroom' }, created_at: c.createdAt, html_url: url(owner, repo, n) };
    },
  });
  const restore = () => Object.assign(requests, saved);
  if (t && typeof t.after === 'function') t.after(restore);
  return {
    filed, commented, closed, restore,
    board: (owner, repo) => [...((repoState(owner, repo, false) || { rows: new Map() }).rows.values())],
  };
}

module.exports = { installFakeRequests };
