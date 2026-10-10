'use strict';

/**
 * The choices POST /api/apps accepts beyond a name and a repo (communities,
 * stage 3): who the project is for, who is invited into it, and who approves
 * its changes. Pure, so every rule here is tested without a server
 * (tests/create-options.test.js); the route resolves usernames and writes
 * rows with what this returns.
 *
 * ── Who it is for ───────────────────────────────────────────────────────
 *
 * `audience` is the create screen's first question in the platform's own
 * words (services/communities.js): `solo` (Just me), `invited` (A private
 * community) or `open` (A public community). It is not stored — audience is
 * derived, never stored — so it resolves here to the two visibility columns
 * it implies:
 *
 *   solo, invited → collab private, view private. A private project; it
 *                   reads as a Private community once anyone else is in it
 *                   or invited.
 *   open          → collab public, view public. Anyone can see, join and
 *                   build.
 *
 * "Public to use, invite-only building" is not an audience a creator picks:
 * it stays in the project's settings for later. A body without `audience`
 * is an older client (or a script) and keeps today's two fields, with
 * today's defaults and today's combination rule.
 *
 * ── Who is invited ─────────────────────────────────────────────────────
 *
 * `invitees` is a list of usernames and `inviteEmails` a list of addresses,
 * both for a private community only: an invite into a project anyone can
 * already build is meaningless (the invites route refuses it for the same
 * reason), and into a Just-me project it would make it a private community,
 * which is a different answer to the first question. An address is for somebody who may not be
 * on Homeroom yet (services/email-invites.js); together the two lists hold
 * at most MAX_INVITEES people.
 *
 * ── Who approves ───────────────────────────────────────────────────────
 *
 * `governance` is dapp.json's own block, in dapp.json's own shape
 * (services/app-manifest.js readGovernance), because that is where it is
 * written: the new repository's dapp.json carries it, so the rule is
 * votable later like any other line of the manifest. Strict here where the
 * manifest reader is lenient: a creator who sent a value meant it, and a
 * silently dropped rule would be a project that approves changes
 * differently from what its creator chose. An import sends it only when its
 * repository's dapp.json does not set one already (the dialog reads it at
 * the check); the bot then commits it there (services/import-manifest.js),
 * and where the repo does set one, its own rule still wins on the first
 * deploy.
 *
 * ── What it is ─────────────────────────────────────────────────────────
 *
 * `description` is dapp.json's top-level one line about what the project
 * is, optional, and written where the approval rule is: the new
 * repository's dapp.json, so a community changes it later with a vote like
 * any other line there. The join screen, Discover and the project's page
 * read it off the manifest snapshot. Whitespace collapses to single spaces;
 * at most DESCRIPTION_MAX characters. An import sends it on the same terms as
 * the rule above.
 *
 * #3572: DESCRIPTION_MAX is two lines on a phone, measured where the line is
 * read largest: the project's hub hero (community-card.tsx
 * `.dev-ws-hero-desc`, 15px over 21px, the page's full width less 16px). That
 * column is 344px wide on a 360px Android phone and 359px on a 375px iPhone,
 * and two lines of it hold 99 to 112 characters of real one-line
 * descriptions in a phone's system font (measured in Chromium with a
 * Helvetica-metric face, the nearest stand-in for SF Pro and Roboto). 90
 * leaves a tenth of that room for long words and capitals, so a description
 * that passes here is two lines on a common phone. It was 100, which the
 * narrowest of those could already push onto a third line.
 *
 * A dapp.json can still say more: an import keeps its repository's line,
 * and a later proposal can lengthen it (services/app-manifest.js
 * readDescription keeps up to 280). Rejecting either would turn a sentence
 * into a failed import or a failed deploy. Instead every surface clamps what
 * it shows (two lines in the hub hero, on Discover and on the join screen,
 * three beside the icon in the About pane), and the line in dapp.json stays
 * as it was written.
 *
 * ── What it starts from ───────────────────────────────────────────────
 *
 * `template` is the starter the new repository is scaffolded from
 * (services/app-templates.js): one of its TEMPLATE_IDS, `empty` when
 * absent. Strict, like the rest: an unknown id is a 400, never quietly the
 * empty starter. An import keeps its own repository, so it takes no
 * template beyond the default.
 */

const appTemplates = require('./app-templates');

const AUDIENCES = new Set(['solo', 'invited', 'open']);
const VISIBILITIES = new Set(['public', 'private']);
const MAX_INVITEES = 20;
const MAX_APPROVALS_REQUIRED = 50;
const USERNAME_MAX = 64;
const DESCRIPTION_MAX = 90;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** The two visibility columns an audience implies. */
function visibilityForAudience(audience) {
  return audience === 'open'
    ? { collabVisibility: 'public', viewVisibility: 'public' }
    : { collabVisibility: 'private', viewVisibility: 'private' };
}

/** Today's rule for the two raw fields, unchanged (routes/apps.js had it). */
function visibilityComboError(collab, view) {
  if (!VISIBILITIES.has(collab) || !VISIBILITIES.has(view)) {
    return 'Visibility must be "public" or "private"';
  }
  if (collab === 'public' && view === 'private') {
    return 'An app that everyone can build cannot be private to view';
  }
  return null;
}

function parseInvitees(raw) {
  if (raw == null) return { invitees: [] };
  if (!Array.isArray(raw)) return { error: 'invitees must be a list of usernames' };
  const seen = new Set();
  const invitees = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'invitees must be a list of usernames' };
    const name = entry.trim().replace(/^@/, '');
    if (!name) continue;
    if (name.length > USERNAME_MAX) return { error: `@${name.slice(0, 24)}… is not a username` };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    invitees.push(name);
  }
  if (invitees.length > MAX_INVITEES) {
    return { error: `Invite at most ${MAX_INVITEES} people when you create it; add more from its page.` };
  }
  return { invitees };
}

function parseInviteEmails(raw) {
  if (raw == null) return { emails: [] };
  if (!Array.isArray(raw)) return { error: 'inviteEmails must be a list of email addresses' };
  const emails = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'inviteEmails must be a list of email addresses' };
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { error: `${entry.slice(0, 40)} is not an email address.` };
    if (!emails.includes(email)) emails.push(email);
  }
  return { emails };
}

/**
 * dapp.json's governance block → the two columns, or an error. `null`
 * (absent) is the default rule: anyone approves, time and majority.
 */
function parseGovernance(raw) {
  if (raw == null) return { governance: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'governance must be an object' };
  const approvers = raw.approvers == null ? 'anyone' : raw.approvers;
  if (approvers !== 'anyone' && approvers !== 'invited') {
    return { error: 'governance.approvers must be "anyone" or "invited"' };
  }
  let approvalsRequired = null;
  if (raw.approvals != null && raw.approvals !== 'default') {
    const n = raw.approvals && typeof raw.approvals === 'object' && !Array.isArray(raw.approvals)
      ? raw.approvals.atLeast : undefined;
    if (!Number.isInteger(n) || n < 1 || n > MAX_APPROVALS_REQUIRED) {
      return { error: `governance.approvals must be "default" or { "atLeast": 1-${MAX_APPROVALS_REQUIRED} }` };
    }
    approvalsRequired = n;
  }
  if (approvers === 'anyone' && approvalsRequired == null) return { governance: null };
  return { governance: { approverPolicy: approvers, approvalsRequired } };
}

/** The one line, tidied, or null when blank. */
function parseDescription(raw) {
  if (raw == null) return { description: null };
  if (typeof raw !== 'string') return { error: 'description must be a line of text' };
  const text = raw.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (!text) return { description: null };
  if (text.length > DESCRIPTION_MAX) {
    return { error: `Say what it is in ${DESCRIPTION_MAX} characters or fewer.` };
  }
  return { description: text };
}

/**
 * Everything POST /api/apps needs to know about who a new project is for.
 * Returns `{ error }` for a 400, otherwise
 * `{ audience, collabVisibility, viewVisibility, invitees, inviteEmails,
 * governance, description, template }`.
 */
function parseCreateOptions(body = {}, { imported = false } = {}) {
  let audience = null;
  let collabVisibility;
  let viewVisibility;
  if (body.audience != null) {
    if (!AUDIENCES.has(body.audience)) return { error: 'audience must be "solo", "invited" or "open"' };
    audience = body.audience;
    ({ collabVisibility, viewVisibility } = visibilityForAudience(audience));
  } else {
    collabVisibility = body.collabVisibility || 'public';
    viewVisibility = body.viewVisibility || 'public';
    const comboError = visibilityComboError(collabVisibility, viewVisibility);
    if (comboError) return { error: comboError };
  }

  const inv = parseInvitees(body.invitees);
  if (inv.error) return { error: inv.error };
  const mail = parseInviteEmails(body.inviteEmails);
  if (mail.error) return { error: mail.error };
  if ((inv.invitees.length || mail.emails.length) && audience !== 'invited') {
    return { error: 'Only a private community is created with invites. Invite people from a project’s page.' };
  }
  if (inv.invitees.length + mail.emails.length > MAX_INVITEES) {
    return { error: `Invite at most ${MAX_INVITEES} people when you create it; add more from its page.` };
  }

  const gov = parseGovernance(body.governance);
  if (gov.error) return { error: gov.error };

  const desc = parseDescription(body.description);
  if (desc.error) return { error: desc.error };

  const tpl = appTemplates.parseTemplate(body.template);
  if (tpl.error) return { error: tpl.error };
  if (imported && tpl.template !== appTemplates.DEFAULT_TEMPLATE) {
    return { error: 'An import keeps its own repository, so it cannot start from a template.' };
  }

  return {
    audience,
    collabVisibility,
    viewVisibility,
    invitees: inv.invitees,
    inviteEmails: mail.emails,
    governance: gov.governance,
    description: desc.description,
    template: tpl.template,
  };
}

/**
 * The block a new repository's dapp.json carries for a governance choice, in
 * the shape readGovernance reads back. Null for the default rule, so a
 * default project's dapp.json stays the one-line `{ "secrets": [] }` it
 * always was.
 */
function governanceBlock(governance) {
  if (!governance) return null;
  const { approverPolicy = 'anyone', approvalsRequired = null } = governance;
  if (approverPolicy === 'anyone' && approvalsRequired == null) return null;
  return {
    approvers: approverPolicy,
    approvals: approvalsRequired == null ? 'default' : { atLeast: approvalsRequired },
  };
}

module.exports = {
  AUDIENCES,
  MAX_INVITEES,
  DESCRIPTION_MAX,
  parseCreateOptions,
  governanceBlock,
  visibilityForAudience,
  visibilityComboError,
};
