'use strict';

// #6994: a website archive attached in the Homeroom bot chat, put in place
// of a project's public folder as a change of the person's own.
//
// Somebody downloaded their site from GitHub as a ZIP, opened the project
// they already have, attached the archive in a chat with Homeroom bot and
// asked it to build or revamp the app from it. The archive's files become
// the app's public folder, the pages the old site had and the archive does
// not are removed, and the result goes up for the project's vote as the
// person's change, like any other change. No archive entry point is offered
// on the Create screen or in the editor's + button (24 Nov 2026): the chat
// is the one way in, so onboarding keeps its two ways to start a project.
//
// Nothing is written outside public/: the project keeps its server.js,
// dapp.json and dependencies exactly as they are, which is the shape
// archive-import.js's siteFiles keeps.
//
// Reads the archive once, from the bytes the chat stored, so the change is
// the same on a retry. Never throws for a bad archive or a refused person.

const archiveImport = require('./archive-import');
const log = require('./logger');

const MAX_TITLE = 120;

/** The change's name: the file's own name without its archive extension. */
function titleOf(filename, named = null) {
  const asked = typeof named === 'string' ? named.replace(/\s+/g, ' ').trim() : '';
  if (asked) return asked.slice(0, MAX_TITLE);
  const base = String(filename || '').split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.(?:tar\.gz|tgz|zip|rar|7z)$/i, '').trim();
  return (stem || 'Website').slice(0, MAX_TITLE);
}

/** The change's description, as its discussion reads it. */
function changeText(filename, fileCount, removed) {
  const shown = String(filename || '')
    .replace(/\s+/g, ' ')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@​')
    .trim()
    .slice(0, 200) || 'the archive';
  return [
    `The website from ${shown}.`,
    '',
    `Its ${fileCount} ${fileCount === 1 ? 'file replaces' : 'files replace'} the pages this project served.`
      + (removed ? ` ${removed} ${removed === 1 ? 'page the archive did not have was' : 'pages the archive did not have were'} removed.` : ''),
    '',
    'Attached and asked for in a chat with Homeroom bot.',
  ].join('\n');
}

/**
 * Put `data` (a file called `filename`) in place of `app`'s public folder, as
 * `user`'s change, and put it up for the project's vote. Resolves
 * `{ ok: true, sessionId, number, url, pending, fileCount, removed }`, or
 * `{ ok: false, error }` with one plain sentence.
 */
async function createChange(pool, config, { user, app, data, filename, title = null, deps = {} }) {
  if (!user?.id || !app?.id) return { ok: false, error: 'Sign in and choose a project first.' };
  const verdict = await archiveImport.read(data, filename);
  if (!verdict.ok) return { ok: false, error: verdict.error };

  const github = deps.github || require('./github');
  if (!github.isEnabled()) {
    return { ok: false, error: 'Uploading an archive is not available here, because no code host is set up.' };
  }
  // The person must be able to change this project, as for any change.
  const access = deps.appAccess || require('./app-access');
  let row = null;
  try { row = await access.getAppForUser(pool, app.slug, user, 'collab'); } catch { row = null; }
  if (!row) return { ok: false, error: `You cannot change ${app.name || app.slug}.` };
  const join = await (deps.communities || require('./communities')).appNeedsJoin(pool, row.slug, user);
  if (join) return { ok: false, error: `Join ${row.name || row.slug} first, then ask again.` };
  const repo = require('./homeroom-bot').parseRepo(row.repo_url);
  if (!repo) return { ok: false, error: 'That project has no code yet, so there is nowhere to put the archive.' };

  const name = titleOf(filename, title);
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title)
     VALUES ($1, $2, 'paused', FALSE, '{}', $3)
     RETURNING *`,
    [row.id, user.id, name],
  );
  const dropSession = () => pool.query(
    "DELETE FROM chat_sessions WHERE id = $1 AND status = 'paused' AND pr_number IS NULL", [session.id],
  ).catch(() => {});

  let branchName = null;
  try {
    const lifecycle = deps.sessionLifecycle || require('./session-lifecycle');
    ({ branchName } = await lifecycle.ensureSessionBranch({
      pool, sessionId: session.id, userId: user.id, username: user.username, label: 'archive',
    }));
    if (!branchName) throw new Error('The change has no branch');
  } catch (err) {
    await dropSession();
    log.warn('archive-change', 'A change from an archive could not start', { app: row.slug, err: err.message });
    return { ok: false, error: 'Homeroom could not start the change just now. Ask again in a minute.' };
  }

  // The archive becomes the app's public folder. Files the old site had and
  // the archive does not are removed, so a page is never left behind.
  const files = archiveImport.siteFiles(verdict.files);
  const kept = new Set(files.map((file) => file.path));
  let deletes = [];
  try {
    const existing = await github.listRepoFiles(repo.owner, repo.repo, branchName);
    deletes = (existing?.files || [])
      .map((file) => file.path)
      .filter((path) => path.startsWith('public/') && !kept.has(path));
  } catch {
    // Without the list, the archive is still added; nothing is removed.
    deletes = [];
  }

  try {
    await github.pushFiles(repo.owner, repo.repo, files, {
      branch: branchName,
      message: `Replace the site with ${filename}`,
      deletes,
    });
  } catch (err) {
    await dropSession();
    log.warn('archive-change', 'An archive could not be written to its branch', { app: row.slug, err: err.message });
    return { ok: false, error: 'Homeroom could not save the archive to the change. Ask again in a minute.' };
  }

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', $2, $3)`,
    [session.id, changeText(filename, verdict.fileCount, deletes.length),
      JSON.stringify({ archiveImport: { filename: String(filename || '').slice(0, 255), fileCount: verdict.fileCount, removed: deletes.length } })],
  ).catch((err) => log.warn('archive-change', 'Could not record the archive change text', { app: row.slug, err: err.message }));

  const caps = require('./session-caps').effectiveSessionCaps(config, user);
  const platform = deps.platform || require('../workflow/platform.ts');
  let reply;
  try {
    reply = await platform.promoteProposal({
      sessionId: session.id, appId: row.id, userId: user.id, username: user.username,
      from: 'paused', cap: caps.promotedSessions, pr: null,
    });
  } catch (err) {
    reply = { status: 500, body: { error: err.message } };
  }
  if (![200, 202].includes(reply?.status)) {
    await dropSession();
    const said = reply?.body?.error || reply?.body?.message;
    log.warn('archive-change', 'An archive change could not be put up for a vote', {
      app: row.slug, sessionId: session.id, status: reply?.status,
    });
    return { ok: false, error: typeof said === 'string' && said ? said : 'The change could not be put up for a vote just now.' };
  }

  log.info('archive-change', 'An archive became a change', {
    app: row.slug, sessionId: session.id, files: files.length, removed: deletes.length, pending: reply.status === 202,
  });
  return {
    ok: true,
    sessionId: session.id,
    number: Number(reply.body?.prNumber) || null,
    url: reply.body?.prUrl || null,
    pending: reply.status === 202,
    fileCount: verdict.fileCount,
    removed: deletes.length,
  };
}

module.exports = { createChange, titleOf, changeText };
