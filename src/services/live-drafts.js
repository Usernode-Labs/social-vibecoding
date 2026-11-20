'use strict';

// Live app drafts: a project changed with Homeroom bot while its preview
// runs beside the chat.
//
// In a private thread of their chat with the bot that is about a project, a
// person taps "Open app preview". That opens a DRAFT (`live_drafts`): a
// change of their own (a chat_sessions row they own, its branch off main)
// with a preview of it built the ordinary way, by the preview machine, as a
// preview with no checks (the App bench studio's kind). One thing differs:
// the preview's container starts services/live-draft-supervisor.js instead
// of the app's own command (runtimeFor, read by services/staging.js).
//
// While the draft is open, what they say in that thread is answered by the
// draft bot (services/live-draft-bot.js), which reads the draft's code and
// changes it with exact find-and-replace edits, as a design thread does. An
// edit (applyEdit) is a commit on the draft's branch, then the same files
// written into the running preview, which restarts the app in place: no new
// image, so it shows in seconds. What the restart says goes back to the bot
// in the same turn, so an edit that stops the app is fixed before they look.
// An edit that changes what the app installs (a dependency) is answered
// `needsRebuild` by the supervisor: the preview is built again from the
// branch, the ordinary way.
//
// A preview that slept and woke, or was rebuilt, runs its image again, whose
// commit may be older than the draft's: the supervisor says which commit its
// files are at, and syncPreview sends what changed since.
//
// Propose puts the draft up for a vote, as the person's own change, through
// the same promote a change's Propose button uses (platform.promoteProposal).
// Once it is up, the draft is no longer open, so the preview the vote's
// checks run against is an ordinary one (the preview machine checks a
// session that goes up for a vote, previewed with no checks before:
// src/workflow/preview/machine.ts begin).
//
// An admin can switch drafts off for everyone (`live_drafts_enabled` in
// platform_settings, Admin › Limits): no new draft opens and no edit runs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const log = require('./logger');
const botFailure = require('./bot-turn-failure');

const SETTING_KEY = 'live_drafts_enabled';
const CACHE_TTL_MS = 10 * 1000;
// Open drafts a person may have at once: each one is a running preview.
const MAX_OPEN_PER_USER = 2;
const APPLY_TIMEOUT_MS = 150 * 1000;
const STATUS_TIMEOUT_MS = 8 * 1000;
// More changed files than this since the preview's own commit: build it again.
const MAX_SYNC_FILES = 150;
const SHA = /^[0-9a-f]{40}$/i;
const exact = (v) => (SHA.test(String(v || '')) ? String(v).toLowerCase() : null);

const supervisor = () => require('./live-draft-supervisor');

// ── The switch ──────────────────────────────────────────────────────────

const caches = new WeakMap();

/** Whether drafts are on (they are unless an admin switched them off). Never throws. */
async function enabled(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.on;
  let on = true;
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [SETTING_KEY]);
    on = !rows[0] || String(rows[0].value).trim().toLowerCase() !== 'false';
  } catch (err) {
    log.warn('live-drafts', 'Could not read the drafts switch; drafts stay on', { err: err.message });
  }
  caches.set(pool, { on, at: Date.now() });
  return on;
}

async function setEnabled(pool, { on, actorId = null }) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [SETTING_KEY, on ? 'true' : 'false', actorId],
  );
  caches.delete(pool);
}

/** What Admin › Limits shows: the switch and the drafts open now. */
async function adminPayload(pool) {
  const on = await enabled(pool);
  const { rows: [setting] } = await pool.query(
    `SELECT s.updated_at, u.username AS updated_by FROM platform_settings s
       LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = $1`,
    [SETTING_KEY],
  ).catch(() => ({ rows: [] }));
  const { rows: [count] } = await pool.query("SELECT COUNT(*)::int AS n FROM live_drafts WHERE state = 'open'")
    .catch(() => ({ rows: [{ n: 0 }] }));
  return { enabled: on, open: count?.n || 0, updatedAt: setting?.updated_at || null, updatedBy: setting?.updated_by || null };
}

// ── The draft's secret ──────────────────────────────────────────────────

/**
 * The secret a draft's supervisor answers to: an HMAC of the draft's id, so
 * every platform process derives the same one and none is stored. Never
 * handed to the app (the supervisor drops it from the app's environment).
 */
function liveToken(config, draftId) {
  const key = config?.workerJwtSecret || config?.edgeJwtSecret || config?.dataEncryptionKey || 'usernode-live-draft';
  return crypto.createHmac('sha256', String(key)).update(`live-draft:${Number(draftId)}`).digest('hex');
}

// ── Reading drafts ──────────────────────────────────────────────────────

const DRAFT_COLUMNS = `d.id, d.app_id, d.user_id, d.private_thread_id, d.root_message_id, d.session_id, d.state,
  d.base_sha, d.head_sha, d.edits, d.live_state, d.last_error, d.created_at, d.updated_at,
  a.slug AS app_slug, a.name AS app_name, a.repo_url,
  cs.branch_name, cs.status AS session_status, cs.staging_url, cs.staging_commit_sha,
  cs.staging_runtime_kind, cs.staging_runtime_name, cs.pr_number`;
const DRAFT_JOINS = `FROM live_drafts d
  JOIN apps a ON a.id = d.app_id
  LEFT JOIN chat_sessions cs ON cs.id = d.session_id`;

async function byId(pool, id, { userId = null } = {}) {
  const { rows: [row] } = await pool.query(
    `SELECT ${DRAFT_COLUMNS} ${DRAFT_JOINS} WHERE d.id = $1 AND ($2::int IS NULL OR d.user_id = $2::int)`,
    [Number(id), userId ? Number(userId) : null],
  );
  return row || null;
}

/** A thread's open draft, or null. */
async function forThread(pool, { userId, rootId }) {
  if (!Number(userId) || !Number(rootId)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT ${DRAFT_COLUMNS} ${DRAFT_JOINS}
      WHERE d.user_id = $1 AND d.root_message_id = $2 AND d.state = 'open'`,
    [Number(userId), Number(rootId)],
  );
  return row || null;
}

/** The thread a message of the chat with the bot is in: its root's id. */
function rootOf(message) {
  const id = Number(message?.threadRootId ?? message?.thread_root_id ?? message?.thread?.rootId) || null;
  return id || Number(message?.id) || null;
}

/**
 * The open draft of the thread a message is in, or null. With drafts
 * switched off, none: the thread is answered as any other.
 */
async function threadOf(pool, { userId, conversationId = null, message }) {
  try {
    let rootId = Number(message?.threadRootId ?? message?.thread_root_id) || null;
    if (!rootId && message?.id && conversationId) {
      const { rows: [row] = [] } = await pool.query(
        'SELECT thread_root_id FROM conversation_messages WHERE id = $1 AND conversation_id = $2',
        [Number(message.id), Number(conversationId)],
      );
      rootId = Number(row?.thread_root_id) || null;
    }
    rootId = rootId || rootOf(message);
    if (!rootId) return null;
    const draft = await forThread(pool, { userId, rootId });
    if (!draft || draft.state !== 'open' || !Number(draft.id) || Number(draft.root_message_id) !== rootId) return null;
    if (!(await enabled(pool))) return null;
    return draft;
  } catch (err) {
    log.warn('live-drafts', 'Could not read a thread\'s draft', { err: err.message });
    return null;
  }
}

/** Pure: where the preview stands, in the words the bar reads. */
function liveStateOf(draft) {
  if (!draft) return null;
  if (draft.state !== 'open') return draft.state;
  const serves = exact(draft.staging_commit_sha);
  if (draft.live_state === 'rebuilding' && draft.staging_url && serves && serves === exact(draft.head_sha)) return 'live';
  if (draft.live_state === 'starting' && draft.staging_url) return 'live';
  return draft.live_state;
}

/** Pure: a draft as the client reads it. */
function describe(draft) {
  if (!draft) return null;
  return {
    id: Number(draft.id),
    state: draft.state,
    live: liveStateOf(draft),
    sessionId: draft.session_id ? Number(draft.session_id) : null,
    rootId: Number(draft.root_message_id),
    app: { slug: draft.app_slug, name: draft.app_name || draft.app_slug },
    edits: Number(draft.edits) || 0,
    headSha: draft.head_sha || null,
    prNumber: draft.pr_number ? Number(draft.pr_number) : null,
    error: draft.last_error || null,
    updatedAt: draft.updated_at ? new Date(draft.updated_at).toISOString() : null,
  };
}

/** The draft's edits, oldest first. */
async function editsOf(pool, draftId) {
  const { rows } = await pool.query(
    'SELECT commit_sha, summary, paths, created_at FROM live_draft_edits WHERE draft_id = $1 ORDER BY id',
    [Number(draftId)],
  );
  return rows.map((r) => ({ commit: r.commit_sha, summary: r.summary, paths: r.paths || [], at: r.created_at }));
}

/** Tell the person's open tabs where their draft stands. Never throws. */
function noteChanged(draft, extra = {}, deps = {}) {
  try {
    const ws = deps.ws || require('./ws');
    ws.pushToUser(Number(draft.user_id), { type: 'live_draft_changed', draft: describe(draft), ...extra });
  } catch (err) {
    log.warn('live-drafts', 'Could not announce a draft change', { draftId: draft?.id, err: err.message });
  }
}

// ── The draft's repository ──────────────────────────────────────────────

function repoOf(draft) {
  return require('./repo-ref').ownerRepo(draft.repo_url) || null;
}

/** The draft's files at its head: [{ path, size }], or null when they cannot be read. */
async function listFiles(draft, deps = {}) {
  const repo = repoOf(draft);
  if (!repo || !exact(draft.head_sha)) return null;
  const github = deps.github || require('./github');
  const tree = await github.listRepoFiles(repo.owner, repo.repo, draft.head_sha);
  if (!tree) return null;
  return tree.files.map((f) => ({ path: f.path, size: f.size || 0 }));
}

/** One file's text at the draft's head, or null when there is none. */
async function readFile(draft, filePath, deps = {}) {
  const repo = repoOf(draft);
  if (!repo || !exact(draft.head_sha)) return null;
  const github = deps.github || require('./github');
  return github.getFileContent(repo.owner, repo.repo, filePath, draft.head_sha);
}

// ── Opening a draft ─────────────────────────────────────────────────────

const refuse = (status, code, message, extra = {}) => ({ status, body: { ok: false, error: code, message, ...extra } });

/**
 * Open the draft of one of `user`'s private threads that is about a project
 * (`rootId`, its root message), or answer the one already open there.
 * Resolves `{ status, body }`: 200 with `{ ok, draft, reused }`, else why not.
 */
async function open(pool, config, { user, rootId, deps = {} }) {
  if (!user?.id) return refuse(401, 'sign_in', 'Sign in first.');
  if (!(await enabled(pool))) return refuse(503, 'drafts_off', 'App previews in chats are switched off right now.');
  const existing = await forThread(pool, { userId: user.id, rootId });
  if (existing) {
    // Asked for again (Homeroom bot's open_app_preview): it comes up again too.
    noteChanged(existing, { opened: true }, deps);
    return { status: 200, body: { ok: true, draft: describe(existing), reused: true } };
  }

  const access = deps.appAccess || require('./app-access');
  const { rows: [thread] } = await pool.query(
    `SELECT pt.id, pt.app_id, pt.root_message_id FROM private_threads pt
      WHERE pt.root_message_id = $1 AND pt.user_id = $2`,
    [Number(rootId), Number(user.id)],
  );
  if (!thread) return refuse(404, 'no_thread', 'No such thread of yours.');
  if (!thread.app_id) return refuse(409, 'no_project', 'This thread is not about a project yet.');
  const { rows: [app] } = await pool.query(
    `SELECT ${access.nonSecretAppColumnList()} FROM apps WHERE id = $1`, [thread.app_id],
  );
  if (!app) return refuse(404, 'no_project', 'That project is gone.');
  if (app.self_hosted || (config.selfAppSlug && app.slug === config.selfAppSlug)) {
    return refuse(409, 'not_supported', 'Homeroom itself cannot be drafted here: start a change from its Workshop.');
  }
  const repo = repoOf({ repo_url: app.repo_url });
  if (!repo) return refuse(409, 'no_code', 'That project has no code yet.');
  let allowed = false;
  try { allowed = await access.checkAppAccess(pool, app, user, 'collab'); } catch { allowed = false; }
  if (!allowed) return refuse(404, 'no_project', 'You cannot change that project.');
  const join = await (deps.communities || require('./communities')).appNeedsJoin(pool, app.slug, user);
  if (join) return { status: 403, body: join };
  const { rows: [{ n }] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM live_drafts WHERE user_id = $1 AND state = 'open'", [Number(user.id)],
  );
  if (n >= MAX_OPEN_PER_USER) {
    return refuse(409, 'too_many', `You can have ${MAX_OPEN_PER_USER} app previews open at once. Propose or close one first.`);
  }

  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title)
     VALUES ($1, $2, 'paused', FALSE, '{}', $3)
     RETURNING *`,
    [app.id, user.id, `Live draft of ${app.name || app.slug}`.slice(0, 200)],
  );
  let draft;
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO live_drafts (app_id, user_id, private_thread_id, root_message_id, session_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [app.id, user.id, thread.id, Number(rootId), session.id],
    );
    draft = row;
  } catch (err) {
    // Two taps at once: the other one opened it.
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [session.id]).catch(() => {});
    const raced = await forThread(pool, { userId: user.id, rootId });
    if (raced) return { status: 200, body: { ok: true, draft: describe(raced), reused: true } };
    throw err;
  }

  let head = null;
  let asked = null;
  try {
    const lifecycle = deps.sessionLifecycle || require('./session-lifecycle');
    const { branchName } = await lifecycle.ensureSessionBranch({
      pool, sessionId: session.id, userId: user.id, username: user.username, label: 'draft',
    });
    const github = deps.github || require('./github');
    head = exact(await github.getBranchSha(repo.owner, repo.repo, branchName));
    if (!head) throw new Error('The draft\'s branch has no commit');
    await pool.query(
      'UPDATE live_drafts SET base_sha = $2, head_sha = $2, updated_at = NOW() WHERE id = $1', [draft.id, head],
    );
    const previews = deps.previewWorkflow || require('./preview-workflow');
    asked = await previews.request({
      pool, session: { ...session, branch_name: branchName }, head, reason: 'preview', actor: `user:${user.id}`,
    });
    if (asked?.status === 'rejected' && asked.reason !== 'already_serving') {
      throw new Error(`The preview could not be started (${asked.reason || 'refused'})`);
    }
  } catch (err) {
    log.warn('live-drafts', 'A draft could not start', { draftId: draft.id, err: err.message });
    await botFailure.recordPlatformIncident(pool, {
      where: 'live draft open', cause: asked?.reason || 'start',
    }, deps);
    await pool.query(
      `UPDATE live_drafts SET live_state = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [draft.id, String(err.userMessage || err.message).slice(0, 500)],
    );
  }
  const row = await byId(pool, draft.id);
  // `opened`: their thread's bar brings the preview up beside the chat.
  noteChanged(row, { opened: true }, deps);
  log.info('live-drafts', 'Draft opened', { draftId: draft.id, appId: app.id, userId: user.id, sessionId: session.id });
  return { status: 200, body: { ok: true, draft: describe(row), reused: false } };
}

// ── The preview's start ─────────────────────────────────────────────────

let supervisorSource = null;

/** Pure: the container command that starts the supervisor for this build's image. */
function supervisorCommand(build, runtimeMode) {
  if (supervisorSource == null) {
    supervisorSource = fs.readFileSync(path.join(__dirname, 'live-draft-supervisor.js'), 'utf8');
  }
  const node = ['node', '-e', supervisorSource];
  // A buildpack image finds Node through its launcher; a Dockerfile's image
  // has it on the PATH.
  if (runtimeMode === 'docker' || build?.runtimeKind === 'docker' || build?.engine === 'buildkit') return node;
  return ['/cnb/lifecycle/launcher', '--', ...node];
}

/**
 * What a session's preview deploy adds when the session is an open draft
 * (services/staging.js): `{ command, env }`, or null for any other preview.
 * Never throws: a draft whose supervisor cannot be set up gets an ordinary
 * preview, and its edits then build it again each time.
 */
async function runtimeFor(config, { session, build, head }) {
  try {
    const pool = require('../db/pool').getPool(config);
    if (!Number.isSafeInteger(Number(session?.id)) || Number(session.id) <= 0) return null;
    const { rows: [draft] } = await pool.query(
      "SELECT id, state FROM live_drafts WHERE session_id = $1 AND state = 'open'", [Number(session.id)],
    );
    if (!draft || draft.state !== 'open' || !Number.isSafeInteger(Number(draft.id))) return null;
    if (!(await enabled(pool))) return null;
    const mode = require('./application-runtime').mode(config);
    return {
      draftId: Number(draft.id),
      command: supervisorCommand(build, mode),
      env: {
        USERNODE_LIVE_SUPERVISOR: '1',
        USERNODE_LIVE_TOKEN: liveToken(config, draft.id),
        ...(exact(head) ? { USERNODE_LIVE_HEAD: exact(head) } : {}),
      },
    };
  } catch (err) {
    log.warn('live-drafts', 'A draft\'s preview starts as an ordinary one', { sessionId: session?.id, err: err.message });
    return null;
  }
}

/**
 * The preview machine deployed a draft's preview with its supervisor
 * (`runtime`, the runtime it just deployed, not yet on the session's row).
 * Edits saved while it was being built are sent to it now, so it shows the
 * draft's head. Never throws.
 */
async function noteDeployed(config, { sessionId, runtime = null, deps = {} }) {
  try {
    const pool = require('../db/pool').getPool(config);
    const { rows: [draft] } = await pool.query(
      `UPDATE live_drafts SET live_state = 'live', last_error = NULL, updated_at = NOW()
        WHERE session_id = $1 AND state = 'open' RETURNING id`,
      [Number(sessionId)],
    );
    if (!draft) return;
    const row = await byId(pool, draft.id);
    if (runtime?.runtimeName) {
      await syncPreview(pool, config, {
        draft: { ...row, staging_runtime_kind: runtime.runtimeKind || row.staging_runtime_kind, staging_runtime_name: runtime.runtimeName },
        deps,
      });
    }
    noteChanged(await byId(pool, draft.id), { reload: true }, deps);
  } catch (err) {
    log.warn('live-drafts', 'Could not note a draft\'s preview', { sessionId, err: err.message });
  }
}

// ── Talking to the preview ──────────────────────────────────────────────

function originOf(config, draft) {
  if (!draft.staging_runtime_name) return null;
  return require('./application-runtime').appOrigin(config, {
    runtimeKind: draft.staging_runtime_kind || undefined, runtimeName: draft.staging_runtime_name,
  });
}

async function control(config, draft, route, { method = 'GET', body = null, timeoutMs = STATUS_TIMEOUT_MS, deps = {} } = {}) {
  const origin = originOf(config, draft);
  if (!origin) return { reachable: false };
  const doFetch = deps.fetch || fetch;
  try {
    const res = await doFetch(`${origin}${supervisor().CONTROL_PREFIX}${route}`, {
      method,
      headers: { 'content-type': 'application/json', [supervisor().TOKEN_HEADER]: liveToken(config, draft.id) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    // An ordinary preview (no supervisor) answers 404 like an unknown path.
    if (res.status === 404) return { reachable: true, supervised: false };
    const json = await res.json().catch(() => ({}));
    return { reachable: true, supervised: true, status: res.status, body: json };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

/**
 * The files to send so a preview at `since` is at `head`: what changed
 * between them, read at `head` (a file gone there is deleted). Null when
 * there are too many to send, or they cannot be read.
 */
async function filesBetween(draft, since, head, deps = {}) {
  const repo = repoOf(draft);
  if (!repo || !exact(since) || !exact(head)) return null;
  if (exact(since) === exact(head)) return [];
  const github = deps.github || require('./github');
  let paths;
  try {
    paths = await github.listChangedFiles(repo.owner, repo.repo, `${exact(since)}...${exact(head)}`);
  } catch { return null; }
  if (!Array.isArray(paths) || paths.length > MAX_SYNC_FILES) return null;
  const files = [];
  for (const p of paths) {
    const safe = supervisor().safePath(p);
    if (!safe) continue;
    const content = await github.getFileContent(repo.owner, repo.repo, safe, exact(head)).catch(() => null);
    files.push(content == null ? { path: safe, delete: true } : { path: safe, content });
  }
  return files;
}

/** Ask the preview machine to build the draft's head again (a new install, an unreachable preview). */
async function rebuild(pool, config, draft, why, deps = {}) {
  const previews = deps.previewWorkflow || require('./preview-workflow');
  const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [draft.session_id]);
  if (!session) return { ok: false, why: 'no_session' };
  const asked = await previews.request({
    pool, session, head: exact(draft.head_sha), reason: 'preview', actor: `user:${draft.user_id}`,
  }).catch((err) => ({ status: 'rejected', reason: err.message }));
  // Its first preview is still being built: the edit is saved, and the
  // preview gets it once it is up (noteDeployed).
  if (asked?.status === 'rejected' && asked.reason === 'in_progress') {
    log.info('live-drafts', 'Draft edit waits for its preview', { draftId: draft.id, why });
    return { ok: true, rebuilding: true, why: 'starting' };
  }
  // A refusal that is not the preview already being there is Homeroom's
  // failure, not the change's: the draft keeps its head and says so.
  if (asked?.status === 'rejected' && !['already_serving', 'same_head'].includes(asked.reason)) {
    const reason = String(asked.reason || 'refused').slice(0, 120);
    await pool.query(
      `UPDATE live_drafts SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [draft.id, `The preview could not be started (${reason})`.slice(0, 500)],
    );
    await botFailure.recordPlatformIncident(pool, {
      where: 'live draft preview', cause: `preview_refused_${reason}`,
    }, deps);
    log.warn('live-drafts', 'A draft preview was refused', { draftId: draft.id, why, reason });
    return {
      ok: false, platform: true, why: 'preview_refused', reason,
      error: `The preview could not be started (${reason})`.slice(0, 300),
    };
  }
  await pool.query(
    `UPDATE live_drafts SET live_state = 'rebuilding', last_error = NULL, updated_at = NOW() WHERE id = $1`, [draft.id],
  );
  log.info('live-drafts', 'Draft preview built again', { draftId: draft.id, why, outcome: asked?.status, reason: asked?.reason });
  return { ok: true, rebuilding: true, why };
}

/**
 * Send `files` (the edit's own, as committed at `head`) to the draft's
 * preview, with whatever else it lacks since the commit its files are at.
 * Resolves what the preview said:
 *   { ok: true, bootMs }                 the app runs the head
 *   { ok: false, crashed: true, log }    the files are in, the app did not start
 *   { ok: true, rebuilding: true, why }  built again instead (a new install,
 *                                        no supervisor, or no preview to reach)
 */
async function sendToPreview(pool, config, { draft, files, since, head, deps = {} }) {
  const status = await control(config, draft, 'status', { deps });
  if (!status.reachable || !status.supervised || status.status !== 200) {
    return rebuild(pool, config, { ...draft, head_sha: head }, status.reachable ? 'not_supervised' : 'unreachable', deps);
  }
  let send = files;
  const at = exact(status.body?.head);
  if (at !== exact(since)) {
    // The preview's files are not where the draft was: send what changed
    // since the commit they are at (all of it, with this edit's own files).
    const missing = await filesBetween(draft, at || draft.staging_commit_sha || draft.base_sha, head, deps);
    if (missing == null) return rebuild(pool, config, { ...draft, head_sha: head }, 'too_far_behind', deps);
    const byPath = new Map(missing.map((f) => [f.path, f]));
    for (const f of files) byPath.set(f.path, f);
    send = [...byPath.values()];
  }
  if (!send.length) return { ok: true, bootMs: 0 };
  const applied = await control(config, draft, 'apply', {
    method: 'POST', body: { files: send, head }, timeoutMs: APPLY_TIMEOUT_MS, deps,
  });
  if (!applied.reachable || !applied.supervised) {
    return rebuild(pool, config, { ...draft, head_sha: head }, 'unreachable', deps);
  }
  if (applied.status === 409 && applied.body?.needsRebuild) {
    // The app's own build step failed after the edit: that is the app's
    // failure, and the supervisor already put its files back.
    if (applied.body.why === 'build') {
      return { ok: false, crashed: true, why: 'build', log: String(applied.body.log || '').slice(-4000) };
    }
    return rebuild(pool, config, { ...draft, head_sha: head }, applied.body.why || 'install', deps);
  }
  if (applied.status !== 200) {
    const error = applied.body?.error || `The preview answered ${applied.status}`;
    await botFailure.recordPlatformIncident(pool, {
      where: 'live draft preview', cause: `supervisor_${applied.status}`,
    }, deps);
    return { ok: false, platform: true, why: 'supervisor', error };
  }
  if (applied.body?.ok) return { ok: true, bootMs: applied.body.bootMs ?? null };
  return { ok: false, crashed: true, why: applied.body?.why || 'exited', log: String(applied.body?.log || '').slice(-4000) };
}

/**
 * Bring an open draft's preview to its head after it slept or was built
 * again (opening the preview calls it). Never throws.
 */
async function syncPreview(pool, config, { draft, deps = {} }) {
  try {
    if (!draft || draft.state !== 'open' || !exact(draft.head_sha)) return { ok: false };
    await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [draft.session_id]).catch(() => {});
    const status = await control(config, draft, 'status', { deps });
    if (!status.reachable || !status.supervised || status.status !== 200) return { ok: false, why: 'not_up' };
    const at = exact(status.body?.head);
    if (at === exact(draft.head_sha)) return { ok: true, synced: false };
    const files = await filesBetween(draft, at || draft.staging_commit_sha || draft.base_sha, draft.head_sha, deps);
    if (files == null) return rebuild(pool, config, draft, 'too_far_behind', deps);
    if (!files.length) return { ok: true, synced: false };
    const applied = await control(config, draft, 'apply', {
      method: 'POST', body: { files, head: exact(draft.head_sha) }, timeoutMs: APPLY_TIMEOUT_MS, deps,
    });
    if (applied.status === 409 && applied.body?.needsRebuild) return rebuild(pool, config, draft, 'install', deps);
    return { ok: !!applied.body?.ok, synced: true };
  } catch (err) {
    log.warn('live-drafts', 'Could not bring a draft\'s preview up to date', { draftId: draft?.id, err: err.message });
    return { ok: false };
  }
}

// ── An edit ─────────────────────────────────────────────────────────────

/**
 * One edit of an open draft (the draft bot's apply): `files` ({ path,
 * content }), committed on the draft's branch with `summary` as its message,
 * then written into its preview. Runs where code-host writes may (the bot's
 * turn, on a conductor). Resolves `{ ok, head, preview }`, where `preview`
 * is sendToPreview's answer, or `{ ok: false, error }` when nothing was
 * committed.
 */
async function applyEdit(pool, config, { draftId, userId, files, summary, deps = {} }) {
  if (!(await enabled(pool))) return { ok: false, error: 'App previews in chats are switched off right now.' };
  const draft = await byId(pool, draftId, { userId });
  if (!draft || draft.state !== 'open') return { ok: false, error: 'This thread has no open app preview.' };
  if (!draft.branch_name) return { ok: false, error: 'The draft has no branch yet: wait for its preview to start.' };
  const repo = repoOf(draft);
  if (!repo) return { ok: false, error: 'The project has no code.' };
  const list = (Array.isArray(files) ? files : []).map((f) => ({
    path: supervisor().safePath(f?.path), content: typeof f?.content === 'string' ? f.content : null,
  }));
  if (!list.length || list.some((f) => !f.path || f.content == null)) return { ok: false, error: 'Nothing to save.' };
  const message = String(summary || 'Live draft edit').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Live draft edit';
  const github = deps.github || require('./github');
  let commit;
  try {
    commit = await github.pushFiles(repo.owner, repo.repo, list, { branch: draft.branch_name, message });
  } catch (err) {
    log.warn('live-drafts', 'A draft edit could not be saved', { draftId: draft.id, err: err.message });
    return { ok: false, platform: true, error: 'The edit could not be saved to the draft. Try again in a moment.' };
  }
  const head = exact(commit?.sha);
  if (!head) return { ok: false, error: 'The edit could not be saved to the draft.' };
  const since = exact(draft.head_sha);
  await pool.query(
    `UPDATE live_drafts SET head_sha = $2, edits = edits + 1, updated_at = NOW() WHERE id = $1`, [draft.id, head],
  );
  await pool.query(
    'INSERT INTO live_draft_edits (draft_id, commit_sha, summary, paths) VALUES ($1, $2, $3, $4)',
    [draft.id, head, message, list.map((f) => f.path)],
  );
  await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [draft.session_id]).catch(() => {});
  const preview = await sendToPreview(pool, config, { draft, files: list, since, head, deps });
  if (preview.ok && !preview.rebuilding) {
    await pool.query("UPDATE live_drafts SET live_state = 'live', last_error = NULL WHERE id = $1", [draft.id]);
  } else if (!preview.ok) {
    await pool.query('UPDATE live_drafts SET last_error = $2 WHERE id = $1', [draft.id,
      preview.crashed ? 'The last change stopped the app from starting.' : String(preview.error || '').slice(0, 500)]);
  }
  const now = await byId(pool, draft.id);
  noteChanged(now, { reload: !!preview.ok && !preview.rebuilding }, deps);
  return { ok: true, head, preview };
}

// ── Putting it up for a vote, or away ───────────────────────────────────

/** Pure: the change's description, from what the draft's edits said. */
function proposalText(draft, edits) {
  const lines = edits.map((e) => `- ${e.summary}`);
  return [
    `Made with Homeroom bot in a live app preview of ${draft.app_name || draft.app_slug}.`,
    '',
    'What changed:',
    ...(lines.length ? lines : ['- (no edits)']),
  ].join('\n');
}

/**
 * Put an open draft up for a vote, as `user`'s own change (the same promote
 * a change's Propose button runs). Resolves `{ status, body }`.
 */
async function propose(pool, config, { user, draftId, title = null, deps = {} }) {
  const draft = await byId(pool, draftId, { userId: user?.id });
  if (!draft || draft.state !== 'open') return refuse(404, 'no_draft', 'No open draft of yours.');
  if (!(Number(draft.edits) > 0)) return refuse(409, 'no_edits', 'Nothing has changed in this draft yet.');
  if (!draft.session_id || !['active', 'paused'].includes(draft.session_status)) {
    return refuse(409, 'not_proposable', 'This draft cannot be proposed any more.');
  }
  // Proposing is taking part: a member's, as the promote route's gate says.
  const join = await (deps.communities || require('./communities')).appNeedsJoin(pool, draft.app_slug, user);
  if (join) return { status: 403, body: join };
  // A preview still being built for the draft would be joined by the
  // vote's revision and serve with no checks: wait for it.
  if (['starting', 'rebuilding'].includes(liveStateOf(draft))) {
    return refuse(409, 'preview_building', 'The preview is still being built. Propose it once it is up.');
  }
  const edits = await editsOf(pool, draft.id);
  const name = String(title || edits[edits.length - 1]?.summary || `Changes to ${draft.app_name || draft.app_slug}`)
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  // Closed to edits first, so the preview the vote's checks run against is
  // built as an ordinary one (runtimeFor answers null from here on).
  await pool.query(`UPDATE live_drafts SET state = 'proposed', updated_at = NOW() WHERE id = $1`, [draft.id]);
  await pool.query('UPDATE chat_sessions SET session_title = $2 WHERE id = $1', [draft.session_id, name]);
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', $2, $3)`,
    [draft.session_id, proposalText(draft, edits), JSON.stringify({ liveDraft: Number(draft.id) })],
  );
  const caps = require('./session-caps').effectiveSessionCaps(config, user);
  const platform = deps.platform || require('../workflow/platform.ts');
  let reply;
  try {
    reply = await platform.promoteProposal({
      sessionId: draft.session_id, appId: draft.app_id, userId: user.id, username: user.username,
      from: draft.session_status, cap: caps.promotedSessions, pr: null,
    });
  } catch (err) {
    reply = { status: 500, body: { error: err.message } };
  }
  if (reply?.status !== 200) {
    await pool.query(`UPDATE live_drafts SET state = 'open', updated_at = NOW() WHERE id = $1`, [draft.id]);
    log.warn('live-drafts', 'A draft could not be proposed', { draftId: draft.id, status: reply?.status });
    return { status: reply?.status || 500, body: { ok: false, ...(reply?.body || {}) } };
  }
  const now = await byId(pool, draft.id);
  noteChanged(now, {}, deps);
  log.info('live-drafts', 'Draft proposed', { draftId: draft.id, sessionId: draft.session_id });
  return { status: 200, body: { ok: true, draft: describe(now), ...(reply.body || {}) } };
}

/** Put an open draft away. Its preview stops on its own once nobody opens it. */
async function close(pool, { user, draftId, deps = {} }) {
  const { rows: [row] } = await pool.query(
    `UPDATE live_drafts SET state = 'closed', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND state = 'open' RETURNING id`,
    [Number(draftId), Number(user?.id)],
  );
  if (!row) return refuse(404, 'no_draft', 'No open draft of yours.');
  const now = await byId(pool, row.id);
  noteChanged(now, {}, deps);
  return { status: 200, body: { ok: true, draft: describe(now) } };
}

module.exports = {
  SETTING_KEY, MAX_OPEN_PER_USER,
  enabled, setEnabled, adminPayload, liveToken,
  byId, forThread, threadOf, rootOf, describe, liveStateOf, editsOf, noteChanged,
  listFiles, readFile, open, supervisorCommand, runtimeFor, noteDeployed,
  filesBetween, sendToPreview, syncPreview, applyEdit, proposalText, propose, close,
};
