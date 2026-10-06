'use strict';

// The waiting screen says the waitlist in its own words (#4073, #4037):
// waitlist, your spot, a few at a time and access, never queue, batches or
// your turn. frontend/src/features/auth/waiting.tsx draws the onboarding
// canvas's screen: the wordmark, "You're on the waitlist", one line, the
// invite box when a link queued a community, and Sign out. The landing's
// way back to it, for a waiting account, says the same.
//
// Run with: node --test tests/waiting-screen-words.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WAITING = 'frontend/src/features/auth/waiting.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';

/** The source with its comments taken out, so prose about old words does not count. */
function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('the waiting screen: the title, one line, the invite box, Sign out', () => {
  const src = code(read(WAITING));
  assert.match(src, />\s*You're on the waitlist\s*</);
  assert.match(src, />\s*We let people in a few at a time\.\s*</);
  // No email promise until every newcomer gets one (#4083).
  assert.doesNotMatch(src, /email you/);
  assert.match(src, /\{`When you get access, you join \$\{namesLine\(queued\.map\(\(q\) => q\.name\)\)\}\.`\}/);
  assert.match(src, /data-waiting-queued=""/);
  assert.match(src, /<Wordmark className="mx-auto h-6 w-auto text-\[color:var\(--brand-ink\)\]" \/>/);
  assert.match(src, /id="waiting-logout"[\s\S]{0,400}?>\s*Sign out\s*<\/button>/);
  // What it said before, and the two lines that went with it.
  for (const gone of [/in the queue/i, /batches/i, /your turn/i, /platform access/i, /Last checked/, /Connection issue/, /When you're let in/, /id="waiting-who"/, /id="waiting-check-state"/]) {
    assert.doesNotMatch(src, gone);
  }
  // It still lets the account in the moment access is granted.
  assert.match(src, /const POLL_MS = 30000;/);
  assert.match(src, /if \(user\.hasPlatformAccess\) \{/);
});

test('the invite box names every community a link queued, in one sentence', () => {
  const { namesLine } = loadTsx(WAITING);
  assert.equal(namesLine([]), '');
  assert.equal(namesLine(['Sunday Run Club']), 'Sunday Run Club');
  assert.equal(namesLine(['Sunday Run Club', 'Friday Film Crew']), 'Sunday Run Club and Friday Film Crew');
  assert.equal(namesLine(['A', 'B', 'C']), 'A, B and C');
});

test('the landing\'s way back to it says the waitlist too', () => {
  const src = code(read(LANDING));
  assert.match(src, /id="landing-back-to-waiting"[\s\S]{0,200}?>\s*Your spot on the waitlist\s*<\/a>/);
  assert.doesNotMatch(src, /queue status/i);
});

// The before/after shots cannot reach the waiting room: every shot persona
// either has access or has no session. `?shot=waiting` and
// `?shot=waiting-invite` boot the anonymous shell and show the room over it,
// and the room then neither checks for access nor follows a link.
test('?shot=waiting shows the room for the shots, without the poll', () => {
  const { waitingShot } = loadTsx(WAITING);
  assert.equal(waitingShot('?shot=waiting'), 'plain');
  assert.equal(waitingShot('?shot=waiting-invite'), 'invite');
  assert.equal(waitingShot('?shot=anon'), null);
  assert.equal(waitingShot(''), null);
  const src = code(read(WAITING));
  assert.match(src, /const shot = waitingShot\(location\.search\);\s+if \(shot\) \{\s+setQueued\(shot === 'invite' \? \[\{ name: 'Sunday Run Club', inviter: null \}\] : \[\]\);\s+return;\s+\}\s+startWaitingPoll\(\);/,
    'a shot returns before the poll and the invite follow');
  const app = read('public/js/app.js');
  assert.match(app, /_waitingShot\(\) \{\s+let shot = null;\s+try \{ shot = new URLSearchParams\(location\.search\)\.get\('shot'\); \} catch \(err\) \{ \/\* ignore \*\/ \}\s+return shot === 'waiting' \|\| shot === 'waiting-invite';\s+\},/);
  assert.match(app, /if \(App\._waitingShot\(\)\) \{\s+await App\.enterAnonymous\(\);\s+if \(window\.AuthScreens\) AuthScreens\.show\('waiting'\);\s+return;\s+\}/);
  // Before the real session is read, so a shot persona's own session cannot
  // take the page into the shell.
  assert.ok(app.indexOf('if (App._waitingShot()) {') < app.indexOf("await fetch('/api/auth/me'"), 'decided before /api/auth/me');
});
