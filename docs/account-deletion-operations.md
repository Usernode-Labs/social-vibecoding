# Account deletion operations

Self-service is under Settings → Account → Delete account. Both admin Users delete actions call
the same transaction. Shared messages, shared transcripts/specs, published
screenshots and sent attachments remain with anonymous attribution. Their
contents and filenames are intentionally retained, including any personal
information in that content. Private assistant messages, unsent uploads,
credentials and account records are removed. Financial totals and completed
governance history remain; live votes are withdrawn.

Deletion receipts retain an opaque account id, timestamp, mode, and requesting
administrator id. Cleanup tasks retain only resource identifiers needed to
remove provider keys, private objects and workspaces. Completed provider/object
targets are discarded. Session ids remain to prevent a late worker bootstrap
from resurrecting a deleted workspace. Deleted handles are reserved as hashes
without an identity link, preventing old mentions or manifest-admin entries
from granting authority to a later account.

## Monitor and retry

Full administrators can open Admin → Users → Deleted account cleanup. Refresh
shows completed, pending or provider-review work. Retry makes pending tasks due
immediately. The server also drains this durable queue every minute. Failed
tasks wait five minutes; interrupted task leases expire after five minutes.
Only confirmed resource removal completes a task, including Kubernetes pod/PVC
termination. API access is revoked by the deletion transaction, regardless of
cleanup progress. Open streams/sockets are disconnected across pods; a
30-second reconciliation covers a missed cross-pod notification.

The read API is `GET /api/admin/account-deletions`. It omits provider hashes and
raw errors. `POST /api/admin/account-deletions/:id/retry` retries pending work.
These APIs require a full platform administrator.

## An OpenRouter key requires review

A creation request can have an ambiguous outcome, or complete while the user
is being deleted. Never retry the creation request. A confirmed late response
automatically queues the returned key hash for deletion. Otherwise inspect the
organization's OpenRouter key inventory for `usernode-user-<receipt.user_id>`.
After verifying the provider state, use the authenticated admin API:

```text
POST /api/admin/account-deletions/<receipt-id>/reconcile-key
Content-Type: application/json
{"confirmation":"RECONCILED","hash":"<verified provider key hash>"}
```

This queues deletion of the discovered key. If the provider confirms no key
exists, send `{"confirmation":"RECONCILED","noKeyExists":true}` instead.
Never use this acknowledgement while creation is still unresolved. Keep the
receipt pending if the provider cannot establish whether a key exists.

## Retention and restore

This endpoint does not rewrite published GitHub history, blockchain history,
recipients' copies or an independently hosted child app's database. On-chain
allocation/epoch records and append-only delegation evidence remain necessary
operational records; local user links and provisioned wallet secrets are removed.
Personal provider accounts and their independently managed API keys are not
deleted at the provider; Homeroom's copies of those credentials are erased.

Backups and infrastructure logs follow the deployment's existing retention
policy; this feature does not invent a retention period or promise instant
physical erasure from backups. Restrict those systems to recovery/operations.
Keep deletion receipts at least through the longest backup retention window.
Before serving a restored database, reconcile the current deletion receipts
against it and repeat the erasure for resurrected account ids, preserving
resource cleanup tasks. Never restore a historical database directly into
public service without that reconciliation. Backup/restore procedures must
retain the current receipts separately from the snapshot being restored.
