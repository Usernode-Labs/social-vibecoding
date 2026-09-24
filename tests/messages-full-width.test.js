'use strict';

// #2387 follow-up: FULL WIDTH on every discussion pane.
//
// The first cut of single-panel mode put a sidebar glyph at the LEFT of a
// conversation's title row, and only a conversation's and an app channel's.
// It now ends every discussion pane's header, just before ⋯ where there is
// one, as a full-screen control does: arrows out while the list is shown,
// arrows in once it is hidden. What is pinned here, each a way it quietly
// comes undone:
//
//   1. ONE CONTROL: its labels, `aria-pressed`, the glyph swap, and the two
//      classes dapp.json's checks and app.css select it by.
//   2. EVERY PANE CARRIES IT, AT THE RIGHT: a conversation or #general (before
//      ⋯), an app's channel, a dev session's bar, and the two agent panels,
//      which take it as `headerAction` rather than importing this store.
//   3. IT DOES SOMETHING ON EVERY PANE: the layout folds the list for an
//      agent thread too, not only for a conversation or a channel.
//   4. IT STAYS PUT: hidden on a phone, and the agent chat's toolbar spans the
//      pane so the control does not move in with the centred column.
//
// Run with: node --test tests/messages-full-width.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const CHAT = read('frontend/src/features/global-chat/index.tsx');
const SESSION = read('frontend/src/features/agent-session/index.tsx');
const ICONS = read('frontend/@/components/ui/icons.tsx');
const CSS = read('public/css/app.css');

/** The source of one top-level function in the Messages screen. */
function fn(name) {
  const start = SCREEN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = SCREEN.indexOf('\nfunction ', start + 1);
  const nextExport = SCREEN.indexOf('\nexport function ', start + 1);
  const end = [next, nextExport].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), SCREEN.length);
  return SCREEN.slice(start, end);
}

test('the toggle: "Full width" with arrows out, "Show the conversation list" with arrows in', () => {
  const toggle = fn('FullWidthToggle');
  assert.match(toggle, /const label = collapsed \? 'Show the conversation list' : 'Full width';/);
  assert.match(toggle, /className="messages-thread-action messages-list-toggle"/,
    'the disc every header action is, and the class the checks and app.css find it by');
  assert.match(toggle, /aria-pressed=\{collapsed\}/);
  assert.match(toggle, /aria-label=\{label\}\s+title=\{label\}/);
  assert.match(toggle, /onClick=\{\(\) => setListCollapsed\(!collapsed\)\}/);
  assert.match(toggle, /\{collapsed \? <ArrowsPointingInIcon aria-hidden="true" \/> : <ArrowsPointingOutIcon aria-hidden="true" \/>\}/,
    'the glyph is the verb a press performs');
  assert.doesNotMatch(SCREEN, /SidebarIcon/, 'the rail glyph is the platform sidebar\'s toggle, not this one');
  assert.doesNotMatch(SCREEN, /ListToggle/);

  assert.match(ICONS, /export const ArrowsPointingOutIcon = stroked\('ArrowsPointingOutIcon', 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'\);/);
  assert.match(ICONS, /export const ArrowsPointingInIcon = stroked\('ArrowsPointingInIcon', 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'\);/);
});

test('a conversation, a group and #general: at the right of the header, just before ⋯', () => {
  const header = fn('ThreadHeader');
  const at = header.indexOf('<FullWidthToggle />');
  assert.ok(at > 0, 'the conversation header carries it');
  assert.equal(header.indexOf('<FullWidthToggle />', at + 1), -1, 'once');
  assert.ok(at > header.indexOf('className="min-w-0 text-left flex-1"'), 'after the title, which takes the free width');
  assert.ok(at > header.indexOf('aria-label="Group members"'), 'after a group\'s members disc');
  assert.match(header, /<FullWidthToggle \/>\s*<div className="relative"><button type="button" onClick=\{\(\) => setMenu\(\(open\) => !open\)\}[^>]*aria-label="Conversation actions"/,
    'immediately before the ⋯ menu');
  assert.match(header, /<header className="messages-thread-header">\s*\{channel/, 'no longer leading the row');
});

test('an app\'s channel: at the end of its header', () => {
  const pane = fn('AppDiscussionThread');
  assert.match(pane, /Everyone building this app<\/span>\s*<\/span>\s*<FullWidthToggle \/>\s*<\/header>/);
  assert.match(pane, /<header className="messages-thread-header">\s*<span\s+data-icon=/, 'no longer leading the row');
});

test('a dev session: in the pane\'s bar, after "Open full view"', () => {
  const pane = fn('AgentSessionThread');
  assert.match(pane, /<div className="messages-session-bar">\s*<a className="messages-session-full" href=\{full\}>Open full view<\/a>\s*<FullWidthToggle \/>\s*<\/div>/);
  assert.match(CSS, /\.messages-session-bar \{\s*display: flex;\s*align-items: center;\s*justify-content: flex-end;\s*gap: 12px;/);
});

test('an agent chat and a Mayor session: handed to their panels, drawn at the end of their bars', () => {
  assert.match(fn('AgentChatThread'), /<GlobalChatPanel embedded headerAction=\{<FullWidthToggle \/>\} \/>/);
  assert.match(fn('MayorSessionThread'), /<AgentSessionPanel embedded headerAction=\{<FullWidthToggle \/>\} \/>/);

  // The global chat: last in its toolbar, after New. Its own screen passes
  // nothing, so that surface is unchanged.
  assert.match(CHAT, /export function GlobalChatPanel\(\{ embedded = false, headerAction = null \}: \{ embedded\?: boolean; headerAction\?: ReactNode \}\)/);
  assert.match(CHAT, /<span>New<\/span>\s*<\/button>\s*\{headerAction\}\s*<\/header>/);
  assert.match(CHAT, /\{snapshot\.host === 'messages' \? null : <GlobalChatPanel \/>\}/);

  // The Mayor: the session bar's `action`, after Changes.
  assert.match(SESSION, /export function AgentSessionPanel\(\{ embedded = false, headerAction = null \}: \{ embedded\?: boolean; headerAction\?: ReactNode \}\)/);
  assert.match(SESSION, /<SessionBar session=\{snapshot\.session\} about=\{about\} embedded=\{embedded\} action=\{headerAction\} \/>/);
  assert.match(SESSION, /Changes · \{count\}\s*<\/button>\s*\{action\}\s*<\/div>/);
});

test('the list folds for an agent thread too; a reply thread still belongs to a chat', () => {
  assert.match(SCREEN, /const chatOpen = !!\(snap\.route\.conversationId \|\| snap\.route\.appSlug\);\s*const discussionOpen = chatOpen \|\| !!snap\.route\.agent;/);
  assert.match(SCREEN, /\$\{snap\.listCollapsed && discussionOpen \? ' messages-list-collapsed' : ''\}/,
    'a toggle that does nothing on half the panes is worse than none');
  assert.match(SCREEN, /\$\{chatOpen && snap\.route\.threadRootId \? ' messages-has-reply-thread' : ''\}/);
});

test('app.css: a desktop control that keeps its ink, and stays under the pointer', () => {
  assert.match(CSS, /\.messages-list-toggle \{ display: none; \}\s*@media \(min-width: 768px\) \{\s*\.messages-list-toggle \{ display: inline-flex; \}/,
    'a phone shows one pane at a time already');
  assert.match(CSS, /\.messages-layout\.messages-list-collapsed > \.messages-list-pane \{ display: none; \}/);
  assert.doesNotMatch(CSS, /\.messages-list-toggle\[aria-pressed="true"\]/, 'the glyph says the state; no accent on top');
  // Between 768 and 1600px an open reply thread has already moved the list.
  assert.match(CSS, /\.messages-layout\.messages-has-reply-thread \.messages-list-toggle \{ display: none; \}/);
  // So has a Mayor session's side pane (its spec or a preview) open beside its
  // chat, from 1024px up.
  assert.match(fn('FullWidthToggle'), /const specBeside = useSidePaneBeside\('messages'\);[\s\S]*if \(specBeside\) return null;/);
  assert.match(SCREEN, /className=\{`messages-list-pane \$\{specBeside \? 'hidden' : /);
  assert.match(CSS, /\.global-chat-embedded > \.global-chat-toolbar \{ width: 100%; \}/);
});
