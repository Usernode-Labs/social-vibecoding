const { Router } = require('express');
const { getPool } = require('../db/pool');
const threads = require('../services/threads');
const appAccess = require('../services/app-access');
const repoRef = require('../services/repo-ref');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { conversationActionLimiter } = require('../middleware/rate-limits');
const communities = require('../services/communities');
const threadMoves = require('../services/thread-moves');

// Threads (#6019): one thread per piece of work, holding its requests,
// changes, governance rows and their discussions (services/threads.js).
//
// A thread's Notify me and Mute are the viewer's own and are not taking
// part, so they need no membership: anyone who may see the project may
// choose. A thread in a project the viewer cannot see is a 404, the same
// answer as a thread that does not exist.
function threadsRoutes() {
  const router = Router();
  const pool = getPool();

  // The project, if the viewer may see it; null otherwise.
  async function visibleApp(where, value, user) {
    const { rows: apps } = where === 'slug'
      ? await pool.query(
        `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility,
                moderation_suspended_at, repo_url
           FROM apps WHERE slug = $1`,
        [value]
      )
      : await pool.query(
        `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility,
                moderation_suspended_at, repo_url
           FROM apps WHERE id = $1`,
        [value]
      );
    const app = apps[0];
    if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'view'))) return null;
    const m = repoRef.ownerRepo(app.repo_url);
    return { app, owner: m ? m.owner : null, repo: m ? m.repo : null };
  }

  // The thread, and its project if the viewer may see it; null otherwise.
  async function visibleThread(id, user) {
    if (!/^[1-9][0-9]{0,15}$/.test(String(id))) return null;
    const { rows } = await pool.query('SELECT id, app_id, number, kind FROM threads WHERE id = $1', [id]);
    const thread = rows[0];
    if (!thread) return null;
    const found = await visibleApp('id', thread.app_id, user);
    return found ? { thread, ...found } : null;
  }

  // ── The thread page (stage 3) ──────────────────────────────────────
  //
  // A thread by any number in it: a request's or a change's page reads its
  // thread with its own number, so `dev/issues/<n>` and `dev/changes/<n>`
  // land on the same thread, and a merged thread answers with the one it went
  // into (`thread.number` says which). Readable signed out on a public
  // project, as the request and the change are. `?as=change`: the number
  // is a pull request's, and the change's own thread answers (a change's
  // page asks this way; threads.threadForNumber says why).
  router.get('/api/apps/:slug/threads/:number', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!/^[1-9][0-9]{0,8}$/.test(req.params.number)) return res.status(404).json({ error: 'Thread not found' });
      const found = await visibleApp('slug', req.params.slug, req.user);
      if (!found) return res.status(404).json({ error: 'App not found' });
      const thread = await threads.threadForNumber(pool, {
        appId: found.app.id, number: Number(req.params.number), asChange: req.query.as === 'change',
      });
      // A number with no thread (a demo fixture's, or a row the backfill has
      // not reached) is an answer, not an error: every request and change
      // page asks on open, and a 404 is a console error on that page.
      if (!thread) return res.json({ thread: null });
      const page = await threads.threadPage(pool, {
        thread, viewerId: req.user ? req.user.id : null, owner: found.owner, repo: found.repo,
      });
      // Stage 6: a merge or split waiting on this thread. #6421: a change's
      // consent question is drawn for the asker who may answer it.
      return res.json({ ...page, moves: await threadMoves.openMoves(pool, {
        threadId: thread.id, viewerId: req.user ? req.user.id : null,
      }) });
    } catch (err) {
      log.error('threads', 'thread read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 1 Nov 2026 (one page per thread): where a change lives. A change built
  // for a request has no page of its own: its addresses (`dev/changes/<N>`,
  // `dev/proposals/<id>`, `dev/shared/<id>`) open the request's page at it,
  // and this says which request (services/threads.js requestHome). `request`
  // is null for a change that keeps its own page, and for one this viewer
  // may not read, whose own page answers for itself.
  router.get('/api/apps/:slug/threads/change/:sessionId', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!/^[1-9][0-9]{0,15}$/.test(req.params.sessionId)) return res.json({ request: null });
      const found = await visibleApp('slug', req.params.slug, req.user);
      if (!found) return res.status(404).json({ error: 'App not found' });
      const home = await threads.requestHome(pool, {
        appId: found.app.id, sessionId: Number(req.params.sessionId), viewerId: req.user ? req.user.id : null,
      });
      return res.json({ request: home ? home.number : null });
    } catch (err) {
      log.error('threads', 'change home read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The same by the thread's own id: a decision filed as a governance row
  // has no number, and its page knows its thread by id.
  router.get('/api/threads/:id', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const thread = await threads.threadById(pool, req.params.id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });
      const found = await visibleApp('id', thread.app_id, req.user);
      if (!found) return res.status(404).json({ error: 'Thread not found' });
      return res.json(await threads.threadPage(pool, {
        thread, viewerId: req.user ? req.user.id : null, owner: found.owner, repo: found.repo,
      }));
    } catch (err) {
      log.error('threads', 'thread read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Moves (stage 6) ─────────────────────────────────────────────────
  //
  // Merge a thread into another, or split items out of it, for a member
  // (services/thread-moves.js decides who agrees, the 24 hours and the
  // vote). Agree is a requester's; Object anybody's, and puts it to a vote.
  //
  //   POST /api/apps/:slug/threads/:number/moves   { kind: 'merge', into } | { kind: 'split', items }
  //                                                | { kind: 'breakup', request, parts: [{ title, doneWhen? }] }
  //   POST /api/apps/:slug/thread-moves/:id/agree
  //   POST /api/apps/:slug/thread-moves/:id/object { reason? }
  const member = communities.requireAppMembership(pool);
  const answerMove = (res, out) => {
    if (out.ok) return res.json(out);
    const { ok: _ok, status, ...rest } = out;
    return res.status(status || 400).json(rest);
  };
  router.post('/api/apps/:slug/threads/:number/moves', sameOriginBrowserOnly, member, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      if (!/^[1-9][0-9]{0,8}$/.test(req.params.number)) return res.status(404).json({ error: 'Thread not found' });
      const found = await visibleApp('slug', req.params.slug, req.user);
      if (!found) return res.status(404).json({ error: 'App not found' });
      const thread = await threads.threadForNumber(pool, { appId: found.app.id, number: Number(req.params.number) });
      const body = req.body || {};
      return answerMove(res, await threadMoves.propose(pool, {
        app: found.app, user: req.user, thread, kind: body.kind,
        into: Number(body.into) || null, items: Array.isArray(body.items) ? body.items : null,
        request: Number(body.request) || null, parts: Array.isArray(body.parts) ? body.parts : null,
      }));
    } catch (err) {
      log.error('threads', 'move proposal failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  const decideMove = (verb, act) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      if (!/^[1-9][0-9]{0,15}$/.test(req.params.id)) return res.status(404).json({ error: 'No such move' });
      const found = await visibleApp('slug', req.params.slug, req.user);
      if (!found) return res.status(404).json({ error: 'App not found' });
      return answerMove(res, await act(pool, {
        app: found.app, user: req.user, moveId: req.params.id,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
        answer: typeof req.body?.answer === 'string' ? req.body.answer : null,
      }));
    } catch (err) {
      log.error('threads', `move ${verb} failed`, { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
  router.post('/api/apps/:slug/thread-moves/:id/agree', sameOriginBrowserOnly, member, decideMove('agree', threadMoves.agree));
  router.post('/api/apps/:slug/thread-moves/:id/object', sameOriginBrowserOnly, member, decideMove('object', threadMoves.object));
  // #6421: a request's other asker answers a change's question: Yes gathers
  // that thread into the change's, Keep separate leaves it linked where it is.
  router.post('/api/apps/:slug/thread-moves/:id/consent', sameOriginBrowserOnly, member, decideMove('consent', threadMoves.consent));

  // ── A private thread about it (threads, one loop: phase B) ──────────
  //
  // 1 Nov 2026: "Work on this with Homeroom bot" on a request's page or a
  // change's: a thread in the viewer's own chat with the bot, about request
  // or change `number` (services/private-threads.js startAbout), which the
  // bot reads in every turn there. Opened by whoever asked for the request,
  // the bot waits for their plan before it builds it. Anyone who may see
  // the project may open one: it is private, and posts nothing. Their own
  // tap only: same-origin, on no connector's list. Tapping again opens the
  // same thread.
  //
  //   POST /api/apps/:slug/threads/:number/private   { kind: 'request' | 'change' } → { rootId, href, holds }
  router.post('/api/apps/:slug/threads/:number/private', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      if (req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      if (!/^[1-9][0-9]{0,8}$/.test(req.params.number)) return res.status(404).json({ error: 'Thread not found' });
      const kind = req.body?.kind === 'change' ? 'change' : req.body?.kind === 'request' || req.body?.kind == null ? 'request' : null;
      if (!kind) return res.status(422).json({ error: 'kind must be request or change' });
      const found = await visibleApp('slug', req.params.slug, req.user);
      if (!found) return res.status(404).json({ error: 'App not found' });
      const out = await require('../services/private-threads').startAbout(pool, {
        user: req.user, app: found.app, kind, number: Number(req.params.number),
      });
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
      return res.json({ rootId: out.rootId, conversationId: out.conversationId, href: out.href, holds: out.holds, reused: out.reused });
    } catch (err) {
      log.error('threads', 'private thread start failed', { message: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // `notify`: true is Notify me, false is Mute, null goes back to the rule
  // (followers are whoever asked, built, voted or posted). Answers the
  // viewer's standing now: `state` 'following' | 'muted' | 'none', and
  // whether they chose it.
  router.put('/api/threads/:id/follow', sameOriginBrowserOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const notify = req.body ? req.body.notify : undefined;
    if (notify !== true && notify !== false && notify !== null) {
      return res.status(422).json({
        error: 'The given data was invalid.', details: { notify: 'must be true, false or null' },
      });
    }
    try {
      const found = await visibleThread(req.params.id, req.user);
      if (!found) return res.status(404).json({ error: 'Thread not found' });
      const threadId = Number(found.thread.id);
      await threads.setFollow(pool, { threadId, userId: req.user.id, notify });
      const now = await threads.followState(pool, {
        threadId, appId: found.app.id, userId: req.user.id, owner: found.owner, repo: found.repo,
      });
      return res.json({ threadId, ...now });
    } catch (err) {
      log.error('threads', 'follow write failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { threadsRoutes };
