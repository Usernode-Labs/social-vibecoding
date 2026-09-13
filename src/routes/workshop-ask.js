const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const models = require('../services/models');
const workshopAsk = require('../services/workshop-ask');
const { workshopAskLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// The Needs-you deck's ask box. One question about one card the viewer is
// being asked to vote on or pick up; see services/workshop-ask.js for what
// the model is given and why the client cannot contribute to it.
//
// Access is 'view', matching report-ai: the answer is built from data every
// member of the app can already see on the card itself, and the cost lands
// on the asker's own budget. The deny is a 404 like every other app route.
//
// The MODEL comes from the deck's picker, which is the dev session's own
// list, and goes through models.resolve() — the server-side allowlist —
// exactly as the session route does with its own client-supplied model.
// Absent or unrecognised means the box's own default (Haiku), not the
// session default: this is a short comprehension answer somebody is
// waiting on, not a build turn.

// The sentence a mid-stream failure carries. The coded ones are the two a
// reader can act on — top up, or wait — so they keep their own words; a
// bare 500 does not get to leak an internal message into the pane.
function streamErrorMessage(err) {
  if (err.code === 'budget_exceeded' || err.code === 'llm_unavailable') return err.message;
  if (err.code === 'not_found') return 'That item is no longer on this app';
  return 'Could not answer that just now';
}

function workshopAskRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name, repo_url`;

  // This viewer's own thread on one card, so the pane can bring a
  // conversation back when the deck returns to it. Not rate limited beyond
  // the app-wide protections: it is one indexed read of at most
  // THREAD_READ short rows, costs nothing to the LLM budget, and the deck
  // calls it every time you move between cards.
  //
  // It can only ever return the CALLER'S rows — the user id comes from the
  // session and the query carries it — so there is no view of anybody
  // else's questions to authorise separately.
  router.get('/api/apps/:slug/workshop/ask/thread', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const target = workshopAsk.parseTarget({ kind: req.query.kind, ref: req.query.ref });
      if (!target) return res.status(400).json({ error: 'Which item is the thread about?' });
      const messages = await workshopAsk.loadThread(pool, app, req.user.id, target);
      res.json({ messages });
    } catch (err) {
      log.error('workshop-ask', 'thread read failed', { message: err.message });
      res.status(500).json({ error: 'Could not load that conversation' });
    }
  });

  router.post('/api/apps/:slug/workshop/ask', workshopAskLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });

      const body = req.body || {};
      const target = workshopAsk.parseTarget(body.target);
      if (!target) return res.status(400).json({ error: 'Which item is the question about?' });

      // An empty pick is a real state — the picker is not drawn until the
      // box is in use — so only a NON-empty one is resolved. Passing '' to
      // models.resolve() would hand back the session default and quietly
      // bill a build-sized model for a two-sentence answer.
      const picked = typeof body.model === 'string' && body.model.trim()
        ? models.resolve(body.model.trim())
        : null;

      // ── Where the response turns into a stream ──────────────────────
      //
      // Everything that can be REFUSED is refused before a byte of SSE
      // goes out, so an unknown app, a bad target and an empty question
      // are still ordinary JSON errors with a real status code. Once the
      // 200 and the event-stream header are written the status is spent:
      // a failure after that point can only be an `error` event, which is
      // why the two are ordered this way rather than opening the stream
      // first and discovering the problem inside it.
      //
      // The budget check and the GitHub fetches happen inside ask(), which
      // is after the header. That is a deliberate trade: making the client
      // handle a budget refusal in two shapes (a 429 and an error event)
      // is worse than handling it in one, and the client shows the
      // server's sentence either way.
      let open = false;
      // The 200 is written on the FIRST thing that has to reach the client,
      // whether that is a token or the finished answer, so a reply short
      // enough to arrive in one block still opens a stream.
      const openStream = () => {
        if (open) return;
        open = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Caddy/Nginx buffer by default, which would hold the whole
          // answer back and defeat the point of streaming it.
          'X-Accel-Buffering': 'no',
        });
      };
      // JSON.stringify is what keeps the framing intact: an answer with a
      // newline in it would otherwise split one data: line into two and the
      // reader would see a truncated frame. JSON escapes it to \n.
      const send = (event, data) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // A client that navigates away mid-answer aborts the upstream call
      // rather than leaving it running and billable.
      const abort = new AbortController();
      req.on('close', () => { if (!res.writableEnded) abort.abort(); });

      try {
        const { text, model } = await workshopAsk.ask({
          pool,
          config,
          app,
          userId: req.user.id,
          target,
          question: body.question,
          model: picked,
          signal: abort.signal,
          onToken: (chunk) => {
            openStream();
            send('token', { text: chunk });
          },
        });
        // A complete answer that produced no token callback — a very short
        // reply, or a stream the SDK delivered in one block — still has to
        // reach the client, so the header may be opened here instead.
        openStream();
        // The assembled text rides on `done` as well as the tokens. The
        // client renders from THIS, not from what it accumulated: a
        // dropped chunk then costs a flicker rather than a wrong answer.
        send('done', { text, model });
        res.end();
      } catch (err) {
        if (!open) throw err;
        // Past the header: the only channel left is an event.
        log.warn('workshop-ask', 'ask failed mid-stream', { message: err.message });
        send('error', { error: streamErrorMessage(err) });
        res.end();
      }
    } catch (err) {
      if (res.headersSent) return;
      if (err.code === 'empty_question') return res.status(400).json({ error: err.message });
      if (err.code === 'not_found') return res.status(404).json({ error: err.message });
      if (err.code === 'budget_exceeded') {
        return res.status(429).json({ error: err.message, code: 'budget_exceeded' });
      }
      if (err.code === 'llm_unavailable') return res.status(503).json({ error: err.message });
      log.error('workshop-ask', 'ask failed', { message: err.message });
      res.status(500).json({ error: 'Could not answer that just now' });
    }
  });

  return router;
}

module.exports = { workshopAskRoutes };
