'use strict';

// The Homeroom bot's welcome, sent once, when it went on for everyone.
//
// Until then the bot was given out one person at a time, so most people have
// never met it. Everybody who had an account when it went on for everyone
// (homeroom-bot.js KEY_EVERYONE_SINCE), may use the platform, and has not
// met the bot hears from it once in their DM with it: what it does and where
// to start, with a few questions to tap.
//
// It is the person's one hello (homeroom-bot-dm.js claimHello, as a
// 'welcome'), so nobody is greeted twice: somebody the bot already wrote to
// or greeted is left alone, and a person welcomed here does not hear the
// maker's or member's hello again later. Quiet, as every hello is: it waits
// unread in Messages and rings nothing.
//
// The leader's sweep (server.js becomeLeader) sends BATCH_SIZE a pass, a
// pass every INTERVAL_MS, so a few thousand people are welcomed over an hour
// or two rather than at once. It waits while the bot is Off (a welcome for a
// bot that does not answer would be a false claim) and never runs on a
// staging copy, whose people are copies of real ones. Once a pass finds
// nobody left, it writes KEY_DONE and never runs again; people let in after
// that meet the bot through its other hellos. A send that throws gives the
// claim back, so the next pass tries that person again; the message's
// idempotency key keeps a retry from posting twice.

const log = require('./logger');

const KEY_DONE = 'homeroom_bot_welcome_done';
const BATCH_SIZE = 25;
const INTERVAL_MS = 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;

const WELCOME_TEXT = [
  'Hi, I\'m Homeroom bot, the AI that builds things on Homeroom. As of today I work for everyone.',
  'Want to make something new? Tap New project on your Home screen, say what it should do, and I\'ll build a '
    + 'first version you can try.',
  'Want something changed in a project you\'re in, Homeroom included? Post a request on it, or tap Suggest an '
    + 'improvement on its page. I\'ll build it, and the group tries it and decides whether it goes live.',
  'When I need to ask you something, I\'ll ask here, with answers you can tap.',
].join('\n\n');
const WELCOME_PROMPTS = Object.freeze(['What can I ask for?', 'How does the group decide?', 'How do I invite friends?']);

// Who is welcomed: may use the platform (platform access, or a private
// member), a real account (not the bot, a capture account, a test account,
// a deleted one or one whose participation is restricted), made before the
// bot went on for everyone, and not met by the bot yet.
const PEOPLE_SQL = `
  SELECT u.id
    FROM users u
   WHERE (u.has_platform_access OR u.private_member_since IS NOT NULL)
     AND u.anonymised_at IS NULL
     AND u.is_synthetic IS NOT TRUE
     AND u.test_account_created_at IS NULL
     AND u.participation_restricted_at IS NULL
     AND u.created_at <= $1::timestamptz
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_hellos h WHERE h.user_id = u.id)
   ORDER BY u.id
   LIMIT $2`;

let timer = null;
let running = false;

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function botModule() { return require('./homeroom-bot'); }
function dmModule() { return require('./homeroom-bot-dm'); }

async function isDone(pool) {
  const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [KEY_DONE]);
  return rows.length > 0;
}

/**
 * Welcome one person, as the bot. 'sent', or 'skipped' when the bot has
 * met them already or the DM was refused (they blocked it, or declined the
 * conversation). Throws only when the send itself failed, with the claim
 * given back.
 */
async function welcomeOne(pool, { userId, bot }) {
  const dm = dmModule();
  if (!await dm.claimHello(pool, { userId, botId: bot.id, kind: 'welcome' })) return 'skipped';
  let sent;
  try {
    sent = await dm.sendDm(pool, {
      bot,
      userId,
      idempotencyKey: `hrbot-welcome-${userId}`,
      content: WELCOME_TEXT,
      metadata: {
        kind: 'hello_welcome', hello: WELCOME_TEXT, actions: dm.promptActions(WELCOME_PROMPTS), status: 'open',
      },
    });
  } catch (err) {
    await pool.query(
      "DELETE FROM homeroom_bot_hellos WHERE user_id = $1 AND kind = 'welcome' AND message_id IS NULL", [userId],
    ).catch(() => {});
    throw err;
  }
  if (!sent) return 'skipped';
  await dm.noteHelloSent(pool, userId, sent.messageId);
  return 'sent';
}

/**
 * One pass: up to BATCH_SIZE people welcomed. Resolves what it did, or why
 * it did nothing ({ off }, { staging }, { done }, { noBot }).
 */
async function sweep(pool, { batchSize = BATCH_SIZE } = {}) {
  const result = { sent: 0, skipped: 0, retry: 0 };
  if (isStaging()) return { ...result, staging: true };
  if (await isDone(pool)) return { ...result, done: true };
  const settings = await botModule().readSettings(pool);
  if (settings.mode === 'off') return { ...result, off: true };
  const bot = await dmModule().botAccount(pool);
  if (!bot) return { ...result, noBot: true };
  const { rows } = await pool.query(PEOPLE_SQL, [settings.everyoneSince, batchSize]);
  if (!rows.length) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [KEY_DONE, new Date().toISOString()],
    );
    log.info('homeroom-bot-welcome', 'Everybody has been welcomed');
    return { ...result, done: true };
  }
  for (const { id: userId } of rows) {
    try {
      result[await welcomeOne(pool, { userId: Number(userId), bot })] += 1;
    } catch (err) {
      // One person's welcome failing must not hold up the people behind
      // them; they are tried again on the next pass.
      result.retry += 1;
      log.warn('homeroom-bot-welcome', 'Welcome failed', { userId, err: err.message });
    }
  }
  return result;
}

function start(config) {
  if (timer) return;
  const { getPool } = require('../db/pool');
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweep(getPool(config));
      if (result.sent || result.retry) log.info('homeroom-bot-welcome', 'Welcomes sent', result);
      if (result.done || result.staging) stop();
    } catch (err) {
      log.error('homeroom-bot-welcome', 'Sweep failed', { err: err.message });
    } finally {
      running = false;
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS).unref?.();
  timer = setInterval(run, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  KEY_DONE,
  BATCH_SIZE,
  INTERVAL_MS,
  WELCOME_TEXT,
  WELCOME_PROMPTS,
  PEOPLE_SQL,
  welcomeOne,
  sweep,
  start,
  stop,
};
