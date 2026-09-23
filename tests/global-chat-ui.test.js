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
const inbox = read('frontend', 'src', 'features', 'messages', 'index.tsx');
const store = read('frontend', 'src', 'features', 'global-chat', 'store.ts');
const renderers = read('frontend', 'src', 'features', 'global-chat', 'renderers.tsx');
const api = read('frontend', 'src', 'features', 'global-chat', 'api.ts');
const developmentSettings = read(
  'frontend', 'src', 'features', 'global-chat', 'development-settings-editor.tsx',
);
const settings = read('frontend', 'src', 'features', 'settings', 'sections', 'global-chat.tsx');
const css = read('public', 'css', 'app.css');
const shell = read('frontend', 'src', 'Shell.tsx');
const header = read('frontend', 'src', 'features', 'header', 'platform-header.tsx');
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
  assert.match(screen, /Saved in Messages\./);
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'global-chat-screen', false\)/);
  assert.match(screen, /className="hidden flex flex-1 min-h-0 overflow-hidden"/);
  assert.match(appJs, /parts\[0\] === 'chat'/);
  assert.match(appJs, /navigateToGlobalChat\(threadId\)/);
  assert.match(appJs, /App\._showOnlyScreen\('global-chat-screen'\)/);
  // THE ROWS ARE THE INBOX'S (#2718 review), gated on both flags, read once.
  // Starting one moved (#2778): the inbox's "+" offers Agent chat, which for
  // now opens a new dev session on an app the viewer picks — so the compose
  // button `#messages-new-agent` that started a Global Chat is retired, and
  // an existing chat is resumed from its row.
  assert.match(inbox, /parityReady\s*\n?\s*&& chat\.bootstrap\.profiles\.globalChat\.enabled === true/);
  assert.doesNotMatch(inbox, /id="messages-new-agent"/);
  assert.match(inbox, /data-new-choice=\{item\.key\}/);
});

test('the inbox lists resumable chats, and is where one is deleted', () => {
  assert.doesNotMatch(header, /GlobalChatNewChatButton|GlobalChatModeSwitch/);
  // THE PANEL'S LIST RETIRED WITH THE PANEL (#2718 review). These chats are
  // rows of the Messages inbox under its Agents filter — one list, loaded and
  // invalidated in one place — so what the panel's copy is asserted for is
  // asserted of that row now.
  assert.match(inbox, /function AgentChatRow/);
  assert.match(inbox, /href=\{`#chat\/\$\{encodeURIComponent\(chat\.id\)\}`\}/);
  assert.match(inbox, /data-inbox-agent=\{chat\.id\}/);
  assert.match(inbox, /chat\.busy \? 'Working…'/);
  // The DELETE is the one thing that lived nowhere else, so it moved rather
  // than going away with the surface that carried it.
  assert.match(inbox, /removeGlobalChatThread\(chat\.id\)/);
  assert.match(inbox, /Delete this chat\?/);
  assert.match(inbox, /\{removing \? 'Deleting…' : 'Delete'\}/);
  assert.match(inbox, /DraftTrashIcon/);
});
test('chat navigation uses the shared screen router instead of a body-wide mode', () => {
  assert.match(store, /open:\s*false/);
  assert.doesNotMatch(store, /setDocumentMode|CLASSIC_SCREEN_IDS|\.inert\s*=/);
  assert.doesNotMatch(css, /body\.global-chat-mode/);
  assert.match(appJs, /'global-chat-screen'/);
  assert.match(store, /api\.thread\(threadId\)/);
  assert.match(store, /api\.threads\(\)/);
  assert.match(store, /deactivateGlobalChat/);
  assert.match(screen, /aria-label="Close chat"/);
  assert.match(screen, /onClick=\{\(\) => closeGlobalChat\(\)\}/);
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
  assert.match(store, /event\.assistantMessage as GlobalChatMessage/);
  assert.match(store, /assistant\.payload\?\.kind === 'turn_error'/);
  assert.match(store, /retryRequest: failed \? retryRequest : null/);
  assert.match(store, /export async function retryLastGlobalChatRequest/);
  assert.match(screen, /retryLastGlobalChatRequest\(\)/);
  assert.doesNotMatch(screen, /onClick=\{\(\) => void openGlobalChat\(\)\}[\s\S]*Retry/);
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
  assert.match(renderers, /result\.renderer === 'app' \? 6 : 3/);
  assert.match(renderers, /items\.slice\(0, visibleCount\)/);
  assert.match(renderers, /Math\.min\(count \+ pageSize, items\.length\)/);
  assert.match(renderers, />\s*Show more\s*<ChevronDownIcon/s);
  assert.doesNotMatch(renderers, /Show \{items\.length - visible\.length\} more/);
  assert.match(renderers, /#apps\/\$\{segment\(slug\)\}/);
  assert.match(renderers, /#app\/\$\{segment\(slug\)\}\/dev\/issues\/\$\{segment\(issueNumber\)\}/);
  assert.match(renderers, /#app\/\$\{segment\(slug\)\}\/dev\/governance\/\$\{segment\(governanceId\)\}/);
  assert.match(renderers, /#settings\/\$\{segment\(group\)\}/);
  assert.match(renderers, /github_issue_number/);
  assert.match(renderers, /githubIssueCapability/);
  assert.match(renderers, /explicitGithubIssueNumber/);
  assert.match(renderers, /executeGlobalChatResultAction/);
  assert.match(renderers, /itemAction\([^\n]+?'issues\.for_app'/);
  assert.match(renderers, /itemAction\([^\n]+?'messages\.for_app'/);
  assert.match(renderers, /itemAction\([^\n]+?'issue\.comments'/);
  assert.match(renderers, /itemAction\([^\n]+?'session\.checks'/);
  assert.match(renderers, /itemAction\([\s\S]*?'notification\.detail'/);
  assert.match(renderers, /itemAction\([\s\S]*?'leaderboard\.profile'/);
  assert.ok(renderers.includes("|| /\\/dev\\/chat$/.test(base)"));
  assert.match(renderers, /Platform issues/);
  assert.match(renderers, /GitHub issues/);
  assert.match(renderers, /Recent app activity/);
  assert.match(renderers, /Messages \(7d\)/);
  assert.match(renderers, /Active time \(7d\)/);
  assert.match(renderers, /No current proposals\./);
  assert.match(renderers, /SettingInstruction/);
  assert.match(renderers, /LocalSettingEditor/);
  assert.match(renderers, /'settings\.local\.update'/);
  assert.match(renderers, /await runGlobalChatClientAction\(pending\)/);
  assert.match(renderers, /selected === saved \? 'Saved' : 'Save'/);
  assert.match(renderers, /In the "\$\{title\}" settings group \(key: \$\{group\}\)/);
  assert.match(renderers, /Preserve every value I did not ask to change/);
  assert.doesNotMatch(renderers, /function safeFields/);
  assert.doesNotMatch(renderers, />\s*Done\s*</);
  assert.match(directItemActionSource, /proposalType === 'governance'[\s\S]*'governance\.detail'/);
  assert.doesNotMatch(directItemActionSource, /return `#app\//);
  assert.match(classicPathSource, /proposalType === 'governance'[\s\S]*return `#app\/\$\{segment\(slug\)\}\/dev\/governance/);
});

test('app results reuse the platform icon primitive for images, emoji, and fallback letters', () => {
  assert.match(renderers, /AppIconContent, appIconKind/);
  assert.match(renderers, /result\.renderer === 'app'/);
  assert.match(renderers, /<AppIconContent app=\{item\} \/>/);
  assert.match(renderers, /data-icon=\{appIconKind\(item\)\}/);
  assert.match(css, /\.global-chat-result\[data-renderer="app"\] \.global-chat-result-items[\s\S]*grid-template-columns: repeat\(2/);
});

test('single-purpose app choosers select directly without unrelated controls', () => {
  assert.match(screen, /itemSelection=\{itemSelection\}/);
  assert.match(screen, /!itemSelection \? \(/);
  assert.match(renderers, /itemSelection\?\.renderer === result\.renderer/);
  assert.match(renderers, /selectionAction\.actionId/);
  assert.match(renderers, /aria-expanded=\{selectionAction \? undefined : expanded\}/);
  assert.match(renderers, /!selectionAction \? <ChevronDownIcon/);
  assert.match(renderers, /!selectionAction && expanded \? \(/);
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
  assert.match(api, /\/inline-actions/);
  assert.match(api, /method:\s*'DELETE'/);
  assert.match(api, /\/api\/global-chat\/threads\/\$\{encodeURIComponent\(threadId\)\}/);
  assert.match(store, /recoverInterruptedTurn/);
  assert.match(store, /Reconnecting…/);
  assert.match(store, /executeDirectAction/);
  assert.match(store, /executeInlineAction/);
  assert.match(store, /api\.deleteThread\(threadId\)/);
  assert.match(store, /api\.cancelTurn\(threadId\)/);
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
  assert.match(screen, /className="global-chat-progress"/);
  assert.match(screen, /<summary>Activity<\/summary>/);
  assert.match(screen, /Model: \{progress\.model\}/);
  assert.match(screen, /Reasoning: \{progress\.reasoningEffort\} effort/);
  assert.match(store, /event\.type === 'turn\.progress'/);
  assert.match(store, /event\.type === 'tool\.completed'/);
  assert.match(css, /\.global-chat-composer[\s\S]*var\(--platform-safe-bottom/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.global-chat-suggestions button \{ min-height: 42px; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.global-chat-activity svg \{ animation: none; \}/);
  assert.match(css, /\.global-chat-progress-current/);
});

test('Settings keeps navigation AI separate from development AI and reports spend', () => {
  assert.match(settings, /idPrefix = embedded \? `chat-global-chat-\$\{instanceId\}` : 'settings-global-chat'/);
  assert.match(settings, /id=\{`\$\{idPrefix\}-enabled`\}/);
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

test('rendered rows disclose locally and settings can be edited and saved in place', () => {
  assert.match(renderers, /aria-expanded=\{selectionAction \? undefined : expanded\}/);
  assert.match(renderers, /className="global-chat-item-toggle"/);
  assert.match(renderers, /action\.mode === 'inline'/);
  assert.match(renderers, /loadGlobalChatInlineResults/);
  assert.match(renderers, /<GlobalChatSettingsEditor embedded \/>/);
  assert.match(renderers, /<DevelopmentAISettingsEditor \/>/);
  assert.match(developmentSettings, /\/api\/me\/coding-agent/);
  assert.match(developmentSettings, /method: 'PATCH'/);
  assert.match(developmentSettings, /Save development AI/);
  assert.match(developmentSettings, /does not change the Global Chat model/);
  assert.match(css, /\.global-chat-item-toggle/);
  assert.match(css, /\.global-chat-result-nested/);
});
