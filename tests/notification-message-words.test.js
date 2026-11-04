// #5929 item 3: a chat message's words on a bell row are a readable title,
// not the raw message. The row's label still says what kind of thing it is
// ("Mentioned you", "Replied on request #12", "@jordan in Flat 4B Chores");
// the words under it are what was said with its markdown stripped, its lines
// joined, and cut at the last whole word with "…" — the same cut the bot's
// own replies already got (bellWords). A bare `slice(0, 140)` used to put
// "Feedback: This is a strong settings screen. The copy is clear and the" on
// the row, mid-word, which read as a title nobody wrote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const CLIENT = read('frontend/src/features/notifications/notifications.js')
  .replace(/^import \{ agoStamp \}.*$/m, '');

function loadClient() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 1 }, openAppTab() {}, _isScreenVisible: () => false },
    UsernodeReact: { messages: { openDiscussion() {} } },
    GroupChat: { revealMessage() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CLIENT, sandbox);
  const N = sandbox.Notifications;
  N._renderBadge = () => {};
  N._renderList = () => {};
  N.refresh = async () => true;
  return N;
}

const AT = new Date().toISOString();
const LONG = '**Feedback:** This is a strong settings screen. The copy is clear and the defaults '
  + 'are privacy-friendly. Here is what works and what I would change about the helper text, '
  + 'the toggles and the analytics paragraph.';
const row = (over) => ({
  id: 41, readAt: null, createdAt: AT, appSlug: 'flat-4b', appName: 'Flat 4B Chores',
  chatMessageId: 812, sourceUsername: 'jordan', detail: null, ...over,
});
const words = (view) => (view.segments || []).map((s) => s.v).join('');

test('a mention\'s title is the message\'s words: no markdown, cut at a whole word', () => {
  const N = loadClient();
  const view = N._rowView(row({ kind: 'mention', messageContent: LONG }));
  assert.equal(view.label, 'Mentioned you');
  const title = words(view);
  assert.ok(title.startsWith('Feedback: This is a strong settings screen.'), title);
  assert.doesNotMatch(title, /\*\*/, 'markdown stripped');
  assert.ok(title.endsWith('…'), 'cut with an ellipsis');
  assert.ok(title.length <= 140, 'no longer than the bot\'s own replies');
  const body = title.slice(0, -1);
  assert.ok(LONG.replace(/\*\*/g, '').startsWith(body), 'the cut keeps whole words');
  assert.doesNotMatch(body, / $/, 'no trailing space before the ellipsis');
});

test('a short message is shown whole, and a multi-line one is one line', () => {
  const N = loadClient();
  const short = N._rowView(row({ kind: 'reply', messageContent: 'Which one do we go with?' }));
  assert.equal(words(short), 'Which one do we go with?');
  const lines = N._rowView(row({ kind: 'thread_reply', messageContent: 'First line\n\nSecond line' }));
  assert.equal(words(lines), 'First line Second line');
});

test('the same cut serves a conversation message, a channel message and a reaction', () => {
  const N = loadClient();
  const conv = N._rowView(row({ kind: 'conversation_message', conversationKind: 'direct', messageContent: LONG }));
  assert.ok(words(conv).endsWith('…') && !words(conv).includes('**'));
  const channel = N._rowView(row({ kind: 'channel_message', messageContent: LONG }));
  assert.ok(words(channel).endsWith('…') && !words(channel).includes('**'));
  const reaction = N._rowView(row({ kind: 'reaction', messageContent: LONG }));
  assert.ok(words(reaction).endsWith('…') && !words(reaction).includes('**'));
});

test('the source no longer cuts a message body with a bare slice', () => {
  const src = read('frontend/src/features/notifications/notifications.js');
  assert.doesNotMatch(src, /\(n\.messageContent \|\| ''\)\.slice\(0, 140\)/);
  assert.match(src, /function messageWords\(content\) \{\n  return bellWords\(plainMarkdown\(content\)\);/);
});
