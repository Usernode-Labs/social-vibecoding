'use strict';

// Featured-illustration governance (#2086).
//
// Saving or removing an app's featured illustration used to write
// `apps.featured_illustration` on the spot, so one manager could restyle the
// app's Discover card unilaterally. It opens a governance proposal now, an
// `issues` row of kind `featured_illustration`, modelled on the rename card:
// the board shows the proposed image beside the current one, the change
// applies when the vote passes under the app's usual gate, and an admin can
// force-apply it like any other governance card.
//
// The payload is the whole story the card needs and the whole instruction
// the apply needs:
//
//   { proposed: illustration | null,   // null = remove the illustration
//     current:  illustration | null,   // what the app wore when proposed
//     remove:   boolean }
//
// where an illustration is the same record `apps.featured_illustration`
// holds ({ url, darkUrl, zoom, x, y, tint, preview? }, where `preview` is
// the card's animated loop, { url: '/app-previews/<id>', type }, absent when
// it has none). `proposed` is COMPLETE, not a
// diff: a framing-only change carries the current image URLs, a light-only
// upload carries the current darkUrl, so the apply is one write of the
// record as proposed. The bytes behind a NEW url wait in
// app_illustration_proposals until then; the apply moves them into
// app_illustrations under the same ids, which is what keeps the preview URL
// the card rendered valid after the change lands.
//
// The route (src/routes/app-illustrations.js) builds the record and calls
// createProposal; the governance machine applies a passed proposal
// (src/workflow/governance-proposal/, with src/workflow/rules/illustrations.ts
// applyProposal inside its transaction).

const crypto = require('crypto');
const log = require('./logger');
const { sendSystemMessage, pushIssueUpdate } = require('./ws');

const illustrations = require('../workflow/rules/illustrations.ts');

const KIND = 'featured_illustration';
const { IMAGE_PATH, PREVIEW_PATH, imageIdFromUrl, previewIdFromUrl } = illustrations;

function newImageId() {
  return crypto.randomBytes(16).toString('hex');
}

function imageUrl(id) {
  return `${IMAGE_PATH}${id}`;
}

function previewUrl(id) {
  return `${PREVIEW_PATH}${id}`;
}

/** The card's route, the same one shared-objects.js builds for a governance row. */
function governanceHref(slug, issueId) {
  return `#app/${encodeURIComponent(slug)}/dev/governance/${issueId}`;
}

function proposalLink(app, issue) {
  return { id: issue.id, href: governanceHref(app.slug, issue.id) };
}

/** The open illustration proposal on an app, if there is one. */
async function findOpenProposal(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, title, created_at, created_by, payload FROM issues
      WHERE app_id = $1 AND kind = $2 AND status = 'open'
      ORDER BY id LIMIT 1`,
    [appId, KIND]
  );
  return rows[0] || null;
}

class PendingProposalError extends Error {
  constructor(issue) {
    super('A featured illustration change is already waiting for the group to vote on it.');
    this.code = 'pending';
    this.issue = issue;
  }
}

// #6601: the proposer can replace their own waiting change instead of
// withdrawing it and uploading everything again. Anyone else is refused; a
// waiting change that has already been decided cannot be replaced.
class NotProposerError extends Error {
  constructor() {
    super('Only the person who proposed the waiting change can replace it.');
    this.code = 'not_proposer';
  }
}
class NotOpenError extends Error {
  constructor() {
    super('That change was already decided.');
    this.code = 'not_open';
  }
}

/** The issue's title and description for a proposed record. */
function describe(app, user, proposed, current) {
  const remove = proposed === null;
  const title = remove
    ? 'Remove the featured illustration'
    : current ? 'Change the featured illustration' : 'Add a featured illustration';
  const description = `${user.username} proposed ${remove ? 'removing' : current ? 'changing' : 'adding'} `
    + `the featured illustration on ${app.name || app.slug}'s Discover card. `
    + 'It applies when the group votes it in.';
  return { title, description, remove };
}

/**
 * Open the proposal. `proposed` is the complete illustration record the app
 * would wear (null to remove it); `images` carries the bytes behind any NEW
 * url in it as { light: { id, contentType, data } | null, dark: ...,
 * preview: ... } (`preview` the card's loop, under `proposed.preview.url`).
 *
 * Throws PendingProposalError when one is already open on the app. The
 * read below answers the common case with the open card to link to; the
 * partial unique index on issues answers the race, and its violation is
 * translated into the same error.
 */
async function createProposal(pool, { app, user, proposed, images = {} }) {
  const current = app.featured_illustration || null;
  const existing = await findOpenProposal(pool, app.id);
  if (existing) throw new PendingProposalError(existing);

  const remove = proposed === null;
  const { title, description } = describe(app, user, proposed, current);
  const payload = { proposed, current, remove };

  const client = await pool.connect();
  let issue;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO issues (app_id, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [app.id, title, description, KIND, JSON.stringify(payload), user.id]
    );
    issue = rows[0];
    const light = images.light || null;
    const dark = images.dark || null;
    const preview = images.preview || null;
    if (light || dark || preview) {
      await client.query(
        `INSERT INTO app_illustration_proposals
           (issue_id, app_id, id, content_type, data, dark_id, dark_content_type, dark_data,
            preview_id, preview_content_type, preview_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [issue.id, app.id,
          light ? light.id : null, light ? light.contentType : null, light ? light.data : null,
          dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null,
          preview ? preview.id : null, preview ? preview.contentType : null, preview ? preview.data : null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && /open_featured_illustration/.test(err.constraint || '')) {
      throw new PendingProposalError(await findOpenProposal(pool, app.id));
    }
    throw err;
  } finally {
    client.release();
  }

  // Announce it the way the other governance kinds are announced: in the
  // proposal's own thread, so the discussion opens with its origin in
  // context. Best-effort, outside the transaction.
  const createdMsg = `${user.username} proposed ${remove ? 'removing' : 'changing'} the featured illustration`;
  await sendSystemMessage(pool, app.id, createdMsg, 'system',
    null, { type: 'governance', ref: issue.id }).catch(() => {});
  // Enroll it with the governance machine; a failure is caught by the next
  // vote or the boot backfill.
  const workflow = require('../workflow/platform.ts');
  await workflow.fileProposal(issue.id, app.id).catch((err) =>
    log.warn('illustrations', 'Filing the governance proposal failed', { issueId: issue.id, err: err.message }));
  pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: issue.id, kind: KIND });

  log.info('illustrations', 'Featured illustration proposal created', {
    issueId: issue.id, appId: app.id, remove,
  });
  return issue;
}

/**
 * Replace the waiting proposal's record in place (#6601).
 *
 * `proposed` is the COMPLETE new record, built by the route over the waiting
 * proposal's own `proposed` (so a field left out keeps what the waiting
 * change had, not what the card wears). The bytes behind each slot come from
 * the new upload when one was given, else from the old pending row when the
 * new record still names that id, else nothing. Votes already cast are
 * cleared, because they were cast on the old picture.
 *
 * Every write runs in one transaction holding the issue row lock, the same
 * lock the machine's facts take: a vote that is applying concurrently either
 * commits first (the issue is closed, and replace is refused) or waits and
 * then reads the new payload, the new bytes and no votes. The issue row's
 * own payload is the machine's to write (it owns it), so the Revise event
 * appended by the caller carries the new record and writes it in the same
 * transaction that re-evaluates the gate.
 */
async function replaceProposal(pool, { app, user, issueId, proposed, images = {} }) {
  const current = app.featured_illustration || null;
  const { title, description, remove } = describe(app, user, proposed, current);
  const payload = { proposed, current, remove };
  const client = await pool.connect();
  let issue;
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT id, app_id, status, kind, created_by FROM issues WHERE id = $1 FOR UPDATE`, [issueId]);
    if (!row || row.kind !== KIND || row.status !== 'open') throw new NotOpenError();
    if (row.created_by == null || Number(row.created_by) !== Number(user.id)) throw new NotProposerError();
    const { rows: [old] } = await client.query(
      'SELECT * FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
    // A slot takes the new upload, else the old pending bytes when the new
    // record still names that id, else nothing.
    const keptLight = old && old.id && imageIdFromUrl(proposed && proposed.url) === old.id;
    const keptDark = old && old.dark_id && imageIdFromUrl(proposed && proposed.darkUrl) === old.dark_id;
    const keptPreview = old && old.preview_id
      && previewIdFromUrl(proposed && proposed.preview && proposed.preview.url) === old.preview_id;
    const light = images.light
      ? { id: images.light.id, contentType: images.light.contentType, data: images.light.data }
      : keptLight ? { id: old.id, contentType: old.content_type, data: old.data } : null;
    const dark = images.dark
      ? { id: images.dark.id, contentType: images.dark.contentType, data: images.dark.data }
      : keptDark ? { id: old.dark_id, contentType: old.dark_content_type, data: old.dark_data } : null;
    const preview = images.preview
      ? { id: images.preview.id, contentType: images.preview.contentType, data: images.preview.data }
      : keptPreview ? { id: old.preview_id, contentType: old.preview_content_type, data: old.preview_data } : null;
    await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
    if (light || dark || preview) {
      await client.query(
        `INSERT INTO app_illustration_proposals
           (issue_id, app_id, id, content_type, data, dark_id, dark_content_type, dark_data,
            preview_id, preview_content_type, preview_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [issueId, app.id,
          light ? light.id : null, light ? light.contentType : null, light ? light.data : null,
          dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null,
          preview ? preview.id : null, preview ? preview.contentType : null, preview ? preview.data : null]
      );
    }
    // The votes were cast on the old picture.
    await client.query('DELETE FROM issue_votes WHERE issue_id = $1', [issueId]);
    await client.query('COMMIT');
    issue = { id: row.id, app_id: row.app_id, status: 'open' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The issue row's payload is the workflow machine's to write: the Revise
  // event carries the new record and writes it alongside the gate's
  // re-evaluation. The pending bytes and the cleared votes above are already
  // committed, so a refusal is logged rather than thrown back at the caller.
  const workflow = require('../workflow/platform.ts');
  await workflow.reviseProposal(issue, user, { title, description, payload });
  pushIssueUpdate({ action: 'updated', appSlug: app.slug, appId: app.id, issueId: issue.id, kind: KIND });
  log.info('illustrations', 'Featured illustration proposal replaced', {
    issueId: issue.id, appId: app.id, remove,
  });
  return issue;
}

module.exports = {
  KIND,
  IMAGE_PATH,
  PREVIEW_PATH,
  PendingProposalError,
  NotProposerError,
  NotOpenError,
  newImageId,
  imageUrl,
  previewUrl,
  imageIdFromUrl,
  previewIdFromUrl,
  governanceHref,
  proposalLink,
  findOpenProposal,
  describe,
  createProposal,
  replaceProposal,
};
