'use strict';

const crypto = require('crypto');
const conversations = require('./conversations');

function demoUser(id, username) {
  return { id, username, avatarUrl: null };
}

const DEMO_ADA = demoUser(902783, 'staging-demo-general-ada');
const DEMO_LIN = demoUser(902784, 'staging-demo-general-lin');

const DEMO_SCREENSHOT_NAME = 'Screenshot 2026-08-13 at 12.44.10\u202fPM.png';
const DEMO_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsPnECsq5cMDN0aQKmurhEAWCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEvTPAqsgmoaz8xeCAAAAAElFTkSuQmCC',
  'base64'
);

function demoConversations(user) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  const lin = DEMO_LIN;
  return [
    {
      id: 910001, kind: 'direct', title: 'ada', status: 'active', archived: false,
      members: [
        { ...self, role: 'member', status: 'member', joinedAt: '2026-08-11T12:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-11T12:01:00Z' },
      ],
      memberCount: 2, membershipStatus: 'member', myRole: 'member', requester: null, peer: ada,
      latestMessage: null, latestSummary: 'The proposal card is ready to review.',
      lastActivityAt: '2026-08-13T13:30:00Z', unreadCount: 2,
      canSend: true, canInvite: false, canManage: false,
    },
    {
      id: 910002, kind: 'group', title: 'Launch crew', status: 'active', archived: false,
      members: [
        { ...self, role: 'owner', status: 'member', joinedAt: '2026-08-10T10:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-10T10:02:00Z' },
        { ...lin, role: 'member', status: 'member', joinedAt: '2026-08-10T10:03:00Z' },
      ],
      memberCount: 3, membershipStatus: 'member', myRole: 'owner', requester: null, peer: null,
      latestMessage: null, latestSummary: 'I attached the launch checklist.',
      lastActivityAt: '2026-08-13T12:45:00Z', unreadCount: 0,
      canSend: true, canInvite: true, canManage: true,
    },
    {
      id: 910003, kind: 'group', title: 'Design review', status: 'active', archived: false,
      members: [], memberCount: 4, membershipStatus: 'invited', myRole: 'member',
      requester: lin, peer: null, latestMessage: null, latestSummary: '',
      lastActivityAt: '2026-08-13T11:00:00Z', unreadCount: 0,
      canSend: false, canInvite: false, canManage: false,
    },
    {
      id: 910004, kind: 'channel', title: 'general', channelKey: 'general',
      status: 'active', archived: false,
      members: [], memberCount: 128, membershipStatus: 'member', myRole: 'member',
      requester: null, peer: null, latestMessage: null,
      latestSummary: 'Anyone else trying the new #general room?',
      lastActivityAt: '2026-08-13T13:10:00Z', unreadCount: 1,
      canSend: true, canInvite: false, canManage: false,
    },
  ];
}

function demoMessages(user, conversationId) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  if (conversationId === 910001) return [
    {
      id: 9100100, conversationId, sender: ada,
      content: 'This is where the thread started, back in 2024.',
      createdAt: '2024-11-02T08:40:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [],
    },
    {
      id: 9100101, conversationId, sender: ada, saved: true,
      content: 'Can you look at the latest proposal?', createdAt: '2026-08-13T13:20:00Z', editedAt: null,
      reply: null, reactions: [{ emoji: '👍', count: 2, reacted: false, users: [ada.username, self.username] }],
      attachments: [], objects: [{
        type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
        sessionId: 3327, title: 'Platform Messages', subtitle: 'Homeroom', state: 'active',
        author: 'ada', href: '#app/usernode/dev/proposals/3327',
      }],
    },
    {
      id: 9100102, conversationId, sender: self,
      content: 'Yes — the consent and privacy boundary looks right.', createdAt: '2026-08-13T13:25:00Z', editedAt: '2026-08-13T13:26:00Z',
      reply: { id: 9100101, sender: ada, content: 'Can you look at the latest proposal?' },
      reactions: [], attachments: [], objects: [{
        type: 'app', appId: 1, appSlug: 'usernode', available: true,
        title: 'Homeroom', subtitle: 'Platform app', state: 'active', author: 'ada',
        href: '#app/usernode',
      }, {
        type: 'issue', appId: 1, appSlug: 'usernode', issueNumber: 488, available: true,
        title: 'Platform-wide private messaging', subtitle: 'Homeroom · Issue #488',
        state: 'open', author: 'ada', href: '#app/usernode/dev/issues/488',
      }],
    },
    {
      id: 9100103, conversationId, sender: ada,
      content: 'The proposal card is ready to review.', createdAt: '2026-08-13T13:30:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [{
        type: 'spec', appId: 1, appSlug: 'usernode', sessionId: 3327, version: 1,
        available: true, title: 'Platform Messages spec v1', subtitle: 'Homeroom',
        state: 'v1', author: 'ada', href: '#app/usernode/dev/sessions/3327',
      }, {
        type: 'governance', appId: 1, appSlug: 'usernode', proposalId: 701,
        available: true, title: 'Enable Messages rollout', subtitle: 'Homeroom governance',
        state: 'open', author: 'ada', href: '#app/usernode/dev/governance/701',
      }, { type: 'spec', available: false }],
    },
  ];
  if (conversationId === 910002) return [{
    id: 9100201, conversationId, sender: ada,
    content: 'I attached the launch checklist.', createdAt: '2026-08-13T12:45:00Z', editedAt: null,
    reply: null, reactions: [], attachments: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'launch-checklist.md', size: 842,
      contentType: 'text/markdown', kind: 'markdown',
      url: `/api/conversations/${conversationId}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1`,
      viewUrl: null,
    }, {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: DEMO_SCREENSHOT_NAME,
      size: DEMO_SCREENSHOT_PNG.length, contentType: 'image/png', kind: 'image',
      url: `/api/conversations/${conversationId}/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?demo=1`,
      viewUrl: null,
    }], objects: [],
  }];
  if (conversationId === 910004) {
    const lin = DEMO_LIN;
    return [
      {
        id: 9100401, conversationId, sender: ada,
        content: 'Morning all! The Messages list is sectioned now.', createdAt: '2026-08-13T13:00:00Z', editedAt: null,
        reply: null, reactions: [{ emoji: '🎉', count: 3, reacted: false, users: [lin.username] }], attachments: [], objects: [],
      },
      {
        id: 9100402, conversationId, sender: ada,
        content: 'Direct messages and agents on top, channels underneath.', createdAt: '2026-08-13T13:01:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        id: 9100403, conversationId, sender: ada,
        content: 'Issue #488 has the background.', createdAt: '2026-08-13T13:02:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        id: 9100404, conversationId, sender: lin,
        content: 'Anyone else trying the new #general room?', createdAt: '2026-08-13T13:10:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        id: 9100405, conversationId, sender: self,
        content: 'Yes, from here.', createdAt: '2026-08-13T13:12:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
    ];
  }
  return [];
}

// Serial IDs are allocated by PostgreSQL. Never assign the same private
// conversation to several viewers just to preserve a screenshot's address.
async function ensureFixtures(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return new Map();
  return conversations.transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(4781, $1)', [user.id]);
    const existing = await db.query(
      'SELECT legacy_id, conversation_id FROM staging_conversation_fixtures WHERE user_id = $1', [user.id]);
    const ids = new Map(existing.rows.map(row => [row.legacy_id, row.conversation_id]));
    if (ids.size === 4) return ids;
    const actors = await db.query(
      `SELECT id, username FROM users WHERE id = ANY($1::int[])
        AND password = 'staging-demo-not-a-login'`, [[DEMO_ADA.id, DEMO_LIN.id]]);
    if (![DEMO_ADA, DEMO_LIN].every(actor => actors.rows.some(row => row.id === actor.id && row.username === actor.username))) {
      throw new Error('Staging message fixture accounts are missing or conflict with existing users');
    }
    for (const recipe of demoConversations(user)) {
      if (ids.has(recipe.id)) continue;
      let conversationId;
      let seed = true;
      if (recipe.kind === 'channel') {
        // One genuine public channel; no viewer-authored sample messages in it.
        await db.query('SELECT pg_advisory_xact_lock(4781, 0)');
        const room = await db.query("SELECT id FROM conversations WHERE channel_key = 'general' AND kind = 'channel'");
        if (!room.rows[0]) throw new Error('Staging general channel is missing');
        conversationId = room.rows[0].id;
      } else if (recipe.kind === 'direct') {
        const pair = await conversations.lockPair(db, user.id, DEMO_ADA.id);
        const prior = await db.query(
          'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2', pair);
        conversationId = prior.rows[0]?.conversation_id;
        seed = !conversationId;
        if (!conversationId) {
          conversationId = (await db.query(
            "INSERT INTO conversations (kind, created_by, created_at, updated_at) VALUES ('direct', $1, $2, $3) RETURNING id",
            [DEMO_ADA.id, '2024-11-02T08:40:00Z', recipe.lastActivityAt])).rows[0].id;
          await db.query(
            'INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
            [conversationId, ...pair]);
        }
      } else {
        conversationId = (await db.query(
          "INSERT INTO conversations (kind, title, created_by, created_at, updated_at) VALUES ('group', $1, $2, $3, $3) RETURNING id",
          [recipe.title, recipe.membershipStatus === 'invited' ? DEMO_LIN.id : user.id, recipe.lastActivityAt])).rows[0].id;
      }
      if (seed) {
        const members = recipe.kind === 'channel'
          ? [DEMO_ADA, DEMO_LIN, user].map(actor => ({ ...actor, role: 'member', status: 'member' }))
          : recipe.membershipStatus === 'invited'
            ? [{ ...DEMO_LIN, role: 'owner', status: 'member' }, { ...DEMO_ADA, role: 'member', status: 'member' },
              { ...user, role: 'member', status: 'invited' }]
            : recipe.members;
        for (const member of members) {
          await db.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role, status, invited_by, joined_at, responded_at)
             VALUES ($1, $2, $3, $4::varchar, $5, CASE WHEN $4::varchar = 'member' THEN NOW() END, CASE WHEN $4::varchar = 'member' THEN NOW() END)
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, member.id, member.role, member.status, recipe.requester?.id || DEMO_ADA.id]);
        }
        const messageIds = new Map();
        for (const message of demoMessages(user, recipe.id)) {
          if (recipe.kind === 'channel' && message.sender.id === user.id) continue;
          const result = await db.query(
            `INSERT INTO conversation_messages
               (conversation_id, sender_id, content, idempotency_key, created_at, edited_at, reply_to_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (conversation_id, sender_id, idempotency_key)
               WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
            [conversationId, message.sender.id, message.content, `staging-inbox-${message.id}`,
              message.createdAt, message.editedAt, messageIds.get(message.reply?.id) || null]);
          if (!result.rows[0]) continue;
          const messageId = result.rows[0].id;
          messageIds.set(message.id, messageId);
          for (const attachment of message.attachments) {
            const data = attachment.kind === 'image' ? DEMO_SCREENSHOT_PNG
              : Buffer.from('# Launch checklist\n\n- Verify consent states\n- Verify private cards\n');
            await db.query(
              `INSERT INTO conversation_message_attachments
                 (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [crypto.randomBytes(16).toString('hex'), conversationId, messageId, message.sender.id,
                attachment.kind, attachment.name, attachment.contentType, data.length, data]);
          }
          if (message.saved) await db.query(
            'INSERT INTO conversation_message_bookmarks (user_id, message_id) VALUES ($1, $2)', [user.id, messageId]);
          for (const reaction of message.reactions) {
            // Every displayed reaction belongs to an actual member.
            for (const actor of [DEMO_ADA, DEMO_LIN]) {
              await db.query(
                'INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
                [messageId, actor.id, reaction.emoji]);
              if (recipe.kind === 'direct') break;
            }
          }
          // Old cards claimed nonexistent proposals/specs/issues were available.
          // Share only the real platform app; retained examples of missing
          // objects go through the ordinary unavailable-card serializer.
          for (const [position, object] of message.objects.entries()) {
            const app = object.type === 'app'
              ? (await db.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1')).rows[0] : null;
            const type = { proposal: 'code_proposal', governance: 'governance_proposal', issue: 'github_issue' }[object.type] || object.type;
            await db.query(
              `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref, object_version)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [messageId, position, type, app?.id || null, app?.id || 1, type === 'spec' ? 1 : null]);
          }
        }
      }
      await db.query(
        'INSERT INTO staging_conversation_fixtures (user_id, legacy_id, conversation_id) VALUES ($1, $2, $3)',
        [user.id, recipe.id, conversationId]);
      ids.set(recipe.id, conversationId);
    }
    return ids;
  });
}

async function resolveLegacyLink(pool, user, id) {
  if (process.env.USERNODE_ENV !== 'staging' || id < 910001 || id > 910004) return id;
  // A real accessible ID always wins over a historical display-only address.
  if (await conversations.loadMembership(pool, id, user.id, { allowInvited: true })) return id;
  const ids = await ensureFixtures(pool, user);
  return ids.get(id) || id;
}

module.exports = { ensureFixtures, resolveLegacyLink, demoConversations, demoMessages };
