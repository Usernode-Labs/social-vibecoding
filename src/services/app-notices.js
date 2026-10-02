'use strict';

/**
 * A project's notices: what changed about the project itself lately, for the
 * panel on its Workshop tab (frontend/src/features/dev-board/workshop/
 * notices.tsx, GET /api/apps/:slug/notices).
 *
 * These were lines in the project's channel until a channel became only what
 * people said (services/ws.js sendSystemMessage). Two kinds had nowhere else
 * to be seen, and they are this panel:
 *
 *   - SETTINGS CHANGED in the last SETTINGS_DAYS days: who can see and build
 *     it, the approval rule, its admins (each applied from a voted dapp.json
 *     change), the lock, and a new approver. Read from `events`, which every
 *     one of them already records (app-manifest.js, routes/apps.js lock,
 *     routes/approvers.js).
 *   - THIS WEEK: the Friday card (services/weekly-digest.js), shown for
 *     WEEK_DAYS days after it is made. It is recorded as a `weekly_digest`
 *     event carrying the card's data.
 *
 * The other two app-wide notices already have a place: merges paused by a
 * red main and a release that has not rolled out are banners at the top of
 * every project page (dev-board/board-frame.tsx), above both tabs.
 *
 * Nothing here is written: the panel reads what is already on the record.
 */

const { contentLine, MAX_LISTED } = require('./weekly-digest');
const { describeGovernance, describeAdmins } = require('./app-manifest');

const SETTINGS_DAYS = 7;
const WEEK_DAYS = 3;
const SETTINGS_MAX = 8;

const SETTINGS_TYPES = Object.freeze([
  'visibility_changed',
  'governance_changed',
  'app_admins_changed',
  'app_lock_changed',
  'approver_joined',
]);

// Newest first, bounded; the actor's name when a person made the change (a
// manifest change applies on deploy, after the vote that carried it, and
// names nobody). `(event_type, created_at)` is the table's index.
const SETTINGS_SQL = `
  SELECT e.id, e.event_type, e.metadata, e.created_at, u.username
    FROM events e
    LEFT JOIN users u ON u.id = e.user_id
   WHERE e.event_type = ANY($2::text[])
     AND e.created_at > NOW() - ($3 || ' days')::interval
     AND e.app_id = $1
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT $4`;

const WEEK_SQL = `
  SELECT e.metadata, e.created_at
    FROM events e
   WHERE e.event_type = 'weekly_digest'
     AND e.created_at > NOW() - ($2 || ' days')::interval
     AND e.app_id = $1
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT 1`;

/** Who can see a project, in the words its hero uses. */
function visibilityWords(to) {
  const view = to && to.view;
  const collab = to && to.collab;
  if (view === 'public' && collab === 'public') return 'anyone can see it and build';
  if (view === 'public') return 'anyone can see it; its members build';
  return 'only its members can see it';
}

/**
 * One settings event as a line: `{ kind, text, by, at }`. `by` is the person
 * who did it, or null for a change a vote carried (the manifest applies it).
 * Null for a row this panel does not describe.
 */
function settingsLine(row) {
  const meta = row.metadata || {};
  const to = meta.to;
  const by = meta.source === 'manifest' ? null : (row.username || null);
  const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  switch (row.event_type) {
    case 'visibility_changed':
      return { kind: 'visibility', text: `Who can see it changed: ${visibilityWords(to)}`, by, at };
    case 'governance_changed':
      return to
        ? { kind: 'governance', text: `Approval rule changed: ${describeGovernance(to.approverPolicy, to.approvalsRequired)}`, by, at }
        : null;
    case 'app_admins_changed':
      return { kind: 'admins', text: `Admins changed: ${describeAdmins(Array.isArray(to) ? to : [])}`, by, at };
    case 'app_lock_changed':
      return {
        kind: 'lock',
        text: meta.locked
          ? 'Locked: merges also need an admin’s yes vote'
          : 'Unlocked: merges no longer need an admin’s yes vote',
        by,
        at,
      };
    case 'approver_joined':
      return row.username
        ? { kind: 'approver', text: `@${row.username} became an approver`, by: null, at }
        : null;
    default:
      return null;
  }
}

/**
 * The Friday card as the panel draws it, or null. Titles only (#3678): a
 * card stored before then still carries each change's author and backers in
 * its metadata, and none of them leaves here.
 */
function weekCard(row) {
  const digest = row && row.metadata;
  if (!digest || (!digest.mergedTotal && !digest.openTotal)) return null;
  return {
    at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    line: contentLine(digest),
    mergedTotal: Number(digest.mergedTotal) || 0,
    openTotal: Number(digest.openTotal) || 0,
    merged: Array.isArray(digest.merged) ? digest.merged.slice(0, MAX_LISTED).map((m) => ({ title: m.title })) : [],
  };
}

/** `{ settings: [...], week: {...} | null }` for one app. */
async function forApp(pool, appId) {
  const [settings, week] = await Promise.all([
    pool.query(SETTINGS_SQL, [appId, SETTINGS_TYPES, String(SETTINGS_DAYS), SETTINGS_MAX]),
    pool.query(WEEK_SQL, [appId, String(WEEK_DAYS)]),
  ]);
  return {
    settings: settings.rows.map(settingsLine).filter(Boolean),
    week: weekCard(week.rows[0] || null),
  };
}

// A staging `?demo=1` page shows the panel with one of each, appended only
// where the real record has none, so a fresh staging database can be looked
// at and checked. Obviously fake, and never written anywhere.
const DEMO_NOTICES = Object.freeze({
  settings: [{
    kind: 'governance',
    text: 'Approval rule changed: approvals by any user, requiring at least 2 approvals',
    by: null,
    at: null,
    demo: true,
  }],
  week: {
    at: null,
    line: 'This week on Staging demo: 1 change went live: Staging demo change. One proposal is waiting for eyes: Staging demo proposal.',
    mergedTotal: 1,
    openTotal: 1,
    merged: [{ title: 'Staging demo change' }],
    demo: true,
  },
});

function withDemoNotices(notices) {
  const now = new Date().toISOString();
  return {
    settings: notices.settings.length
      ? notices.settings
      : DEMO_NOTICES.settings.map((line) => ({ ...line, at: now })),
    week: notices.week || { ...DEMO_NOTICES.week, at: now },
  };
}

module.exports = {
  forApp,
  settingsLine,
  weekCard,
  visibilityWords,
  withDemoNotices,
  DEMO_NOTICES,
  SETTINGS_SQL,
  WEEK_SQL,
  SETTINGS_TYPES,
  SETTINGS_DAYS,
  WEEK_DAYS,
};
