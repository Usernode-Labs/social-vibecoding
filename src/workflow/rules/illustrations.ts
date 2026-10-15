// A featured-illustration proposal's images, and applying a passed one:
// the governance machine's domain write, read and written inside its
// transaction (services/illustration-proposals.js re-exports both).

import type { Queryable } from './db.ts';

export const IMAGE_PATH = '/app-illustrations/';

/** The image id a stored illustration url names, or null for anything else. */
export function imageIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(IMAGE_PATH)) return null;
  const id = url.slice(IMAGE_PATH.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

interface Proposed { url?: string; darkUrl?: string | null; [k: string]: unknown }
interface Payload { proposed?: Proposed | null }

// Why applyProposal would throw for this record, or null when it would not:
// the same checks, reading ids rather than bytes, so the workflow machine can
// refuse a proposal whose image is gone instead of failing its apply.
export async function missingProposalImage(client: Queryable, appId: number, payload: Payload | null, issueId: number): Promise<string | null> {
  const proposed = payload && payload.proposed ? payload.proposed : null;
  if (!proposed) return null;
  const lightId = imageIdFromUrl(proposed.url);
  const darkId = proposed.darkUrl ? imageIdFromUrl(proposed.darkUrl) : null;
  if (!lightId || (proposed.darkUrl && !darkId)) return 'no_image';
  const { rows } = await client.query(
    `SELECT id, dark_id FROM app_illustration_proposals WHERE issue_id = $1
     UNION ALL
     SELECT id, dark_id FROM app_illustrations WHERE app_id = $2`,
    [issueId, appId]
  );
  const known = new Set(rows.flatMap((r) => [r.id, r.dark_id]).filter(Boolean));
  return known.has(lightId) && (!darkId || known.has(darkId)) ? null : 'image_unavailable';
}

/**
 * Write the proposed record onto the app. Runs on the caller's client, inside
 * the transaction that has the issue row locked, so a vote and the sweeper
 * cannot both apply it. Returns the illustration the app now wears (null
 * when it was removed).
 *
 * The bytes for each url in the record come from the proposal's own pending
 * row when the url is new, or from the app's current row when the proposal
 * kept an image (a reframe, a light-only upload). Anything else means the
 * image is gone, which is an error rather than a silent blank card.
 */
export async function applyProposal(client: Queryable, appId: number, payload: Payload | null, issueId: number): Promise<Proposed | null> {
  const proposed = payload && payload.proposed ? payload.proposed : null;
  if (!proposed) {
    await client.query('DELETE FROM app_illustrations WHERE app_id = $1', [appId]);
    await client.query('UPDATE apps SET featured_illustration = NULL WHERE id = $1', [appId]);
    await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
    return null;
  }
  const lightId = imageIdFromUrl(proposed.url);
  const darkId = proposed.darkUrl ? imageIdFromUrl(proposed.darkUrl) : null;
  if (!lightId || (proposed.darkUrl && !darkId)) {
    throw new Error('The proposed illustration names no image');
  }
  const { rows: pendingRows } = await client.query(
    'SELECT * FROM app_illustration_proposals WHERE issue_id = $1', [issueId]
  );
  const { rows: currentRows } = await client.query(
    'SELECT * FROM app_illustrations WHERE app_id = $1', [appId]
  );
  const sources = [pendingRows[0], currentRows[0]].filter(Boolean);
  const pick = (id: string | null) => {
    if (!id) return null;
    for (const row of sources) {
      if (row.id === id) return { id, contentType: row.content_type, data: row.data };
      if (row.dark_id === id) return { id, contentType: row.dark_content_type, data: row.dark_data };
    }
    return null;
  };
  const light = pick(lightId);
  const dark = pick(darkId);
  if (!light || (darkId && !dark)) {
    throw new Error('The proposed image is no longer available');
  }
  // The pending row goes first: its ids are UNIQUE in that table only, but
  // reading it before the upsert keeps the bytes in hand either way.
  await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
  await client.query(
    `INSERT INTO app_illustrations (app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type,
       data = EXCLUDED.data, dark_id = EXCLUDED.dark_id, dark_content_type = EXCLUDED.dark_content_type,
       dark_data = EXCLUDED.dark_data`,
    [appId, light.id, light.contentType, light.data,
      dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null]
  );
  await client.query(
    'UPDATE apps SET featured_illustration = $2::jsonb WHERE id = $1',
    [appId, JSON.stringify(proposed)]
  );
  return proposed;
}
