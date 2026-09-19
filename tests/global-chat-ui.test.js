'use strict';

// Source-level browser contract for #2377/#2543's React-owned screen. The repository
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
const newChatButton = read('frontend', 'src', 'features', 'global-chat', 'new-chat-button.tsx');
const improveSection = read('frontend', 'src', 'features', 'global-chat', 'improve-section.tsx');
const store = read('frontend', 'src', 'features', 'global-chat', 'store.ts');
const renderers = read('frontend', 'src', 'features', 'global-chat', 'renderers.tsx');
const api = read('frontend', 'src', 'features', 'global-chat', 'api.ts');
const settings = read('frontend', 'src', 'features', 'settings', 'sections', 'global-chat.tsx');
const css = read('public', 'css', 'app.css');
const shell = read('frontend', 'src', 'Shell.tsx');
const header = read('frontend', 'src', 'features', 'header', 'platform-header.tsx');
const improvePanel = read('frontend', 'src', 'features', 'improve', 'improve-panel.tsx');
const viewTabs = read('frontend', 'src', 'features', 'improve', 'view-tabs.tsx');
const appJs = read('public', 'js', 'app.js');

function sourceTree(...parts) {
  const directory = path.join(ROOT, ...parts);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceTree(...parts, entry.name);
    return /\.(?:js|ts|tsx)$/.test(entry.name) ? [fs.readFileSync(target, 'utf8')] : [];
  }).join('\n');
}

test('Global Chat ships as an experimental hash-routed sibling screen', () => {
  assert.match(shell, /<GlobalChatScreen\s*\/>/);
  assert.match(screen, /id="global-chat-screen"/);
  assert.match(screen, /Chat\s*<span>\(experimental\)<\/span>/);
  assert.match(screen, /Saved in Improve\./);
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'global-chat-screen', false\)/);
  assert.match(screen, /className="hidden flex flex-1 min-h-0 overflow-hidden"/);
  assert.match(appJs, /parts\[0\] === 'chat'/);
  assert.match(appJs, /navigateToGlobalChat\(threadId\)/);
  assert.match(appJs, /App\._showOnlyScreen\('global-chat-screen'\)/);
  assert.match(newChatButton, /!snapshot\.bootstrap\?\.parityReady[\s\S]*profiles\.globalChat\.enabled !== true/);
  assert.match(newChatButton, /New chat \(experimental\)/);
});

test('Improve separates resumable chats from coding changes and starts durable sessions', () => {
  assert.doesNotMatch(header, /GlobalChatNewChatButton|GlobalChatModeSwitch/);
  assert.match(improvePanel, /<GlobalChatImproveSection/);

  const sessions = improvePanel.slice(improvePanel.indexOf('id="improve-sessions"'));
  assert.ok(
    sessions.indexOf('<GlobalChatImproveSection') >= 0
      && sessions.indexOf('<GlobalChatImproveSection') < sessions.lastIndexOf('Changes in progress'),
    'the Chats group must render before the coding-change group',
  );

  assert.match(improveSection, /<span>Chats<\/span>/);
  assert.match(improveSection, /snapshot\.threads\.map/);
  assert.match(improveSection, /href=\{`#chat\/\$\{encodeURIComponent\(thread\.id\)\}`\}/);
  assert.match(improveSection, /data-improve-row="chat"/);
  assert.match(improveSection, /Working/);
  assert.match(improveSection, /Current/);
  assert.match(newChatButton, /void startNewGlobalChat\(\)/);
  assert.match(store, /`#chat\/\$\{encodeURIComponent\(created\.thread\.id\)\}`/);
  assert.match(viewTabs, /active === 'chat' \? 'Chat' : 'Change'/);
});

test('chat navigation uses the shared screen router instead of a body-wide mode', () => {
  assert.match(store, /open:\s*false/);
  assert.doesNotMatch(store, /setDocumentMode|CLASSIC_SCREEN_IDS|\.inert\s*=/);
  assert.doesNotMatch(css, /body\.global-chat-mode/);
  assert.match(appJs, /'global-chat-screen'/);
  assert.match(store, /api\.thread\(threadId\)/);
  assert.match(store, /api\.threads\(\)/);
  assert.match(store, /deactivateGlobalChat/);
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
  assert.match(screen, /Hold an option for related suggestions\./);
  assert.match(screen, /onPointerDown/);
  assert.match(screen, /onContextMenu/);
  assert.match(screen, /event\.shiftKey && event\.key === 'F10'/);
  assert.match(screen, /global-chat-related-suggestions/);
  assert.match(screen, /selectGlobalChatSuggestion\(suggestion\)/);
  assert.match(screen, /requestMoreSuggestions\(context\)/);
  assert.match(store, /if \(!boot\.available && !more\)/);
  assert.match(screen, /The direct options below still work without it\./);
  assert.match(screen, /snapshot\.bootstrap && !snapshot\.messages\.length/);
});

test('authoritative results never execute model HTML and retain exact Classic escapes', () => {
  const directItemActionSource = renderers.slice(
    renderers.indexOf('function directItemActions'),
    renderers.indexOf('function itemClassicPath'),
  );
  const classicPathSource = renderers.slice(
    renderers.indexOf('function itemClassicPath'),
    renderers.indexOf('function compactMetadata'),
  );
  assert.doesNotMatch(renderers, /dangerouslySetInnerHTML|innerHTML|eval\s*\(/);
  assert.match(renderers, /result\.authoritativeResult/);
  assert.match(renderers, /Open in Classic/);
  assert.match(renderers, /closeGlobalChat\(classicPath\)/);
  assert.match(renderers, /status === 'confirmation_required'/);
  assert.match(renderers, /confirmGlobalChatAction\(result, token\)/);
  assert.match(renderers, /payload\.preview/);
  assert.match(renderers, /items\.slice\(0, 3\)/);
  assert.match(renderers, /#apps\/\$\{segment\(slug\)\}/);
  assert.match(renderers, /#app\/\$\{segment\(slug\)\}\/dev\/issues\/\$\{segment\(issueNumber\)\}/);
  assert.match(renderers, /#app\/\$\{segment\(slug\)\}\/dev\/governance\/\$\{segment\(governanceId\)\}/);
  assert.match(renderers, /#settings\/\$\{segment\(group\)\}/);
  assert.match(renderers, /github_issue_number/);
  assert.match(renderers, /githubIssueCapability/);
  assert.match(renderers, /executeGlobalChatResultAction/);
  assert.match(renderers, /actionId: 'issues\.for_app'/);
  assert.match(renderers, /actionId: 'issue\.comments'/);
  assert.match(renderers, /actionId: 'session\.checks'/);
  assert.match(directItemActionSource, /proposalType === 'governance'[\s\S]*actionId: 'governance\.detail'/);
  assert.doesNotMatch(directItemActionSource, /return `#app\//);
  assert.match(classicPathSource, /proposalType === 'governance'[\s\S]*return `#app\/\$\{segment\(slug\)\}\/dev\/governance/);
});

test('app results reuse the platform icon primitive for images, emoji, and fallback letters', () => {
  assert.match(renderers, /AppIconContent, appIconKind/);
  assert.match(renderers, /result\.renderer === 'app'/);
  assert.match(renderers, /<AppIconContent app=\{item\} \/>/);
  assert.match(renderers, /data-icon=\{appIconKind\(item\)\}/);
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
  assert.match(api, /\/turn-status/);
  assert.match(api, /\/cancel/);
  assert.match(api, /\/direct-actions/);
  assert.match(store, /recoverInterruptedTurn/);
  assert.match(store, /Reconnecting…/);
  assert.match(store, /executeDirectAction/);
  assert.match(api, /modelInvocations:\s*0/);
  assert.doesNotMatch(store, /The response ended before it was complete\./);
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
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.global-chat-new-chat-btn \{ min-height: 44px; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.global-chat-activity svg \{ animation: none; \}/);
});

test('Settings keeps navigation AI separate from development AI and reports spend', () => {
  assert.match(settings, /id="settings-global-chat-enabled"/);
  assert.match(settings, /Enable experimental Global Chat/);
  assert.match(settings, /api\.saveProfile\(\{ enabled: nextEnabled \}\)/);
  assert.match(settings, /initializeGlobalChat\(\{ force: true \}\)/);
  assert.match(settings, /Global Chat model/);
  assert.match(settings, /Low · recommended for GLM Flash/);
  assert.match(settings, /Monthly Chat cap in USD/);
  assert.match(settings, /Global Chat this month/);
  assert.match(settings, /Overall OpenRouter remaining/);
  assert.match(settings, /Development AI settings/);
  assert.match(settings, /This profile only controls Global Chat/);
});
