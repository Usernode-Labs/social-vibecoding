'use strict';

// The Homeroom bot's DM cards while something is still happening, and the
// news that its first version is live (#4227, #4228, #4231, #4242).
//
//   - #4231: the news that a new project's first version is live offers its
//     community and Invite people; the client keeps the new `invite` button
//     and answers it by opening the first session's invite sheet in place;
//   - #4227: the plan card's "Building it" spins while its build runs, and
//     the DM's read goes on while a card or a ready card is still moving;
//   - #4242: a change whose checks failed on what looks like the platform,
//     or a build that became no proposal, is said in a ringing "needs a
//     look" message rather than nowhere.
//
// The activity card's own outcomes are in tests/homeroom-bot-activity.test.js,
// the ready card's in tests/homeroom-bot-dm-live-cards.test.js.
//
// Run with: node --test tests/homeroom-bot-dm-working-cards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const API = 'frontend/src/features/messages/api.ts';
const QUESTION = 'frontend/src/features/messages/bot-question.tsx';
const PLAN_VIEW = 'frontend/src/features/messages/bot-plan-view.tsx';
const PLAN = 'frontend/src/features/messages/bot-plan.tsx';
const STORE = 'frontend/src/features/messages/bot-activity-store.ts';

const dm = require('../src/services/homeroom-bot-dm');

// ── #4231: Open community and Invite people ──

const FIRST_LIVE = {
  kind: 'merged', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 1, firstVersion: true, live: true,
  actions: [dm.openAppAction({ slug: 'plant-pal', appName: 'Plant Pal' }), ...dm.firstLiveActions({ slug: 'plant-pal' })],
};

test('the client keeps Invite people, and draws a first version\'s live news with its three buttons', () => {
  const { normalizeBotMeta } = loadTsx(API);
  const meta = normalizeBotMeta({ homeroomBot: FIRST_LIVE }).homeroomBot;
  assert.deepEqual(meta.actions.map((a) => [a.id, a.type, a.style]), [
    ['open_app', 'open', 'primary'], ['open_community', 'open', 'secondary'], ['invite_people', 'invite', 'secondary'],
  ]);
  assert.equal(meta.actions[1].target, '#app/plant-pal/workshop');
  assert.equal('target' in meta.actions[2], false, 'an invite goes nowhere by address: it is answered in place');

  const { BotQuestion, inviteMade } = loadTsx(QUESTION, {
    stubs: { '../first-session/made': { InviteSheet: () => null } },
  });
  const message = {
    id: 9, conversationId: 3, deleted: false, sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: meta },
  };
  const html = renderToHtml(createElement(BotQuestion, { message, conversationId: 3 }));
  assert.match(html, /<span>Open Plant Pal<\/span>[\s\S]*<span>Open community<\/span>[\s\S]*<span>Invite people<\/span>/);
  assert.deepEqual(inviteMade(meta), {
    slug: 'plant-pal', name: 'Plant Pal', emoji: null, description: null, example: null, conversationId: null,
  });
  assert.equal(inviteMade({ ...meta, appSlug: undefined }), null, 'no project, no sheet');

  // The sheet is mounted as it is, live (`making` false), never re-implemented.
  const src = read(QUESTION);
  assert.match(src, /import \{ InviteSheet \} from '\.\.\/first-session\/made';/);
  assert.match(src, /<InviteSheet made=\{invite\} me=\{inviterName\(\)\} making=\{false\} onClose=\{\(\) => setInviting\(false\)\} onSent=\{\(\) => \{\}\} \/>/);
  assert.match(src, /if \(action\.type === 'invite'\) \{\n\s+if \(invite\) setInviting\(true\);\n\s+return;\n\s+\}/);
});

test('only a first version\'s live news offers the community and invites: a change to a project does not', () => {
  const src = read('src/services/homeroom-bot-dm.js');
  const fn = src.slice(src.indexOf('async function noteProposalMerged('), src.indexOf('// ── A person writing to the bot'));
  assert.match(fn, /context\.firstVersion \? firstLiveActions\(\{ slug: run\.slug \}\) : \[\]/);
  // The staging demo shows it.
  const fixture = read('src/services/staging-messages.js');
  assert.match(fixture, /kind: 'merged', appSlug: BOT_DM_FIRST_LIVE_SLUG, \.\.\.firstLive, live: true,/);
  assert.match(fixture, /\.\.\.dm\.firstLiveActions\(\{ slug: BOT_DM_FIRST_LIVE_SLUG \}\),/);
});

// ── #4227: the plan's Building it spins while it builds ──

test('a plan\'s "Building it" spins while its build runs, and is a check once it has', () => {
  const { PlanCardView } = loadTsx(PLAN_VIEW);
  const plan = { bullets: ['A list of plants'], questions: [] };
  const draw = (props) => renderToHtml(createElement(PlanCardView, { appName: 'Plant Pal', plan, state: 'built', ...props }));
  assert.match(draw({ building: true }), /data-bot-plan-building=""[\s\S]*data-progress-ring-spinning=""[\s\S]*Building it/);
  assert.doesNotMatch(draw({ building: false }), /data-progress-ring-spinning/);
  assert.match(draw({ busy: true }), /data-progress-ring-spinning/, 'pressed here and on its way: building');
  assert.doesNotMatch(draw({}), /data-progress-ring-spinning/, 'nothing says it builds: the check');

  const { planBuilding } = loadTsx(PLAN);
  const meta = { kind: 'plan', appSlug: 'plant-pal', issueNumber: 1 };
  const cardMessage = (id, extra = {}) => ({
    id, deleted: false, sender: { bot: true },
    metadata: { homeroomBot: { kind: 'activity', appSlug: 'plant-pal', issueNumber: 1, ...extra } },
  });
  const working = new Map([[21, { messageId: 21, state: 'working' }]]);
  const done = new Map([[21, { messageId: 21, state: 'done', outcome: 'checking' }]]);
  assert.equal(planBuilding(meta, [cardMessage(21)], working), true);
  assert.equal(planBuilding(meta, [cardMessage(21)], done), false, 'built: the check, whatever comes after');
  assert.equal(planBuilding(meta, [cardMessage(21)], new Map()), true, 'not read yet');
  assert.equal(planBuilding(meta, [cardMessage(20, { movedTo: 21 })], working), undefined, 'a card moved away is not it');
  assert.equal(planBuilding(meta, [cardMessage(21, { appSlug: 'other' })], working), undefined);
  assert.equal(planBuilding(meta, [cardMessage(19), cardMessage(21)], new Map([[19, { state: 'working' }], [21, { state: 'done' }]])), false,
    'the newest card says');
});

test('the DM is read again while a card spins or a ready card goes live, as while work goes', () => {
  const { stillMoving } = loadTsx(STORE);
  const snap = (cards, ready = []) => ({
    cards: new Map(cards.map((c, i) => [i + 1, c])), ready: new Map(ready.map((r, i) => [i + 1, r])),
  });
  assert.equal(stillMoving(snap([{ state: 'working' }])), true);
  assert.equal(stillMoving(snap([{ state: 'done', outcome: 'checking' }])), true);
  assert.equal(stillMoving(snap([{ state: 'done', outcome: 'going_live' }])), true);
  assert.equal(stillMoving(snap([{ state: 'done', outcome: 'proposed' }])), false);
  assert.equal(stillMoving(snap([{ state: 'done', outcome: 'needs_look' }])), false, 'a person looks: nothing to wait for');
  assert.equal(stillMoving(snap([], [{ state: 'going_live' }])), true);
  assert.equal(stillMoving(snap([], [{ state: 'live' }])), false);
});

// ── #4242: "needs a look" ──

test('a change nothing will offer without a person rings its requester, once, and its card stops checking', () => {
  assert.equal(dm.momentOf({ kind: 'needs_look' }), 'stopped');
  const line = '**Plant Pal**, its first version';
  assert.match(dm.needsLookText(line, 'checks'), /^\*\*Plant Pal\*\*, its first version\n\nI built it, but its checks failed in a way that looks like a problem on Homeroom's side/);
  assert.match(dm.needsLookText(line, 'built'), /didn't become a change you can try[\s\S]*It needs a person to look at it\./);
  for (const why of ['checks', 'built']) assert.doesNotMatch(dm.needsLookText(line, why), /—/);

  const src = read('src/services/homeroom-bot-dm.js');
  const fn = src.slice(src.indexOf('async function noteNeedsLook('), src.indexOf('const UNPROPOSED_AFTER_MS'));
  // Once per approval epoch, or per run, and recorded where the card reads it.
  assert.match(fn, /`hrbot-needs-look-checks-\$\{id\}-\$\{Number\(run\.approval_epoch\) \|\| 0\}`/);
  assert.match(fn, /`hrbot-needs-look-built-\$\{id\}`/);
  assert.match(fn, /VALUES \(\$1, \$2, \$3, \$4, \$5, 'needs_look', \$6\)/);
  const activitySrc = read('src/services/homeroom-bot-activity.js');
  assert.match(activitySrc, /AND t\.kind = 'needs_look' AND t\.created_at >= c\.began\n\s+\) AS needs_look/);
  assert.match(activitySrc, /AND t\.kind = 'proposal' AND t\.created_at >= c\.began\n\s+\) AS told/);

  // Where nothing was said before: the platform-looking failure the bot
  // leaves for a re-run, and the refresh's look for builds with no proposal.
  const bot = read('src/services/homeroom-bot.js');
  const checks = bot.slice(bot.indexOf('async function noteProposalChecks('), bot.indexOf('async function runChecksFix('));
  assert.match(checks, /if \(followup\.checksLookLikeInfra\(due\)\) \{[\s\S]*if \(due\.failing\.length\) await require\('\.\/homeroom-bot-dm'\)\.noteNeedsLook\(pool, \{ sessionId: row\.id, why: 'checks' \}\);\n\s+return false;/);
  assert.match(bot, /\.sweepUnproposedBuilds\?\.\(pool, \{ ws: deps\.ws \|\| null \}\);/);
});
