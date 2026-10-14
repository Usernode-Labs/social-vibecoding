'use strict';

const github = require('./github');
const { GITHUB_ISSUE_BODY_MAX } = require('./issue-body-limit');

const FEEDBACK_EDIT_WINDOW_SECONDS = 300;
// clock_timestamp is checked AFTER acquiring the lock: waiting for another
// save must not extend the deadline to the transaction's start time.
const EDIT_SECONDS_SQL = `GREATEST(0, EXTRACT(EPOCH FROM
  fr.created_at + make_interval(secs => ${FEEDBACK_EDIT_WINDOW_SECONDS}) - clock_timestamp()))`;

function editInfo(row) {
  if (!row || row.source != null || !row.has_body || !row.issue_owner || !row.issue_repo
      || !Number.isSafeInteger(Number(row.issue_number)) || Number(row.issue_number) <= 0
      || Number(row.seconds_left) <= 0) return null;
  return {
    reportId: Number(row.id), version: Number(row.edit_version),
    title: row.title || '', description: row.description,
    secondsLeft: Number(row.seconds_left),
  };
}

async function readEditInfo(pool, id, userId) {
  if (!id) return null;
  const { rows } = await pool.query(`
    SELECT fr.*, (fr.body_prefix IS NOT NULL AND fr.body_suffix IS NOT NULL) AS has_body,
           ${EDIT_SECONDS_SQL} AS seconds_left
      FROM feedback_reports fr WHERE fr.id = $1 AND fr.user_id = $2`, [id, userId]);
  return editInfo(rows[0]);
}

// Shared by corrections and the title healer, including across server replicas.
// Generation happens outside the lock; its queue row is checked again inside.
async function withFeedbackIssueLock(pool, owner, repo, number, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`feedback:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function saveFeedbackEdit(pool, id, userId, { title, description, version }) {
  const { rows } = await pool.query(
    'SELECT issue_owner, issue_repo, issue_number FROM feedback_reports WHERE id = $1 AND user_id = $2',
    [id, userId]);
  const target = rows[0];
  if (!target) return { status: 404, code: 'not_found' };
  if (!target.issue_owner || !target.issue_repo || !target.issue_number) {
    return { status: 409, code: 'not_editable' };
  }
  return withFeedbackIssueLock(pool, target.issue_owner, target.issue_repo, target.issue_number, async (client) => {
    const { rows: locked } = await client.query(`
      SELECT fr.*, (fr.body_prefix IS NOT NULL AND fr.body_suffix IS NOT NULL) AS has_body,
             ${EDIT_SECONDS_SQL} AS seconds_left
        FROM feedback_reports fr WHERE fr.id = $1 AND fr.user_id = $2 FOR UPDATE`, [id, userId]);
    const fr = locked[0];
    if (!fr) return { status: 404, code: 'not_found' };
    if (fr.source != null || !fr.has_body) return { status: 409, code: 'not_editable' };
    if (Number(fr.seconds_left) <= 0) return { status: 409, code: 'edit_window_closed' };
    if (Number(fr.edit_version) !== version) return { status: 409, code: 'edit_conflict' };
    const body = fr.body_prefix + description + fr.body_suffix;
    if (body.length > GITHUB_ISSUE_BODY_MAX) return { status: 400, code: 'body_too_long', length: body.length };
    if (title === fr.title && description === fr.description) {
      return { status: 200, unchanged: true, edit: editInfo(fr) };
    }
    // A failed remote write rolls back everything local. If the response is
    // lost or the database write fails afterwards, retrying this exact content
    // is safe: it updates the same issue, never files another one.
    await github.patchIssueContent(fr.issue_owner, fr.issue_repo, fr.issue_number, { title, body });
    await client.query(`UPDATE feedback_reports SET title = $3, description = $4,
      edit_version = edit_version + 1 WHERE id = $1 AND user_id = $2`, [id, userId, title, description]);
    if (title !== fr.title) {
      await client.query('DELETE FROM title_heal_queue WHERE owner = $1 AND repo = $2 AND issue_number = $3',
        [fr.issue_owner, fr.issue_repo, fr.issue_number]);
    } else {
      await client.query(`UPDATE title_heal_queue SET description = $4
        WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
      [fr.issue_owner, fr.issue_repo, fr.issue_number, description.slice(0, 2000)]);
    }
    if (fr.app_id) {
      await client.query(`UPDATE homeroom_bot_requesters SET issue_title = $3, asked_text = $4
        WHERE app_id = $1 AND issue_number = $2`,
      [fr.app_id, fr.issue_number, title.slice(0, 300), description.slice(0, 2000)]);
    }
    const edit = await readEditInfo(client, id, userId);
    return { status: 200, target: fr, edit: edit || {
      reportId: Number(id), title, description, version: Number(fr.edit_version) + 1, secondsLeft: 0,
    } };
  });
}

module.exports = { FEEDBACK_EDIT_WINDOW_SECONDS, EDIT_SECONDS_SQL, editInfo, readEditInfo,
  withFeedbackIssueLock, saveFeedbackEdit };
