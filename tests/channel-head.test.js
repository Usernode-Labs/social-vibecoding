'use strict';

// #5303: #general's line (what it is for, its members, Mute), the Mute
// behind it (services/channel-mutes.js and its route), and a card from
// another project saying where it is from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const HEAD = 'frontend/src/features/dev-board/workshop/channel-head.tsx';
const DISCUSSION = 'frontend/src/features/dev-board/workshop/project-discussion.tsx';
const FORMAT = 'frontend/src/features/messages/format.tsx';

const general = (over) => ({
  id: null, kind: 'general', key: null, handle: 'general', aliases: [], name: 'general', about: '', icon: '',
  state: 'live', merged_into: null, merged_at: null, requests: null, unread: 0, figures: [], ...over,
});
const record = (over = {}, channel = {}) => ({
  slug: 'homeroom', member_count: 263, places: { owed: 0, channels: [general(channel)] }, ...over,
});

function head(data) {
  const { ChannelHead } = loadTsx(HEAD);
  return renderToHtml(createElement(ChannelHead, { slug: 'homeroom', name: 'Homeroom', data }));
}

test('#general says what it is for and how many members it reaches, then Mute', () => {
  const html = head(record({}, { muted: false }));
  const about = message('project:places.generalHead.about').replace('{{project}}', 'Homeroom');
  const members = message('project:places.generalHead.members_other').replace('{{count}}', '263');
  assert.match(html, /data-ws-channel-head="general"/);
  assert.ok(html.includes(`${about} · ${members}`), 'what it is for, then its members');
  assert.match(html, /data-ws-channel-mute="off"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-ws-channel-mute="off"/);
  assert.ok(html.includes(message('project:places.generalHead.mute')));
});

test('a muted #general says Muted, pressed', () => {
  const html = head(record({}, { muted: true }));
  assert.match(html, /aria-pressed="true"/);
  assert.ok(html.includes(`>${message('project:places.generalHead.muted')}<`));
});

test('no member count says nothing, and a record that does not say whether it is muted has no Mute', () => {
  const html = head(record({ member_count: 0 }, {}));
  const about = message('project:places.generalHead.about').replace('{{project}}', 'Homeroom');
  assert.ok(html.includes(`>${about}<`));
  assert.doesNotMatch(html, /data-ws-channel-mute/);
  assert.doesNotMatch(head(null), /data-ws-channel-mute/);
});

test('both of #general\'s rooms are under the line, and Homeroom\'s gives its cards their home', () => {
  const src = read(DISCUSSION);
  assert.equal(src.match(/<ChannelHead slug=\{slug\} name=\{name\} data=\{data\} \/>/g).length, 2);
  assert.match(src, /<CardHomeContext\.Provider value=\{slug\}>\s*<EmbeddedConversation/);
});

test('a card from another project says where it is from; its own project and the project itself do not', () => {
  const { cardProjectWords } = loadTsx(FORMAT);
  const from = message('messages:object.fromProject').replace('{{project}}', 'KasirKU');
  const card = { type: 'issue', appSlug: 'kasirku', subtitle: 'KasirKU' };
  assert.equal(cardProjectWords(card, 'homeroom'), from);
  assert.equal(cardProjectWords(card, 'kasirku'), 'KasirKU', 'the room\'s own');
  assert.equal(cardProjectWords(card, null), 'KasirKU', 'a room of no project (Messages)');
  assert.equal(cardProjectWords({ ...card, type: 'hub' }, 'homeroom'), 'KasirKU', 'the project itself');
  assert.equal(cardProjectWords({ ...card, subtitle: null }, 'homeroom'), null);
});

test('the mute service: read, filter, set', async () => {
  const mutes = require('../src/services/channel-mutes');
  const calls = [];
  const rows = new Set();
  const db = {
    async query(sql, params) {
      calls.push(sql);
      if (/^\s*INSERT INTO channel_mutes/.test(sql)) { rows.add(params.join(':')); return { rows: [] }; }
      if (/^\s*DELETE FROM channel_mutes/.test(sql)) { rows.delete(params.join(':')); return { rows: [] }; }
      if (/SELECT channel_ref FROM channel_mutes/.test(sql)) {
        return { rows: [...rows].filter((k) => k.startsWith(`${params[0]}:${params[1]}:`)).map((k) => ({ channel_ref: Number(k.split(':')[2]) })) };
      }
      if (/SELECT user_id FROM channel_mutes/.test(sql)) {
        return { rows: params[2].filter((u) => rows.has(`${u}:${params[0]}:${params[1]}`)).map((u) => ({ user_id: u })) };
      }
      throw new Error(`unexpected ${sql}`);
    },
  };
  assert.equal(await mutes.setMuted(db, { userId: 7, appId: 3, muted: true }), true);
  assert.deepEqual([...await mutes.mutedRefs(db, 7, 3)], [mutes.GENERAL]);
  assert.deepEqual(await mutes.filterUnmuted(db, { userIds: [7, 8], appId: 3 }), [8]);
  assert.equal(await mutes.setMuted(db, { userId: 7, appId: 3, muted: false }), false);
  assert.deepEqual([...await mutes.mutedRefs(db, 7, 3)], []);
  assert.deepEqual([...await mutes.mutedRefs(db, null, 3)], [], 'no viewer, no read');
});

test('the places block zeroes a muted #general\'s unread, and a small group\'s ring skips who muted it', () => {
  const places = read('src/services/places.js');
  assert.match(places, /unread: generalMuted \? 0 : \(Number\(general\.unread_count\) \|\| 0\)/);
  assert.match(places, /muted: generalMuted,/);
  const ring = read('src/services/group-channel-notify.js');
  assert.match(ring, /channelMutes\.filterUnmuted\(pool, \{ userIds: ids, appId, ref: channelMutes\.GENERAL \}\)/);
  const route = read('src/routes/notifications.js');
  assert.match(route, /router\.put\('\/api\/apps\/:slug\/channels\/:handle\/mute'/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS channel_mutes \(/);
  assert.match(schema, /COMMENT ON TABLE channel_mutes IS 'staging:private';/);
});
