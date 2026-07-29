# Verified React shell deployment

Production deploys use one immutable, exact-SHA React shell artifact. The
artifact tested by `Frontend checks` is the artifact copied into the
production image; neither the deploy workflow nor the production Docker build
rebuilds it.

## Artifact identity

The Vite finalizer has two deliberate revision modes:

- CI supplies `SV_REACT_SHELL_REVISION=<40-character source SHA>`. That exact
  SHA is embedded in the page and worker and becomes the React shell cache
  revision.
- A local build without an explicit revision derives
  `sha256-<artifact-digest>` from the emitted React files plus the required
  root runtimes. Identical inputs therefore produce the same revision; time,
  randomness, and build order are not revision inputs.

The finalizer also derives the worker's complete boot inventory from the one
completed Vite output. It includes the canonical `/react/` document, every
compiled boot JS/CSS/font/image required by that artifact, the portable
shortcut runtime, and the required root bridge/host/offline runtimes. No
placeholder may remain in an emitted HTML or JavaScript file.

## Verified production chain

1. `Frontend checks` builds `public/react` once with
   `SV_REACT_SHELL_REVISION` set to the exact source SHA.
2. The production-build service-worker suite exercises that prebuilt artifact;
   the remaining frontend, bridge, cache-boundary, Storybook, and bundle gates
   run before packaging.
3. The workflow writes a manifest containing `sourceSha` and
   `reactShellRevision`, records SHA-256 checksums for every file, and uploads
   `react-shell-<sha>`.
4. An automatic `Deploy` run resolves the current `refs/heads/main` before
   doing any mutation. If the successful checks belong to an older main SHA,
   the run exits as a stale success instead of rolling production backward.
5. For the current main SHA, `Deploy` checks out that exact commit, downloads
   the artifact from that exact successful workflow run, validates the
   manifest and every checksum, and installs it into `public/react`.
6. The production Docker build receives matching `GIT_SHA` and
   `SV_REACT_SHELL_REVISION`, validates the staged manifest and checksums again,
   and does not run a frontend build.

Manual deployment is a replay, not a bypass. The operator supplies a full
40-character lowercase main SHA. The workflow refuses to continue unless a
successful push-triggered `Frontend checks` run and matching retained artifact
exist for that exact SHA. Unlike automatic deployment, this explicit replay
may intentionally select an older verified main revision.

## Deliberate tradeoffs

- `Frontend checks` runs for every push to `main`, including backend-only
  changes. The production image always contains the React shell, so this keeps
  backend deploy behavior while preserving one check-to-deploy artifact chain.
- Verified artifacts are retained for 30 days. Replaying an older release
  requires re-running its checks to mint a fresh artifact rather than silently
  rebuilding unverified assets.
- Local Docker builds keep the previous convenience behavior and let Vite
  derive a deterministic artifact revision. Any build carrying a 40-character
  production `GIT_SHA` switches to strict verified-artifact mode.
- The artifact is handed off with GitHub Actions artifacts, avoiding image
  registry credentials. The VPS still builds the backend image locally, but
  the React files inside it are the exact checked files.
