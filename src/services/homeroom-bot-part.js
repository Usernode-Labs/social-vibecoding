'use strict';

// #6869: a yes to the part the bot offered.
//
// A person verdict that no go-ahead can settle still ends its note with the
// smaller part the bot can build ("I can build this part now: A clear reload
// message when a screen fails to load."). Answering with that part, "Yes" or
// "Go ahead" is a request for the part, not a go-ahead on the whole request:
// this files it as a smaller request linked to the one it came from, and puts
// it at the front of the bot's queue. The original request stays as it was.
//
// A yes could never settle the whole request, so the refusal is kept only for
// a note that offered no part.

const log = require('./logger');

function clip(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }

/**
 * Pure: whether a stored live run offered a part somebody may say yes to:
 * a person verdict with a smaller first step, and either a go-ahead that
 * cannot settle it or a report about Homeroom itself. Pure.
 */
function partOffered(run) {
  return !!run && run.mode === 'live' && run.verdict === 'person' && !!String(run.first_step || '').trim()
    && (liveModule({}).cannotStands(run) || run.about_platform === true);
}

// A plain yes, in the words a person types. "Go ahead" is live.saysGoAhead's.
const YES_WORDS = new Set([
  'yes', 'yes please', 'yes thanks', 'yeah', 'yep', 'ok', 'okay', 'do it', 'build it', 'build that', 'please do',
]);

/** Pure: the reply's words, lower-cased and without a trailing full stop. */
function plainReply(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim().toLowerCase();
}

/**
 * Pure: whether a reply accepts the offered part: the step's own words (as
 * the note offered them), a plain yes, or a go-ahead. `firstStep` is the
 * stored run's first_step.
 */
function acceptsPart(text, firstStep) {
  const said = plainReply(text);
  if (!said) return false;
  const step = plainReply(firstStep);
  if (step && said === step) return true;
  if (liveModule({}).saysGoAhead(String(text || ''))) return true;
  return YES_WORDS.has(said);
}

/** Pure: the answer after the part is filed, in the note's own words. */
function partStartedText(firstStep, issueNumber) {
  const step = String(firstStep || '').replace(/\s+/g, ' ').trim();
  const said = step ? `${step.charAt(0).toLowerCase()}${step.slice(1)}` : 'that part';
  return `Building ${said} now, as its own request #${Number(issueNumber)}. `
    + 'It\'s linked to this one, and its plan comes next.';
}

/**
 * #6869: file the part a note offered as a smaller request linked to the one
 * it came from, and put it first in the bot's queue, paid from the week of
 * the person who said yes. Keyed by the run, so a second yes finds the same
 * request. Resolves { ok: true, issueNumber, link, again } or
 * { ok: false, code, error }.
 */
async function startOfferedPart(pool, config, { app, issueNumber, run, user, settings, deps = {} }) {
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const bot = deps.botSvc || require('./homeroom-bot');
  const move = require('./homeroom-bot-move');
  const n = Number(issueNumber);
  const firstStep = String(run?.first_step || '').replace(/\s+/g, ' ').trim();
  if (!firstStep || !user?.id || !app?.id) return { ok: false, code: 'no_part', error: 'There is no part to start.' };
  const { rows: [original] } = await pool.query(
    `SELECT title FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id DESC LIMIT 1`,
    [app.id, n],
  ).catch(() => ({ rows: [] }));
  const originalTitle = String(original?.title || '').trim();
  const domain = deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
  const originalLink = move.requestLink(domain, app.slug, n);
  const filed = await mayor.fileRequest(pool, config, {
    user, app, settings, deps,
    title: clip(firstStep, 200),
    details: `A smaller part of request #${n}${originalTitle ? `: ${clip(originalTitle, 200)}` : ''}.`,
    askedText: firstStep,
    footer: `A smaller part of ${app.name || app.slug} request #${n} (${originalLink}), asked by @${user.username}.`,
    reason: 'offered_part',
    // Keyed by the run, so a retry (or a second yes) finds the same request.
    fileKey: `part:${app.id}:${n}:${run.id}`,
  });
  const link = move.requestLink(domain, app.slug, Number(filed.issueNumber));
  // The person who said yes pays for it from their own week, as starting any
  // request does.
  await bot.enqueueFront(pool, {
    appId: app.id, issueNumber: Number(filed.issueNumber), userId: user.id, reason: 'dm_start', payerId: user.id,
  }).catch((err) => {
    log.warn('homeroom-bot-part', 'Could not put the offered part first in the queue', {
      app: app.slug, issueNumber: Number(filed.issueNumber), err: err.message,
    });
  });
  if (!filed.again) {
    await move.movedLine(pool, {
      app, thread: { type: 'issue', ref: n }, kind: 'part_filed', version: `part-${run.id}`,
      words: `I filed the part as request #${filed.issueNumber}: ${link}. It's linked to this one.`, deps,
    });
  }
  log.info('homeroom-bot-part', 'Filed the part a note offered', {
    app: app.slug, issueNumber: n, part: filed.issueNumber, runId: run.id, userId: user.id,
  });
  return { ok: true, issueNumber: Number(filed.issueNumber), link, again: !!filed.again };
}

module.exports = {
  partOffered,
  acceptsPart,
  partStartedText,
  startOfferedPart,
  YES_WORDS,
};
