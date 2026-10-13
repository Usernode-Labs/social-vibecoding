'use strict';

// Why a proposal needs a Yes from someone other than its author: the
// vocabulary of chat_sessions.explicit_approval_reason, and the words every
// surface uses for it.
//
// #788 introduced the rule for one dapp.json block, `admins`. The same risk
// sits in four more places, and each of them used to merge on silence or on
// its author's own Yes:
//
//   admins       who runs the app (app admins can force-merge)
//   governance   how changes are approved (who votes, how many Yes)
//   visibility   who can see and build the app
//   platform_env the platform's own settings (the self-hosted app only)
//   secrets      the app's keys (a declaration PR can carry a value)
//
// A flagged proposal loses every time-based merge path
// (services/governance.js applyNoTimerMerge) and, whenever its community has
// more than one member, also needs at least one qualifying Yes from someone
// who is not its author (the member floor, same file).
//
// ONE stored reason. A proposal can touch several blocks, and the column is
// VARCHAR(32): the joined list ("admins,governance,visibility,platform_env,
// secrets") does not fit. More to the point, every surface says one sentence,
// so the column holds the PRIMARY reason, picked by REASONS' order (the one
// that hands out the most power first). The full list rides on the merge
// debug step, where an admin reading why a merge waited can see all of it.
//
// The copy is mirrored in public/js/merge-status.js (explicitApprovalCopy),
// which loads before app-view.js in the browser and cannot require this file.
// tests/explicit-approval-vote-panel.test.js holds the two to the same words.

const REASONS = Object.freeze(['admins', 'governance', 'visibility', 'platform_env', 'secrets']);

// What each reason is about, in the words a member reads. A noun phrase, so
// it fits both "Changes to … need a Yes from another member." and
// "It changes …".
const REASON_PHRASES = Object.freeze({
  admins: 'who runs this app',
  governance: 'how changes are approved',
  visibility: 'who can see this app',
  platform_env: 'this app’s platform settings',
  secrets: 'this app’s keys',
});

function isReason(r) {
  return typeof r === 'string' && Object.prototype.hasOwnProperty.call(REASON_PHRASES, r);
}

// The first reason in REASONS order that `reasons` contains, or null.
function primaryReason(reasons) {
  const list = Array.isArray(reasons) ? reasons : (reasons == null ? [] : [reasons]);
  for (const r of REASONS) if (list.includes(r)) return r;
  return null;
}

// The phrase for a reason, or null for one this build does not know (a row
// stamped by a newer build, or a NULL reason on a TRUE flag).
function reasonPhrase(reason) {
  return isReason(reason) ? REASON_PHRASES[reason] : null;
}

// The full sentence: "Changes to who can see this app need a Yes from
// another member." A missing or unknown reason still reads as a sentence.
function reasonSentence(reason) {
  const phrase = reasonPhrase(reason);
  return phrase
    ? `Changes to ${phrase} need a Yes from another member.`
    : 'This change needs a Yes from another member.';
}

// The requirement row's line under "A Yes from another member": short, and
// only the part the label does not already say.
function reasonLine(reason) {
  const phrase = reasonPhrase(reason);
  return phrase ? `It changes ${phrase}` : 'It changes a protected setting';
}

// A secret-change request (issues.kind = 'secret_change') always carries a
// value, so it is always flagged. Which reason depends on where the value
// lands: the platform's own variables on the self-hosted app, the app's
// keys everywhere else (routes/issues.js maybeApplySecretChangeProposal).
function secretChangeReason(selfHosted) {
  return selfHosted ? 'platform_env' : 'secrets';
}

module.exports = {
  REASONS,
  REASON_PHRASES,
  isReason,
  primaryReason,
  reasonPhrase,
  reasonSentence,
  reasonLine,
  secretChangeReason,
};
