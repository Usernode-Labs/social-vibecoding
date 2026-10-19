'use strict';

// Uploads nothing came to own, reclaimed after a day (a week for a staging
// preview's app files), and closed moderation records past their window.
// One pass of the `upload-gc` clock (src/workflow/clock/services.ts); each step
// is an age DELETE, so two passes at once delete nothing twice. A step that
// fails fails the pass, and the clock tries again sooner: the others ran.

const log = require('./logger');

// Rows an upload made that no message, issue or conversation took.
const ORPHANS = [
  // A dev-chat upload removed from the composer or abandoned (#450).
  ['chatAttachments', 'chat_session_attachments', 'message_id'],
  // A feedback screenshot or clip whose modal was cancelled (#683, #3940).
  ['issueScreenshots', 'issue_screenshots', 'issue_number'],
  ['issueVideos', 'issue_videos', 'issue_number'],
  // A group-chat upload never sent (#694).
  ['groupChatAttachments', 'chat_message_attachments', 'message_id'],
  // A conversation upload never sent.
  ['conversationAttachments', 'conversation_message_attachments', 'message_id'],
];

async function sweep(pool, config) {
  const out = {};
  let failed = null;
  for (const [name, table, owner] of ORPHANS) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE ${owner} IS NULL AND created_at < NOW() - INTERVAL '24 hours'`);
      out[name] = rowCount || 0;
    } catch (err) {
      failed ||= err;
      log.warn('upload-retention', 'An orphaned-upload sweep failed', { table, err: err.message });
    }
  }
  try {
    // Uploads from staging previews are test data (#752): object first, row
    // second, so a row whose object delete failed is tried again.
    const appFiles = require('./app-files');
    out.stagingAppFiles = await appFiles.sweepStagingFiles(pool, appFiles.getStore(config));
  } catch (err) {
    failed ||= err;
    log.warn('upload-retention', 'The staging app-file sweep failed', { err: err.message });
  }
  try {
    await require('./moderation').purgeExpired(pool);
  } catch (err) {
    failed ||= err;
    log.warn('upload-retention', 'The moderation retention purge failed', { err: err.message });
  }
  if (failed) throw failed;
  const removed = Object.values(out).reduce((n, v) => n + (Number(v) || 0), 0);
  if (removed) log.info('upload-retention', 'Reclaimed orphaned uploads', out);
  return out;
}

module.exports = { sweep, ORPHANS };
