// Source pins for the first-entry web terms prompt (#1297).
//
// The prompt lives in frontend/src/features/settings/settings.js — a classic
// module evaluated in the shell bundle, with no DOM test runner in this repo.
// Same idiom as the confirm-route pin in tests/platform-mail.test.js: assert
// the load-bearing shapes exist in the source, so a refactor that silently
// drops one of them fails here instead of in production.
//
// Run with: node --test tests/terms-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/settings/settings.js'),
  'utf8'
);

test('the prompt hooks the one-shot authed boot event', () => {
  // sv:authed fires once per page load and only for sessions that enter the
  // full shell — the waiting room returns from enterAuthed before dispatch.
  assert.match(SRC, /addEventListener\('sv:authed',[\s\S]{0,120}\{ once: true \}/);
  assert.match(SRC, /maybePromptTerms/);
});

test('the prompt never fires over screenshot fixtures or demo states', () => {
  const fn = SRC.slice(SRC.indexOf('async maybePromptTerms'));
  const head = fn.slice(0, fn.indexOf('fetch('));
  // Both guards must run BEFORE the network call, so a ?shot= route never
  // even fetches — the declared checks select on the screen underneath.
  assert.match(head, /get\('shot'\)/);
  assert.match(head, /_unDemoMode\(\)/);
});

test('only a never-responded consent prompts, and only once per (user, version)', () => {
  const fn = SRC.slice(SRC.indexOf('async maybePromptTerms'));
  // status null = never responded; 'accepted' AND 'declined' are responses.
  assert.match(fn, /consent\.status != null\) return/);
  // The once-per-browser stamp is keyed by user AND version id, so a newly
  // published version prompts again.
  assert.match(SRC, /_termsPromptSeenKey\(user, versionId\)/);
  assert.match(SRC, /'sv-terms-prompted:' \+ who \+ ':' \+ versionId/);
});
