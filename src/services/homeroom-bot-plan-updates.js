'use strict';

// A newer plan posted on a request while Homeroom bot is building it, or
// after the change it built is up for a vote (#6406).
//
// Until this, the bot read a request's plan once, when its build started
// (homeroom-bot.js usePersonPlan): a version posted a minute into the build
// was ignored until somebody asked the bot to follow it. request-specs.js
// postRequestSpec now tells this module about every version it saves, and
// the module decides by the state of the request's live run:
//
//   1. WAITING     the run has not claimed a build session yet: the newer
//                  plan, when it is enough to build from, replaces the old
//                  one on the run, and the bot says it will build from it.
//   2. BUILDING    the build is under way: the bot says the newer version
//                  came in while it was building. It finishes the change and
//                  then queues the update (followNewerPlan, called from
//                  announceBuilt once the proposal is up).
//   3. UP A VOTE   the change is promoted: the update is queued at once.
//   4. SOMEBODY    a version from anybody but the requester or the plan's
//      ELSE       author changes nothing: the bot asks the requester first.
//
// Only a newer version counts: a repost with the same words changes nothing.
// Every function catches and logs; nothing here throws into the plan post.

const log = require('./logger');

const KIND = 'newer_plan';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "Change #178", or "the change" when it has no number yet. Pure. */
function changeName(pr) {
  return num(pr) ? `Change #${num(pr)}` : 'the change';
}

/** "@name, " or "" at the start of a line. Pure. */
function at(name) {
  return name ? `@${name}, ` : '';
}

// ── The lines the bot says (pure, exported for tests) ────────────────────

/** "v2", or "an earlier version" when the old plan carried no number. Pure. */
function versionName(version) {
  return num(version) ? `v${num(version)}` : 'an earlier version';
}

/** 1. Waiting: the newer plan replaces the old one before the build starts. */
function waitingText({ version, fromVersion } = {}) {
  return `You posted v${Number(version)} before I started: I'll build from v${Number(version)} `
    + `instead of ${versionName(fromVersion)}.`;
}

/** 2. Building: the bot finishes and updates the change afterwards. */
function buildingText({ poster, version, fromVersion } = {}) {
  return `${at(poster)}you posted v${Number(version)} while I was building ${versionName(fromVersion)}. `
    + `I'll finish it, then update the change to follow v${Number(version)}.`;
}

/** 3. Up for a vote: the update is queued at once. */
function queuedText({ author, pr, version, fromVersion, building = false } = {}) {
  const name = changeName(pr);
  if (building) {
    return `${name} is built from ${versionName(fromVersion)}, and ${author ? `@${author}` : 'somebody'} posted `
      + `v${Number(version)} while I was building. I've queued its update to v${Number(version)}: its votes clear when the update lands.`;
  }
  return `${at(author)}${name} is built from ${versionName(fromVersion)} and you posted v${Number(version)}. `
    + `I've queued its update to v${Number(version)}: its votes clear when the update lands.`;
}

/** 4. Somebody else's plan: ask the requester before anything changes. */
function askRequesterText({ requester, poster, pr, building = false } = {}) {
  const whose = building ? 'the one I\'m building' : `the one ${changeName(pr)} is built from`;
  return `${at(requester)}@${poster} posted a newer plan than ${whose}. `
    + 'Want me to update the change to follow it? Reply here and I will.';
}

// ── Reading what the change is built from ────────────────────────────────

/** { sessionId, version, author } of a run's recorded plan, or null. Pure. */
function planFrom(runPlan) {
  const from = runPlan && typeof runPlan === 'object' ? runPlan.fromPlan : null;
  if (!from || !num(from.sessionId)) return null;
  return {
    sessionId: num(from.sessionId),
    version: num(from.version),
    author: from.author || null,
  };
}

/** The plan a change was built from (chat_sessions.built_from_*), or null. */
async function builtFromOf(pool, sessionId) {
  const id = num(sessionId);
  if (!id) return null;
  const { rows: [row] = [] } = await pool.query(
    `SELECT cs.built_from_session_id, cs.built_from_version, u.username AS built_from_author
       FROM chat_sessions cs
       LEFT JOIN chat_sessions b ON b.id = cs.built_from_session_id
       LEFT JOIN users u ON u.id = b.user_id
      WHERE cs.id = $1`,
    [id],
  );
  if (!row || row.built_from_session_id == null) return null;
  return {
    sessionId: num(row.built_from_session_id),
    version: num(row.built_from_version),
    author: row.built_from_author || null,
  };
}

/** The id of the person whose plan `sessionId` is, or null. */
async function authorIdOf(pool, sessionId) {
  const id = num(sessionId);
  if (!id) return null;
  const { rows: [row] = [] } = await pool.query('SELECT user_id FROM chat_sessions WHERE id = $1', [id]);
  return row && row.user_id != null ? Number(row.user_id) : null;
}

/** The text of one version of a plan (chat_session_specs.content), or null. */
async function specContentOf(pool, sessionId, version) {
  const id = num(sessionId);
  if (!id) return null;
  const { rows: [row] = [] } = version
    ? await pool.query(
      'SELECT content FROM chat_session_specs WHERE session_id = $1 AND version = $2',
      [id, Number(version)],
    )
    : await pool.query(
      'SELECT content FROM chat_session_specs WHERE session_id = $1 ORDER BY version DESC LIMIT 1',
      [id],
    );
  return row ? String(row.content || '') : null;
}

/**
 * The newest plan on the request that the change is not built from, as
 * { sessionId, version, author, authorId, markdown, html, enough } or null.
 * `sessionId`: the change; `from`: { sessionId, version } to compare against
 * (from override, else the change's own built_from_*). A repost whose words
 * are the built-from version's words is not newer. Never throws.
 */
async function newerPlanFor(pool, { appId, issueNumber, sessionId = null, from = null }, deps = {}) {
  try {
    const specs = deps.requestSpecs || require('./request-specs');
    let built = from && num(from.sessionId)
      ? { sessionId: num(from.sessionId), version: num(from.version), author: from.author || null }
      : await builtFromOf(pool, sessionId);
    if (!built || !built.sessionId) return null;
    const newest = await specs.personPlanOf(pool, { appId, issueNumber });
    if (!newest) return null;
    const same = Number(newest.sessionId) === Number(built.sessionId)
      && Number(newest.version) === Number(built.version);
    if (same) return null;
    const builtText = await specContentOf(pool, built.sessionId, built.version);
    if (builtText != null && String(newest.markdown || '').trim() === builtText.trim()) return null;
    return newest;
  } catch (err) {
    log.warn('homeroom-bot-plan-updates', 'Could not read a newer plan on a request', {
      appId, issueNumber, sessionId, err: err.message,
    });
    return null;
  }
}

/**
 * Whether `posterId` may have the change follow their plan without asking:
 * the request's requester (homeroom_bot_requesters, else requests.created_by)
 * or the author of the plan the change is built from. Never throws.
 */
async function eligible(pool, { app, issueNumber, posterId, fromAuthorId = null }, deps = {}) {
  try {
    const id = num(posterId);
    if (!id || !app || !num(app.id)) return false;
    const dm = deps.dm || require('./homeroom-bot-dm');
    const requester = await dm.requesterOf(pool, app.id, issueNumber).catch(() => null);
    let requesterId = num(requester && requester.userId);
    if (!requesterId) {
      const { rows: [row] = [] } = await pool.query(
        'SELECT created_by FROM requests WHERE app_id = $1 AND number = $2 ORDER BY id DESC LIMIT 1',
        [Number(app.id), Number(issueNumber)],
      );
      requesterId = num(row && row.created_by);
    }
    if (requesterId && requesterId === id) return true;
    return !!fromAuthorId && Number(fromAuthorId) === id;
  } catch (err) {
    log.warn('homeroom-bot-plan-updates', 'Could not tell who may change a plan', {
      appId: app && app.id, issueNumber, err: err.message,
    });
    return false;
  }
}

/** The newest live run for a request, with what decides each case. */
async function liveRunOf(pool, appId, issueNumber) {
  const { rows: [run] = [] } = await pool.query(
    `SELECT id, mode, verdict, build_ok, build_session_id, proposal_session_id, plan
       FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live'
      ORDER BY id DESC LIMIT 1`,
    [Number(appId), Number(issueNumber)],
  );
  return run || null;
}

/** A change on the request that is up for a vote and was built from a plan. */
async function promotedChangeOf(pool, appId, issueNumber) {
  const { rows: [row] = [] } = await pool.query(
    `SELECT cs.id, cs.status, cs.pr_number
       FROM homeroom_bot_runs r JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE r.app_id = $1 AND r.issue_number = $2 AND r.mode = 'live'
        AND cs.status = 'promoted' AND cs.built_from_session_id IS NOT NULL
      ORDER BY cs.id DESC LIMIT 1`,
    [Number(appId), Number(issueNumber)],
  );
  return row || null;
}

/** A change's own row: status and number. */
async function changeOf(pool, sessionId) {
  const id = num(sessionId);
  if (!id) return null;
  const { rows: [row] = [] } = await pool.query(
    'SELECT id, status, pr_number FROM chat_sessions WHERE id = $1',
    [id],
  );
  return row || null;
}

// ── Posting one line, once ───────────────────────────────────────────────

async function botUser(pool, deps = {}) {
  if (deps.bot) return deps.bot;
  const dm = deps.dm || require('./homeroom-bot-dm');
  return dm.botAccount(pool);
}

/**
 * Post one bot line in the request's thread, unless the same line (kind,
 * stage, plan session, version) was already posted there. Step 4 (11 Nov
 * 2026): one post (bot-post.js), keyed by that line, so it is said once.
 * Resolves the message { id } it posted or found, or null. Never throws.
 */
async function postLine(pool, { app, issueNumber, stage, planSessionId, version, content, bot = null }, deps = {}) {
  try {
    const ws = deps.ws || require('./ws');
    const n = Number(issueNumber);
    const meta = {
      homeroomBot: {
        kind: KIND,
        stage,
        planSessionId: num(planSessionId),
        version: Number(version),
        issueNumber: n,
      },
    };
    const user = bot || await botUser(pool, deps);
    if (!user) return null;
    const words = require('./em-dashes').withoutEmDashes(String(content || ''));
    const botPost = require('./bot-post');
    const out = await botPost.post(pool, {
      place: { type: 'issue', ref: n }, appId: Number(app.id), kind: KIND, words, author: user, metadata: meta,
      issueNumber: n, version: `${stage}-${num(planSessionId) || 0}-v${Number(version)}`, record: false,
    }, { ws });
    if (out.outcome === 'again') return out.messageId ? { id: Number(out.messageId), existed: true } : null;
    return out.outcome === 'said' ? { id: Number(out.messageId), existed: false } : null;
  } catch (err) {
    log.warn('homeroom-bot-plan-updates', 'Could not say a newer plan came in', {
      appId: app && app.id, issueNumber, stage, err: err.message,
    });
    return null;
  }
}

// ── 1 to 4: what a posted version does ───────────────────────────────────

/**
 * Called by request-specs.js postRequestSpec after a version is saved.
 * Reads the request's newest live run and its change and takes one of the
 * four cases above. `posted` is the version just saved
 * ({ sessionId, version, user }). Never throws.
 */
async function noticeNewerPlan(pool, { app, issueNumber, posted = null }, deps = {}) {
  try {
    const n = Number(issueNumber);
    if (!app || !num(app.id) || !num(n) || !posted) return null;
    const posterId = posted.user && posted.user.id != null ? Number(posted.user.id) : null;
    const posterName = (posted.user && posted.user.username) || null;
    const run = await liveRunOf(pool, app.id, n);
    if (!run) return null;

    const from = planFrom(run.plan);
    const changeSessionId = num(run.proposal_session_id) || num(run.build_session_id);
    const change = changeSessionId ? await changeOf(pool, changeSessionId) : null;

    // 1. Waiting for its turn: a newer plan enough to build from replaces
    // the old one, and the bot says it will build from it instead.
    if (!run.build_session_id && run.build_ok == null && from) {
      const newer = await newerPlanFor(pool, { appId: app.id, issueNumber: n, from }, deps);
      if (!newer) return null;
      if (!(await eligible(pool, { app, issueNumber: n, posterId, fromAuthorId: await authorIdOf(pool, from.sessionId) }, deps))) {
        return null;
      }
      if (!newer.enough) return null;
      const bot = deps.botModule || require('./homeroom-bot');
      const used = typeof bot.usePersonPlan === 'function'
        ? await bot.usePersonPlan(pool, { runId: run.id, app, issueNumber: n, deps })
        : null;
      if (used && used.use === 'build') {
        await postLine(pool, {
          app, issueNumber: n, stage: 'waiting', planSessionId: newer.sessionId, version: newer.version,
          content: waitingText({ version: newer.version, fromVersion: from.version }),
        }, deps);
        return { acted: 'swapped', version: newer.version };
      }
      // A build claimed the run between the read and the write: fall through
      // to the building case, which says what happens now.
    }

    // 2. While the bot is building: say the newer version came in; the
    // update is queued once the change is up (announceBuilt, followNewerPlan).
    const building = !!num(run.build_session_id) && !num(run.proposal_session_id) && run.build_ok == null;
    if (building) {
      const built = from || await builtFromOf(pool, run.build_session_id);
      const newer = await newerPlanFor(pool, {
        appId: app.id, issueNumber: n, sessionId: run.build_session_id, from: built,
      }, deps);
      if (!newer) return null;
      const fromAuthorId = built ? await authorIdOf(pool, built.sessionId) : null;
      if (await eligible(pool, { app, issueNumber: n, posterId, fromAuthorId }, deps)) {
        await postLine(pool, {
          app, issueNumber: n, stage: 'building', planSessionId: newer.sessionId, version: newer.version,
          content: buildingText({ poster: posterName, version: newer.version, fromVersion: built ? built.version : null }),
        }, deps);
        return { acted: 'noticed', version: newer.version };
      }
      const dm = deps.dm || require('./homeroom-bot-dm');
      const requester = await dm.requesterOf(pool, app.id, n).catch(() => null);
      await postLine(pool, {
        app, issueNumber: n, stage: 'ask', planSessionId: newer.sessionId, version: newer.version,
        content: askRequesterText({ requester: requester && requester.username, poster: posterName, building: true }),
      }, deps);
      return { acted: 'asked', version: newer.version };
    }

    // 3. Up for a vote: the update is queued at once, by the same path an
    // ask from a person takes.
    const promoted = await promotedChangeOf(pool, app.id, n)
      || (change && change.status === 'promoted' ? change : null);
    if (promoted) {
      const built = await builtFromOf(pool, promoted.id);
      const newer = await newerPlanFor(pool, {
        appId: app.id, issueNumber: n, sessionId: promoted.id, from: built,
      }, deps);
      if (!newer) return null;
      const fromAuthorId = built ? await authorIdOf(pool, built.sessionId) : null;
      if (await eligible(pool, { app, issueNumber: n, posterId, fromAuthorId }, deps)) {
        const out = await followNewerPlan(pool, {
          app, issueNumber: n, sessionId: promoted.id, reason: 'voted',
        }, deps);
        return out || null;
      }
      const dm = deps.dm || require('./homeroom-bot-dm');
      const requester = await dm.requesterOf(pool, app.id, n).catch(() => null);
      await postLine(pool, {
        app, issueNumber: n, stage: 'ask', planSessionId: newer.sessionId, version: newer.version,
        content: askRequesterText({ requester: requester && requester.username, poster: posterName, pr: promoted.pr_number }),
      }, deps);
      return { acted: 'asked', version: newer.version };
    }
    return null;
  } catch (err) {
    log.warn('homeroom-bot-plan-updates', 'Could not follow a newer plan', {
      appId: app && app.id, issueNumber, err: err.message,
    });
    return null;
  }
}

/**
 * The change follows the newest plan: say so, then queue its update through
 * the voice's own ask path (homeroom-bot-voice.js recordAsk), the way a
 * person asking "update for the latest plan" does. Used by noticeNewerPlan
 * (up for a vote) and by announceBuilt (while the bot was building).
 * `reason`: 'voted' or 'building'. Never throws.
 */
async function followNewerPlan(pool, { app, issueNumber, sessionId, bot = null, reason = 'voted' }, deps = {}) {
  try {
    const n = Number(issueNumber);
    const change = await changeOf(pool, sessionId);
    if (!change || change.status !== 'promoted') return null;
    const built = await builtFromOf(pool, change.id);
    if (!built) return null;
    const newer = await newerPlanFor(pool, { appId: app.id, issueNumber: n, sessionId: change.id }, deps);
    if (!newer) return null;
    const fromAuthorId = await authorIdOf(pool, built.sessionId);
    if (!(await eligible(pool, { app, issueNumber: n, posterId: newer.authorId, fromAuthorId }, deps))) return null;

    // `voted` says it to the person who posted; `building` is the bot's own
    // line after it finished (it was building when the version came in).
    let msg;
    if (reason === 'building') {
      // Wait until the run that built it has recorded its proposal, so the
      // line lands after "I built this" in the thread, and name the version
      // the build read.
      msg = await postLine(pool, {
        app, issueNumber: n, stage: 'queued', planSessionId: newer.sessionId, version: newer.version, bot,
        content: queuedText({
          author: newer.author, pr: change.pr_number, version: newer.version, fromVersion: built.version, building: true,
        }),
      }, deps);
    } else {
      msg = await postLine(pool, {
        app, issueNumber: n, stage: 'queued', planSessionId: newer.sessionId, version: newer.version, bot,
        content: queuedText({
          author: newer.author, pr: change.pr_number, version: newer.version, fromVersion: built.version,
        }),
      }, deps);
    }

    const voice = deps.voice || require('./homeroom-bot-voice');
    const ask = await voice.recordAsk(pool, {
      appId: app.id,
      sessionId: change.id,
      issueNumber: n,
      askerId: newer.authorId,
      source: 'issue',
      place: { type: 'issue', ref: n },
      // The line's own id makes the ask idempotent (homeroom_bot_change_asks_once):
      // a second look at the same version reuses the message it already posted.
      messageId: msg ? msg.id : null,
      force: true,
      queueReason: 'plan_update',
      instruction: `Bring this change in line with @${newer.author || 'the author'}'s plan version ${newer.version} `
        + `on the request (it was built from version ${built.version == null ? 'an earlier one' : built.version}). `
        + 'Follow the newer plan where they differ.',
      deps,
    });
    return { followed: !!ask, version: newer.version, askId: ask ? ask.id : null };
  } catch (err) {
    log.warn('homeroom-bot-plan-updates', 'Could not queue an update to a newer plan', {
      appId: app && app.id, issueNumber, sessionId, err: err.message,
    });
    return null;
  }
}

module.exports = {
  KIND,
  changeName,
  waitingText,
  buildingText,
  queuedText,
  askRequesterText,
  planFrom,
  builtFromOf,
  authorIdOf,
  newerPlanFor,
  eligible,
  noticeNewerPlan,
  followNewerPlan,
  liveRunOf,
  promotedChangeOf,
};
