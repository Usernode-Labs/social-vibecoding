require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { load: loadConfig } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const { authMiddleware } = require('./src/middleware/auth');
const { authRoutes } = require('./src/routes/auth');
const jwt = require('jsonwebtoken');
const { appRoutes } = require('./src/routes/apps');
const { chatRoutes } = require('./src/routes/chat');
const { sessionRoutes } = require('./src/routes/sessions');
const { voteRoutes } = require('./src/routes/votes');
const { issueRoutes } = require('./src/routes/issues');
const { adminRoutes } = require('./src/routes/admin');
const { feedbackRoutes } = require('./src/routes/feedback');
const { notificationsRoutes } = require('./src/routes/notifications');
const { statusRoutes } = require('./src/routes/status');
const { internalRoutes } = require('./src/routes/internal');
const anthropicProxyRoutes = require('./src/routes/anthropic-proxy');
const github = require('./src/services/github');
const llm = require('./src/services/llm');
const worker = require('./src/services/worker');
const ws = require('./src/services/ws');
const log = require('./src/services/logger');
const lifecycle = require('./src/services/lifecycle');
const chainPoller = require('./src/services/chain-poller');
const genesisAccounts = require('./src/services/genesis-accounts');
const nodeStatus = require('./src/services/node-status');
const statusService = require('./src/services/status');
const { getActiveWorkerCount } = require('./src/routes/sessions');
const { sweepStuckCreatingApps } = require('./src/routes/apps');
const { getPool } = require('./src/db/pool');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();

// One hop (Caddy) in front of us — enables accurate req.ip for rate limits.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Lightweight endpoint polled by the header "platform version" pill
// (public/js/app.js → renderPlatformVersionPill). Four pieces of
// information packaged together so the client only needs one fetch:
//   - `sha`            : the SHA the running platform was built from.
//   - `name`           : short label shown in the pill (mirrors how the
//                        per-app pill leads with the app slug, so the
//                        two read symmetrically as "usernode · sha"
//                        and "myapp · sha · #pr"). Overridable via env.
//   - `repoUrl`        : where to link the pill (commit on GitHub).
//                        Overridable via env so forks point at their own repo.
//   - `deployProgress` : null in idle state, or { deploying, sha, startedAt }
//                        when the deploy workflow has flagged a redeploy in
//                        flight (see services/deploy-status.js + deploy.yml).
const deployStatus = require('./src/services/deploy-status');
app.get('/api/version', (_req, res) => {
  res.json({
    sha: process.env.GIT_SHA || 'dev',
    name: process.env.USERNODE_PROJECT_NAME || 'usernode',
    repoUrl: process.env.USERNODE_REPO_URL || 'https://github.com/Usernode-Labs/social-vibecoding',
    deployProgress: deployStatus.read(),
    // SELF-HOSTING.md Phase 2f / Phase 3: the platform's own slug
    // in the apps table. Clients use this to recognize self-app
    // surfaces (e.g. the "Platform updating…" banner cross-checks
    // sessionStorage state against the live self-app slug). Cheap to
    // include — already available in config; saves the client a second
    // round-trip for any code path that needs it.
    selfAppSlug: config.selfAppSlug,
  });
});

// Public conventions endpoint. Apps' own CLAUDE.md files point here so
// a developer (or Claude Code) running locally against a repo can
// fetch the current platform rules without cloning the harness.
// Mounted before authMiddleware so it's open to anyone.
app.get('/claude.md', (_req, res) => {
  const fs = require('fs');
  const fp = path.join(__dirname, 'src', 'prompts', 'app-conventions.md');
  try {
    const body = fs.readFileSync(fp, 'utf-8');
    const stat = fs.statSync(fp);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Last-Modified', stat.mtime.toUTCString());
    // No strong caching — the whole point is that this URL serves the
    // current conventions, not a snapshot.
    res.set('Cache-Control', 'public, max-age=60');
    res.send(body);
  } catch (err) {
    log.error('conventions', 'Failed to serve /claude.md', { err: err.message });
    res.status(500).type('text/plain').send('conventions unavailable');
  }
});

// Public sidecar-status endpoints. All read the cached snapshot maintained
// by `services/node-status.js` (one poll per process, regardless of how
// many clients are watching). Mounted before authMiddleware so anonymous
// visitors and embedded child-app pages can both read them. All on-chain
// info is already public, so no progressive disclosure here.
//
// Three surfaces:
//   - /api/node-status        : compact node snapshot (powers the summary
//                                card on the main /status page)
//   - /api/node-status/full   : full snapshot (server + node + explorer +
//                                chain-dependent services). Powers the
//                                /node-status viewer page.
//   - /node-status            : the standalone HTML viewer (modeled on
//                                dapp-server.js's /status page)
app.get('/api/node-status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.get());
});

app.get('/api/node-status/full', (_req, res) => {
  // Lazy require here (rather than top of file) keeps the import graph
  // straight: chain-poller and genesis-accounts are leaf modules; node-
  // status doesn't import them. The callback shape is what wires them
  // together at request time.
  const chainPollerSvc = require('./src/services/chain-poller');
  const genesisAccountsSvc = require('./src/services/genesis-accounts');
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.getFull({
    name: 'usernode-social-vibecoding',
    mode: process.env.USERNODE_LOCAL_DEV ? 'local-dev' : 'production',
    services: () => ({
      chainPoller: chainPollerSvc.getStatus(),
      genesisAccounts: {
        loaded: genesisAccountsSvc.isLoaded(),
        count: genesisAccountsSvc.count(),
      },
    }),
  }));
});

app.get('/node-status', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-status.html'));
});

// Status routes are public (with progressive disclosure for admins) —
// mount before authMiddleware so they don't redirect anonymous visitors.
app.use(statusRoutes(config));

// Worker → platform internal API (git push proxy, PR creation).
// Mounted BEFORE authMiddleware because requests come from worker
// containers, not users — they carry a session-scoped JWT in
// Authorization: Bearer, verified by internal-auth middleware inside
// the router. Also gated by a private-IP check; not reachable through
// Caddy's external vhosts in production.
app.use(internalRoutes(config));

// Worker → platform Anthropic proxy. The CC worker container holds a
// session-scoped JWT (in ANTHROPIC_API_KEY env, picked up as x-api-key
// by the SDK) and ANTHROPIC_BASE_URL points at /api/internal/anthropic
// here. The proxy verifies the JWT, swaps in the real platform key, and
// forwards to api.anthropic.com — so the platform key never enters the
// worker container and "echo $ANTHROPIC_API_KEY" exfiltrates only a
// short-lived JWT useless against Anthropic directly. Same private-IP
// gate as internalRoutes; not reachable through Caddy externally.
app.use(anthropicProxyRoutes(config));

app.use(authMiddleware(config));
app.use(authRoutes(config));
app.use(appRoutes(config));
app.use(chatRoutes(config));
app.use(sessionRoutes(config));
app.use(voteRoutes(config));
app.use(issueRoutes(config));
app.use(adminRoutes(config));
app.use(feedbackRoutes(config));
app.use(notificationsRoutes(config));

app.get('/api/iframe-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  let usernodePubkey = null;
  try {
    const { rows } = await getPool(config).query(
      'SELECT usernode_pubkey FROM users WHERE id = $1',
      [req.user.id]
    );
    usernodePubkey = rows[0]?.usernode_pubkey || null;
  } catch {}
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, usernode_pubkey: usernodePubkey },
    config.jwtSecret,
    { expiresIn: '1h' }
  );
  res.json({ token });
});

// Bridge centralization: versioned bridge served from /usernode-bridge/vN/.
// Within a major version (e.g. v1), bug fixes ship by editing the file in
// SV and redeploying — every dapp picks the fix up on next page load.
// Browsers must therefore revalidate on every request so changes propagate
// quickly; the file is ~100KB and revalidates via 304 when unchanged.
// Across major versions the URL changes (/v1/ → /v2/) so caches segregate
// naturally. Dapps still vendor their own copy for now; this is the
// additive scaffolding for a future migration off vendoring.
app.use('/usernode-bridge', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

async function start() {
  await migrate(config);
  await github.init(config);
  await llm.init(config);

  // Any app stuck in 'creating' from a previous process crash gets flipped
  // to 'error' so the creator can retry instead of staring at a spinner.
  await sweepStuckCreatingApps(getPool(config)).catch(() => {});

  // Backfill `main_sha` for apps created before #21 added the column.
  // Non-blocking: we log and continue so a single slow/unauthorized
  // repo doesn't delay the server coming up.
  const { backfillMainShas } = require('./src/services/app-version');
  backfillMainShas(getPool(config)).catch((err) => {
    log.warn('server', 'main_sha backfill failed', { err: err.message });
  });

  // Public-only audit: scan existing `apps` rows and log a warning for
  // any repo that's currently private. The worker bootstrap guard
  // refuses to spawn against private repos, so these apps will fail
  // to start a dev session until the user makes the repo public —
  // surfacing them at boot lets operators see the impact ahead of
  // first user contact. Non-blocking.
  auditExistingRepoPrivacy(getPool(config)).catch((err) => {
    log.warn('server', 'private-repo audit failed', { err: err.message });
  });

  worker.ensureWorkerImage().catch((err) => {
    log.warn('server', 'Worker image build deferred', { err: err.message });
  });

  const server = app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
  });

  ws.attach(server, config);
  chainPoller.start(config);
  genesisAccounts.start();
  nodeStatus.start({ nodeRpcUrl: process.env.NODE_RPC_URL });
  // Warm the /api/status cache so the first dashboard load doesn't have
  // to wait 1-2s on `docker stats`. Subsequent loads are served from
  // cache via stale-while-revalidate (see services/status.js).
  statusService.start(config);
  // Periodically check imported / bot-owned repos for new commits on
  // `main` we didn't make ourselves and redeploy via the same path
  // that the dev-chat merge flow uses. See main-drift-poller.js.
  require('./src/services/main-drift-poller').start(config);

  // Adopt any worker containers left over from a previous server run —
  // either still executing or already exited but un-finalized. These
  // orphans are a feature, not a bug: workers are intentionally detached
  // from the server lifecycle so `node --watch` restarts don't interrupt
  // in-flight Claude Code sessions.
  recoverActiveWorkers(config).catch((err) => {
    log.warn('server', 'Worker adoption failed', { err: err.message });
  });

  // Idle-eviction sweeper. Warm workers cost ~256MB resident; eviction
  // reclaims that memory after a tunable idle period. The CC volume
  // (cc-volume-<sessionId>) is preserved so the next dispatch's
  // re-warm replays prior conversation state via `claude --resume`.
  //
  // WORKER_IDLE_EVICTION_MS is the only knob (default 10min). Lower it
  // if memory headroom shrinks; raise it if we're seeing frequent
  // re-warms in production logs.
  startIdleEvictionSweeper();

  // If the previous server died mid-merge, some sessions may be stuck
  // in the 'merging' claim state. There's no way to know from here
  // whether the GitHub merge + prod rebuild actually completed — but
  // the merge step is guarded against concurrent runs by GitHub's own
  // lock, and the rebuild step is guarded by `rebuildProduction`
  // swapping containers idempotently. Safest move: flip 'merging' back
  // to 'promoted' so the next vote (or retry) can redrive. If the PR
  // was already merged on GitHub, the next attempt will fail with a
  // clear error that surfaces to users.
  recoverStuckMerges(config).catch((err) => {
    log.warn('server', 'Stuck-merge recovery failed', { err: err.message });
  });

  // Fallback recovery: for sessions whose container is already gone but
  // whose branch is ahead of main (i.e. CC pushed commits during an old
  // pre-autonomous-worker run), complete the PR + staging tail.
  recoverSessions(config).catch((err) => {
    log.warn('server', 'Session recovery failed', { err: err.message });
  });

  return server;
}

start().catch((err) => {
  // pg's ECONNREFUSED and some Octokit errors leave `.message` empty, so
  // also surface `.code` and the stack — otherwise boot failures print
  // as `{"message":""}` and there's nothing to act on.
  log.error('server', 'Failed to start', {
    message: err.message || '(empty)',
    code: err.code,
    stack: err.stack,
  });
  process.exit(1);
});

// Scan existing imported apps for privacy violations. Usernode workers
// run with zero GitHub credentials and rely on unauthenticated public
// HTTPS clones; a private repo can't be cloned by the worker, so dev
// sessions against it will fail at bootstrap. Surface those rows at
// boot so the operator can decide whether to ask the user to make
// the repo public or delete the import.
//
// Bounded concurrency (a small pool) keeps the scan from spending
// minutes on a large `apps` table during startup. The check is purely
// read-only — we log and move on.
async function auditExistingRepoPrivacy(pool) {
  const github = require('./src/services/github');
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, slug, repo_url FROM apps
       WHERE repo_url IS NOT NULL AND status != 'archived'`
    ));
  } catch (err) {
    log.warn('server', 'private-repo audit: query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Starting private-repo audit', { count: rows.length });

  // Cap concurrency so a 100-row deployment doesn't fire 100 GitHub
  // API calls in parallel and trip secondary rate limits.
  const CONCURRENCY = 4;
  const queue = rows.slice();
  let privateCount = 0;
  let errorCount = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) continue;
      const [, owner, repo] = m;
      try {
        const result = await github.checkRepoPublic(owner, repo);
        if (!result.ok) {
          errorCount++;
          log.warn('server', 'private-repo audit: lookup failed', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`, err: result.message,
          });
        } else if (result.private) {
          privateCount++;
          log.warn('server', 'private-repo audit: app references a PRIVATE repo (dev sessions will fail)', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`,
          });
        }
      } catch (err) {
        errorCount++;
        log.warn('server', 'private-repo audit: unexpected error', {
          appId: row.id, slug: row.slug, err: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  log.info('server', 'Private-repo audit complete', {
    total: rows.length, private: privateCount, errors: errorCount,
  });
}

// Unstick sessions left in 'merging' by a previous server process.
// See the call site for rationale.
async function recoverStuckMerges(config) {
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);
  try {
    const { rows } = await pool.query(
      `UPDATE chat_sessions SET status = 'promoted'
       WHERE status = 'merging'
       RETURNING id`
    );
    if (rows.length) {
      log.info('server', 'Unstuck merging sessions on startup', {
        count: rows.length, ids: rows.map((r) => r.id),
      });
    }
  } catch (err) {
    log.warn('server', 'recoverStuckMerges query failed', { err: err.message });
  }
}

// Recover sessions where CC finished but post-processing didn't complete
async function recoverSessions(config) {
  const { getPool } = require('./src/db/pool');
  const staging = require('./src/services/staging');
  const docker = require('./src/services/docker');
  const ghub = require('./src/services/github');
  const { broadcastGlobal } = require('./src/services/ws');
  const pool = getPool(config);

  // Find active sessions that have a branch but no staging URL
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     WHERE cs.status = 'active' AND cs.branch_name IS NOT NULL AND cs.staging_url IS NULL`
  );

  for (const session of rows) {
    try {
      const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!owner || !repo) continue;

      // Check if the branch has commits ahead of main
      const octokit = await ghub.getInstallationOctokit(owner).catch(() => null);
      const pat = process.env.GITHUB_BOT_TOKEN;
      if (!pat) continue;

      const { Octokit } = await import('@octokit/rest');
      const ok = new Octokit({ auth: pat });

      let compare;
      try {
        const { data } = await ok.rest.repos.compareCommits({
          owner, repo, base: 'main', head: session.branch_name,
        });
        compare = data;
      } catch { continue; }

      if (compare.ahead_by === 0) continue;

      log.info('server', 'Recovering session — building staging', {
        sessionId: session.id, branch: session.branch_name, aheadBy: compare.ahead_by,
      });

      const commitHash = compare.commits[compare.commits.length - 1]?.sha || 'latest';
      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

      // Create PR if missing
      if (!session.pr_number) {
        try {
          const pr = await ghub.createPR(owner, repo, {
            branch: session.branch_name,
            title: `Changes on ${session.branch_name}`,
            body: `Recovered dev session via Usernode`,
          });
          await pool.query(
            `UPDATE chat_sessions SET pr_number = $1, pr_url = $2 WHERE id = $3`,
            [pr.number, pr.html_url, session.id]
          );
          session.pr_number = pr.number;
          session.pr_url = pr.html_url;
        } catch {}
      }

      // Build staging
      const stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
      await pool.query(
        `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
        [stagingResult.containerId, stagingResult.stagingUrl, session.id]
      );

      // Save a status message
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, 'Staging recovered after restart', JSON.stringify({ stagingUrl: stagingResult.stagingUrl })]
      );

      // Notify via WebSocket
      broadcastGlobal({
        type: 'session_event', sessionId: session.id,
        event: 'staging_ready', url: stagingResult.stagingUrl,
      });

      log.info('server', 'Session recovered', { sessionId: session.id, url: stagingResult.stagingUrl });
    } catch (err) {
      log.warn('server', 'Failed to recover session', { sessionId: session.id, err: err.message });
    }
  }
}

// Adopt orphan worker containers on startup.
//
// A worker is "orphan" if its container (usernode-worker-<sessionId>)
// still exists on the host after the server comes up. That can happen
// two ways:
//
//   1) The previous server exited (SIGTERM from `node --watch`, crash,
//      host reboot) while a worker was in flight. Because the worker's
//      entrypoint runs the full clone→claude→commit→push pipeline on
//      its own, it may be STILL RUNNING or may have EXITED cleanly
//      while we were gone.
//   2) A past server exited after push but before building staging.
//
// For each case we re-attach to `docker logs -f` (which blocks on
// running containers and dumps everything immediately on exited ones),
// parse the final __USERNODE_RESULT__ line, and run PR + staging the
// same way the live chat handler does. All client updates go over the
// global WebSocket so any open tab sees the tail of its own session.
async function recoverActiveWorkers(config) {
  const pool = getPool(config);
  const staging = require('./src/services/staging');
  const ghub = require('./src/services/github');
  const { broadcastGlobal } = require('./src/services/ws');

  const orphans = await worker.listOrphanWorkers();
  if (!orphans.length) return;

  log.info('server', 'Adopting orphan worker containers', {
    count: orphans.length,
    names: orphans.map((o) => o.name),
  });

  for (const orphan of orphans) {
    // Run each adoption in parallel; they're IO-bound and isolated.
    adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal })
      .catch((err) => {
        log.warn('server', 'Orphan adoption failed', {
          name: orphan.name, err: err.message,
        });
      });
  }
}

async function adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal }) {
  const { name: containerName, sessionId, state: containerState } = orphan;

  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url, u.username
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     JOIN users u ON cs.user_id = u.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) {
    // Session gone (archived/deleted). Just reap the container.
    log.info('server', 'Orphan has no session row — removing', { containerName });
    await worker.destroyWorker(containerName);
    return;
  }
  const session = rows[0];

  if (session.status !== 'active') {
    // Session archived while we were down — drop the container.
    await worker.destroyWorker(containerName);
    return;
  }

  // Long-lived worker reality check: a *running* container could be
  //   (a) a warm-idle wrapper sitting in `sleep infinity` — clean adopt,
  //       no log scrape needed.
  //   (b) a legacy single-shot still in flight — only possible during
  //       rollout from the old worker contract; tail logs as before.
  //   (c) a warm wrapper that was mid-exec when our process died. The
  //       host-side `docker exec` child was killed with us; the in-
  //       container claude/run-cc.sh keeps running but its stdout went
  //       to a disconnected client and is unrecoverable. Killing it
  //       avoids racing the next dispatch's exec against a phantom.
  //
  // `pgrep claude || pgrep run-cc.sh` inside the container distinguishes
  // case (a) from (b)+(c).
  if (containerState === 'running') {
    const busy = await worker.isWorkerExecuting(containerName);
    if (busy === false) {
      log.info('server', 'Adopting warm-idle worker (no in-flight exec)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    if (busy === true && session.cc_session_id) {
      // V1 conservative recovery for case (c): the prior in-flight turn
      // is unrecoverable from the host. Kill the orphan exec to free
      // the warm container for fresh dispatches, then post a system
      // message so the user knows to retry. We DON'T try to scrape
      // logs — `docker exec` output went to our dead parent, not the
      // wrapper's stdout, so `docker logs -f` would only ever show
      // bootstrap + warm-ready. Better to fail fast than hang forever.
      log.info('server', 'Adopting mid-exec worker — killing orphan exec', {
        containerName, sessionId,
      });
      const docker = require('./src/services/docker');
      await docker.execFileAsync('docker', [
        'exec', containerName, 'pkill', '-f', '(^|/)(claude|run-cc.sh)( |$)',
      ], { timeout: 5000 }).catch(() => {});
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          'Lost connection mid-turn after restart — please retry your request.',
          JSON.stringify({}),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: 'Lost connection mid-turn after restart — please retry your request.',
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    // busy === null (couldn't probe) or true with no cc_session_id
    // (legacy single-shot rollout): fall through to the legacy
    // watchWorker scrape. Safe on already-exited containers; for a
    // hung warm wrapper it'd block, but the idle sweeper plus session
    // archive cap the worst case.
  }

  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  emit('status', { text: 'Reconnecting to in-flight coding agent...' });

  const result = await worker.watchWorker(containerName, {
    onProgress: (text) => {
      emit('cc_progress', { text });
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(
           metadata, '{progressLog}',
           (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
         )
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify([text]), sessionId]
      ).catch(() => {});
    },
  });

  // Capture the CC session id so the next turn can --resume, even though
  // the server process that originally spawned this worker is gone.
  const newCcId = result.sessionId || result.initSessionId || null;
  if (newCcId && newCcId !== session.cc_session_id) {
    await pool.query(
      `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
      [newCcId, sessionId]
    ).catch(() => {});
  }

  const hasChanges = result.ahead > 0 && !!result.sha;
  if (!hasChanges) {
    emit('status', { text: 'Recovered session produced no changes.' });
    await worker.destroyWorker(containerName);
    return;
  }

  try {
    // Pull the user's most recent message so the PR title helper has
    // the same "what did you ask for?" signal that the normal dev-turn
    // path gets via the live SSE request body. Without this, recovery
    // would hit the fallback template ("<user>'s changes") and never
    // regenerate titles for iterative edits.
    const { rows: userMsgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    const recoveredUserMessage = userMsgRows[0]?.content || '';
    const recoveredCcSummary = result.lastResultText || '';

    const prMetadata = require('./src/services/pr-metadata');
    await prMetadata.applyPrMetadata({
      pool, session, repoOwner, repoName,
      userMessage: recoveredUserMessage,
      ccSummary: recoveredCcSummary,
      username: session.username,
      broadcast: (event, data) => emit(event, data),
      userId: session.user_id,
    });

    emit('status', { text: 'Building staging preview...' });
    const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
    const stagingResult = await staging.buildAndDeployStaging(config, session, app, result.sha);

    await pool.query(
      `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
      [stagingResult.containerId, stagingResult.stagingUrl, sessionId]
    );

    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Staging deployed (recovered after restart)', $2)`,
      [sessionId, JSON.stringify({ stagingUrl: stagingResult.stagingUrl })]
    );

    emit('staging_ready', { url: stagingResult.stagingUrl });
    log.info('server', 'Orphan finalized', {
      sessionId, commitHash: result.sha.substring(0, 8), url: stagingResult.stagingUrl,
    });
  } finally {
    await worker.destroyWorker(containerName);
  }
}

// Idle-eviction sweeper for warm worker containers.
//
// Runs every SWEEP_INTERVAL_MS. For each session in the warm registry,
// if there's no in-flight exec AND the container hasn't been used in
// WORKER_IDLE_EVICTION_MS, we `docker stop && docker rm` it. The
// per-session CC volume is preserved so the next dispatch can re-warm
// with `claude --resume <id>` and replay conversation state.
//
// Tuning: WORKER_IDLE_EVICTION_MS (default 10min). The sweeper itself
// is cheap — a `Map` walk + at most a couple of execs per cycle — so
// the interval is fixed at 30s.
const WORKER_IDLE_EVICTION_MS = parseInt(
  process.env.WORKER_IDLE_EVICTION_MS || (10 * 60 * 1000),
  10
);
const SWEEP_INTERVAL_MS = 30 * 1000;

let sweeperHandle = null;

function startIdleEvictionSweeper() {
  if (sweeperHandle) return;
  log.info('server', 'Worker idle-eviction sweeper started', {
    idleEvictionMs: WORKER_IDLE_EVICTION_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
  });
  sweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;
    const now = Date.now();
    const snapshot = worker.warmRegistrySnapshot();
    for (const meta of snapshot) {
      if (meta.inFlight) continue;
      if (meta.bootstrapping) continue;
      if (now - meta.lastUsedMs < WORKER_IDLE_EVICTION_MS) continue;
      try {
        await worker.evictWorker(meta.sessionId);
        log.info('server', 'Idle warm worker evicted', {
          sessionId: meta.sessionId,
          containerName: meta.containerName,
          idleMs: now - meta.lastUsedMs,
        });
      } catch (err) {
        log.warn('server', 'Idle eviction failed', {
          sessionId: meta.sessionId, err: err.message,
        });
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
  // .unref() so the sweeper doesn't hold the event loop open if everything
  // else has shut down. We still clearInterval explicitly in cleanup() to
  // race-free stop the sweeper before exit.
}

// Graceful shutdown: mark drain state so new chats/app-creates/builds get
// 503'd, wait up to DRAIN_TIMEOUT_MS for in-flight HTTP handlers to
// finish flushing DB writes, then exit.
//
// IMPORTANT: we deliberately do NOT force-remove worker containers here.
// Two reasons in the long-lived worker world:
//   - In-flight execs (workers in `activeWorkers`): killing them would
//     drop the user's turn mid-CC. Better to drain naturally; if the
//     drain times out the host-side `docker exec` child dies with us
//     and recoverActiveWorkers handles the orphan on restart.
//   - Warm-idle workers (NOT in `activeWorkers`): these are siblings
//     on the host Docker daemon, so they survive a `docker compose up`
//     redeploy of the server. Next boot's recoverActiveWorkers adopts
//     them as warm-idle, so the next dispatch is fast even across
//     production redeploys. The idle sweeper reclaims their memory in
//     steady state.
const DRAIN_TIMEOUT_MS = 60000;
let cleanupStarted = false;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  lifecycle.setShuttingDown();
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }

  const startingCount = getActiveWorkerCount();
  log.info('server', 'Shutdown initiated, draining handlers', {
    activeWorkers: startingCount, timeoutMs: DRAIN_TIMEOUT_MS,
  });

  const drained = await lifecycle.waitFor(() => getActiveWorkerCount() === 0, {
    timeoutMs: DRAIN_TIMEOUT_MS, intervalMs: 500,
  });

  if (!drained) {
    log.warn('server', 'Drain timeout — exiting; workers keep running and will be adopted on restart', {
      remaining: getActiveWorkerCount(),
    });
  } else if (startingCount > 0) {
    log.info('server', 'All handlers drained; worker containers persist across restart');
  }

  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
