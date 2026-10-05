'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');

test('UI added by a main sync uses the selected packs without freezing English at import', async t => {
  const originalFetch = global.fetch;
  global.fetch = async url => new Response(fs.readFileSync(path.join(__dirname, '..', 'public', url)));
  t.after(() => { global.fetch = originalFetch; });
  const ui = loadTsx('tests/fixtures/merged-language-ui.ts');
  for (const namespace of ['apps', 'auth', 'community', 'workshop', 'core']) ui.registerNamespace(namespace);
  const read = () => [ui.INTRO_TITLE(), ui.INTRO_ROWS[0].subtitle, ui.NOTIFY_ME_LINES.granted,
    ui.pillLabel('making'), ui.waitingWords({ names: ['ada'], missing: 1 })];
  const offer = { inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, building: true, note: 'Bring coffee' };
  const readSynced = () => [ui.SHARE_TYPES[1].label, ui.APP_GROUPS[1].label,
    ui.newMessagesLabel(1), ui.newMessagesLabel(2), ui.jumpLabel(2),
    ui.invitedByLine(offer), ui.seenByLine(offer), ui.CLOSED_LINE()];
  const syncedEnglish = readSynced();
  assert.deepEqual(syncedEnglish.slice(0, 7), ['GitHub issue', 'Your projects',
    '1 new message', '2 new messages', 'Jump to latest, 2 new messages',
    'Maya is making it and invited you', 'Maya will see that you joined.']);
  const english = read();
  assert.deepEqual(english, ['How challenges work', 'Complete challenges.',
    'I’ll send you a notification when it’s ready.', 'Being made', 'Waiting for approval from @ada']);
  assert.equal(ui.t('workshop:tally_value1_of_value2_approvals', { count: 1, value1: 0, value2: 1 }), '0 of 1 approval');
  assert.equal(ui.t('workshop:tally_value1_of_value2_approvals', { count: 2, value1: 1, value2: 2 }), '1 of 2 approvals');

  await ui.changeLanguage('es');
  const spanish = read();
  readSynced().forEach((text, index) => {
    assert.notEqual(text, syncedEnglish[index]);
    assert.doesNotMatch(text, /sync_|{{|undefined/);
  });
  assert.match(ui.invitedByLine(offer), /Maya/);
  const invite = renderToHtml(createElement(ui.InviteCard, { offer, name: 'Coffee Club', busy: false, onJoin() {} }));
  assert.match(invite, /Coffee Club/);
  assert.match(invite, /Bring coffee/);
  assert.doesNotMatch(invite, /Join Coffee Club|invited you/);
  const rows = renderToHtml(createElement(ui.AppChoiceRows, { rows: [], appId: null, open: true, loading: false, failed: false, searching: true, onChoose() {} }));
  assert.ok(rows.includes(ui.t('community:sync_no_apps_match_your_search_780f4366')));
  const divider = renderToHtml(createElement(ui.NewMessagesDivider));
  assert.ok(divider.includes(ui.t('core:sync_new_messages_ef5df7e6')));
  spanish.forEach((text, i) => {
    assert.notEqual(text, english[i]);
    assert.doesNotMatch(text, /merged_|{{|undefined/);
  });
  assert.match(spanish[4], /@ada/, 'user names remain data');
  const intro = renderToHtml(createElement(ui.ChallengesIntroView, { closed: true, onOpen() {}, onClose() {} }));
  assert.ok(intro.includes(spanish[0]));
  const chip = renderToHtml(createElement(ui.BotStatusChip, { chip: { status: 'building' } }));
  assert.ok(chip.includes(ui.t('workshop:homeroom_bot_is_building_this_024e15bd')));
  assert.doesNotMatch(chip, /Homeroom bot is building this/);

  await ui.changeLanguage('en');
  assert.deepEqual(readSynced(), syncedEnglish);
  assert.deepEqual(read(), english, 'switching back retains the merged English wording');
});
