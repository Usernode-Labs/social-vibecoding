// #1584 — the Activity feed's inline reply is a real multiline composer.
//
// Run with: node --test tests/activity-reply-composer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SOURCE = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const INPUT = read('frontend/@/components/ui/input.tsx');
const dapp = JSON.parse(read('dapp.json'));

let api = null;
const mod = () => (api || (api = loadTsx(
  'frontend/src/features/dev-board/card/feed-thread.tsx'
)));

function composerHtml(draft, posting = false) {
  return renderToHtml(createElement(mod().FeedReplyComposer, {
    draft,
    posting,
    onDraftChange: () => {},
    onSubmit: () => {},
  }));
}

test('the reply is a one-row textarea that grows with its controlled value', () => {
  assert.match(SOURCE, /useAutoGrow\(inputRef, draft\)/,
    'typing, pasting and clearing all remeasure through the shared hook');
  assert.match(SOURCE, /<Textarea[\s\S]*?rows=\{1\}[\s\S]*?value=\{draft\}/);
  const component = SOURCE.slice(
    SOURCE.indexOf('export function FeedReplyComposer'),
    SOURCE.indexOf('\nexport function FeedThread')
  );
  assert.doesNotMatch(component, /onKeyDown/,
    'plain Enter keeps the textarea default: insert a newline');

  const html = composerHtml('First line\nSecond line');
  assert.match(html, /<textarea[^>]*rows="1"[^>]*>First line\nSecond line<\/textarea>/,
    'multiline reply content survives the render');
});

test('growth has a CSS ceiling and keeps overflow reachable', () => {
  const recipe = INPUT.slice(
    INPUT.indexOf('activityReply:'),
    INPUT.indexOf('// The DEV chat', INPUT.indexOf('activityReply:'))
  );
  assert.match(recipe, /\bmax-h-24\b/, 'the compact feed composer stops at its declared ceiling');
  assert.match(recipe, /\boverflow-y-auto\b/, 'additional lines scroll instead of being clipped');
  assert.match(recipe, /\bresize-none\b/, 'content, rather than a drag handle, owns its height');
});

test('the send arrow is always present and reflects whether it can submit', () => {
  const empty = composerHtml('');
  assert.match(empty,
    /<button(?=[^>]*type="submit")(?=[^>]*disabled="")(?=[^>]*aria-label="Send reply")[^>]*>/);
  assert.match(empty, /<button[^>]*\bun-touch-target\b/,
    'the compact arrow keeps a 44px touch target');
  assert.match(empty, /<svg[^>]*class="h-3\.5 w-3\.5"/, 'the action is an icon, not a hidden text button');

  const ready = composerHtml('First line\nSecond line');
  assert.match(ready, /<button[^>]*type="submit"[^>]*aria-label="Send reply"/);
  assert.doesNotMatch(ready, /<button[^>]*type="submit"[^>]*disabled=""/,
    'a non-empty multiline reply enables the arrow');

  const posting = composerHtml('Still here', true);
  assert.match(posting,
    /<button(?=[^>]*type="submit")(?=[^>]*disabled="")(?=[^>]*aria-label="Send reply")[^>]*>…<\/button>/,
    'the arrow remains in place but locks while the post is in flight');
});

test('submission and row-navigation behavior stay on their existing seams', () => {
  const submit = SOURCE.slice(SOURCE.indexOf('const submit = useCallback'), SOURCE.indexOf('const hidden'));
  assert.match(submit, /const content = draft\.trim\(\)/);
  assert.match(submit, /method: 'POST'/);
  assert.match(submit, /thread_type: type, thread_ref: refId/);
  assert.match(SOURCE, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/,
    'using the composer does not open its Activity row');
});

test('the Activity staging route requires both the textarea and arrow', () => {
  const check = dapp.tests.find((entry) => entry.name.includes('#1584'));
  assert.ok(check, 'a declared check names this change');
  assert.equal(check.path, '/?demo=1#app/usernode-2d5619/activity');
  assert.match(check.expectSelector, /textarea\[aria-label="Reply to this item"\]/);
  assert.match(check.expectSelector, /button\[aria-label="Send reply"\]:disabled/);
});
