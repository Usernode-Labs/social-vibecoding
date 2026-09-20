# Managed OpenRouter keys: deployment and operations

Homeroom can create one company-funded OpenRouter child key for each account.
By default, any authenticated user may claim one; deployments can optionally
require a verified GitHub or X identity. Each child key carries the user's
platform weekly allowance as its OpenRouter limit (the same weekly cap the
Claude side enforces: an admin's per-user weekly cap, else the platform
default from Admin > Limits, else 17500 cents, $175/week), is stored
encrypted as that user's default session credential, and is
shown in plaintext to the user only in the successful claim response.

The OpenRouter organization management credential is a deploy secret. It is
never stored in Postgres, shown in an admin screen, sent to a worker, or
injected into a child app.

## One-time OpenRouter setup

1. In OpenRouter, create or select the funded organization that will pay for
   these users. A separate Homeroom workspace is recommended so aggregate
   company-key spend is easy to inspect and cap independently.
2. Create an OpenRouter **Management API key** in that organization. Use a
   management key, not a normal inference key. Management keys administer
   child keys and cannot make model-completion requests.
3. Copy the workspace id if new keys should be assigned to the dedicated
   workspace.

OpenRouter references:

- [Management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
- [Create a child API key](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key)
- [Update/disable a child API key](https://openrouter.ai/docs/api/api-reference/api-keys/update-an-api-key)
- [Delete a child API key](https://openrouter.ai/docs/api/api-reference/api-keys/delete-an-api-key)

## GitHub deployment configuration

In `Usernode-Labs/social-vibecoding`, open **Settings → Secrets and variables
→ Actions** and configure:

| Type | Name | Required | Purpose |
| --- | --- | --- | --- |
| Secret | `USERNODE_OPENROUTER_MANAGEMENT_API_KEY` | Yes for included keys | OpenRouter organization management key. |
| Variable | `OPENROUTER_MANAGED_DAILY_LIMIT_USD` | No longer used | The child key's limit is the user's platform weekly allowance, not a per-key amount. The deploy still writes this variable; it is inert. |
| Variable | `OPENROUTER_MANAGED_WORKSPACE_ID` | Recommended | Dedicated funded OpenRouter workspace id. |
| Variable | `OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY` | No longer used | Every account is created with its included key (#2568), so there is no eligibility gate. The deploy still writes this variable; it is inert. |
| Variable | `OPENROUTER_DEFAULT_CODEX_MODEL` | Optional | Preferred model slug; deploy default is `z-ai/glm-5.3-flash`. |

`CODEX_OPENROUTER_ENABLED` remains `true` by default and is now the only
switch: #2568 retired both eligibility gates. `CODEX_OPENROUTER_BETA_USER_IDS`
is no longer read, and neither is
`OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY`. Every account is created with
its included key, and an account that somehow has none gets one the next time
it opens the new-change screen.

After the values are saved, merge to `main` or manually run the normal deploy
workflow. The deploy writes the management key into `/opt/usernode/.env`,
which remains mode `0600`, and restarts the platform. No database seed or
manual per-user key creation is required.

If `z-ai/glm-5.3-flash` is not present in a particular key's live OpenRouter model
catalog, Homeroom selects the normal compatible fallback for that user. The
model picker is never restricted to GLM: every model exposed by the user's
key remains available.

## Verification after deployment

1. Create a new account.
2. Open **Settings → OpenRouter**. The included-key card should already read
   **Active**, with the key's last four and the platform's weekly allowance
   for that user. There is nothing to press: the key was created with the
   account. The raw company-funded credential is stored internally and is
   never sent to the user's browser.
3. Confirm OpenRouter is selected as the user's default and that the model
   picker contains the full key-visible catalog.
5. As an admin, open **Admin → Users**. The user's row should show the local
   owner, remote key hash, limit, verification state, and Block/Enable/Delete
   controls. Admin notifications also link to this screen.

## Operational behavior

- The database enforces one managed-key record per Homeroom user, including
  after deletion, so a user cannot claim another company key.
- The key's limit mirrors the user's platform weekly allowance (#2119): the
  per-user weekly cap in Admin → Users, else `user_weekly_limit_cents` in
  Admin → Limits, else 17500 cents ($175/week). The two backends do not share
  one pool: OpenRouter enforces the child key's limit, Claude spend is
  metered by the platform. They share the number.
- An account whose weekly allowance resolves to zero (an admin set the
  weekly cap to 0, or under the tiered identity policy an unverified account
  is granted nothing) cannot claim a company key; the claim card says so and
  the user may add a personal key instead.
- When the allowance changes under an issued key (a key issued before the
  weekly policy, an admin changing that user's weekly cap, or the platform
  default moving), the platform re-limits the key at OpenRouter, best-effort:
  immediately when an admin sets the user's weekly cap, and otherwise the
  next time the owner's OpenRouter credential status is read (opening
  Settings → OpenRouter or starting a build). A failed attempt is logged and
  retried after the next platform restart; until it succeeds the settings
  screen keeps showing the limit the key really has. A zero allowance is
  never written to an issued key: it keeps its last limit, and an admin
  blocks or deletes it from Admin → Users.
- Creation is never automatically retried after an ambiguous provider
  response. The record changes to **Needs review** and admins are notified;
  this avoids accidentally creating duplicate billable keys.
- The verification setting affects new claims only. Enabling it later does not
  revoke keys that were already issued.
- When identity verification is required, removing the user's last verified
  identity does not revoke the key. Admins receive a manual-review notification
  and decide whether to block or delete it. With the default-open policy, no
  identity-loss review notification is generated.
- Block/Enable calls OpenRouter first and then updates the local encrypted
  credential status. Delete removes the OpenRouter child key, clears the
  encrypted child secret locally, retains the one-key tombstone, and resets
  the user's default to Claude until they add a personal OpenRouter key.
- Rotate the management credential by replacing the GitHub Actions secret and
  redeploying. Existing child keys remain intact. Ensure the replacement key
  belongs to an organization/workspace that can administer them.
