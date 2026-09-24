# Account deletion with retained shared history (#2716)

## User outcome
Users can permanently delete their Homeroom account from Settings → Account → Delete account. Administrators can delete an account through either Users surface using the same policy. Personal account data and access credentials are removed. Shared messages, replies, and sent attachments remain readable by their existing participants and show **Deleted user**, without a profile/avatar link. A remaining participant can read a direct conversation with a deleted account but cannot send new messages to it.

## Confirmed requirements
- Put Delete account directly below Password in Settings → Account, with a red label and an exclamation warning icon on desktop and mobile.
- Implement the recommended explicit deletion workflow, combining deletion of personal records with removal of identifying attribution from necessary shared records.
- Retain shared messages and attachments; the user explicitly chose the name “Deleted user.”
- Include a correction to repository agent guidance so native proposals do not unnecessarily call prepare_work or require a linked personal GitHub identity.
- Base: 0076a0391db6030dc89e5af656d1351d6750675b, verified through Homeroom and accepted in this conversation. Native proposal, managed branch, linked issue 2716.

## Deletion contract
- Use one service for self-service and both existing admin endpoints.
- Require explicit confirmation. Self-service verifies the current password, or a recent authenticated browser session for accounts without a password. Full-admin authorization gates admin deletion. Enforce the last-full-admin invariant using the same transaction lock used by role changes.
- Delete the account transactionally; cascading removal revokes browser/mobile/CLI/MCP credentials and deletes private profile, preferences, drafts, private assistant chats, device registrations, and membership data.
- Explicitly remove account-linked email/waitlist/OTP records and identifying audit snapshots not covered by foreign keys. Retain shared human-authored bodies and sent attachment bytes as requested; do not promise those bodies are free of personal information.
- Remove attribution from retained shared proposals, discussion messages, replies, and necessary historical vote/spend/allocation records. Withdraw live approvals before detaching historical votes. Keep existing decisions/history intact.
- Preserve group conversation ownership using the existing transfer rule. Preserve direct-history access for existing accepted participants only; never expose declined, blocked, or unaccepted histories. Make retained conversations read-only when a participant is gone.
- Prevent deletion from silently stranding app administration. Provide an actionable conflict when the account is the last explicit administrator of an app; the admin can assign a successor before retrying.
- Retain sent shared uploads; remove unsent and private-only uploads and their external objects. Erase credentials rather than revoking unrelated user-owned accounts or personal provider keys.
- Track external cleanup in durable jobs without storing erased names/emails or credentials in the job/audit payload. Retry company OpenRouter key deletion, worker/workspace teardown, and object deletion. Preserve reconciliation information for an ambiguous in-flight key provisioning result.
- Disconnect live sockets across instances, abort running work, invalidate identity caches, and reject stale user tokens on platform-controlled app API surfaces. Reconcile live connections every 30 seconds if a cross-pod notification is missed; prevent late worker bootstraps from recreating erased workspaces.
- Reserve current and previous handles using fingerprints without identity links, so new accounts cannot inherit historical mentions or manifest-admin authority.
- Show pending/retrying cleanup to admins. A failed external service never silently reports complete cleanup.

## Scope boundaries and retention
Account deletion affects Homeroom-controlled account data. Shared content is deliberately retained. Independently stored child-app data, published GitHub history, blockchain records, other recipients’ copies, and backups cannot be represented as instantly erased by this endpoint. Explain those limits in the confirmation and document the operational retention/restore responsibilities. Preserve enough minimal deletion receipts to retry cleanup and prevent restored records from being mistaken for live accounts; do not retain profile identifiers merely for audit convenience.

## Implementation
- Add a shared account-deletion service, self-service route, and durable cleanup worker with startup integration.
- Add necessary schema changes for deletion receipts/jobs, retained historical rows, and read-only deleted-peer conversation access.
- Update both admin routes/UI copy and add a reusable self-service account deletion component using existing shell primitives.
- Normalize deleted-author rendering in conversation and app discussion surfaces, including replies/bookmarks, while preserving system-message labels.
- Add explicit API authorization and concurrency coverage, real-Postgres deletion tests, cleanup retry tests, and UI/staging checks.
- Update AGENTS.md and the usernode-proposal skill with a clear native-vs-external workflow boundary and a native base-resolution rule that does not require prepare_work. Keep pinned-SHA verification, isolated branching, exact-tree uploads, and promotion safeguards.

## Verification
Test populated accounts with browser/mobile/CLI/MCP credentials, waitlist/mail records, votes, usage, messages and attachments; verify personal data removal and retained message bytes/Deleted user attribution. Exercise both admin endpoints and self-service, wrong-password/confirmation refusal, view-only admin refusal, last-admin concurrency, idempotent retries, transient provider failures, stale tokens, and deleted direct-message read/send behavior. Run SQL validation, frontend typecheck/build, and the repository’s affected test suites. Submit the exact tested tree to Homeroom, wait for staging/checks, and supply reviewer interactions before promotion.

### Cross-account authorization verification
- The self-service route selects both the actor and target from the authenticated browser identity. Client-supplied account ids, roles, and deletion modes have no authority. The service separately verifies actor/target equality and a live session belonging to that target.
- `tests/account-deletion-postgres.test.js` exercises the real cookie-auth middleware against disposable PostgreSQL accounts: forged ids in the body/query/headers, forged admin flags, absent/fabricated/expired sessions, password and confirmation bypass attempts, and replay after deletion. Successful self-deletion leaves the other account, its session, and its deletion-receipt state unchanged.
- Both admin deletion APIs reject ordinary users. Full administrators intentionally retain account-management authority; view-only or stale administrator authority is rejected, with the database role checked again inside the deletion transaction.
- The isolated PostgreSQL run passed all 10 scenarios (11 reported tests including the parent suite) on 2026-09-22. This does not replace the outstanding staging/browser and real external-cleanup verification.

## How to test / observe
- Settings → Account → Delete account: inspect the retained-content explanation; cancel safely; use a disposable staging account to confirm deletion and verify sign-out and rejected old credentials.
- Messages: after deleting a disposable participant, the remaining participant sees the existing transcript and attachments under Deleted user; the composer is disabled for the direct conversation.
- Admin → Users (and Programme → Users): inspect the consistent confirmation; delete a disposable account and inspect cleanup status/retries.


Operational cleanup, provider reconciliation, retained blockchain evidence, and backup restoration responsibilities are documented in `docs/account-deletion-operations.md`.
