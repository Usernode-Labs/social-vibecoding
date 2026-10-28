# Versions: originals and the versions made from them

Every copy of a project is a **version** of one **original**. The original's
merged changes are offered down to each version that follows it, as an
ordinary change that the version's own group votes on. A version can send its
own changes back up as a suggestion. The ready-made starters become real
Homeroom projects, the originals, approved by the platform's own approvers.
Remixes of anyone's project work the same way.

This file is the contract the pieces are built against. The sections name
which module owns what.

## Words on screen

| Say | Never say |
|---|---|
| your version, a version of Tier list, Make your own (version) | remix, copy (except "Copied:" in the dialog's list), template |
| the original, Made from Tier list | parent, upstream, fork |
| Gets its updates / Doesn't get its updates, Get Tier list's updates | follow, sync |
| Update from Tier list (an offered change), Skip this update | offer, merge |
| Suggest to Tier list, Suggested by Book club picks | suggest back, upstream PR |

Ids, routes and code keep `fork`, `forked_from` and `suggest-back`: tests and
dapp.json checks select on them.

## Data model (src/db/schema.sql, block "Versions")

- **`apps.upstream JSONB`**: a version's link to its original, NULL on
  everything else.
  `{ appId, slug, following, syncedSha, baseSha, share, legacy, since }`
  - `appId`: the original's id. This is authoritative; `slug` is the fallback for display.
  - `following`: whether updates are offered on their own. dapp.json
    `followOriginal` reconciles into it on deploy.
  - `syncedSha`: the original's commit this version last took. At creation
    it is the original's main. It advances when an update merges or is skipped.
  - `baseSha`: a commit **in the version's repository** whose tree is the
    original at `syncedSha` as it looks in this version. At first it is the
    version's first commit. After an update it is the synthetic commit the
    update was built from (`theirs_sha`). `refs/homeroom/upstream` in the
    version's repository keeps it reachable.
  - `share`: a private version lets the original show the titles of its
    merged changes ("Lately in its versions"). Public versions are always
    shown.
  - `legacy`: a copy made before versions existed. `syncedSha` and `baseSha`
    are found when first needed (`upstream-lineage.resolveLegacy`).
- **`apps.original_of VARCHAR(40) UNIQUE`**: the starter directory a
  platform-made original stands for (`app-templates/<dir>`, e.g.
  `tier-list`). Set only on those originals.
- **`apps.approvers_from_app_id`**: this app's approver roster is that
  app's. The ready-made originals point it at the platform app, so changing
  the platform's approvers changes theirs.
- **`chat_sessions.upstream_from_app_id`**: an update proposal on a version,
  from that original. Only one can be open per version.
- **`upstream_offers`**: one row per version, holding its update's state.
  - `state`:
    - `available`: the original moved on and nothing has been opened yet.
    - `open`: the proposal exists.
    - `needs_fit`: it conflicts with the version's own changes.
    - `skipped`
    - `merged`
    - `failed`
  - The other fields: `from_sha`, `theirs_sha`, `session_id`, `facts`, `brings`, `keeps`,
    `conflicts`, `error`.

## The off switch (services/versions-setting.js)

The `platform_settings` key is `versions`, on by default. Setting the env
`VERSIONS_ENABLED=false` turns it off absolutely. Read it with
`enabled(config, pool)`; it is set from the Admin › Limits card "Versions".

While it is off:
- no updates are planned or opened;
- ready-mades are made from app-templates as before;
- the UI shows no update cards.

Lineage is still recorded either way.

## Left out in both directions (services/upstream-lineage.js)

- **Paths:** `words.json`, `.claude/homeroom-canonical-repo`, `README.md`,
  `CLAUDE.md`, `LICENSE`.
- **dapp.json keys:** `name`, `visibility`, `admins`, `governance`,
  `description`, `followOriginal`. Any other changed key is carried over onto
  the target's dapp.json, the way suggest-back's `mergeManifest` does it.

## Words in config (owner: originals and creation)

A ready-made's placeholders (`{{ITEM_PLURAL}}` and the rest) are filled at
**run** time from `words.json` at the repo root:
- HTML through the generated server's starter page, as `{{APP_NAME}}`
  already is;
- the three api.js files read the same file.

So every version of one starter runs identical code, and an update is a
plain diff. `words.json` is the version's own and never travels.

## Originals (owner: originals and creation)

`originals.ensure(config, pool)` makes one project per starter directory
that has ready-made entries. It runs only when the git host is configured,
versions are on, and this is not a platform preview. Each original is:
- named for its starter (Tier list, Group poll, and so on);
- owned by the `usernode-platform` user;
- public;
- given `original_of = <dir>`, `template` = the first ready-made id of that
  directory, and `approvers_from_app_id` = the platform app;
- made through the normal create path.

The platform's approvers are joined to each original's community with
source `auto`.

**Making a ready-made:** `POST /api/apps` with a ready-made template, when
versions are on and that directory's original is running with a `main_sha`,
makes a version of the original. `app-creator` pushes this as the first
commit:
- the original's main tree;
- `words.json` for the chosen ready-made;
- the files `seedStarter` writes per project (names in README, CLAUDE.md
  and LICENSE, dapp.json name, description and governance).

It also writes:
- `upstream = { appId, slug, following: true, syncedSha: <original main>, baseSha: <that commit> }`;
- dapp.json `followOriginal: true`.

`template` stays set, and the prebuilt image key is computed from these files.

Otherwise the old path renders from app-templates. The version still links
to the original when one exists, with `legacy: true`.

`starter-images` renders a ready-made from its original's main tree when
the original exists, and from app-templates otherwise.

## Remixes and lineage (owner: lineage and suggestions)

- `POST /api/apps/:slug/fork` takes `follow` (default true) and writes
  `upstream` and dapp.json `followOriginal`. `copyFork` fills `syncedSha`
  (the original's commit it copied) and `baseSha` (the version's first
  commit).
- **Backfill:** every existing remix gets
  `upstream = { following: false, syncedSha: sourceSha, baseSha: forkBaseSha }`,
  or `legacy: true` without those shas. Every existing ready-made copy is
  linked to its directory's original once that exists, with
  `following: false, legacy: true`.
- **Following** is a line of dapp.json, so changing it is a vote:
  `POST /api/apps/:slug/follow-pr {follow}` opens that proposal, the way
  visibility does.
- **`share`** is a privacy preference that managers set directly:
  `POST /api/apps/:slug/upstream/share {share}`.

## Updates down (owner: services/upstream-offers.js)

**Planning** an update for a version (scratch repository):
1. Fetch the original at `syncedSha` and `from_sha` (its main), and the
   version's `main` and `baseSha`.
2. Build **theirs**: `baseSha`'s tree plus the original's own diff
   `syncedSha..from_sha`, with the left-out paths dropped. dapp.json goes
   through `mergeManifest`. The result is commit T, with parent B = `baseSha`.
3. Merge three ways with an explicit base. git 2.39 has no
   `--merge-base`, so use the synthetic commits B, O = (version main tree,
   -p B) and T (-p B), then run `merge-tree --write-tree O T`. The way
   `hosted-git.revertOnto` already does it is the pattern.
4. On a clean merge, the update's head is a commit of the merged tree with
   parent = the version's main. On a conflict, the state is `needs_fit`,
   with the conflicting paths.

**Facts**, from the original's diff (never the bot's words):
- `tablesAdded`;
- `destructive` (DROP TABLE or COLUMN, RENAME, ALTER … TYPE, TRUNCATE);
- `hostsAdded` (new outside hosts in code);
- `secretsAdded` (dapp.json secrets);
- `ai` (it starts using the LLM proxy);
- `storage`.

**Brings:** the original's change titles between the two commits.
**Keeps:** the version's own change titles since `baseSha`, up to three,
plus a count.

**Opening:** push the branch `homeroom/update-<short>` and
`refs/homeroom/offer` (T) to the version's repository, open its pull
request, and insert a `chat_sessions` row:
- `source = 'maintenance'` (platform-authored, holds no one's slot);
- user `usernode-platform`;
- `upstream_from_app_id`;
- promoted.

The version's members get a `change_ready` notification.

**The clock job `upstream-offers`** (every minute, newest build only):
1. **Mark:** following versions whose original's `main_sha` differs from
   their `syncedSha` get an `available` row.
2. **Open:** up to 10 a minute, for versions where someone was active in
   the last 10 days. Dormant versions wait for the hub's card.
3. **Advance:** an update whose proposal merged sets `syncedSha = from_sha`
   and `baseSha = theirs_sha`, and moves `refs/homeroom/upstream`.
4. **Refresh:** an open update whose original moved on is planned again
   and its branch moved (its votes clear).

**Routes:**
- `GET /api/apps/:slug/upstream` returns the hub card's and the menu's state:
  `{ original:{slug,name,emoji}, following, share, behind, offer:{state, sessionId, href, brings, facts, keeps, conflicts} }`.
  `behind` means the original moved on since `syncedSha`, which is what a
  version that doesn't get updates shows its one-time card for.
- `POST /api/apps/:slug/upstream/open` opens it now. Members only.
- `POST /api/apps/:slug/upstream/skip` is allowed for members, and only
  on `open` and `needs_fit`. It closes the proposal and advances the
  lineage without changing any code.
- `POST /api/apps/:slug/upstream/fit` is for a `needs_fit` update. It files a
  request on the version that describes the update and the conflicting
  files, and asks Homeroom bot to build it as that member. This uses the
  normal bot path, with its normal costs.

**The change page:** the proposal routes add
`upstream: { from:{slug,name,emoji}, since, brings, facts, keeps }` when
`upstream_from_app_id` is set.

## Suggestions up (owner: lineage and suggestions)

- **What can be sent:** suggest-back reads `upstream`. "Your changes" are
  the commits on the version's main since `baseSha` that are not update
  merges.
  - `GET` lists them as `{sha, title}`.
  - `POST` takes `picks: [sha]` (default all). Those commits are sent,
    without the left-out paths and keys, applied on the original at
    `syncedSha` (`git am --3way`).
  - The pull request goes on the original, as today, labelled "Suggested by
    <version>".
  - A suggestion to a platform-approved original stays in review: it is
    not put up for a vote, and the original's hub lists it.
- **The original's hub:** `GET /api/apps/:slug/versions` returns
  `{ count, following, suggestions:[{sessionId, href, title, from}], lately:{versions, changes, rows:[{title, from}]}, lastUpdate:{offered, took, skipped, deciding} }`.
  `lately` covers public versions and versions with `share`; a private
  suggestion's `from` is null ("a private version").
- **The community payload** (`GET /api/apps/:slug/community`) adds
  `made_from:{slug,name,following}` on a version and
  `versions:{count,following}` on an original.
- **Additive changes only:** an original with following versions cannot
  merge a change whose diff has destructive schema statements. The merge
  gate refuses it in words.

## UI (owner: frontend)

- **The rename:** Remix becomes Make your own / your version in every
  door (Discover, About, the ⋯, the home tile, the progress title, the
  allowance line) and in the dialog.
- **The Make your own dialog** gets the switch "Get <original>'s updates",
  on by default.
- **The hub hero** gets "Made from <original> · Gets its updates" on a
  version, or "N versions · M get its updates" on an original.
  Discover's page gets the versions line.
- **The hub:**
  - the update card when an update is `available`, or when `behind` on a
    version that doesn't get updates ("Tier list has changed since you made
    this · See the update · Not now");
  - "From its versions" on an original: Suggestions, Lately in its
    versions, Your last update.
- **The change page:** the From <original> card (brings, then In <version>:
  keeps and facts) and Skip this update. `needs_fit` shows "Ask Homeroom
  bot to fit it".
- **The ⋯ menu:** Suggest to <original> (with a pick list), and Updates
  from <original> (the following switch, which opens its proposal, plus
  share for a private version).
- **Admin › Limits:** the Versions card.

## API shapes (what the frontend builds against)

Every field below is present, or null where it says so.

- `GET /api/apps/:slug/upstream`, the version's side:
  ```
  { enabled, original: {slug, name, emoji, iconUrl} | null,
    following, share, canManage, private, behind,
    offer: null | { state, sessionId, href, fromSha,
                    brings: [{title}], facts, keeps: {count, titles: [..]},
                    conflicts: [path] } }
  ```
  - `facts` is `{ tablesAdded: [name], destructive: [text], hostsAdded: [host], secretsAdded: [key], ai, storage }`.
  - `href` is the change page's address (`changeHref`).
  - `private` is whether the version is private, which decides whether its menu offers `share`.
- `POST /api/apps/:slug/upstream/open` and `.../skip` return the same body as the GET.
  `.../fit` returns `{ ok, requestNumber, href }`.
- `POST /api/apps/:slug/upstream/share {share}` is for managers. It returns the GET body.
- `POST /api/apps/:slug/follow-pr {follow}` returns `{ ok, sessionId, prNumber, href }`. It answers 409 `already_open` when that proposal is already up, and its body then names it.
- `GET /api/apps/:slug` (the app payload) adds:
  - `upstream_link: {slug, name, following, linkable} | null`;
  - `versions: {count, following} | null`.

  The existing `forked_from` stays for the old readers.
- `GET /api/apps/:slug/community` adds `made_from: {slug, name, following} | null` and `versions: {count, following} | null`.
- `GET /api/apps/:slug/versions`, the original's hub:
  ```
  { count, following,
    suggestions: [{sessionId, href, title, from: {slug, name} | null}],
    lately: {versions, changes, rows: [{title, from: {slug, name}, at}]},
    lastUpdate: {offered, took, skipped, deciding} | null }
  ```
- `GET /api/apps/:slug/suggest-back` adds `changes: [{sha, title}]`, the version's own changes, newest last. `POST` accepts `picks: [sha]`; leaving it out sends all of them.
- `POST /api/apps/:slug/fork` accepts `follow` (boolean, default true).
- `GET /api/admin/versions` and `PUT /api/admin/versions {enabled: true|false|null}` return `{enabled, source, setting}`, as `/api/admin/preview-projects` does.
- **The change page:** the proposal read (`GET /api/apps/:slug/proposals/:id`, and the session details) adds
  `upstream: { from: {slug, name, emoji}, brings: [{title}], facts, keeps, state, conflicts } | null`.
  `app-view.js` `_changeThreadView` passes it through as `v.upstream`.
