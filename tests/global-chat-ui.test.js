'use strict';

// Source-level browser contract for #2377's React-owned mode. The repository
// does not ship a DOM test runtime for TSX islands, so the shell build verifies
// compilation/hydration while these checks pin the product decisions that are
// easy to lose in later visual edits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const screen = read('frontend', 'src', 'features', 'global-chat', 'index.tsx');
const modeSwitch = read('frontend', 'src', 'features', 'global-chat', 'mode-switch.tsx');
const store = read('frontend', 'src', 'features', 'global-chat', 'store.ts');
const renderers = read('frontend', 'src', 'features', 'global-chat', 'renderers.tsx');
const api = read('frontend', 'src', 'features', 'global-chat', 'api.ts');
const settings = read('frontend', 'src', 'features', 'settings', 'sections', 'global-chat.tsx');
const css = read('public', 'css', 'app.css');
const shell = read('frontend', 'src', 'Shell.tsx');

function sourceTree(...parts) {
  const directory = path.join(ROOT, ...parts);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceTree(...parts, entry.name);
    return /\.(?:js|ts|tsx)$/.test(entry.name) ? [fs.readFileSync(target, 'utf8')] : [];
  }).join('\n');
}

test('Global Chat ships as an experimental sibling while Classic remains the startup mode', () => {
  assert.match(shell, /<GlobalChatScreen\s*\/>/);
  assert.match(screen, /id="global-chat-screen"/);
  assert.match(screen, /Chat\s*<span>\(experimental\)<\/span>/);
  assert.match(screen, /Classic remains the default\./);
  assert.match(screen, /snapshot\.open \? 'flex' : 'hidden'/);
  assert.match(modeSwitch, /if \(!snapshot\.bootstrap\?\.parityReady\) return null/);
  assert.match(modeSwitch, /Switch to Chat \(experimental\)/);
});

test('Chat mode is memory-only and leaves every launch in Classic', () => {
  assert.doesNotMatch(store, /(?:localStorage|sessionStorage|indexedDB)[\s\S]{0,80}(?:global.?chat|chat.?mode)/i);
  assert.match(store, /open:\s*false/);
  assert.match(store, /document\.body\.classList\.toggle\('global-chat-mode', open\)/);
  assert.match(store, /element\.inert = open/);
  assert.match(store, /setDocumentMode\(false\)/);
});

test('Global Chat stays isolated from developer and proposal chat implementations', () => {
  for (const existingChat of [
    sourceTree('frontend', 'src', 'features', 'dev-chat'),
    sourceTree('frontend', 'src', 'features', 'group-chat'),
  ]) {
    assert.doesNotMatch(existingChat, /(?:from|import\s*\()\s*['"][^'"]*global-chat/i);
    assert.doesNotMatch(existingChat, /\bglobalChat(?:Controller|Store)?\b/);
  }
});

test('a streamed turn failure keeps its actionable error instead of being replaced by an incomplete-stream error', () => {
  assert.match(store, /event\.type === 'turn\.failed'[\s\S]*?completed = true;/);
  assert.match(store, /turn\.failed'[\s\S]*?pending \? \{ \.\.\.item, pending: false \}/);
});

test('suggestions stay compact, button-like, and append through a separate More control', () => {
  assert.match(screen, /className="global-chat-suggestions"/);
  assert.match(screen, /suggestions\.map\(\(suggestion\) => \(\s*<button/s);
  assert.match(screen, />\s*\{suggestion\.label\}\s*<\/button>/s);
  assert.match(screen, /className="global-chat-more-suggestions"/);
  assert.match(screen, />\s*More suggestions\s*<\/button>/s);
  assert.doesNotMatch(screen, /suggestion\.description|Fewer suggestions|Hide suggestions/);
  assert.match(store, /\.\.\.current\.messages\.map[\s\S]*assistant,/);
});

test('authoritative results never execute model HTML and retain a Classic escape', () => {
  assert.doesNotMatch(renderers, /dangerouslySetInnerHTML|innerHTML|eval\s*\(/);
  assert.match(renderers, /result\.authoritativeResult/);
  assert.match(renderers, /Open in Classic/);
  assert.match(renderers, /closeGlobalChat\(classicPath\)/);
  assert.match(renderers, /status === 'confirmation_required'/);
  assert.match(renderers, /confirmGlobalChatAction\(result, token\)/);
  assert.match(renderers, /payload\.preview/);
  assert.match(renderers, /items\.slice\(0, 3\)/);
});

test('the browser transport uses authenticated POST SSE and same-origin client actions', () => {
  assert.match(api, /method:\s*'POST'/);
  assert.match(api, /Accept:\s*'text\/event-stream'/);
  assert.match(api, /credentials:\s*'same-origin'/);
  assert.match(api, /response\.body\.getReader\(\)/);
  assert.match(store, /new URL\(path, window\.location\.origin\)/);
  assert.match(store, /url\.origin !== window\.location\.origin/);
  assert.match(store, /\['GET', 'POST', 'PUT', 'PATCH', 'DELETE'\]\.includes\(method\)/);
  assert.match(store, /transport === 'development_handoff'/);
  assert.match(store, /action\.transport === 'local_setting'/);
  assert.match(store, /drainResponse\(response\.body\)/);
});

test('Global Chat has a mobile/native layout and accessible composer controls', () => {
  assert.match(api, /native_android/);
  assert.match(api, /native_ios/);
  assert.match(api, /viewport: window\.matchMedia\('\(max-width: 767px\)'\)/);
  assert.match(screen, /aria-label="Chat \(experimental\)"/);
  assert.match(screen, /aria-label="Message Global Chat"/);
  assert.match(screen, /aria-label=\{sending \? 'Stop response' : 'Send message'\}/);
  assert.match(css, /\.global-chat-composer[\s\S]*var\(--platform-safe-bottom/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.global-chat-suggestions button \{ min-height: 42px; \}/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.global-chat-mode-switch \{ min-height: 44px; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.global-chat-activity svg \{ animation: none; \}/);
});

test('Settings keeps navigation AI separate from development AI and reports spend', () => {
  assert.match(settings, /Global Chat model/);
  assert.match(settings, /Low · recommended for GLM Flash/);
  assert.match(settings, /Monthly Chat cap in USD/);
  assert.match(settings, /Global Chat this month/);
  assert.match(settings, /Overall OpenRouter remaining/);
  assert.match(settings, /Development AI settings/);
  assert.match(settings, /This profile only controls Global Chat/);
});
