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

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

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

test('making something, or looking around, answers the join screen without the Getting started card; starting answers nothing', async () => {
  const pool = fakePool([[], [], []]);
  await firstSession.answerJoinScreen(pool, 7, 'made');
  assert.match(pool.calls[0].sql, /SET needs_communities_choice = FALSE,/);
  assert.match(pool.calls[0].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE/);
  assert.doesNotMatch(pool.calls[0].sql, /communities_onboarded_at/);
  // join_answer is still how the question reached them; the answer is beside it.
  assert.match(pool.calls[0].sql, /'join_answer', COALESCE\(getting_started_seen->>'first_session', \$2::text\),\s+'first_session_answer', \$2::text\)/);
  assert.deepEqual(pool.calls[0].params, [7, 'made']);
  await firstSession.answerJoinScreenByLookingAround(pool, 9);
  assert.deepEqual(pool.calls[1].params, [9, 'looked_around']);
  // Being shown the question is recorded once, and leaves it owed.
  await firstSession.recordStart(pool, 7, 'story');
  assert.doesNotMatch(pool.calls[2].sql, /needs_communities_choice = FALSE/);
  assert.match(pool.calls[2].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE\s+AND getting_started_seen->>'first_session' IS NULL/);
  assert.deepEqual(pool.calls[2].params, [7, 'story']);
  assert.match(read('src/routes/apps.js'), /if \(req\.body\.from === 'first-session'\) \{\s+await require\('\.\.\/services\/first-session'\)\.answerJoinScreenByMaking\(pool, req\.user\.id\)/);
  const routes = read('src/routes/onboarding.js');
  assert.match(routes, /router\.post\('\/api\/me\/first-session\/started', drainGuard, sameOriginBrowserOnly,/);
  assert.match(routes, /await firstSession\.recordStart\(pool, req\.user\.id, via\);/);
  assert.match(routes, /router\.post\('\/api\/me\/first-session\/look-around', drainGuard, sameOriginBrowserOnly,/);
  assert.match(routes, /await firstSession\.answerJoinScreenByLookingAround\(pool, req\.user\.id\);/);
  // A provider's sign-up from the story records the start the same way.
  assert.match(read('src/routes/sign-in-providers.js'), /if \(state\.started_from === 'story'\) await firstSession\.recordStart\(pool, result\.userId, 'story'\);/);
  // Recorded before the account is let in, so it is open to one still waiting;
  // the answer is not (the make screen is only ever shown with access).
  const gate = read('src/middleware/auth.js');
  assert.match(gate, /'\/api\/me\/first-session\/started',\s+\];/);
  assert.doesNotMatch(gate, /first-session\/look-around/);
});

test('an account that signs in some other way is asked what to make in the join screen\'s place', () => {
  // The server: only for an account still due the join screen, while the story is on.
  const auth = read('src/routes/auth.js');
  assert.match(auth, /if \(needsCommunitiesChoice\) storyFirstSession = await firstSession\.asksWhatToMake\(pool, req\.user\.id\);/);
  assert.match(auth, /needsCommunitiesChoice,\s+\/\/[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+storyFirstSession,/);
  // The join step hands over to the island, recording itself as 'sign_in'.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /if \(window\.App\.user\.storyFirstSession === true && firstSession\) \{\s+CommunitiesFirstRun\._openFirstSession\(firstSession\);\s+return;/);
  assert.match(join, /body: JSON\.stringify\(\{ via: 'sign_in' \}\),/);
  // Opening it leaves the account's flag as the server said: only an answer clears it.
  const open = join.slice(join.indexOf('_openFirstSession(firstSession) {'), join.indexOf('_showFromSnapshot() {'));
  assert.match(open, /CommunitiesFirstRun\._answered = true;\s+firstSession\.make\(\);\s+CommunitiesFirstRun\._recordFirstSession\(\);\s+CommunitiesFirstRun\._resolve\(\);/);
  assert.doesNotMatch(open, /needsCommunitiesChoice = false/);
  // It comes before the suggestions are fetched, so the join screen is never drawn first.
  assert.ok(join.indexOf('CommunitiesFirstRun._openFirstSession(firstSession);') < join.indexOf("fetch('/api/me/join-suggestions'"));
  assert.match(read('src/routes/onboarding.js'), /const via = req\.body && req\.body\.via === 'sign_in' \? 'sign_in' : 'story';/);
  // The island opens it once, whichever of the two asks first, and draws it
  // at once when asked from the shell's own start (sv:authed, or the join
  // step in that tick), so Home is never painted before it.
  const island = read(`${DIR}/index.tsx`);
  assert.match(island, /const open = \(\) => setMode\(\(prev\) => \(prev\.kind === 'none' \? \{ kind: 'make' \} : prev\)\);\s+if \(now\) flushSync\(open\);\s+else open\(\);/);
  assert.match(island, /make\(\): boolean \{\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+openMake\(setMode, true\);/);
  assert.match(island, /if \(!flagged\) return;\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+openMake\(setMode, now\);/);
  // From the mount's own check it is an ordinary update: React is mid-effect
  // there and cannot draw synchronously.
  assert.match(island, /if \(legacy\(\)\.App\?\.user\) check\(false\);\s+const onAuthed = \(\) => check\(true\);/);
});

test('the route records which way the first session was reached', async () => {
  const pool = fakePool([[]]);
  await firstSession.recordStart(pool, 8, 'sign_in');
  assert.deepEqual(pool.calls[0].params, [8, 'sign_in']);
});

test('the landing: the story in place of the pitch unless switched off, for nobody signed in and no invite', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  // The default, so it is drawn before the options arrive, and when they fail.
  assert.match(landing, /const storyOn = waitlistPayload\?\.story_landing !== false && !onInvitePath && !session;/);
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && !!inviteTokenFrom\(location\.pathname\),\s+\);/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn \|\| invitePending;/);
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
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', 'Your own idea', 'Or start from an example', 'Not sure yet? ', 'Look around first']) {
    assert.ok(make.includes(words), words);
  }
});

// #4038 and #4040 (canvas C2-make, C2b-make-waitlist, 6 Oct 2026): a title and
// the one thing. No line under the title (it also said Homeroom bot builds
// while you invite, which is not so: the plan waits until the tour ends), no
// line under the name, and no "!".
test('the make screen says only its question: no line under the title or the name, and "Hi <name>" without "!"', () => {
  const make = read(`${DIR}/make.tsx`);
  for (const gone of ['Describe it for your group', 'while you invite', 'It\'s your group\'s name too', 'You\'re in!']) {
    assert.ok(!make.includes(gone), `no longer says: ${gone}`);
  }
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  assert.doesNotMatch(html, /tart from an example/, 'the tiles need no label');
  assert.match(html, />Hi Jordan<\/p>/);
  assert.doesNotMatch(html, /!/, 'no "!" anywhere on the screen');
  // The title is followed by the tiles, with nothing between.
  assert.match(html, /What do you want to make\?<\/h1><\/div><div class="mt-7 grid grid-cols-2 gap-2" role="group"/);
  // No name, no kicker.
  const nameless = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: '', onMade() {}, onLookAround() {} });
  assert.doesNotMatch(nameless, />Hi\b/);
});

test('it opens on the first example, chosen and filled in; their waitlist answer instead when they gave one', () => {
  const { openingAnswers } = loadTsx(`${DIR}/make.tsx`);
  const { EXAMPLES } = loadTsx(`${DIR}/examples.ts`);
  const plain = openingAnswers(null);
  assert.equal(plain.picked.key, 'run');
  assert.equal(plain.brief, EXAMPLES[0].brief);
  assert.equal(plain.name, EXAMPLES[0].name);
  assert.deepEqual(openingAnswers('   '), plain, 'an empty answer is no answer');
  assert.deepEqual(openingAnswers('  A tracker for my run club  '), { brief: 'A tracker for my run club', name: '', picked: null });
});

test('four tiles that look like buttons: the three examples and "Your own idea", the first chosen', () => {
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const tiles = [...html.matchAll(/<button type="button" aria-pressed="(true|false)" data-first-session-(example="(\w+)"|own="")[^>]*class="([^"]*)"/g)];
  assert.deepEqual(tiles.map((m) => m[3] || 'own'), ['run', 'poll', 'trip', 'own']);
  assert.deepEqual(tiles.map((m) => m[1]), ['true', 'false', 'false', 'false']);
  for (const m of tiles) {
    assert.match(m[4], /flex min-h-16 items-center/, 'at least 64px, taller when a label wraps on a narrow phone');
    assert.match(m[4], /shadow-\[0_1px_3px_rgba\(0,0,0,0\.1\),inset_0_0_0_(1px_var\(--app-sheet-line\)|2px_var\(--accent\))\]/, 'lifted, with a hairline or the accent ring');
  }
  assert.match(tiles[0][4], /inset_0_0_0_2px_var\(--accent\)/, 'the chosen one has the ring');
  assert.match(html, />Your own idea<\/span>/);
  // Both fields hold the first example's words.
  const { EXAMPLES } = loadTsx(`${DIR}/examples.ts`);
  assert.ok(html.includes(`>${EXAMPLES[0].brief.replace(/'/g, '&#x27;')}</textarea>`), 'the brief is filled');
  assert.match(html, new RegExp(`id="first-session-name"[^>]*value="${EXAMPLES[0].name}"`));
  assert.doesNotMatch(html, /Or start from an example/);
});

test('with a waitlist answer: "What should it do?" holds it, the name is theirs to give, and the examples are chips under the fields', () => {
  const idea = 'A tracker for my run club, so we can see who keeps up with their weekly miles';
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', idea, onMade() {}, onLookAround() {} });
  assert.ok(html.includes(`>${idea}</textarea>`));
  assert.match(html, /id="first-session-name"[^>]*value=""/);
  assert.match(html, /placeholder="For example, Sunday Run Club"/);
  // The fields first, then the chips, none of them chosen, and no "Your own idea".
  assert.ok(html.indexOf('id="first-session-brief"') < html.indexOf('Or start from an example'));
  const chips = [...html.matchAll(/<button type="button" aria-pressed="(true|false)" data-first-session-example="(\w+)"[^>]*class="([^"]*)"/g)];
  assert.deepEqual(chips.map((m) => m[2]), ['run', 'poll', 'trip']);
  assert.ok(chips.every((m) => m[1] === 'false'));
  assert.ok(chips.every((m) => /rounded-full/.test(m[3])), 'pills');
  assert.ok(html.indexOf('Or start from an example') < html.indexOf('data-first-session-example="run"'));
  assert.doesNotMatch(html, /data-first-session-own|Your own idea/);
  // The island hands it over from the account (GET /api/auth/me).
  const island = read(`${DIR}/index.tsx`);
  assert.match(island, /const idea = legacy\(\)\.App\?\.user\?\.waitlistIdea;/);
  assert.match(island, /<MakeScreen\s+who=\{viewerName\(\)\}\s+idea=\{waitlistIdea\(\)\}/);
});

test('the waitlist answer is the linked row\'s "What would its own app do", read only while the question is owed', async () => {
  const ok = fakePool([[{ idea: 'A tracker for my run club' }]]);
  assert.equal(await firstSession.waitlistIdea(ok, 7), 'A tracker for my run club');
  assert.match(ok.calls[0].sql, /NULLIF\(BTRIM\(answers->'group'->>'need'\), ''\) AS idea/);
  assert.match(ok.calls[0].sql, /FROM waitlist_signups\s+WHERE linked_user_id = \$1/);
  assert.deepEqual(ok.calls[0].params, [7]);
  // No row (an email-code sign-up makes none), no answer, or a failed read: the plain screen.
  assert.equal(await firstSession.waitlistIdea(fakePool([[]]), 7), null);
  assert.equal(await firstSession.waitlistIdea(fakePool([[{ idea: null }]]), 7), null);
  assert.equal(await firstSession.waitlistIdea(fakePool([new Error('boom')]), 7), null);
  // The key the stage-2 survey stores it under.
  assert.match(read('src/services/waitlist-questions.js'), /const groupNeed = str\(body\?\.group_need, 800\);\s+if \(groupNeed\) group\.need = groupNeed;/);
  const auth = read('src/routes/auth.js');
  assert.match(auth, /if \(storyFirstSession\) waitlistIdea = await firstSession\.waitlistIdea\(pool, req\.user\.id\);/);
  assert.match(auth, /storyFirstSession,\s+\/\/[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+waitlistIdea,/);
});

// Production run, iOS app, 5 Oct 2026: the keyboard's next chevron did not
// move from the description to the name; "Make it" looked disabled until a
// name was typed, beside a placeholder that read like a name already given;
// and with the keyboard up the screen scrolled "Start from an example" up
// behind the status bar.

test('"Make it" looks pale only while making: a press with an answer missing goes to that field and says what it needs', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.missingAnswer('', ''), 'brief');
  assert.equal(make.missingAnswer('too short', 'Page Turners'), 'brief', 'under BRIEF_MIN');
  assert.equal(make.missingAnswer('Our little book club, meeting monthly', '   '), 'name');
  assert.equal(make.missingAnswer('Our little book club, meeting monthly', 'Page Turners'), null);
  assert.equal(make.neededLine('brief', ''), 'Say what it should do first.');
  assert.equal(make.neededLine('brief', 'a club'), 'Say a little more about what it should do.');
  assert.equal(make.neededLine('name', 'Our little book club'), 'Give it a name to make it. You can change it later.');
  assert.equal(make.neededLine(null, ''), null);
  for (const line of ['Say what it should do first.', 'Give it a name to make it. You can change it later.']) {
    assert.doesNotMatch(line, /\u2014/, 'no em dash');
  }
  const src = read(`${DIR}/make.tsx`);
  assert.match(src, /disabled=\{busy\}/, 'never disabled for a missing answer');
  assert.doesNotMatch(src, /disabled=\{!valid/);
  // (preventScroll since 5 Oct 2026: the keyboard surface reveals the field, with Make it.)
  assert.match(src, /const gap = missingAnswer\(brief, name\);\s+if \(gap\) \{\s+setMissing\(gap\);\s+\(gap === 'brief' \? briefRef\.current : nameRef\.current\)\?\.focus\(\{ preventScroll: true \}\);\s+return;\s+\}/);
  assert.match(src, /\{missing === 'name' \? <p id="first-session-name-needed" role="alert" className=\{NEEDED\}>\{needed\}<\/p> : null\}/);
  // The placeholder reads as an example, not as a name already given.
  assert.match(src, /placeholder="For example, Sunday Run Club"/);
  assert.doesNotMatch(src, /placeholder="Sunday Run Club"/);
  // Drawn: the button is live before anything is typed.
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const button = /<button[^>]*type="submit"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(button, /\sdisabled(?:=|[\s>])/, 'no disabled attribute');
  assert.match(html, />Make it<\/button>/);
});

test('the description and the name are one sequence: Return says next and goes on, then makes it', () => {
  const src = read(`${DIR}/make.tsx`);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: '', onMade() {}, onLookAround() {} });
  // In the one form, the description first and the name straight after it.
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  const fields = [...form.matchAll(/<(textarea|input)\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(fields.length, 2);
  assert.match(fields[0], /^<textarea[^>]*id="first-session-brief"/);
  assert.match(fields[0], /enterKeyHint="next"/i);
  assert.match(fields[1], /^<input[^>]*id="first-session-name"/);
  assert.match(fields[1], /enterKeyHint="go"/i);
  assert.match(form, /<button[^>]*type="submit"/, 'Return in the name submits the form');
  // Return in the description moves on; Shift+Return and an IME's Return do not.
  assert.match(src, /if \(e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.nativeEvent\.isComposing\) return;\s+e\.preventDefault\(\);\s+nameRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(src, /ref=\{nameRef\}\s+id="first-session-name"/);
});

test('with the keyboard up nothing scrolls under the status bar: the bar stays, the form scrolls under it, inside the visible band', () => {
  const src = read(`${DIR}/make.tsx`);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const root = /<div role="dialog"[^>]*>/.exec(html)[0];
  assert.match(root, /class="platform-kb-surface fixed inset-0 z-\[9000\] flex flex-col /);
  assert.doesNotMatch(root, /overflow/, 'the screen itself does not scroll from the top of the glass');
  // The bar (with the status bar's inset) comes first, then the scroller holding the form.
  const bar = html.indexOf('pt-[env(safe-area-inset-top)]');
  const scroller = html.indexOf('data-first-session-make-scroll=""');
  assert.ok(bar > -1 && scroller > bar && html.indexOf('<form') > scroller);
  assert.match(html, /<div data-first-session-make-scroll="" class="flex min-h-0 grow flex-col overflow-y-auto">\s*<form/);
  // 5 Oct 2026 (iOS Safari): the screen is a keyboard surface, padded into
  // the band of the page that is visible while the keys are up (app.css
  // `.platform-kb-surface`), and its fields are lib/keyboard-surface.ts's: a
  // tap focuses without iOS's pan, and the focused field is revealed inside
  // the scroller with Make it under it when they fit. The scroller is what
  // the surface reveals in; the bar is above it, outside it.
  assert.match(src, /import \{ useKeyboardSurface \} from '\.\.\/\.\.\/lib\/keyboard-surface';/);
  assert.match(src, /useKeyboardSurface\(scrollerRef\);/);
  assert.doesNotMatch(src, /useComposerKeyboard/, 'one owner of the fields\' taps: the surface, not the kit\'s chat avoidance too');
  assert.match(src, /useEffect\(\(\) => \{ briefRef\.current\?\.focus\(\{ preventScroll: true \}\); \}, \[\]\);/);
  // The bar holds the whole mark under the status bar's inset (on a notched
  // phone the mark used to hang 12px out of a 52px box), so what scrolls
  // stops below it.
  assert.match(src, /<div className=\{`flex h-\[max\(52px,calc\(env\(safe-area-inset-top\)\+32px\)\)\] shrink-0 items-center justify-center pt-\[env\(safe-area-inset-top\)\] \$\{motion\}`\}>/);
  // The scroller's class string is constant.
  assert.match(src, /<div ref=\{scrollerRef\} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">/);
  // #3894's arrival is untouched: the bar and the form still rise in.
  assert.match(src, /className=\{`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] \$\{motion\}`\}/);
});

// Evan, 5 Oct 2026: a chosen example stayed chosen after he started writing
// his own description over it.
test('typing their own words into "What should it do?" lets go of the example; the name it filled stays theirs', () => {
  const src = read(`${DIR}/make.tsx`);
  // The description's onChange drops the example the moment its text is not
  // the example's own.
  assert.match(src, /onChange=\{\(e\) => \{\s+const next = e\.target\.value;\s+setBrief\(next\);\s+\/\/[^\n]*\n\s+if \(picked && next !== picked\.brief\) setPicked\(null\);/);
  // The chip is marked from `picked` alone, so it is unmarked with it.
  assert.match(src, /const on = picked\?\.key === e\.key;/);
  assert.match(src, /aria-pressed=\{on\}/);
  // Make it sends the example's description only while it is still picked
  // and its brief untouched.
  assert.match(src, /const example = picked && brief\.trim\(\) === picked\.brief \? picked : null;/);
  // The name field is not cleared by letting go of the example.
  const onChange = src.slice(src.indexOf('const next = e.target.value;'), src.indexOf('placeholder="For example, a sign-up'));
  assert.doesNotMatch(onChange, /setName\(/);

  // Executed against a React it can step by hand: pick an example, type over
  // it, and no chip is pressed any more; the name stays.
  let slots = [];
  let at = 0;
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState(init) {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useRef(init) { const k = at++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useCallback(fn) { at++; return fn; },
    useEffect() { at++; },
    useLayoutEffect() { at++; },
  };
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React } });
  const draw = () => { at = 0; return MakeScreen({ who: 'Jordan', onMade() {}, onLookAround() {} }); };
  const find = (node, test, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
    if (node.props && test(node)) out.push(node);
    if (node.props) find(node.props.children, test, out);
    return out;
  };
  const chips = (tree) => find(tree, (n) => n.props['data-first-session-example'] !== undefined);
  const brief = (tree) => find(tree, (n) => n.type === 'textarea')[0];
  const nameField = (tree) => find(tree, (n) => n.props.id === 'first-session-name')[0];
  let tree = draw();
  const first = chips(tree)[0];
  first.props.onClick();
  tree = draw();
  assert.equal(chips(tree).filter((c) => c.props['aria-pressed']).length, 1, 'the example is chosen');
  const prefilled = nameField(tree).props.value;
  assert.ok(prefilled, 'and it filled in the name');
  brief(tree).props.onChange({ target: { value: `${brief(tree).props.value} and our own twist` } });
  tree = draw();
  assert.equal(chips(tree).filter((c) => c.props['aria-pressed']).length, 0, 'their own words let go of it');
  assert.equal(nameField(tree).props.value, prefilled, 'the name it filled stays theirs');
  // Typing the example's own words back does not choose it again by itself.
  slots = [];
  tree = draw();
  chips(tree)[1].props.onClick();
  tree = draw();
  brief(tree).props.onChange({ target: { value: brief(tree).props.value } });
  tree = draw();
  assert.equal(chips(tree).filter((c) => c.props['aria-pressed']).length, 1, 'the same text is not their own words');
});

// #4038: the examples did not look like something to tap, and there was no
// choice for an idea of their own.
test('another example swaps its words in; "Your own idea" empties both fields and puts the caret in the first', () => {
  let slots = [];
  let at = 0;
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState(init) {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useRef(init) { const k = at++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useCallback(fn) { at++; return fn; },
    useEffect() { at++; },
    useLayoutEffect() { at++; },
  };
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React } });
  const { EXAMPLES } = loadTsx(`${DIR}/examples.ts`);
  const draw = () => { at = 0; return MakeScreen({ who: 'Jordan', onMade() {}, onLookAround() {} }); };
  const find = (node, test, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
    if (node.props && test(node)) out.push(node);
    if (node.props) find(node.props.children, test, out);
    return out;
  };
  const examples = (tree) => find(tree, (n) => n.props['data-first-session-example'] !== undefined);
  const ownTile = (tree) => find(tree, (n) => n.props['data-first-session-own'] !== undefined)[0];
  const brief = (tree) => find(tree, (n) => n.type === 'textarea')[0];
  const nameField = (tree) => find(tree, (n) => n.props.id === 'first-session-name')[0];
  let tree = draw();
  assert.equal(brief(tree).props.value, EXAMPLES[0].brief, 'opens on the run tracker');
  examples(tree)[2].props.onClick();
  tree = draw();
  assert.equal(brief(tree).props.value, EXAMPLES[2].brief);
  assert.equal(nameField(tree).props.value, EXAMPLES[2].name);
  assert.deepEqual(examples(tree).map((c) => c.props['aria-pressed']), [false, false, true]);
  assert.equal(ownTile(tree).props['aria-pressed'], false);
  // "Your own idea": both fields empty, its tile chosen, the caret in the first.
  let focused = null;
  brief(tree).ref.current = { focus(opts) { focused = opts; } };
  ownTile(tree).props.onClick();
  tree = draw();
  assert.equal(brief(tree).props.value, '');
  assert.equal(nameField(tree).props.value, '');
  assert.equal(ownTile(tree).props['aria-pressed'], true);
  assert.deepEqual(examples(tree).map((c) => c.props['aria-pressed']), [false, false, false]);
  assert.deepEqual(focused, { preventScroll: true });
  // Typing keeps it theirs; an example taken afterwards takes the ring back.
  brief(tree).props.onChange({ target: { value: 'A sign-up sheet for our book club' } });
  tree = draw();
  assert.equal(ownTile(tree).props['aria-pressed'], true);
  examples(tree)[1].props.onClick();
  tree = draw();
  assert.equal(ownTile(tree).props['aria-pressed'], false);
  assert.equal(brief(tree).props.value, EXAMPLES[1].brief);
});

test('the make screen sends the device\'s time zone with Make it, so the sketch\'s today is the maker\'s', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  const zone = make.deviceTimeZone();
  assert.ok(zone === null || (typeof zone === 'string' && zone.length > 0));
  assert.match(read(`${DIR}/make.tsx`), /from: 'first-session',\s+\/\/[^\n]*\n\s+\.\.\.\(timeZone \? \{ timeZone \} : \{\}\),/);
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
  // WP-D: until it is turned off, for anyone it reaches (0 is no limit).
  assert.match(src, /const LINK_DAYS = 0;\s+const LINK_USES = 0;/);
  assert.equal(require('../src/services/community-invites').NO_LIMIT, 0);
  assert.match(src, /Anyone with the link can join, until you turn it off\./);
  // Evan, 5 October 2026: the first invite is a link and nothing else. No
  // invite by username (somebody brand new knows nobody on Homeroom yet), and
  // no joining-rule line ("With one other person using it, a change goes
  // live when you both say yes, …"): both stay in the project's own invite
  // pane (features/app-context/invite-pane.tsx).
  assert.doesNotMatch(src, /joiningRule|setRule|Invite by username|\/invites`/);
  const sheet = renderToHtml(createElement(made.InviteSheet, {
    made: { slug: 'page-turners', name: 'Page Turners', emoji: '📚', description: null, example: null, conversationId: 3 },
    me: 'alex', onClose() {}, onSent() {},
  }));
  assert.match(sheet, />Share link</);
  assert.doesNotMatch(sheet, /username|say yes|goes live/i);
  assert.match(read('frontend/src/features/app-context/invite-pane.tsx'), /joiningRule/, 'the project\'s own pane keeps the rule');
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

// 5 October 2026 (Evan, on his phone): 7 of 7 cut the bot's messages out of
// the dim and left the conversation's header ("Homeroom bot AI · <Project>
// needs you", the clock and ⋯) under it, and the newest card began part-way
// down, with bullets and no "Here's my plan for …". He read it as the chat
// missing its header.
test('the maker\'s last step shows the chat with Homeroom bot whole: its header with its messages, the newest card from its top', () => {
  const { makerSteps, BOT_CHAT_HEADER, BOT_CHAT_MESSAGES } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  const chat = steps[6];
  assert.equal(chat.title, 'Your chat with Homeroom bot');
  assert.equal(BOT_CHAT_HEADER, '.messages-thread-direct > .messages-thread-header');
  assert.equal(BOT_CHAT_MESSAGES, '.messages-thread-direct > .messages-thread-scroll');
  // One cut-out round both (index.tsx targetBox draws a selector list as one box).
  assert.deepEqual(chat.target.split(',').map((s) => s.trim()), [BOT_CHAT_HEADER, BOT_CHAT_MESSAGES]);
  assert.deepEqual(chat.newestFromTop, { scroller: BOT_CHAT_MESSAGES, rows: 'article.messages-message' });
  assert.equal(chat.place, 'bottom');
  assert.equal(chat.text, 'It shows how the build is going here, and messages you when it\'s ready to try. Ask it for changes any time.');
  // And the platform's top bar over them, as one cut-out (Evan, 5 Oct 2026:
  // "include the header on step 7 also").
  assert.equal(chat.alongside, '#platform-header');
  assert.equal(chat.endsAbove, undefined, 'the transcript ends at the composer, above the tab bar');
  // The other steps' targets (the close step cuts out the app screen, with
  // ✕ its press: tests/first-session.test.js), and only this one moves a
  // transcript.
  assert.deepEqual(steps.slice(0, 6).map((s) => s.target), [
    '.app-card[data-slug="film"]', '#app-content', '#app-view', '#platform-tab-workshop', '#app-content', '#platform-tab-messages',
  ]);
  assert.equal(steps[2].press, '#back-btn');
  assert.deepEqual(steps.map((s) => !!s.newestFromTop), [false, false, false, false, false, false, true]);
  // The Messages screen draws what it names: a direct conversation's section,
  // whose first child is its header (none when embedded in a hub, which the
  // bot's chat never is), its scroller, and an <article> per message.
  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /const kind = snap\.active\?\.kind \|\| 'direct';/);
  assert.match(messages, /<section className=\{`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-\$\{kind\}[^`]*`\}[^>]*>\s*\{embedded \? null : <ThreadHeader \/>\}/);
  assert.match(messages, /function ThreadHeader\(\) \{[\s\S]*?return \(\s*<header className="messages-thread-header">/);
  assert.match(messages, /<div ref=\{scroller\} className="messages-thread-scroll platform-safe-scroll" aria-live="polite">/);
  assert.match(read('frontend/src/features/messages/message-row.tsx'),
    /<article id=\{`messages-message-\$\{message\.id\}`\} data-message-id=\{message\.id\} className=\{`messages-message group /);
});

test('the newest card is shown from its top: scrolled back just far enough, never forward', () => {
  const { scrollBackFor, showNewestFromTop } = loadTsx(`${DIR}/index.tsx`);
  assert.equal(scrollBackFor(120, 60), 68, 'its first line above the transcript: back to 8px under its top');
  assert.equal(scrollBackFor(120, 128), 0);
  assert.equal(scrollBackFor(120, 400), 0, 'lower down is in view: never forward');
  assert.equal(scrollBackFor(120, 119.5), 9, 'whole pixels, rounded up');

  const box = (top, height = 40) => ({ getBoundingClientRect: () => ({ top, height }) });
  const transcript = ({ top = 120, height = 500, scrollTop = 900, rows = [] } = {}) => {
    const el = { scrollTop, ...box(top, height), querySelectorAll: (sel) => { el.asked = sel; return rows; } };
    return el;
  };
  const rootOf = (...scrollers) => ({ querySelectorAll: (sel) => { rootOf.asked = sel; return scrollers; } });
  const spec = { scroller: '.messages-thread-direct > .messages-thread-scroll', rows: 'article.messages-message' };

  // The plan card, newest and taller than the space: its top 60px above.
  const hidden = transcript({ height: 0, rows: [box(-400)] });
  const shown = transcript({ rows: [box(-300), box(60, 700)] });
  assert.equal(showNewestFromTop(spec, rootOf(hidden, shown)), true);
  assert.equal(rootOf.asked, spec.scroller);
  assert.equal(shown.asked, spec.rows);
  assert.equal(shown.scrollTop, 900 - 68, 'the visible transcript, not one drawn nowhere');
  assert.equal(hidden.scrollTop, 900);
  // Already from its top, a short newest message, nothing loaded yet, or no
  // transcript at all: nothing moves.
  const fits = transcript({ rows: [box(130)] });
  assert.equal(showNewestFromTop(spec, rootOf(fits)), false);
  assert.equal(fits.scrollTop, 900);
  assert.equal(showNewestFromTop(spec, rootOf(transcript({ rows: [box(520)] }))), false);
  assert.equal(showNewestFromTop(spec, rootOf(transcript())), false);
  assert.equal(showNewestFromTop(spec, rootOf()), false);
  // Never past the transcript's start.
  const near = transcript({ scrollTop: 20, rows: [box(-200, 900)] });
  assert.equal(showNewestFromTop(spec, rootOf(near)), true);
  assert.equal(near.scrollTop, 0);

  // Each frame, before the cut-out is measured, so the ring is drawn round
  // what it shows, and it holds when the rows arrive after the step lands.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const reveal = stepRef\.current\.newestFromTop;\s+if \(reveal\) showNewestFromTop\(reveal\);\s+const m = measure\(at, stepRef\.current\);/);
});

test('the admin Journey page says which first session answered the join screen', () => {
  assert.match(read('src/services/journey.js'),
    /note: seen\.join_answer \? `not asked: \$\{seen\.join_answer\}` : 'not asked', weak: true/);
});
