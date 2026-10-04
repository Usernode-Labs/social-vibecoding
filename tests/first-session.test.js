'use strict';

// "You're in" and the first-session tour after an invite
// (frontend/src/features/first-session). The tour walks real screens, so
// what is pinned here is that every step names a control or region the
// shell really has, that the island adds nothing to the prerendered
// document, and the seams that open it: App._followInvite asks it, and the
// invite's standing says when the viewer joined.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const GC_FORM_SRC = 'frontend/src/features/group-chat/composer.tsx';

test('the invited tour: each screen whole, then the tap that leads on, ending in the chat', () => {
  const { invitedSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = invitedSteps({ slug: 'sunday-run-club', name: 'Sunday Run Club' });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'app', 'app', 'home', 'hub', 'hub', 'discussion']);
  assert.deepEqual(steps.map((s) => (s.tap ? 'tap' : 'look')), ['tap', 'look', 'tap', 'tap', 'look', 'tap', 'look']);
  assert.equal(steps[0].target, '.app-card[data-slug="sunday-run-club"]');
  assert.equal(steps[0].title, 'Sunday Run Club is on your Home');
  assert.equal(steps.filter((s) => s.last).length, 1);
  assert.equal(steps[steps.length - 1].last, true);
  assert.deepEqual(steps[steps.length - 1].place, { above: '#gc-form' });
  // WP-C: it says what the bot does with a newcomer's idea, now that it does
  // (homeroom-bot-chat.js maybeOffer; tests/homeroom-bot-chat-offer.test.js),
  // and no more: it suggests, the group decides.
  assert.match(steps[steps.length - 1].text, /Homeroom bot offers to suggest an idea to the group in your name, and the group decides what goes in\./);
  assert.doesNotMatch(JSON.stringify(steps), /Homeroom bot (builds|turns)/);
});

test('every id the tour points at is one the shell ships', () => {
  const { invitedSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const baseline = JSON.parse(read('tests/baselines/shell-markup.json'));
  const ids = new Set(baseline.ids || []);
  const named = invitedSteps({ slug: 'x', name: 'X' })
    .flatMap((s) => s.target.split(',').map((t) => t.trim()))
    .filter((t) => t.startsWith('#'))
    .map((t) => t.slice(1));
  assert.deepEqual([...new Set(named)].sort(), ['app-content', 'back-btn', 'gc-form', 'gc-messages', 'platform-tab-workshop']);
  // The shell's own ids, from its pinned inventory.
  for (const id of ['app-content', 'back-btn']) assert.ok(ids.has(id), `#${id} is in the shell's id inventory`);
  // The tab bar draws its tabs' ids from their keys, and dapp.json's checks
  // select the Communities tab by this one.
  assert.ok(read('dapp.json').includes('#platform-tab-workshop'));
  // The rest are drawn by the screens the tour opens.
  assert.match(read('frontend/src/features/dev-board/workshop/project-band.tsx'), /data-ws-tab-btn/);
  assert.match(read('frontend/src/features/group-chat/general-chat.tsx'), /id="gc-messages"/);
  assert.match(read(GC_FORM_SRC), /form: 'gc-form',/);
});

test('the island renders nothing until it is opened, so the prerender is unchanged', () => {
  const html = renderComponent(`${DIR}/index.tsx`, 'FirstSession');
  assert.equal(html, '');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="FirstSession"><FirstSession \/><\/Island>/);
  const src = read(`${DIR}/index.tsx`);
  // Shown once per account and project, and it says when it will not show.
  assert.match(src, /if \(!info \|\| !info\.slug \|\| seen\(info\.slug\)\) return false;/);
  // The layer lets presses through to the cut-out's own control.
  assert.match(src, /className="pointer-events-none fixed inset-0 z-\[9000\]"/);
});

test('the Communities tab opens on the project the tour is about', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const path = App\?\._workshopViewPath\?\.\(`\/app\/\$\{encodeURIComponent\(slug\)\}\/workshop`\);/);
  assert.match(src, /localStorage\.setItem\(key, JSON\.stringify\(\{ slug, path \}\)\)/);
  const app = read('public/js/app.js');
  assert.match(app, /_WORKSHOP_VIEW_KEY: 'usernode_workshop_view_v1',/);
});

test('App._followInvite welcomes somebody the link has just let in, and lands anyone else as before', () => {
  const app = read('public/js/app.js');
  assert.match(app, /const fresh = standing\.joinedAt && Date\.now\(\) - Date\.parse\(standing\.joinedAt\) < 30 \* 60 \* 1000;\s+if \(fresh && welcome\(standing, standing\.slug\)\) return;\s+openHub\(standing\.slug\);/);
  assert.match(app, /if \(welcome\(\{ \.\.\.standing, newAccount: false \}, result\.slug\)\) return;\s+toast\(`You joined \$\{result\.name \|\| name\}\.`\);/);
  const invites = read('src/services/community-invites.js');
  assert.match(invites, /joinedAt: appliedAt instanceof Date \? appliedAt\.toISOString\(\) : \(appliedAt \|\| null\),\s+newAccount,/);
});

test('somebody an invite is bringing in is asked to join it once, and not what to make meanwhile', () => {
  const app = read('public/js/app.js');
  // The follow publishes whether it brought them in.
  assert.match(app, /async _followInvite\(token\) \{\s*App\._markNavigationVia\?\.\('handed'\);[\s\S]{0,400}App\._inviteFollow = new Promise\(\(resolve\) => \{ settle = resolve; \}\);\s+try \{/);
  assert.match(app, /\} finally \{\s+settle\(joinedHere\);\s+\}\s+\},\s+_deepLinkTarget\(\) \{/);
  assert.match(app, /if \(standing\.mine === 'joined' && standing\.slug\) \{\s+joinedHere = true;/);
  assert.match(app, /toast\(DEAD\[result\.reason\] \|\| 'Could not join\. Try again\.', true\); return; \}\s+joinedHere = true;/);
  // Join pressed on the link's page, then a password sign-in: no second ask.
  assert.match(app, /pressed = sessionStorage\.getItem\('usernode:invite-join'\) === `\/invite\/\$\{token\}`;\s+sessionStorage\.removeItem\('usernode:invite-join'\);/);
  assert.match(app, /const ok = pressed \? true : window\.ConfirmModal \? await ConfirmModal\.show\(\{/);
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheet, /onClick=\{\(\) => \{ if \(followInvite\) rememberInviteJoin\(\); onClose\(\); \}\}/);
  assert.match(sheet, /sessionStorage\.setItem\('usernode:invite-join', location\.pathname\.replace\(\/\\\/\$\/, ''\)\);/);
  // The join step waits for the follow before it asks anything.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /if \(await CommunitiesFirstRun\._joinedByInvite\(\)\) \{\s+CommunitiesFirstRun\._answered = true;/);
  assert.ok(join.indexOf('await CommunitiesFirstRun._joinedByInvite()') < join.indexOf('window.App.user.storyFirstSession === true'),
    'the invite is settled before the first session is offered');
  assert.match(join, /try \{ return \(await app\._inviteFollow\) === true; \} catch \(_\) \{ return false; \}/);
});

test('a join from the confirm reads Home\'s challenges again before the welcome opens on Home', () => {
  // Home painted its challenges before the confirm and caches them for a
  // minute, while the redeem counts "Join a community" before it answers
  // (routes/community-invites.js scoreOnJoin). The invited tour's first
  // screen is Home, where the cached read said Not started beside the
  // community just joined (first-session run-through, 2026-10-04).
  const app = read('public/js/app.js');
  const follow = app.slice(app.indexOf('async _followInvite(token) {'), app.indexOf('_deepLinkTarget() {'));
  assert.match(follow, /if \(!joined\.ok \|\| !result\.ok\) \{[^\n]*return; \}\s+joinedHere = true;\s+(?:\/\/[^\n]*\n\s*)*if \(result\.status === 'joined'\) window\.HomePanels\?\.ensureLoaded\?\.\(\{ force: true \}\);\s+if \(result\.slug\) \{\s+if \(welcome\(/,
    'after a join that went through, and before the welcome or the hub');
  const route = read('src/routes/community-invites.js');
  assert.match(route, /if \(result\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);\s+return res\.json\(result\);/,
    'the credit is written before the answer the refresh follows');
  const panels = read('frontend/src/features/home/home-panels.js');
  assert.match(panels, /ensureLoaded\(opts\) \{\s+const force = !!\(opts && opts\.force\);/, 'force skips the minute-long cache');
});

test('a link answers the join screen for the person it brings in', () => {
  const invites = read('src/services/community-invites.js');
  assert.match(invites, /SET needs_communities_choice = FALSE,\s+getting_started_seen = COALESCE\(getting_started_seen, '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('join_answer', 'invite'\)\s+WHERE id = \$1 AND needs_communities_choice = TRUE/);
  // communities_onboarded_at stays NULL, so the Getting started card, which
  // needs it, stays out of their first session too.
  assert.doesNotMatch(invites, /communities_onboarded_at = NOW\(\)/);
});

test("You're in tells a new account what Homeroom is, and an existing one only where it is", () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /'On Homeroom, communities make apps together\.'/);
  assert.match(src, /`Someone makes an app for their group\. \$\{maker\} made this one\.`/);
  assert.match(src, /existing \? `Welcome to \$\{info\.name\}\.`/);
  assert.match(src, /\{`Go to \$\{info\.name\}`\}/);
});
