'use strict';

// The first session for somebody who arrives on their own: the signed-out
// story (frontend/src/features/auth/story.tsx), its switch
// (src/services/first-session.js), "What do you want to make?"
// (frontend/src/features/first-session/make.tsx), what comes after it
// (./made.tsx) and the maker's tour. Pins the words, the switch's failure
// direction, and the seams to the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const firstSession = require('../src/services/first-session');

function fakePool(rowsByCall) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = rowsByCall.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('the story landing is off unless switched on, and off when the setting cannot be read', async () => {
  assert.equal(firstSession.STORY_KEY, 'first_session_story');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[]])), false, 'no row is off');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[{ value: 'true' }]])), true);
  assert.equal(await firstSession.storyLandingEnabled(fakePool([new Error('relation does not exist')])), false);
  // A save forgets the cached read.
  const pool = fakePool([[{ value: 'false' }], [], [{ value: 'true' }]]);
  assert.equal(await firstSession.storyLandingEnabled(pool), false);
  await firstSession.setStoryLanding(pool, { enabled: true, actorId: 9 });
  assert.equal(await firstSession.storyLandingEnabled(pool), true);
  assert.deepEqual(pool.calls[1].params.slice(0, 2), ['first_session_story', 'true']);
});

test('the options carry the switch, and the admin switches it beside the invite setting', () => {
  assert.match(read('src/routes/public-api.js'), /story_landing: await firstSession\.storyLandingEnabled\(pool\),/);
  const admin = read('src/routes/topochain/admin/waitlist.js');
  assert.match(admin, /router\.get\('\/api\/v4\/admin\/story-landing',/);
  assert.match(admin, /router\.put\('\/api\/v4\/admin\/story-landing', adminWriteGate,/);
  const screen = read('frontend/src/features/admin/topochain/waitlist.tsx');
  assert.match(screen, /<InviteTreePanel \/>\s+<StoryLandingPanel \/>/);
  assert.match(screen, /id="admin-topo-wl-story-enabled"/);
});

test('making something, or starting from the story, answers the join screen without the Getting started card', async () => {
  const pool = fakePool([[]]);
  await firstSession.answerJoinScreen(pool, 7, 'story');
  assert.match(pool.calls[0].sql, /SET needs_communities_choice = FALSE,/);
  assert.match(pool.calls[0].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE/);
  assert.doesNotMatch(pool.calls[0].sql, /communities_onboarded_at/);
  assert.deepEqual(pool.calls[0].params, [7, 'story']);
  assert.match(read('src/routes/apps.js'), /if \(req\.body\.from === 'first-session'\) \{\s+await require\('\.\.\/services\/first-session'\)\.answerJoinScreenByMaking\(pool, req\.user\.id\)/);
  assert.match(read('src/routes/onboarding.js'), /router\.post\('\/api\/me\/first-session\/started', drainGuard, sameOriginBrowserOnly,/);
  // Recorded before the account is let in, so it is open to one still waiting.
  assert.match(read('src/middleware/auth.js'), /'\/api\/me\/first-session\/started',\s+\];/);
});

test('the landing: the story in place of the pitch, only when switched on, for nobody signed in and no invite', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const storyOn = waitlistPayload\?\.story_landing === true && !onInvitePath && !session;/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn;/);
  assert.match(landing, /<Story primaryClass=\{PRIMARY_PILL\} onStart=\{\(\) => setSheet\('start'\)\} onSignIn=\{\(\) => setSheet\('signin'\)\} \/>/);
  // A new account from its sheet is asked what to make, not which communities to join.
  assert.match(landing, /sessionStorage\.setItem\('usernode:first-session:make', '1'\)/);
  assert.match(landing, /fetch\('\/api\/me\/first-session\/started', \{ method: 'POST', credentials: 'same-origin' \}\)/);
  const story = read('frontend/src/features/auth/story.tsx');
  for (const words of ['On Homeroom, communities make apps together.', 'Anyone using an app can change it. Your group decides what goes in.', 'What groups make', 'Get started', 'Already have an account? ']) {
    assert.ok(story.includes(words), words);
  }
  // No waitlist ask and no "learn more" link on it.
  assert.doesNotMatch(story, /Join the waitlist|Learn more about Homeroom/i);
});

test('three examples, the same on the story and the make screen, each a whole starting point', () => {
  const { EXAMPLES } = loadTsx(`${DIR}/examples.ts`);
  assert.deepEqual(EXAMPLES.map((e) => e.key), ['run', 'poll', 'trip']);
  for (const e of EXAMPLES) {
    assert.ok(e.brief.length >= 10, `${e.key} brief meets BRIEF_MIN`);
    assert.ok(e.description.length <= 90, `${e.key} description fits DESCRIPTION_MAX`);
    assert.ok(e.note.length <= 280, `${e.key} note fits a link's note`);
    for (const k of ['emoji', 'title', 'line', 'short', 'name']) assert.ok(e[k], `${e.key}.${k}`);
  }
});

test('"Make it" makes a private community through the dialog\'s own route', () => {
  const make = read(`${DIR}/make.tsx`);
  assert.match(make, /fetch\('\/api\/apps', \{/);
  assert.match(make, /audience: 'invited',\s+brief: brief\.trim\(\),/);
  assert.match(make, /from: 'first-session',/);
  assert.match(make, /export const BRIEF_MIN = 10;/);
  assert.match(read('frontend/src/features/dialogs/create-app.tsx'), /BRIEF_MIN = 10/);
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', 'It\'s your group\'s name too. You can change it later.', 'Look around first']) {
    assert.ok(make.includes(words), words);
  }
});

test('after Make it: the build\'s step, then one invite, and the second button says where it goes', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.buildLine({ step: 2, of: 7, stepName: 'Read the description' }, 'running'), 'Step 2 of 7: Read the description');
  assert.equal(made.buildLine({ ready: true }, 'running'), 'Version one is ready to try.');
  assert.equal(made.buildLine(null, 'creating'), 'Setting it up…');
  assert.equal(made.buildLine(null, 'running'), 'Homeroom bot builds it from your description.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /\{sent \? 'Go to the Homeroom app' : 'Invite people later'\}/);
  // The link outlives a week, and the note is said to be the first message.
  assert.match(src, /body: JSON\.stringify\(\{ days: LINK_DAYS, maxUses: LINK_USES, note: note\.trim\(\) \|\| null \}\)/);
  assert.match(src, /const LINK_DAYS = 30;\s+const LINK_USES = 100;/);
  assert.match(src, /Your note is also your first message in the group chat\./);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/messages`/);
  const invites = require('../src/services/community-invites');
  assert.equal(invites.LIMITS.maxDays, 30);
  assert.equal(invites.LIMITS.maxUses, 100);
});

test('the maker\'s tour ends in Homeroom bot\'s chat when it builds for them, and on the hub when not', () => {
  const { makerSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const withBot = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  assert.deepEqual(withBot.map((s) => s.screen), ['home', 'app', 'app', 'home', 'hub', 'hub', 'bot']);
  assert.equal(withBot[5].target, '#platform-tab-messages');
  assert.equal(withBot[5].opensNext, true);
  assert.equal(withBot[6].last, true);
  const without = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: null });
  assert.deepEqual(without.map((s) => s.screen), ['home', 'app', 'app', 'home', 'hub']);
  assert.equal(without[4].last, true);
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /else if \(screen === 'bot' && conversationId\) window\.location\.hash = `#messages\/\$\{conversationId\}`;/);
});

test('the admin Journey page says which first session answered the join screen', () => {
  assert.match(read('src/services/journey.js'),
    /note: seen\.join_answer \? `not asked: \$\{seen\.join_answer\}` : 'not asked', weak: true/);
});
