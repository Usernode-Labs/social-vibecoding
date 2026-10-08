'use strict';

// "Your community, started" (#4041, #4042): the screen right after Make it
// (frontend/src/features/first-session/made.tsx), its invite sheet, the
// screen after sharing, and the people row (./people-row.tsx).
//
// Evan's test on iPhone, 6 October 2026: the screen led with the build, a
// "Needs you" card asked for the plan before anyone was invited, and after
// sharing "Go to the Homeroom app" did not say where it led. The canvas boards
// C3-started, C4-invite-sheet and C5-shared: the community first, one quiet
// line, and buttons that keep their places (owner, 8 October 2026). The
// sheet's Copy link on a computer is #4180's (tests/first-session-copy-link).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const SRC = read(`${DIR}/made.tsx`);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const made = loadTsx(`${DIR}/made.tsx`);
const people = loadTsx(`${DIR}/people-row.tsx`);


const MADE = { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 };
const draw = (props) => renderToHtml(createElement(made.MadeScreen, { made: MADE, me: 'maya', onContinue() {}, onOpenChat() {}, ...props }));

test('the words: the community first, one quiet line, buttons that say what comes next', () => {
  assert.equal(message(made.COMMUNITY_LABEL), 'Your new community');
  assert.equal(message(made.INVITE_HINT), 'Invite people to use it and help improve it together.');
  assert.equal(message(made.PREVIEW_LABEL), 'What they\'ll see');
  assert.equal(made.sharedLine('shared'), 'Invite shared. Next, a short tour.');
  // Where there is no share sheet, the link is copied (decided 6 October 2026).
  assert.equal(made.sharedLine('copied'), 'Link copied. Next, a short tour.');
  // From Create there is no tour to be next.
  assert.equal(made.sharedLine('shared', false), 'Invite shared.');
  assert.equal(made.sharedLine('copied', false), 'Link copied.');
  assert.equal(made.continueLabel('first-session', true, 'Plant Pal'), 'Start the tour');
  assert.equal(made.continueLabel('first-session', false, 'Plant Pal'), 'Invite people later');
  for (const words of [message(made.COMMUNITY_LABEL), message(made.INVITE_HINT), message(made.PREVIEW_LABEL), made.sharedLine('shared'), made.sharedLine('copied'), message(made.NO_BOT_NOTE)]) {
    assert.doesNotMatch(words, /!|—|\bgroup\b/, words);
  }
});

test('C3: who, then the community, then the app, then one line over two buttons', () => {
  const html = draw();
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  // The Homeroom logo bar first, as on the story, the invite page and the
  // make screen (owner, 7 October 2026), then the people row 16px under it.
  assert.ok(at('data-first-session-made-top=""') < at('data-first-session-people="1"'));
  assert.match(CODE, /<div data-first-session-made-top="" className="flex h-\[max\(52px,calc\(env\(safe-area-inset-top\)\+32px\)\)\] shrink-0 items-center justify-center pt-\[env\(safe-area-inset-top\)\]">\s+<Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" \/>/);
  assert.match(CODE, /max-w-sm grow flex-col px-6 pb-\[max\(36px,env\(safe-area-inset-bottom\)\)\]">/);
  // The faces and the heading over the thumbnail, one block centred in the
  // room between the bar and the line over the buttons. The name is the
  // thumbnail's alone.
  assert.match(CODE, /<div data-first-session-made-body="" className="flex grow flex-col justify-center gap-4 py-4">/);
  assert.ok(at('data-first-session-made-body=""') < at('data-first-session-people="1"'));
  assert.ok(at('data-first-session-people="1"') < at('<h1 id="first-session-made-title"'));
  assert.ok(at('<h1 id="first-session-made-title"') < at('data-featured-card='));
  assert.ok(at('data-featured-card=') < at('data-build-line="planning"'));
  assert.ok(at('data-build-line="planning"') < at('>Invite people to use it and help improve it together.</p>'));
  assert.ok(at('>Invite people to use it and help improve it together.</p>') < at('>Share invite</button>'));
  assert.ok(at('>Share invite</button>') < at('>Invite people later</button>'));
  assert.match(html, /<h1 id="first-session-made-title" class="text-\[15px\] font-normal leading-5 text-zinc-600 dark:text-zinc-400">Your new community<\/h1>/);
  assert.equal((html.match(/>Plant Pal</g) || []).length, 1, 'the name once, on the thumbnail');
  assert.match(html, /role="dialog" aria-labelledby="first-session-made-title" data-first-session-made=""/);
  // Nothing else: no note under the card, no plan, no old invite heading.
  assert.doesNotMatch(html, /Homeroom is making|Needs you|Go to chat|Invite people to Plant Pal|They can follow along|data-first-session-note|Share again|Start the tour/);
  // Invite people later starts the tour with nothing sent.
  assert.match(CODE, /data-first-session-continue="" onClick=\{\(\) => onContinue\(true\)\} className=\{SECONDARY\}>\s*\{continueLabel\(entry, false, made\.name\)\}/);
});

test('C4: the sheet is titled with the community, a small caps label over the invite as they will see it', () => {
  const html = renderToHtml(createElement(made.InviteSheet, { made: MADE, me: 'maya', onClose() {}, onSent() {} }));
  assert.match(html, /<h2 id="first-session-invite-title" class="[^"]*">Invite people to Plant Pal<\/h2>/);
  assert.match(html, /<p data-first-session-invite-label="" class="[^"]*uppercase[^"]*">What they&#x27;ll see<\/p>/);
  assert.ok(html.indexOf('>Invite people to Plant Pal<') < html.indexOf('What they&#x27;ll see'));
  assert.ok(html.indexOf('What they&#x27;ll see') < html.indexOf('data-first-session-invite-line'));
  assert.ok(html.indexOf('data-first-session-invite-line') < html.indexOf('<textarea'));
  // Share and Copy link are main's (#4180): on a computer without a share
  // sheet, Copy link alone.
  assert.match(html, /data-first-session-invite-action="copy"[^>]*>Copy link<\/button>/);
});

test('C5: after sharing, the line says so, and the buttons keep their places: Share again, then Start the tour', () => {
  // Share again is grey where Share invite was; Start the tour is blue where
  // Invite people later was.
  const shared = CODE.slice(CODE.indexOf('{sent ? ('), CODE.indexOf('{inviting ? ('));
  assert.ok(shared.indexOf('data-first-session-share-again=""') < shared.indexOf('data-first-session-continue=""'));
  assert.match(CODE, /<button type="button" data-first-session-share-again="" onClick=\{\(\) => setInviting\(true\)\} className=\{SECONDARY\}>\s*\{t\('onboarding:firstSession\.made\.shareAgain'\)\}/);
  assert.equal(message('onboarding:firstSession.made.shareAgain'), 'Share again');
  assert.match(CODE, /<Button type="button" data-first-session-continue="" onClick=\{\(\) => onContinue\(false\)\} layout="full" variant="pillAccent"/);
  assert.match(CODE, /\{sentHow \? sharedLine\(sentHow, !fromCreate\) : t\(INVITE_HINT\)\}/);
  assert.match(CODE, /onSent=\{\(how\) => setSentHow\(how\)\}/);
  // The logo bar stays behind the sheet and after sharing; Share invite is gone.
  assert.doesNotMatch(draw(), /Go to the Homeroom app|Invite sent|joined\./);
});

test('the people row: your face in the middle, waiting seats on both sides, faces take the seats as people join', () => {
  const row = (list) => renderToHtml(createElement(people.PeopleRow, { people: list }));
  const src0 = read(`${DIR}/people-row.tsx`);
  const one = row([{ username: 'maya' }]);
  assert.match(one, /role="img" aria-label="You" data-first-session-people="1"/);
  assert.equal((one.match(/data-first-session-seat=""/g) || []).length, 4, 'two seats on each side');
  assert.match(one, />M<\/span>/);
  // Your face is the middle of five places, with a seat either side of it.
  const at = (needle) => one.indexOf(needle);
  const seats = [...one.matchAll(/data-first-session-seat=""/g)].map((m) => m.index);
  assert.ok(seats[0] < seats[1] && seats[1] < at('>M</span>') && at('>M</span>') < seats[2] && seats[2] < seats[3]);
  // Not interactive, a soft person silhouette, lightened colours rather than opacity.
  assert.doesNotMatch(one, /<button|<a |tabindex|opacity/);
  assert.equal((one.match(/pointer-events-none/g) || []).length, 4);
  assert.equal((one.match(/<svg[^>]*><path d="M12 4\.4a4\.6 4\.6/g) || []).length, 4, 'a silhouette in every seat');
  assert.match(src0, /import \{ PersonSilhouetteIcon \} from '@\/components\/ui\/icons';/);
  for (const bg of ['#ebefed', '#ede5f2', '#fae5dc', '#f5e9e5']) assert.match(one, new RegExp(`background:${bg}`), bg);
  assert.match(one, /margin-left|-ml-2\.5/, 'the places overlap');
  const three = row([{ username: 'maya' }, { username: 'sam' }, { username: 'alex' }]);
  assert.equal((three.match(/data-first-session-seat=""/g) || []).length, 2, 'two seats left once three are in');
  assert.match(three, /aria-label="You and 2 others"/);
  assert.deepEqual(people.placesOf([{ username: 'maya' }, { username: 'sam' }, { username: 'alex' }]).map((p) => p && p.username),
    [null, 'alex', 'maya', 'sam', null]);
  const many = row(Array.from({ length: 7 }, (_, i) => ({ username: `p${i}` })));
  assert.match(many, /data-first-session-people="5"/, 'at most five faces');
  assert.doesNotMatch(many, /data-first-session-seat=""/);
  assert.equal(people.peopleLabel([{ username: 'maya' }, { username: 'sam' }]), 'You and sam');
  assert.equal(people.peopleLabel([{ username: 'maya' }, {}]), 'You and 1 other');
  assert.equal(people.PLACES, 5);
  // The hub's faces: the initial on the person's swatch.
  const src = read(`${DIR}/people-row.tsx`);
  assert.match(src, /import \{ swatchFor \} from '\.\.\/\.\.\/lib\/community-color';/);
  assert.match(src, /background: swatchFor\(name\)/);
  // The made screen draws the community's members, else you.
  assert.match(CODE, /<PeopleRow people=\{peopleOf\(community, me\)\} \/>/);
});

test('from Create there is no tour: its line and its way on say so', () => {
  const html = draw({ entry: 'create', underHeader: true });
  assert.doesNotMatch(html, /data-first-session-made-top/, 'under the platform header there is no logo bar');
  assert.equal(made.continueLabel('create', true, 'Plant Pal'), 'Go to Plant Pal');
  assert.match(CODE, /\{plan && !stalled && fromCreate \? <PlanWaitsCard/);
});
