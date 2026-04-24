# Usernode Social Vibecoding

> where the users are the developers are the users are the developers...

A social platform where every signed-in user can propose changes to
any app — and to the platform itself — through a chat-driven
Mayor / Claude Code pipeline that produces real PRs.

## Design docs

- **[SPEC.md](./SPEC.md)** — overall architecture, auth model, app
  layout, URL conventions.
- **[EXTRACT-PLAN.md](./EXTRACT-PLAN.md)** — phased plan for moving
  this repo from a monorepo subdirectory to a standalone deploy.
- **[SELF-HOSTING.md](./SELF-HOSTING.md)** — design for registering
  Usernode as an app inside itself, including the staging /
  Docker-isolation model.
- **[src/prompts/app-conventions.md](./src/prompts/app-conventions.md)**
  — authoritative platform conventions injected into Mayor and
  Claude Code prompts. Also served live at
  `https://usernode.evanshapiro.dev/claude.md`.

## Running locally

This repo is currently consumed as a git submodule by the
`evanshapi.ro` monorepo, which provides the dev compose stack and
deploy pipeline. Local-dev instructions live in `evanshapi.ro`'s
`docker-compose.dev.yml`.

`EXTRACT-PLAN.md` Phase 3 covers building a self-contained
`docker-compose.yml` here so this repo can run standalone.

## Status

Active development. See `TODO` for the current short-list.
