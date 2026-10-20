// A new project's setup: the I/O of app-creation's `app.setup` work
// (src/workflow/app-creation/). Each part is a step its work keeps, so a
// process that stops part way through leaves the next one to carry on from
// the last part done, never doing one twice:
//
//   database    its Postgres database and its own role (the password is
//               written to the row, never into a step)
//   card        the first session's card, when one is owed: the model's,
//               within its wait, else the fallback (services/app-sketch.js)
//   repository  a fresh repository with the starter (and the card) as its
//               first commit; a remix's copy of its source; an import's
//               connector scaffold and create answers. Then `repo_url`.
//
// What it resolves is the machine's: the first commit, the image a
// ready-made app may deploy instead of building, and what it measured. Its
// first deploy is then app delivery's, like every production deploy
// (staging.deployProduction). A failure resolves `{ failed }`, the row's
// last_failure record; the machine writes it.

const log = require('./logger');
const github = require('./github');
const dbManager = require('./db-manager');
const deployFailure = require('./deploy-failure');
const { getTemplateFiles, getConnectorScaffoldFiles, getCanonicalRepoFile } = require('./template');
const appTemplates = require('./app-templates');
const appSketch = require('./app-sketch');
const creationTiming = require('./app-creation-timing');
const starterImages = require('./starter-images');
const { pushAppCreationPhase } = require('./ws');

// Tell connected clients which step creation is on (the frame the made
// screen and the create dialog follow). Display only: never throws.
function reportPhase(appId, slug, phase) {
  try {
    pushAppCreationPhase({ id: appId, slug, phase });
  } catch (err) {
    log.warn('app-creator', 'Phase report failed', { appId, slug, phase, err: err.message });
  }
}

// The approval rule a new app's row carries (POST /api/apps writes the
// create screen's choice there), for the template's dapp.json.
function governanceOf(row) {
  // #4666: a preset or rules of its own, as the row stores them.
  const rules = require('./governance').rulesFromColumn(row?.governance_rules);
  if (rules) {
    return {
      preset: rules.preset,
      groups: rules.groups.map((g) => ({ name: g.name, people: g.people })),
      rules: rules.rules,
    };
  }
  return { approverPolicy: row?.approver_policy || 'anyone', approvalsRequired: row?.approvals_required ?? null };
}

// The create screen's "What is it?" line. POST /api/apps seeds it into the
// row's manifest snapshot (the dapp.json the template is about to write), so
// a Retry after a failed create writes it too.
function descriptionOf(row) {
  const d = row?.manifest_snapshot?.description;
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

// The create screen's starter (services/app-templates.js), from the row
// POST /api/apps wrote it to. NULL, every project from before templates and
// any id no longer on the list, is the empty scaffold.
function templateOf(row) {
  const t = row?.template;
  return typeof t === 'string' && appTemplates.isTemplate(t) ? t : appTemplates.DEFAULT_TEMPLATE;
}

// The starter's files for a project, the card in them when it has one
// (design/sketch.json, its emoji as dapp.json's icon, its tagline as the
// description it lacks). The same row and card give the same files.
function starterFiles(row, { repoUrl = null, sketch = null } = {}) {
  return getTemplateFiles(row.name, row.slug, null, repoUrl, {
    governance: governanceOf(row), description: descriptionOf(row) || appSketch.taglineOf(sketch),
    template: templateOf(row), sketch,
  });
}

const initMessage = (name) => `Initialize ${name} from Homeroom template`;

// A step that failed says which part of creation it was, for the record
// (deployFailure.record), unless it said already (a clone, a repository).
async function part(stage, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && !err.cloneFailed && !err.repoFailed && !err.stage) err.stage = stage;
    throw err;
  }
}

/**
 * The setup, for the work (`ctx`: its steps and signal). Resolves
 * { sha, repoUrl, offer, timing } or { failed, timing }.
 */
async function setUp(config, pool, appId, ctx) {
  const steps = ctx.steps({ owner: `app-creation/app:${appId}` });
  const timing = creationTiming.stopwatch();
  const { rows: [row] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  if (!row || row.self_hosted || row.status !== 'creating') {
    return { failed: { stage: 'other', reason: 'This project is no longer being set up.', at: new Date().toISOString() } };
  }
  const fork = !!row.forked_from;
  timing.note('kind', row.repo_url ? 'existing_repo' : 'new_repo');
  timing.note('starter', templateOf(row));
  try {
    reportPhase(appId, row.slug, 'database');
    // The database, and the card then the repository, do not need each
    // other (#4895: the starter writes no database URL into the
    // repository): side by side. The made screen's 'repository' step is
    // reported once the database is done, so it never ticks off a database
    // still being made.
    const database = steps.once('database', () => timing.time('database', () => part('database', async () => {
      const dbName = dbManager.appDbName(row.slug);
      const { password } = await dbManager.createDatabase(dbName);
      await pool.query('UPDATE apps SET db_password = $1 WHERE id = $2', [password, appId]);
      return true;
    }))).then((done) => { reportPhase(appId, row.slug, 'repository'); return done; });
    const repository = (async () => {
      const sketch = fork || row.repo_url ? null : await steps.once('card', () => timing.time('card', () => appSketch.drawFor(pool, appId)));
      return steps.once('repository', () => timing.time('repository', () => part('repo',
        () => (fork ? copyFork(config, pool, row) : row.repo_url ? scaffoldImport(row) : seedStarter(config, pool, row, sketch, ctx)))));
    })();
    // Both settle before a failure is reported, so nothing of this attempt
    // runs on after it; a database that failed is reported first.
    const [db, repoDone] = await Promise.allSettled([database, repository]);
    if (db.status === 'rejected') throw db.reason;
    if (repoDone.status === 'rejected') throw repoDone.reason;
    const repo = repoDone.value;
    return { sha: repo.sha ?? null, repoUrl: repo.repoUrl ?? null, offer: repo.offer ?? null, timing: timing.snapshot() };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    log.error('app-creator', 'Setting up a project failed', { appId, slug: row.slug, err: err.message });
    timing.settle('error');
    return { failed: deployFailure.record(err, err.stage ? { stage: err.stage } : {}), timing: timing.snapshot() };
  }
}

// A fresh project: its repository made (or adopted, when an earlier try
// made it), the starter and its card as its first commit, then repo_url.
// A try that resumes finds its own first commit at the repository's head
// and does not push it again. Without GitHub there is no repository: the
// first deploy builds the starter's files.
async function seedStarter(config, pool, row, sketch, ctx) {
  if (!github.isEnabled()) return { sha: null, repoUrl: null, offer: null };
  try {
    const botUsername = await github.getBotUsername();
    // adoptExisting: a try after one that died between GitHub's create and
    // the repo_url write has the SAME slug, so the repository is there.
    const repo = await github.createRepo(botUsername, row.slug, {
      description: `${row.name}: built on Homeroom`,
      adoptExisting: true,
    });
    const repoUrl = repo.html_url;
    // repoUrl makes the template name this repo as the app's canonical one
    // (.claude/homeroom-canonical-repo, read by the freshness check). No
    // database URL: none goes into a repository.
    const files = starterFiles(row, { repoUrl, sketch });
    const head = repo.adopted ? await github.headCommit(botUsername, row.slug).catch(() => null) : null;
    const commit = head && head.message === initMessage(row.name)
      ? head
      : await github.pushFiles(botUsername, row.slug, files, { message: initMessage(row.name) });
    const sha = String(commit?.sha || '').toLowerCase() || null;
    await pool.query('UPDATE apps SET repo_url = $1 WHERE id = $2', [repoUrl, row.id]);
    if (sketch) await appSketch.markCommitted(pool, row.id).catch(() => {});
    // The deploy may build this commit's tree into the starter's shared
    // layer cache, and a ready-made app's image is built already under its
    // key (services/starter-images.js): both only for this exact commit.
    const template = templateOf(row);
    const key = appTemplates.isReadyMade(template) ? starterImages.contextKey(files, starterImages.buildRecipe(config)) : null;
    return { sha, repoUrl, offer: sha ? { starter: { sha, template, ...(key ? { key } : {}) } } : null };
  } catch (err) {
    // GitHub is enabled but the repository could not be made: the project
    // cannot work without one (the session-2585 incident), so it fails here
    // and Retry makes it again.
    err.repoFailed = true;
    throw err;
  }
}

// An import keeps the repository it imported. Before #1218's follow-up an
// imported app never received `.claude/settings.json`, and its users kept
// getting a permission prompt on every read-only connector call: the
// connector scaffold is added (with the pointer naming this repo as the
// app's canonical one) when the repository has none, and the create
// dialog's answers its dapp.json does not already give. Neither is a reason
// the import fails: a GitHub App with no write access to a user-owned repo
// is a normal import.
async function scaffoldImport(row) {
  const repoUrl = row.repo_url;
  try {
    const parsed = github.parseGithubUrl(repoUrl);
    if (github.isEnabled() && parsed) {
      const existing = await github.getFileContent(parsed.owner, parsed.repo, '.claude/settings.json', 'main');
      if (existing === null) {
        const canonicalRepoFile = getCanonicalRepoFile(repoUrl);
        const scaffold = [...getConnectorScaffoldFiles(), ...(canonicalRepoFile ? [canonicalRepoFile] : [])];
        await github.pushFiles(parsed.owner, parsed.repo, scaffold, {
          message: 'Add Homeroom connector permissions and checkout freshness check',
        });
        log.info('app-creator', 'Added connector scaffold to imported repo', { appId: row.id, slug: row.slug, repoUrl });
      }
    }
  } catch (err) {
    log.warn('app-creator', 'Could not add connector scaffold to imported repo', { appId: row.id, repoUrl, error: err.message });
  }
  try {
    const added = await require('./import-manifest').commitCreateAnswers({
      repoUrl, description: descriptionOf(row), governance: governanceOf(row),
    });
    if (added.length) log.info('app-creator', 'Committed create answers into imported dapp.json', { appId: row.id, added });
  } catch (err) {
    log.warn('app-creator', 'Could not commit create answers into imported dapp.json', { appId: row.id, repoUrl, error: err.message });
  }
  return { sha: null, repoUrl, offer: null };
}

// A remix: its source's current main copied into a fresh bot-owned
// repository, history-free (services/app-forker.js copyRepoTree, a force
// push: the same copy again lands the same way), and the repository and
// the lineage it was cut from written in ONE update. A copy whose
// repository is recorded already is not copied again: its source may have
// changed or gone since.
async function copyFork(config, pool, row) {
  if (row.repo_url) return { sha: null, repoUrl: row.repo_url, offer: null };
  const forker = require('./app-forker');
  const sourceApp = await forker.findForkSource(pool, row);
  if (sourceApp?.self_hosted) throw new Error('Homeroom itself cannot be remixed.');
  if (!sourceApp) throw new Error('The app this copy came from no longer exists.');
  if (!sourceApp.repo_url) {
    const err = new Error('The original app is not ready to copy yet.');
    err.cloneFailed = true;
    throw err;
  }
  if (!github.isEnabled()) {
    const err = new Error('Remixing is unavailable because GitHub integration is not configured.');
    err.repoFailed = true;
    throw err;
  }
  const tempDir = `/tmp/usernode-fork-${row.slug}`;
  try {
    const botUsername = await github.getBotUsername();
    const copied = await forker.copyRepoTree({ sourceApp, botUsername, forkSlug: row.slug, forkName: row.name, tempDir });
    await pool.query(
      `UPDATE apps
          SET repo_url = $1,
              forked_from = CASE WHEN jsonb_typeof(forked_from) = 'object'
                                 THEN forked_from || $2::jsonb
                                 ELSE forked_from END
        WHERE id = $3`,
      [copied.repoUrl, JSON.stringify(forker.forkLineageShas(copied)), row.id]);
    return { sha: copied.mainSha ? String(copied.mainSha).toLowerCase() : null, repoUrl: copied.repoUrl, offer: null };
  } finally {
    await require('./docker').execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
  }
}

module.exports = { setUp, starterFiles, governanceOf, descriptionOf, templateOf, reportPhase };
