'use strict';

// After the coding agent finishes, Homeroom captures the change's visual
// change preview. The conversation says so ("Capturing previews", with a
// Stop) instead of reading the change's busy worker as the coding agent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const agentSessions = require('../src/services/agent-sessions');

function sessionRow(overrides = {}) {
  return {
    id: 5, user_id: 7, title: 'Solarized', title_source: 'auto', status: 'open',
    focus_app_id: null, focus_context: {}, active_change_id: 50, active_turn: null,
    last_activity_at: new Date(), created_at: new Date(), turn_live: false,
    change_id: 50, change_status: 'active', change_title: 'Solarized theme',
    change_app_slug: 'rss', change_app_name: 'RSS',
    change_evidence_state: 'exploring',
    change_evidence_started_at: new Date('2026-09-25T12:00:00Z'),
    ...overrides,
  };
}

async function readSession(row) {
  const pool = { query: async (sql) => ({ rows: /FROM agent_sessions s/.test(sql) ? [row] : [] }) };
  return agentSessions.getAgentSession(pool, { userId: 7, id: 5 });
}

test('the active change carries its preview only while one is being captured', async () => {
  const capturing = await readSession(sessionRow());
  assert.deepEqual(capturing.activeChange.previewCapture, { state: 'exploring', startedAt: '2026-09-25T12:00:00.000Z' });
  for (const state of ['planned', 'failed', 'verified', null]) {
    const settled = await readSession(sessionRow({ change_evidence_state: state }));
    assert.equal(settled.activeChange.previewCapture, null, `${state} is not capturing`);
  }
});

test('the conversation shows "Capturing previews" with its step and a Stop', () => {
  const { PreviewCapture } = loadTsx('frontend/src/features/agent-session/index.tsx');
  const html = renderToHtml(createElement(PreviewCapture, {
    change: { id: 50, appSlug: 'rss', previewCapture: { state: 'replaying', startedAt: null } },
  }));
  assert.match(html, /data-agent-session-capture="replaying"/);
  assert.match(html, /Capturing previews<\/span> · Replaying the flow on both builds/);
  assert.match(html, /data-agent-session-capture-stop="true"[^>]*>Stop<\/button>/);
  assert.doesNotMatch(html, /coding agent/i);
  assert.equal(renderToHtml(createElement(PreviewCapture, { change: { id: 50, previewCapture: null } })), '');
});
