'use strict';
const { englishUiSource } = require("./lib/english-ui-source");

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

test('the story landing is on unless switched off, and on when the setting cannot be read', async () => {
  assert.equal(firstSession.STORY_KEY, 'first_session_story');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[]])), true, 'no row is the default: on');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[{ value: 'false' }]])), false);
  assert.equal(await firstSession.storyLandingEnabled(fakePool([new Error('relation does not exist')])), true);
  // A save forgets the cached read.
  const pool = fakePool([[{ value: 'true' }], [], [{ value: 'false' }]]);
  assert.equal(await firstSession.storyLandingEnabled(pool), true);
  await firstSession.setStoryLanding(pool, { enabled: false, actorId: 9 });
  assert.equal(await firstSession.storyLandingEnabled(pool), false);
  assert.deepEqual(pool.calls[1].params.slice(0, 2), ['first_session_story', 'false']);
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

test('an account that signs in some other way is asked what to make in the join screen\'s place', () => {
  // The server: only for an account still due the join screen, while the story is on.
  const auth = read('src/routes/auth.js');
  assert.match(auth, /if \(needsCommunitiesChoice\) storyFirstSession = await firstSession\.storyLandingEnabled\(pool\);/);
  assert.match(auth, /needsCommunitiesChoice,\s+\/\/[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+storyFirstSession,/);
  // The join step hands over to the island, answering itself as 'sign_in'.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /if \(window\.App\.user\.storyFirstSession === true\s+&& firstSession && typeof firstSession\.make === 'function'\) \{/);
  assert.match(join, /body: JSON\.stringify\(\{ via: 'sign_in' \}\),/);
  assert.match(join, /window\.App\.user\.needsCommunitiesChoice = false;\s+firstSession\.make\(\);\s+CommunitiesFirstRun\._resolve\(\);\s+return;/);
  // It comes before the suggestions are fetched, so the join screen is never drawn first.
  assert.ok(join.indexOf('firstSession.make()') < join.indexOf("fetch('/api/me/join-suggestions'"));
  assert.match(read('src/routes/onboarding.js'), /const answer = req\.body && req\.body\.via === 'sign_in' \? 'sign_in' : 'story';/);
  // The island opens it once, whichever of the two asks first.
  const island = read(`${DIR}/index.tsx`);
  assert.match(island, /make\(\): boolean \{\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+setMode\(\(prev\) => \(prev\.kind === 'none' \? \{ kind: 'make' \} : prev\)\);/);
  assert.match(island, /if \(!flagged\) return;\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+setMode\(\(prev\) => \(prev\.kind === 'none' \? \{ kind: 'make' \} : prev\)\);/);
});

test('the route records which way the first session was reached', async () => {
  const pool = fakePool([[]]);
  await firstSession.answerJoinScreen(pool, 8, 'sign_in');
  assert.deepEqual(pool.calls[0].params, [8, 'sign_in']);
});

test('the landing: the story in place of the pitch unless switched off, for nobody signed in and no invite', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  // The default, so it is drawn before the options arrive, and when they fail.
  assert.match(englishUiSource(landing), /const storyOn = waitlistPayload\?\.story_landing !== false && !onInvitePath && !session;/);
  assert.match(englishUiSource(landing), /useState\(\s+\(\) => typeof location !== 'undefined' && !!inviteTokenFrom\(location\.pathname\),\s+\);/);
  assert.match(englishUiSource(landing), /const pitchHidden = madeForYou \|\| storyOn \|\| invitePending;/);
  assert.match(englishUiSource(landing), /<Story primaryClass=\{PRIMARY_PILL\} onStart=\{\(\) => setSheet\('start'\)\} onSignIn=\{\(\) => setSheet\('signin'\)\} \/>/);
  // A new account from its sheet is asked what to make, not which communities to join.
  assert.match(englishUiSource(landing), /sessionStorage\.setItem\('usernode:first-session:make', '1'\)/);
  assert.match(englishUiSource(landing), /fetch\('\/api\/me\/first-session\/started', \{ method: 'POST', credentials: 'same-origin' \}\)/);
  const story = read('frontend/src/features/auth/story.tsx');
  for (const words of ['On Homeroom, communities make apps together.', 'Anyone using an app can change it. Your group decides what goes in.', 'What groups make', 'Get started', 'Already have an account? ']) {
    assert.ok(englishUiSource(story).includes(words), words);
  }
  // No waitlist ask and no "learn more" link on it.
  assert.doesNotMatch(englishUiSource(story), /Join the waitlist|Learn more about Homeroom/i);
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
  assert.match(englishUiSource(make), /fetch\('\/api\/apps', \{/);
  assert.match(englishUiSource(make), /audience: 'invited',\s+brief: brief\.trim\(\),/);
  assert.match(englishUiSource(make), /from: 'first-session',/);
  assert.match(englishUiSource(make), /export const BRIEF_MIN = 10;/);
  assert.match(englishUiSource(read('frontend/src/features/dialogs/create-app.tsx')), /BRIEF_MIN = 10/);
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', 'It\'s your group\'s name too. You can change it later.', 'Look around first']) {
    assert.ok(englishUiSource(make).includes(words), words);
  }
});

test('after Make it: the build\'s step, then one invite, and the second button says where it goes', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.buildLine({ step: 2, of: 7, stepName: 'Read the description' }, 'running'), 'Step 2 of 7: Read the description');
  assert.equal(made.buildLine({ ready: true }, 'running'), 'Version one is ready to try.');
  assert.equal(made.buildLine(null, 'creating'), 'Setting it up…');
  assert.equal(made.buildLine(null, 'running'), 'Homeroom bot builds it from your description.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(englishUiSource(src), /\{sent \? 'Go to the Homeroom app' : 'Invite people later'\}/);
  // The link outlives a week, and the note is said to be the first message.
  assert.match(englishUiSource(src), /body: JSON\.stringify\(\{ days: LINK_DAYS, maxUses: LINK_USES, note: note\.trim\(\) \|\| null \}\)/);
  // WP-D: until it is turned off, for anyone it reaches (0 is no limit).
  assert.match(englishUiSource(src), /const LINK_DAYS = 0;\s+const LINK_USES = 0;/);
  assert.equal(require('../src/services/community-invites').NO_LIMIT, 0);
  assert.match(englishUiSource(src), /Anyone with the link can join, until you turn it off\./);
  assert.match(englishUiSource(src), /setRule\(data\.joiningRule\)/);
  assert.match(englishUiSource(src), /Your note is also your first message in the group chat\./);
  assert.match(englishUiSource(src), /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/messages`/);
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
