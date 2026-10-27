# Recovery from GitHub's suspension of usernode-bot

GitHub suspended the account that owned every app repository and filed every
request (25 Oct 2026). What survived was copied to the rescue folder
(`~/homeroom-rescue-2026-10-26`, see its `MANIFEST.tsv`). These tools turn it
into app repositories on Homeroom's git host and rows in the `requests` table.
The design is `docs/plans/github-independence-build.md`.

They run on the machine that holds the rescue folder. Nothing here uses
`usernode-bot`: GitHub is only read anonymously, for the seven repositories it
still serves.

## Order

1. **Forgejo is up** (`Usernode-Labs/infra`), with the `apps` organisation and
   the platform's service account.
2. **dapp.json snapshots** (read-only, on a replica):
   ```sh
   psql ... -d app_usernode_2d5619 < scripts/github-recovery/manifests.sql > manifests.tsv
   ```
3. **Dry run** (builds everything under `<rescue>/recovery`, sends nothing):
   ```sh
   node scripts/github-recovery/recover-apps.js --rescue ~/homeroom-rescue-2026-10-26 --manifests manifests.tsv --all
   ```
   Read `recovery/report.tsv`: per app, `recovered` (rebuilt from its image),
   `mirrored` (cloned from GitHub) or `failed`, whether the tree is exactly
   GitHub main's, and what the image did not hold.
4. **Push** (needs the service account in `GIT_HOST_URL`, `GIT_HOST_USER`,
   `GIT_HOST_TOKEN`):
   ```sh
   node scripts/github-recovery/recover-apps.js --rescue ~/homeroom-rescue-2026-10-26 --manifests manifests.tsv --all --push
   ```
   Re-running is safe. It writes `recovery/git-host-moves.sql`.
5. **Requests** (user content: the file is 0600 and goes only to the primary):
   ```sh
   node scripts/github-recovery/import-requests.js --rescue ~/homeroom-rescue-2026-10-26
   ```
   Then run `recovery/import-requests.sql`, then `recovery/git-host-moves.sql`,
   on the primary. Both are one transaction each and safe to run again.
6. **The platform release.** Its boot migration (`services/github-move.js`)
   repoints every app with a recorded move. An app without one stays where it
   was.

## What a recovered repository is

One commit, "Recovered from image <digest>", whose message names GitHub's main
commit and anything the image did not hold. Its history is not kept: the
rescued mirrors hold commits and trees but no file contents. If GitHub's
archive of the account ever arrives, its history goes under
`refs/archive/github/*`, beside main, not into it.

Where a rescued mirror held GitHub's main, its tree decides which files belong,
so build output in the image is left out; elsewhere the repository's
`.gitignore` and the template's ignore list do.
