'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const conversations = require('../src/services/conversations');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

test('notes are bounded plain text; omitted notes remain compatible', async () => {
  assert.equal(conversations.normalizeInvitationNote(undefined), '');
  assert.equal(conversations.normalizeInvitationNote(null), '');
  assert.equal(conversations.normalizeInvitationNote('  Review\nthe launch  '), 'Review\nthe launch');
  assert.equal(conversations.normalizeInvitationNote('x'.repeat(500)).length, 500);
  for (const value of ['x'.repeat(501), {}, [], 12, true, 'null\0byte']) {
    assert.equal(conversations.normalizeInvitationNote(value), null);
    const noDb = { connect() { throw new Error('invalid note reached a write'); } };
    assert.equal(await conversations.createGroup(noDb, { id: 1 }, 'Crew', [2], value), null);
    assert.equal(await conversations.addMembers(noDb, { id: 1 }, 3, [2], value), null);
  }
});

test('the invited recipient sees their note without the retained roster or messages', async () => {
  let status = 'invited';
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (/me\.role AS my_role/.test(sql)) return { rows: [{
      id: 8, kind: 'group', title: 'Review', status: 'active', membership_status: status,
      invited_by: 1, requester_username: 'alice', invitation_note: 'Your design feedback would help.',
      latest_message_id: null, my_role: 'member',
    }] };
    return { rows: [] };
  } };
  const r = await conversations.getConversation(pool, { id: 2 }, 8);
  assert.equal(r.invitationNote, 'Your design feedback would help.');
  assert.deepEqual(r.members, []);
  assert.equal(r.latestMessage, null);
  assert.equal(r.canSend, false);
  const query = queries[0];
  assert.match(query.sql, /me\.user_id = \$2/);
  assert.match(query.sql, /me\.invitation_note/);
  assert.deepEqual(query.params, [8, 2]);
  status = 'member';
  assert.equal((await conversations.getConversation(pool, { id: 2 }, 8)).invitationNote, null);
});

test('invitation context is escaped text, never HTML or auto-linked content', () => {
  const html = renderComponent('frontend/src/features/messages/invitation-note.tsx', 'InvitationContext', {
    note: '<img src=x onerror=alert(1)> https://example.invalid [click](javascript:alert(1))',
  });
  assert.ok(html.includes('&lt;img'));
  assert.doesNotMatch(html, /<img|<a\b/);
  assert.match(renderComponent('frontend/src/features/messages/invitation-note.tsx', 'InvitationContext', {}), /No invitation note was included/);
});

test('the API normalizer exposes notes only on pending group invitations', () => {
  const { normalizeConversation } = loadTsx('frontend/src/features/messages/api.ts');
  const base = { id: 5, kind: 'group', membershipStatus: 'invited', invitationNote: 'A reason' };
  assert.equal(normalizeConversation(base).invitationNote, 'A reason');
  assert.equal(normalizeConversation({ ...base, membershipStatus: 'member' }).invitationNote, null);
  assert.equal(normalizeConversation({ ...base, kind: 'direct' }).invitationNote, null);
});
