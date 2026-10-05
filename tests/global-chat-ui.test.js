'use strict';
const { englishUiSource } = require("./lib/english-ui-source");

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
  assert.match(englishUiSource(shell), /<GlobalChatScreen\s*\/>/);
  assert.match(englishUiSource(screen), /id="global-chat-screen"/);
  assert.match(englishUiSource(screen), /Chat\s*<span>\(experimental\)<\/span>/);
  assert.match(englishUiSource(screen), /Saved in Messages\./);
  assert.match(englishUiSource(screen), /useVisibilityHiddenClass\(screenRef, 'global-chat-screen', false\)/);
  assert.match(englishUiSource(screen), /className="hidden flex flex-1 min-h-0 overflow-hidden"/);
  assert.match(englishUiSource(appJs), /parts\[0\] === 'chat'/);
  assert.match(englishUiSource(appJs), /navigateToGlobalChat\(threadId\)/);
  assert.match(englishUiSource(appJs), /App\._showOnlyScreen\('global-chat-screen'\)/);
  // THE ROWS ARE THE INBOX'S (#2718 review), gated on both flags, read once.
  // Starting one moved (#2778): the inbox's "+" offers Agent chat, which for
  // now opens a new dev session on an app the viewer picks — so the compose
  // button `#messages-new-agent` that started a Global Chat is retired, and
  // an existing chat is resumed from its row.
  assert.match(englishUiSource(inbox), /parityReady\s*\n?\s*&& chatBootstrap\.profiles\.globalChat\.enabled === true/);
  assert.doesNotMatch(englishUiSource(inbox), /id="messages-new-agent"/);
  assert.match(englishUiSource(inbox), /data-new-choice=\{item\.key\}/);
});

test('the inbox lists resumable chats, and is where one is deleted', () => {
  assert.doesNotMatch(englishUiSource(header), /GlobalChatNewChatButton|GlobalChatModeSwitch/);
  // THE PANEL'S LIST RETIRED WITH THE PANEL (#2718 review). These chats are
  // rows of the Messages inbox under its Agents filter — one list, loaded and
  // invalidated in one place — so what the panel's copy is asserted for is
  // asserted of that row now.
  assert.match(englishUiSource(inbox), /function AgentChatRow/);
  // #2813: the row's address is the inbox's own, so on a desktop the chat
  // opens beside the list; a phone's router swaps it for `#chat/<id>`.
  assert.match(englishUiSource(inbox), /const thread: MessagesAgentThread = \{ kind: 'chat', id: chat\.id \};/);
  assert.match(englishUiSource(inbox), /href=\{href\}/);
  assert.match(englishUiSource(inbox), /data-inbox-agent=\{chat\.id\}/);
  assert.match(englishUiSource(inbox), /chat\.busy \? 'Working…'/);
  // The DELETE is the one thing that lived nowhere else, so it moved rather
  // than going away with the surface that carried it.
  assert.match(englishUiSource(inbox), /removeGlobalChatThread\(chat\.id\)/);
  assert.match(englishUiSource(inbox), /Delete this chat\?/);
  assert.match(englishUiSource(inbox), /\{removing \? 'Deleting…' : 'Delete'\}/);
  assert.match(englishUiSource(inbox), /DraftTrashIcon/);
});
test('chat navigation uses the shared screen router instead of a body-wide mode', () => {
  assert.match(englishUiSource(store), /open:\s*false/);
  assert.doesNotMatch(englishUiSource(store), /setDocumentMode|CLASSIC_SCREEN_IDS|\.inert\s*=/);
  assert.doesNotMatch(englishUiSource(css), /body\.global-chat-mode/);
  assert.match(englishUiSource(appJs), /'global-chat-screen'/);
  assert.match(englishUiSource(store), /api\.thread\(threadId\)/);
  assert.match(englishUiSource(store), /api\.threads\(\)/);
  assert.match(englishUiSource(store), /deactivateGlobalChat/);
  assert.match(englishUiSource(screen), /aria-label="Close chat"/);
  assert.match(englishUiSource(screen), /onClick=\{\(\) => closeGlobalChat\(\)\}/);
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
  assert.match(englishUiSource(screen), /className="global-chat-suggestions"/);
  assert.match(englishUiSource(screen), /suggestions\.map\(\(suggestion\) => \(\s*<button/s);
  assert.match(englishUiSource(screen), />\s*\{suggestion\.label\}\s*<\/button>/s);
  assert.match(englishUiSource(screen), /className="global-chat-more-suggestions"/);
  assert.match(englishUiSource(screen), />\s*More suggestions\s*<\/button>/s);
  assert.doesNotMatch(englishUiSource(screen), /suggestion\.description|Fewer suggestions|Hide suggestions/);
  assert.match(englishUiSource(store), /\.\.\.current\.messages\.map[\s\S]*assistant,/);
  assert.match(englishUiSource(screen), /Hold an option for related suggestions\./);
  assert.match(englishUiSource(screen), /onPointerDown/);
  assert.match(englishUiSource(screen), /onContextMenu/);
  assert.match(englishUiSource(screen), /event\.shiftKey && event\.key === 'F10'/);
  assert.match(englishUiSource(screen), /global-chat-related-suggestions/);
  assert.match(englishUiSource(screen), /selectGlobalChatSuggestion\(suggestion\)/);
  assert.match(englishUiSource(screen), /requestMoreSuggestions\(context\)/);
  assert.match(englishUiSource(store), /if \(!boot\.available && !more\)/);
  assert.match(englishUiSource(screen), /The direct options below still work without it\./);
  assert.match(englishUiSource(screen), /snapshot\.bootstrap && !snapshot\.messages\.length/);
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
  assert.doesNotMatch(englishUiSource(renderers), /dangerouslySetInnerHTML|innerHTML|eval\s*\(/);
  assert.match(englishUiSource(renderers), /result\.authoritativeResult/);
  assert.match(englishUiSource(renderers), /Open in Classic/);
  assert.match(englishUiSource(renderers), /closeGlobalChat\(classicPath\)/);
  assert.match(englishUiSource(renderers), /status === 'confirmation_required'/);
  assert.match(englishUiSource(renderers), /confirmGlobalChatAction\(result, token\)/);
  assert.match(englishUiSource(renderers), /payload\.preview/);
  assert.match(englishUiSource(renderers), /result\.renderer === 'app' \? 6 : 3/);
  assert.match(englishUiSource(renderers), /items\.slice\(0, visibleCount\)/);
  assert.match(englishUiSource(renderers), /Math\.min\(count \+ pageSize, items\.length\)/);
  assert.match(englishUiSource(renderers), />\s*Show more\s*<ChevronDownIcon/s);
  assert.doesNotMatch(englishUiSource(renderers), /Show \{items\.length - visible\.length\} more/);
  assert.match(englishUiSource(renderers), /#apps\/\$\{segment\(slug\)\}/);
  assert.match(englishUiSource(renderers), /#app\/\$\{segment\(slug\)\}\/dev\/issues\/\$\{segment\(issueNumber\)\}/);
  assert.match(englishUiSource(renderers), /#app\/\$\{segment\(slug\)\}\/dev\/governance\/\$\{segment\(governanceId\)\}/);
  assert.match(englishUiSource(renderers), /#settings\/\$\{segment\(group\)\}/);
  assert.match(englishUiSource(renderers), /github_issue_number/);
  assert.match(englishUiSource(renderers), /githubIssueCapability/);
  assert.match(englishUiSource(renderers), /explicitGithubIssueNumber/);
  assert.match(englishUiSource(renderers), /executeGlobalChatResultAction/);
  assert.match(englishUiSource(renderers), /itemAction\([^\n]+?'issues\.for_app'/);
  assert.match(englishUiSource(renderers), /itemAction\([^\n]+?'messages\.for_app'/);
  assert.match(englishUiSource(renderers), /itemAction\([^\n]+?'issue\.comments'/);
  assert.match(englishUiSource(renderers), /itemAction\([^\n]+?'session\.checks'/);
  assert.match(englishUiSource(renderers), /itemAction\([\s\S]*?'notification\.detail'/);
  assert.match(englishUiSource(renderers), /itemAction\([\s\S]*?'leaderboard\.profile'/);
  assert.ok(renderers.includes("|| /\\/dev\\/chat$/.test(base)"));
  assert.match(englishUiSource(renderers), /Platform issues/);
  assert.match(englishUiSource(renderers), /GitHub issues/);
  assert.match(englishUiSource(renderers), /Recent app activity/);
  assert.match(englishUiSource(renderers), /Messages \(7d\)/);
  assert.match(englishUiSource(renderers), /Active time \(7d\)/);
  assert.match(englishUiSource(renderers), /No current proposals\./);
  assert.match(englishUiSource(renderers), /SettingInstruction/);
  assert.match(englishUiSource(renderers), /LocalSettingEditor/);
  assert.match(englishUiSource(renderers), /'settings\.local\.update'/);
  assert.match(englishUiSource(renderers), /await runGlobalChatClientAction\(pending\)/);
  assert.match(englishUiSource(renderers), /selected === saved \? 'Saved' : 'Save'/);
  assert.match(englishUiSource(renderers), /In the "\$\{title\}" settings group \(key: \$\{group\}\)/);
  assert.match(englishUiSource(renderers), /Preserve every value I did not ask to change/);
  assert.doesNotMatch(englishUiSource(renderers), /function safeFields/);
  assert.doesNotMatch(englishUiSource(renderers), />\s*Done\s*</);
  assert.match(englishUiSource(directItemActionSource), /proposalType === 'governance'[\s\S]*'governance\.detail'/);
  assert.doesNotMatch(englishUiSource(directItemActionSource), /return `#app\//);
  assert.match(englishUiSource(classicPathSource), /proposalType === 'governance'[\s\S]*return `#app\/\$\{segment\(slug\)\}\/dev\/governance/);
});

test('app results reuse the platform icon primitive for images, emoji, and fallback letters', () => {
  assert.match(renderers, /AppIconContent, AppIconLink, appIconKind/);
  // #3365: the tile opens the app it names.
  assert.match(renderers, /<AppIconLink\s+slug=\{text\(item\.slug \|\| item\.app_slug, 255\)\}/);
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
  // #2779: Start development work opens an unsent agent session with the task.
  assert.match(store, /action\.transport === 'agent_session_handoff'/);
  assert.match(store, /agentSession\?\.prepareDraft\(hint\)[\s\S]{0,200}closeGlobalChat\('#messages\/agent\/new'\)/);
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
  assert.match(englishUiSource(api), /native_android/);
  assert.match(englishUiSource(api), /native_ios/);
  assert.match(englishUiSource(api), /viewport: window\.matchMedia\('\(max-width: 767px\)'\)/);
  assert.match(englishUiSource(screen), /aria-label="Chat \(experimental\)"/);
  assert.match(englishUiSource(screen), /aria-label="Message Global Chat"/);
  assert.match(englishUiSource(screen), /aria-label=\{sending \? 'Stop response' : 'Send message'\}/);
  assert.match(englishUiSource(screen), /className="global-chat-progress"/);
  assert.match(englishUiSource(screen), /<summary>Activity<\/summary>/);
  assert.match(englishUiSource(screen), /Model: \{progress\.model\}/);
  assert.match(englishUiSource(screen), /Reasoning: \{progress\.reasoningEffort\} effort/);
  assert.match(englishUiSource(store), /event\.type === 'turn\.progress'/);
  assert.match(englishUiSource(store), /event\.type === 'tool\.completed'/);
  // BUG e: on a phone #global-chat-screen keeps the platform tab bar up, and
  // the composer cleared only the home-indicator strip — "Ask Homeroom…" sat
  // under the bar. It wears the shell's safe-bar contract now, which clears
  // whichever of the tab bar and the strip is taller; and the transcript
  // above it no longer reserves that band too (it is always above the
  // composer, so the band is the composer's to clear, once).
  assert.match(englishUiSource(screen), /<form className="global-chat-composer platform-safe-bar" onSubmit=\{submit\}>/);
  assert.match(englishUiSource(screen), /<div ref=\{scroll\} className="global-chat-transcript" aria-live="polite">/);
  assert.match(englishUiSource(css),
    /\.platform-safe-bar \{[^}]*padding-bottom: calc\(0\.5rem \+ max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)\) !important;/,
    'the contract the composer wears');
  // Comments off first: the rule's own note quotes the old declaration to say
  // what it replaced, and prose about a value is not the value.
  const composerRule = /\n\.global-chat-composer \{([\s\S]*?)\n\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(composerRule, 'the composer rule');
  assert.match(englishUiSource(composerRule[1]), /padding: 10px 12px 8px;/,
    'its own bottom is the safe bar\'s base gap, so desktop renders what the rule says');
  assert.doesNotMatch(englishUiSource(composerRule[1]), /var\(--platform-safe-bottom/,
    'and it no longer clears the strip alone');
  assert.match(englishUiSource(css), /@media \(max-width: 639px\)[\s\S]*\.global-chat-suggestions button \{ min-height: 42px; \}/);
  assert.match(englishUiSource(css), /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.global-chat-activity svg \{ animation: none; \}/);
  assert.match(englishUiSource(css), /\.global-chat-progress-current/);
});

test('Settings keeps navigation AI separate from development AI and reports spend', () => {
  assert.match(englishUiSource(settings), /idPrefix = embedded \? `chat-global-chat-\$\{instanceId\}` : 'settings-global-chat'/);
  assert.match(englishUiSource(settings), /id=\{`\$\{idPrefix\}-enabled`\}/);
  assert.match(englishUiSource(settings), /Enable experimental Global Chat/);
  assert.match(englishUiSource(settings), /api\.saveProfile\(\{ enabled: nextEnabled \}\)/);
  assert.match(englishUiSource(settings), /initializeGlobalChat\(\{ force: true \}\)/);
  assert.match(englishUiSource(settings), /Global Chat model/);
  assert.match(englishUiSource(settings), /Low · recommended for GLM Flash/);
  assert.match(englishUiSource(settings), /Monthly Chat cap in USD/);
  assert.match(englishUiSource(settings), /Global Chat this month/);
  assert.match(englishUiSource(settings), /Overall OpenRouter remaining/);
  assert.match(englishUiSource(settings), /Development AI settings/);
  assert.match(englishUiSource(settings), /This profile only controls Global Chat/);
});

test('rendered rows disclose locally and settings can be edited and saved in place', () => {
  assert.match(englishUiSource(renderers), /aria-expanded=\{selectionAction \? undefined : expanded\}/);
  assert.match(englishUiSource(renderers), /className="global-chat-item-toggle"/);
  assert.match(englishUiSource(renderers), /action\.mode === 'inline'/);
  assert.match(englishUiSource(renderers), /loadGlobalChatInlineResults/);
  assert.match(englishUiSource(renderers), /<GlobalChatSettingsEditor embedded \/>/);
  assert.match(englishUiSource(renderers), /<DevelopmentAISettingsEditor \/>/);
  assert.match(englishUiSource(developmentSettings), /\/api\/me\/coding-agent/);
  assert.match(englishUiSource(developmentSettings), /method: 'PATCH'/);
  assert.match(englishUiSource(developmentSettings), /Save development AI/);
  assert.match(englishUiSource(developmentSettings), /does not change the Global Chat model/);
  assert.match(englishUiSource(css), /\.global-chat-item-toggle/);
  assert.match(englishUiSource(css), /\.global-chat-result-nested/);
});
