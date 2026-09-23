'use strict';

// The agent-session Mayor's system prompt (#2779, spec: docs/agent-sessions.md,
// "Prompt").
//
// The classic Mayor's prompt (./prompt.js) is written for one change on one
// app: "ONE branch and ONE pull request", a spec, a worker. An agent session
// is a standing conversation that works on any app, one change at a time, so
// its prompt says where the conversation stands instead: the app it was
// opened from, the change it is working on, the changes it has parked. The
// rules that hold for any reader of the platform's tools come from the
// connector charter's `agent_mayor` variant (services/mcp-charter.js), so the
// Mayor and an external client cannot be told different things about them.
//
// Anything a user or a member wrote (a change title, an app name) is wrapped
// as untrusted content, as every tool result is.

const charter = require('../mcp-charter');

const MAX_LISTED_CHANGES = 10;
const MAX_TITLE_CHARS = 200;

const ENTRY_LABELS = Object.freeze({
  improve: 'the Improve screen',
  workshop: 'the Workshop',
  app: 'the app\'s Dev tab',
  issue: 'a request',
  feedback: 'a feedback report',
  proposal: 'a proposal',
  messages: 'Messages',
  banner: 'a change page',
});

// Collapsed to one line, and with any envelope tag of its own removed, so a
// title cannot close the envelope early and speak as the prompt.
function untrusted(value) {
  const text = String(value == null ? '' : value)
    .replace(/<\/?untrusted-content>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  return text ? `<untrusted-content>${text}</untrusted-content>` : '';
}

function changeRef(change) {
  return change.prNumber ? `PR #${change.prNumber} (change ${change.id})` : `change ${change.id}`;
}

function changeLine(change) {
  const title = change.title ? ` ${untrusted(change.title)}` : '';
  const where = change.appSlug ? ` on ${change.appSlug}` : '';
  return `${changeRef(change)}${where}:${title} (${change.status || 'unknown'})`;
}

function focusBlock(session) {
  const context = session.focusContext || {};
  const from = context.entry && ENTRY_LABELS[context.entry] ? ` from ${ENTRY_LABELS[context.entry]}` : '';
  if (!session.focusApp) {
    return `FOCUS\nNo app was in view when this conversation started${from}. When it matters which app the user `
      + 'means, ask, or look with list_apps.';
  }
  const app = session.focusApp;
  const lines = [
    'FOCUS',
    `The focus app is ${app.slug}${app.name ? ` (${untrusted(app.name)})` : ''}, set${from ? ` when the user opened this${from}` : ''}.`
      + ' Treat it as the default when a request does not name an app. It is never a limit: a request that names '
      + 'another app, or clearly concerns Homeroom itself, goes there, and you say so in one line first.',
  ];
  if (context.issueNumber) {
    lines.push(`They were looking at request #${context.issueNumber} on ${app.slug}. Read it with get_request before `
      + 'acting on it, and pass linkedIssues when you start a change for it.');
  }
  if (context.proposalId) {
    lines.push(`They were looking at proposal ${context.proposalId} on ${app.slug}. Read it with get_proposal before `
      + 'discussing it.');
  }
  return lines.join('\n');
}

function changesBlock(session) {
  const lines = ['CHANGES'];
  const active = session.activeChange;
  if (active) {
    lines.push(`The active change is ${changeLine(active)}. Call get_change for its checks, votes and next step `
      + 'before advising on it.');
  } else {
    lines.push('There is no active change.');
  }
  const others = (session.changes || []).filter((change) => !active || change.id !== active.id);
  if (others.length) {
    lines.push('Other changes this conversation started, newest first:');
    for (const change of others.slice(0, MAX_LISTED_CHANGES)) lines.push(`- ${changeLine(change)}`);
  }
  return lines.join('\n');
}

function getAgentMayorPrompt({ username, session }) {
  const who = username ? `${username}'s` : 'the user\'s';
  return [
    `You are the Mayor: ${who} project manager on Homeroom. Homeroom is a platform where small web apps are built `
      + 'collaboratively, and every change is merged only when the app\'s group votes it in. This conversation is an '
      + 'agent session. It is not tied to one app, it does not end when a change merges, and you can work on any app '
      + 'the user can see, including Homeroom itself.',
    'HOW YOU WORK\n'
      + '- Answer in plain English: one to four short sentences unless the user asks for more.\n'
      + '- You never write code. The coding agent writes code, on one change at a time.\n'
      + '- Look before you answer: use the platform tools to read apps, requests, proposals and changes instead of '
      + 'guessing.\n'
      + '- A change is one proposal on one app: a branch, a staging preview, the checks that gate merge, and a vote. '
      + 'This conversation works on one active change at a time. start_change opens a new change and makes it '
      + 'active, parking the one before it (its branch and preview are kept). switch_active_change makes one of '
      + 'this conversation\'s earlier changes active again. set_focus_app records which app the user means when '
      + 'they do not say.\n'
      + '- Name a change by its pull request number first when it has one: PR #N (change M).\n'
      + '- The coding agent cannot be dispatched from this conversation yet. When the user wants something built, you '
      + 'may start the change for them to confirm, then say plainly that building from an agent session is not '
      + 'switched on yet.',
    focusBlock(session),
    changesBlock(session),
    `PLATFORM RULES\n${charter.charterFor('agent_mayor')}`,
  ].join('\n\n');
}

module.exports = {
  ENTRY_LABELS,
  MAX_LISTED_CHANGES,
  focusBlock,
  changesBlock,
  getAgentMayorPrompt,
};
