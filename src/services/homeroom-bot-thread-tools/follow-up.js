'use strict';

// Homeroom bot parity, #6264: see ./index.js for this module's shape.
//
// tell_me_when: somebody in their chat or private thread with the bot asks
// to be told when something about one of its changes happens ("tell me when
// the update is made", "let me know when it is ready to vote"). The promise
// is stored (services/thread-followups.js) and kept by the change's own
// moment, which posts one line here naming them, so their bell rings.
//
// Offered only in a private turn: in a public place the voice has the same
// tool, in the place the person asked in.

const EVENT_DESC = 'The one moment they asked about: the update is made, its checks finish, it is ready to vote, it is merged, or it is live.';

function dmOf(ctx) { return ctx?.deps?.dm || require('../homeroom-bot-dm'); }
function mayorOf(ctx) { return ctx?.deps?.mayor || require('../homeroom-bot-mayor'); }
function followupsOf() { return require('../thread-followups'); }
function liveOf() { return require('../homeroom-bot-live'); }

/** Pure: whether this turn may promise a follow-up (a private chat with the bot). */
function offered(ctx) {
  return !!ctx?.user?.id && !ctx.inPublic;
}

const TELL_ME_WHEN = Object.freeze({
  type: 'function',
  function: {
    name: 'tell_me_when',
    description: 'Promise to tell them here, in this chat, when one thing about one of your changes happens. It is stored and kept: the line comes here and their bell rings. One per turn.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project\'s name or short name.' },
        number: { type: 'integer', description: 'The request number whose change it is.' },
        event: { type: 'string', enum: ['update', 'checks', 'vote', 'merged', 'live'], description: EVENT_DESC },
      },
      required: ['project', 'number', 'event'],
      additionalProperties: false,
    },
  },
});

function tools(ctx) {
  return offered(ctx) ? [TELL_ME_WHEN] : [];
}

function promptLines(ctx) {
  if (!offered(ctx)) return [];
  return [
    '- When they ask to be told when something about a change happens, call tell_me_when with that one moment and say its',
    '  promise in your reply. Never tell them you cannot message them later. When you say work is queued or running,',
    '  offer to tell them here when it is ready to vote, and store it only once they say yes or when they asked for it.',
  ];
}

async function run(pool, ctx, name, args) {
  if (name !== 'tell_me_when') return undefined;
  if (ctx.followedUp) return { error: 'One promise per reply: that one is stored.' };
  const mayor = mayorOf(ctx);
  const app = await mayor.findApp(pool, args.project);
  const n = Number(args.number);
  if (!app || !Number.isInteger(n) || n <= 0 || !(await mayor.canView(pool, app, ctx.user))) {
    return { ok: false, error: 'No such request on a project they can see. Nothing was stored.' };
  }
  const bot = await dmOf(ctx).botAccount(pool);
  if (!bot) return { ok: false, error: 'I could not keep that just now. Nothing was stored.' };
  const change = await liveOf().openBotProposal(pool, bot.id, app.id, n).catch(() => null);
  if (!change?.id) {
    return { ok: false, error: `You have no change up for a vote on ${app.name || app.slug} request #${n}, so there is nothing to tell them about. Nothing was stored.` };
  }
  const out = await followupsOf().register(pool, {
    user: ctx.user, app, sessionId: change.id, event: String(args.event || ''),
    place: { type: 'dm', ref: null },
    conversationId: ctx.conversationId ?? null,
    threadRootId: ctx.deps?.threadRootId ?? null,
    deps: ctx.deps || {},
  });
  if (!out.ok) return { ok: false, error: out.error };
  ctx.followedUp = true;
  return { ok: true, promise: out.promise, next: 'Say that promise in your reply, as written or in your own words. Never promise more than that one moment.' };
}

module.exports = { tools, run, promptLines, offered };
