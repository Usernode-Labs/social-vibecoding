# Reporting and moderation — issue #2721

Approved by the user before implementation. Initial base: `953e95c021cbde554a5aac0b485df18515669f4d`.
Integrated with synced revision `bd768a6d2d318a19a8fd6063917423c61333d2bc`, including the reporting entry points merged in #2895.

## Reporting

Signed-in users can report apps from listings and the open app menu, messages
from their action menu (including touch/long-press), and users from profiles,
user cards and conversations even when their public profile is unpublished.
Message support covers direct/group conversations and Homeroom public/app
discussions. Arbitrary messages inside a mini-app are covered by reporting
the app, not by inspecting the mini-app's private storage.

A shared dialog identifies the target and asks for an applicable reason
(spam, scam/fraud, harassment, hate/threats, sexual/unsafe content,
impersonation, other) and optional details up to 1,000 characters. Other
requires details. Private-message reports explain that the message and its
attachments become available to moderators. Submit confirms receipt and
offers blocking separately where supported. Retries return the existing
open report; reporting alone never imposes a penalty. App owners do not see
Report app; an already-open form clearly explains that an owner cannot report
their own app. App-report confirmations offer Done, without offering to block
the app's creator. Blocking remains a separate option for user/message reports.

## Moderation

Admin → Moderation (the existing `/#admin/reports` route) is a private, paginated queue filterable by target type,
reason, status and date. Group reports by target without losing individual
submissions/evidence. States: new, in_review, resolved, dismissed; closed
cases can be reopened. Show target, author/owner, location, report count,
each reporter/reason/detail/time, captured evidence, current target state,
internal notes and action history. Existing profile/conversation reports
must appear too; preserve old reporting endpoint compatibility.

Platform administrators can inspect; only administrators with write access
can moderate. App ownership is not moderation permission.

Actions require a reason and confirmation, and are reversible:

- Message: hide/restore; ordinary viewers see “Removed by moderation”, with
  attachments unavailable while hidden.
- App: suspend/restore access through Homeroom and discovery; preserve code
  and data.
- User: hide/restore profile; restrict/restore participation. Restrictions
  prevent posting, messaging, invitations, voting, coding work and app
  creation/publishing while preserving settings, existing data, shared
  history and other participants' access.
- Case: dismiss, resolve with explanation, reopen, and internal notes.

Closing a report does not restore a target. Account deletion stays separate.
Prevent conflicting concurrent actions and restricting the last full admin.

## Security and privacy

Validate access to each reported target on the server without disclosing
inaccessible records. Capture evidence from server records, never trust
client snapshots. Snapshot message text/attachments, visible profile fields,
or app metadata/version. A private-message report grants access only to its
evidence, not the conversation. Evidence survives target edits/removal.
Reporter identities and internal notes remain private. Enforce rate limits
and idempotency; report count never triggers automatic punishment.

Enforce restrictions server-side on API requests, direct app links,
attachments and existing sessions. Record actor/time/reason/effect for every
moderation change. Retain evidence 180 days after closure and audit metadata
one year; private moderation tables must be scrubbed from staging clones.

## Communication

Reporters receive an in-app acknowledgment and generic closure outcome.
Affected users/app owners receive the action and reason, never reporter
identity or private notes. No promised response deadline.

## Verification

Exercise desktop/mobile entry points for all targets, legacy report
compatibility, report grouping, permission isolation, private attachment
evidence, edited/deleted targets, duplicate requests and concurrent decisions,
restriction enforcement and restoration. Run affected suites, SQL lint and
frontend checks; submit the exact tested revision to normal hosted checks.
Replay and inspect exact base/head visual evidence locally before submitting
the proposal build. No direct production infrastructure operations.
