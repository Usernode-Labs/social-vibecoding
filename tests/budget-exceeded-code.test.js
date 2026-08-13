// #463: budget-exhaustion 429s must be distinguishable from rate-limit
// 429s so the client can show "you're out of free credits — add your own
// API key" instead of "Rate limit reached".
//
// Source-level checks (same style as the SELECT check in
// chat-edit-render.test.js): every `resolveBillingPath → 429` site that a
// browser client consumes tags its body with code: 'budget_exceeded',
// while the generic rate-limit middleware stays untagged — that contrast
// is exactly what the dev-chat 429 branch keys on.
//
// Run with: node --test tests/budget-exceeded-code.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const TAGGED_429 =
  /res\.status\(429\)\.json\(\{\s*error: billing\.error,\s*code: 'budget_exceeded',/g;

test('sessions.js tags both billing 429s (chat turn + headless start) with budget_exceeded', () => {
  const src = read('src/routes/sessions.js');
  const tagged = src.match(TAGGED_429) || [];
  assert.equal(tagged.length, 2,
    'expected exactly the chat-turn and headless-session billing 429s to carry the code');
  // No billing 429 left untagged. Extra entitlement fields are allowed so
  // the client can render a direct identity-unlock action.
  assert.doesNotMatch(src,
    /res\.status\(429\)\.json\(\{ error: billing\.error \}\)/,
    'a bare billing 429 (no code) would be indistinguishable from a throttle');
});

// (#827 removed routes/proposal-discuss.js — the "Ask AI" advisor and its
// own billing 429 — so sessions.js is the only remaining browser-facing
// resolveBillingPath site.)

test('rate-limit middleware 429s stay code-free (the discriminator the client relies on)', () => {
  const src = read('src/middleware/rate-limits.js');
  assert.doesNotMatch(src, /budget_exceeded/,
    'throttle responses must NOT claim budget exhaustion');
});

test('dev-chat branches the 429 handler on the budget_exceeded code', () => {
  const src = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(src, /data\.code === 'budget_exceeded'/,
    'the chat send path distinguishes budget exhaustion from throttling');
  assert.match(src, /free AI credits/,
    'the budget branch names the actual problem');
});
