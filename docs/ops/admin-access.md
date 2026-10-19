# Admin access: least privilege, the quarterly review, and the MFA plan

Request #5133 ("[I-06] Tighten admin access") asks for three things: MFA for
admins, least privilege, and a quarterly review of who can export the
database. This page says what the platform enforces today, how the review is
run, what is still an operations task, and how MFA will be built.

## Who can do what today

A platform account has one of three roles, set in the console's Users
section (`POST /api/admin/users/:id/is-admin`, full admins only):

| Role | Columns | Gate in code |
| --- | --- | --- |
| Member | `is_admin = FALSE` | none |
| View-only admin | `is_admin = TRUE`, `admin_readonly = TRUE` | `adminMiddleware` (`src/middleware/admin.js`) |
| Full admin | `is_admin = TRUE`, `admin_readonly = FALSE` | `requireAdminWrite`, which reads `canAdminWrite` |

What each admin role reaches:

| Capability | View-only admin | Full admin |
| --- | --- | --- |
| Read every admin console screen | yes | yes |
| SQL console (`POST /api/v4/admin/sql-query/execute`) | yes | yes |
| Change anything (every `POST`/`PUT`/`PATCH`/`DELETE` under `/api/admin` and `/api/v4/admin`) | no | yes |
| Whole-database export (`/api/admin/db-export`) | no | yes, with their password each time |
| Programme database export (`/api/v4/admin/database/export`) | no | yes |
| CSVs carrying personal data or verdicts (programme users, waitlist, bot verdicts, shots runs, benchmark trials) | no | yes |
| Programme configuration CSV (`/api/v4/admin/programme/export.csv`) | yes | yes |
| Set another account's role, reset its password, merge or delete accounts | no | yes |
| Access review (`#admin/access-review`) | no | yes |

Notes on the rows above:

- **The SQL console is open to view-only admins on purpose**
  (`src/routes/topochain/admin/db-tools.js`). A query runs SELECT-only, in a
  `READ ONLY` transaction, as the `topochain_console_ro` role, which has a
  column-level grant that leaves out every credential column
  (`src/services/topochain/db-console-scope.js`). It can still read personal
  data such as email addresses, up to 1,000 rows a query, which a view-only
  admin can already read screen by screen. Whether view-only admins should
  keep it is a policy decision; if not, add `adminWriteGate` to that route
  and update `tests/topochain-db-tools.test.js` and
  `src/services/admin-access-review.js` together.
- **The programme configuration CSV** holds no personal data
  (`src/routes/topochain/admin/programme-export.js`), so it stays readable by
  every admin.
- **Nothing lets an admin sign in as someone else.** There is no
  impersonation route. A full admin can set a temporary password on another
  account (`POST /api/admin/users/:id/reset-password`), which is the closest
  thing: it answers with a temporary password and signs the account out,
  and is full-admin only.
- **CLI tokens never reach admin routes.** `src/services/cli-api-policy.js`
  denies `/api/admin` and `/api/v4` to a CLI bearer token whatever the
  account's role. The hosted connector (MCP) allows a short list of admin
  tools (benchmark, shots evaluation, test accounts, challenge admin), each
  behind `canAdminWrite`; it has no export tool.

A sweep of every mutating route under `/api/admin` and `/api/v4/admin`
(175 of them) as a view-only admin found each one refused with 403 except the
SQL console's read-only `execute`; every export that carries personal data or
secrets is behind the full-admin gate. `tests/view-only-admin.test.js` and
`tests/admin-access-review.test.js` pin the gates the review relies on.

## The quarterly review

The console's **People > Access review** section (full admins only) lists
every account with admin rights: its role, when it got that role and from
whom (recorded since #5133; older grants read "Not recorded"), its newest
live sign-in, its last completed database export, and what it can do. The
top of the section says when the list was last reviewed, by whom, and when
the next review is due: 90 days after the last one.

Every quarter, a full admin who is not the only full admin should:

1. Open `#admin/access-review`.
2. For each account, confirm with its owner, or with whoever asked for the
   access, that they still need it. Lower anyone who does not in
   **People > Users** (full admin to view-only, or view-only to member).
   The platform refuses to remove the last full admin.
3. Check that no one holds full admin who only needs to read. Prefer
   view-only.
4. Open **Platform > Database export** and read the history. Every export,
   refused ones included, is there and cannot be cleared. Ask about any you
   cannot account for.
5. Review infrastructure access (next section) the same day.
6. Back in Access review, write what changed in the note (for example
   "removed old-ops; lowered sam to view-only") and press **Reviewed**.
   The review records who pressed it, when, and the list of admin ids and
   roles at that moment (`admin_access_reviews`).

Admin rights given straight in SQL (for example the first admin on a new
installation) leave no role-change row. Give roles through the console so
the review can show when and by whom.

## Infrastructure access (operations only)

The platform's own checks stop at its HTTP routes. Anyone with
infrastructure access can read or copy the database without going through
them, so the same quarterly review covers these. None of this is in the
repository; it is done by whoever holds the accounts.

1. **Hetzner Cloud and Robot.** In the Hetzner console, list the project
   members and Robot users. Remove anyone who no longer operates the
   servers. Require two-factor authentication on every member account.
   Rotate API tokens that belong to people who have left, and delete unused
   ones.
2. **SSH to servers and the storage box.** On each host, read
   `~/.ssh/authorized_keys` for every login user and remove keys whose owner
   you cannot name. Do the same for the backup storage box's authorized
   keys.
3. **Kubernetes.** List who can reach the cluster: the kubeconfigs that
   were handed out and the RBAC bindings
   (`kubectl get clusterrolebindings,rolebindings -A -o wide`). Remove
   bindings for people who have left, and rotate any kubeconfig credential
   that was shared rather than issued per person. Anyone who can
   `kubectl exec` into the platform or database Pods, or read the Secrets in
   `social-platform`, can export the database. Count them as database
   exporters.
4. **PostgreSQL.** List the roles that can log in
   (`SELECT rolname FROM pg_roles WHERE rolcanlogin;`) on the platform
   database cluster. Each should be a service role the platform or the
   operator uses. Rotate the platform role's password if anyone who has
   left knew it, then update the Kubernetes Secret it is read from.
5. **Backups.** Backups are a copy of the database. Confirm who can read the
   backup storage (object storage keys, storage box users) and remove anyone
   who should not.
6. **GitHub.** Review the organization's owners and the people who can
   change deployment workflows or repository secrets.

Record the outcome in the Access review note, so the platform keeps one
record of the whole review.

## Re-authentication for dangerous actions

There is no shared "signed in recently" check in the platform today. The
whole-database export already asks for the admin's own password on every
export, beside a typed `EXPORT`, a daily cap and an audit row
(`src/routes/admin.js`, `POST /api/admin/db-export/ticket`). No other admin
action asks again.

Plan, after MFA lands (below), so one step-up covers both:

- Add `src/middleware/fresh-auth.js` exporting `requireFreshAuth(maxAgeMs)`.
  It passes when the session's last step-up (`sessions.stepped_up_at`, a new
  column) is within `maxAgeMs` (10 minutes), and otherwise answers
  `401 { code: 'step_up_required' }`.
- `POST /api/auth/step-up` takes the account password, or a TOTP code when
  the admin has MFA, and stamps `stepped_up_at` on the current session only.
- The console's fetch wrapper turns `step_up_required` into a prompt and a
  retry, the way `join_required` works for membership.
- Apply it to the actions that hand over the platform: the database export
  ticket (replacing its inline password check), setting a role, resetting
  another account's password, merging and deleting accounts, revealing or
  rotating platform secrets, and recording an access review.

## MFA plan: TOTP for admins

Not built yet; a separate, auth-critical change. The design:

1. **Enrolment.** A new account setting, "Two-step sign-in", shows a TOTP
   secret as a QR code and as text, and asks for one code to confirm. The
   secret is encrypted at rest with the envelope that protects stored API
   keys (`src/services/secrets.js`, AES-256-GCM keyed by
   `config.dataEncryptionKey`), in a new `credentials.user_totp` row: secret, `confirmed_at`, `last_used_step` (so
   a code cannot be replayed within its window).
2. **Recovery codes.** On confirmation, show ten single-use recovery codes
   once. Store only their bcrypt hashes, each with `used_at`. Using one is
   logged and mailed to the account.
3. **Enforcement at the console entry.** For an account with `is_admin`,
   every `/api/admin` and `/api/v4/admin` request requires the session to be
   MFA-verified (`sessions.mfa_verified_at`), checked in `adminMiddleware`
   itself so no route can forget it. An admin without MFA enrolled is sent
   to enrolment when they open the console, after a grace period an
   operator sets (a platform setting), and is refused after it. Members are
   not affected.
4. **Sign-in.** After the password (or Apple, Google, phone) step, an
   account with TOTP confirmed is asked for a code before the session is
   marked verified. Sessions created before enforcement keep working for
   member routes and must verify before admin routes.
5. **Connector and CLI.** CLI tokens already cannot reach admin routes. The
   connector's admin tools should require that the token was authorised in
   an MFA-verified session (a claim on the token), or be removed for
   admins without MFA.
6. **Recovery by an operator.** Removing a lost second factor is a full-admin
   action on another account, with step-up, recorded and mailed to the
   account. Never on yourself.
7. **Review.** The Access review gains a "Two-step sign-in" column, and the
   quarterly procedure gains: every admin has MFA confirmed.

Tests to write with it: replay of a used code, a code from the wrong window,
recovery code single use, an unenrolled admin refused after the grace
period, the connector and CLI paths, and a staging fixture admin that can
still run the declared checks.
