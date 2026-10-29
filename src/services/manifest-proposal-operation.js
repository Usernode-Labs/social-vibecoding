'use strict';

// `manifest.propose`, a platform operation (services/platform-operations.js):
// a settings proposal that edits the project's dapp.json, opened on a
// conductor. The settings routes in routes/apps.js validate the change, check
// who may propose it and answer their refusals, then ask for this; the
// conductor reads the same authority and target again before it writes the
// branch, the file and the PR (services/rename-pr.js createManifestPR).
//
// Input: { flavor, args }, where args is what the flavor's builder takes,
// already validated by its route.

const github = require('./github');
const repoRef = require('./repo-ref');
const appAccess = require('./app-access');
const appAdmins = require('./app-admins');
const communities = require('./communities');
const renamePr = require('./rename-pr');
const topicsPr = require('./topics-pr');
const whoDecidesPr = require('./who-decides-pr');
const followPr = require('./follow-pr');
const pendingSecrets = require('./pending-secrets');
const platformEnv = require('./platform-env');
const appSecrets = require('./app-secrets');
const events = require('./events');
const { decrypt } = require('./secrets');
const { ADMIN_MUTATION_LOCK } = require('./advisory-locks');

const SELF_HOSTED = 'The Homeroom platform deploys via GitHub Actions; this action does not apply to the self-app row.';

// The authority each flavor's route requires, read the same way:
//   access     'collab' (can build here) or 'manage' (the creator or an admin)
//   selfHosted whether the platform's own row may be the target
//   member     whether the community's membership gate applies
//   public     whether this change makes the project public (needs a verified owner)
//   existing   the open proposal of this kind a second one would duplicate
const FLAVORS = new Map([
  ['rename', {
    access: 'collab', selfHosted: true,
    build: (d, app, a, actor, steps) => renamePr.createRenamePR(d.config, d.pool, app, a.newName, actor, { steps }),
  }],
  ['secret-declaration', {
    access: 'collab', selfHosted: 'voting',
    existing: (pool, app, a) => pendingSecrets.findLiveByKey(pool, app.id, a.key)
      .then((r) => r && { id: r.sessionId, pr_number: r.prNumber, pr_url: r.prUrl }),
    existingError: (a) => `${a.key} is already waiting for approval`,
    build: (d, app, a, actor, steps) => renamePr.createSecretDeclarationPR(d.config, d.pool, app,
      { scope: a.scope, key: a.key, declaration: a.declaration, hasValue: !!a.hasValue }, actor, { steps }),
  }],
  ['visibility', {
    access: 'manage', selfHosted: false,
    public: (app, a) => a.view === 'public' && app.view_visibility !== 'public',
    existing: (pool, app) => renamePr.findVisibilityPr(pool, app.id),
    existingError: () => 'A visibility change is already waiting for a vote',
    build: (d, app, a, actor, steps) => renamePr.createVisibilityPR(d.config, d.pool, app, { collab: a.collab, view: a.view }, actor, { steps }),
  }],
  ['who-decides', {
    access: 'manage', selfHosted: (a) => !a.visibility,
    public: (app, a) => a.visibility === 'public' && app.view_visibility !== 'public',
    build: (d, app, a, actor, steps) => whoDecidesPr.createWhoDecidesPR(d.config, d.pool, app, a, actor, { steps }),
  }],
  ['admins', {
    access: 'manage', selfHosted: false,
    existing: (pool, app) => renamePr.findAdminsPr(pool, app.id),
    existingError: () => 'An admins change is already waiting for a vote',
    build: (d, app, a, actor, steps) => renamePr.createAdminsPR(d.config, d.pool, app, { usernames: a.usernames }, actor, { steps }),
  }],
  ['governance', {
    access: 'manage', selfHosted: true,
    existing: (pool, app) => renamePr.findGovernancePr(pool, app.id),
    existingError: () => 'A governance change is already waiting for a vote',
    build: (d, app, a, actor, steps) => renamePr.createGovernancePR(d.config, d.pool, app,
      { policy: a.policy, approvalsRequired: a.approvalsRequired ?? null }, actor, { steps }),
  }],
  ['topics', {
    access: 'collab', selfHosted: true, member: true,
    build: (d, app, a, actor, steps) => topicsPr.createTopicsPR(d.config, d.pool, app, a, actor, { steps }),
  }],
  // Whether a version gets its original's updates (services/follow-pr.js):
  // anyone who builds here and has joined may put it to the vote, as with
  // any other change; the platform's own app is nobody's version.
  ['follow', {
    access: 'collab', selfHosted: false, member: true,
    existing: (pool, app) => followPr.findFollowPr(pool, app.id),
    existingError: () => 'A change to whether this project gets its original\'s updates is already waiting for a vote',
    build: (d, app, a, actor, steps) => followPr.createFollowPR(d.config, d.pool, app,
      { follow: !!a.follow, originalName: a.originalName || null }, actor, { steps }),
  }],
]);

async function loadApp(pool, appId) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  return app || null;
}

function flavorOf(request) {
  const f = FLAVORS.get(request.input?.flavor);
  if (!f || !request.input.args || typeof request.input.args !== 'object') {
    throw Object.assign(new Error('Unknown manifest proposal'), { permanent: true });
  }
  return f;
}

async function authorize({ config, pool }, request, user, { steps = null } = {}) {
  const flavor = flavorOf(request);
  const args = request.input.args;
  const app = await loadApp(pool, request.appId);
  if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'view'))) return { status: 404, error: 'App not found' };
  if (flavor.member) {
    const join = await communities.appNeedsJoin(pool, app.slug, user);
    if (join) return { status: 403, ...join };
  }
  if (flavor.access === 'collab' && !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) {
    return { status: 403, error: 'You can no longer propose this change here.' };
  }
  if (flavor.access === 'manage' && !(await appAdmins.canManageApp(pool, app, user))) {
    return { status: 403, error: 'Only the app creator or an admin can propose this change.' };
  }
  const selfHosted = typeof flavor.selfHosted === 'function' ? flavor.selfHosted(args) : flavor.selfHosted;
  if (app.self_hosted && selfHosted === false) return { status: 403, error: SELF_HOSTED };
  if (app.self_hosted && selfHosted === 'voting' && !user.isAdmin && !config.selfAppPublicVoting) {
    return { status: 404, error: 'App not found' };
  }
  if (flavor.public && flavor.public(app, args)) {
    const refusal = await communities.identityPublicRefusal(pool, user.id);
    if (refusal) return { status: 403, ...refusal };
  }
  if (!github.hasWriteAccess()) return { status: 503, error: 'Settings changes need a code host configured on the platform.' };
  if (!app.repo_url || !repoRef.parse(app.repo_url)) return { status: 400, error: 'App has no repository to open a PR against' };
  // The repository the route saw: a project moved since asks again.
  if (request.input.repoUrl && request.input.repoUrl !== app.repo_url) {
    return { status: 409, error: 'The project moved to another repository. Try again.' };
  }
  // A proposal of the same kind already open is another's, unless it is this
  // very request's: the session it recorded (createManifestPR's `session`
  // step), or, when that session's insert committed but its reply or its
  // checkpoint was lost, the one for the PR it recorded (its `pr` step,
  // always kept before the session is inserted).
  if (flavor.existing) {
    const open = await flavor.existing(pool, app, args);
    const ownPr = steps?.get?.('pr')?.number;
    if (open && open.id !== steps?.get?.('session') && !(ownPr != null && Number(open.pr_number) === Number(ownPr))) {
      return { status: 409, error: flavor.existingError(args), sessionId: open.id, prNumber: open.pr_number, prUrl: open.pr_url };
    }
  }
  return null;
}

// A secret declaration's value, once its PR exists (a failed proposal must
// not leave a value behind). It came encrypted with the data key, as
// pending_secret_declarations keeps it. A full admin's value lands now,
// through the same DAO path the PUT routes use (both stores accept a
// not-yet-declared key; for a child app it stays inert until the
// declaration merges, because mergeForDeploy only injects declared keys).
// Everyone else's waits in pending_secret_declarations and is applied by the
// merge. Kept as a step; a retry finds the proposal's row already there.
async function declareValue({ config, pool }, app, args, user, sessionId) {
  const value = args.valueEnc ? decrypt(args.valueEnc, config.dataEncryptionKey) : '';
  const applyNow = !!user.canAdminWrite && !!value.length;
  if (applyNow) {
    if (args.scope === 'platform') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
        await platformEnv.setValue(client, app.id, args.key, value, {
          userId: user.id, dataKey: config.dataEncryptionKey, privateHint: !!args.isPrivate,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      events.record(pool, {
        type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED, userId: user.id, appId: app.id,
        metadata: { key: args.key, action: 'set', private: !!args.isPrivate, appliedBy: 'admin-direct' },
      });
    } else {
      await appSecrets.setValue(pool, app.id, args.key, value, {
        sensitive: !!args.isPrivate, userId: user.id, dataKey: config.dataEncryptionKey,
      });
    }
  }
  const { rows: [held] } = await pool.query(
    'SELECT 1 FROM pending_secret_declarations WHERE session_id = $1 AND key = $2', [sessionId, args.key]);
  if (!held) {
    await pendingSecrets.create(pool, {
      appId: app.id, sessionId, scope: args.scope, key: args.key, declaration: args.declaration,
      value: value.length ? value : null, userId: user.id, dataKey: config.dataEncryptionKey, valueApplied: applyNow,
    });
  }
  return { valueApplied: applyNow };
}

async function run({ config, pool }, request, user, steps) {
  const flavor = flavorOf(request);
  const app = await loadApp(pool, request.appId);
  if (!app) throw Object.assign(new Error('App not found'), { permanent: true });
  let result;
  try {
    result = await flavor.build({ config, pool }, app, request.input.args, { id: user.id, username: user.username }, steps);
  } catch (err) {
    // A change that no longer applies to main's manifest (a topic renamed
    // or archived since) is refused before anything is written.
    if (err instanceof topicsPr.TopicsPrError || err instanceof whoDecidesPr.WhoDecidesError) {
      return { ok: false, status: err.status || 400, error: err.message, ...(err.extra || {}) };
    }
    throw err;
  }
  const value = request.input.flavor === 'secret-declaration'
    ? await steps.once('value', () => declareValue({ config, pool }, app, request.input.args, user, result.sessionId))
    : null;
  return { sessionId: result.sessionId, prNumber: result.prNumber, prUrl: result.prUrl, branch: result.branch,
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(value ? { valueApplied: value.valueApplied } : {}) };
}

module.exports = { authorize, run, FLAVORS, declareValue };
