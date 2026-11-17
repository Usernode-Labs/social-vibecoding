// #463: budget-exhaustion 429s must be distinguishable from rate-limit
// 429s so a client can show "you're out of free credits — add your own
// API key" instead of "Rate limit reached".
//
// A budget refusal carries code: 'budget_exceeded' (routes/workshop-ask.js,
// routes/report-ai.js, the proxies); these source-level checks pin the other
// half of that contrast, that the generic rate-limit middleware stays
// untagged, and that checkBudget (#1788) names the weekly refusal and the
// no-allowance one under reasons of their own.
//
// Run with: node --test tests/budget-exceeded-code.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('rate-limit middleware 429s stay code-free (the discriminator the client relies on)', () => {
  const src = read('src/middleware/rate-limits.js');
  assert.doesNotMatch(src, /budget_exceeded/,
    'throttle responses must NOT claim budget exhaustion');
});

test('checkBudget names the weekly refusal and the no-allowance one', () => {
  const src = read('src/services/limits.js');
  assert.match(src, /reason: 'weekly_limit'/,
    'a spent weekly cap is its own reason, not a second flavour of user_limit');
  assert.match(src, /Weekly limit reached \(\$\$\{[\s\S]{0,80}\}\)\. Resets \$\{WEEKLY_RESET_LABEL\}\./,
    'and its sentence names the weekly boundary, from the shared label constant');

  assert.match(src, /reason: 'no_allowance'/,
    'the weekly cap switched off fails closed under its own reason');
  assert.match(src, /An admin can set a weekly cap in the admin console\./,
    'whose copy points at the fix rather than at identity verification');
  assert.doesNotMatch(src, /no_allowance'[\s\S]{0,400}Connect GitHub or X/,
    'an admin decision is not an identity problem');
});
