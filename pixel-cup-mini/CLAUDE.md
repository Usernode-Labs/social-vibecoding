# Pixel Cup Mini

A standalone 2D pixel-art arcade futsal (5-a-side) game built with
**Phaser 3 + TypeScript**. The player picks one of five national teams
(Brazil, Japan, Argentina, France, Germany) and plays a single 90-second
5v5 match against an AI opponent. Originates from platform issue #345
("Add World Cup football game event celebration").

Platform conventions at https://social-vibecoding.usernodelabs.org/claude.md
are authoritative for platform matters (auth gate, deploy, secrets). This
file covers app-specific details.

## Architecture

- **Client-only game.** No database, no `/api` routes. `server.js` is a
  minimal Express static server with the canonical iframe-token auth gate.
- **Phaser 3** with arcade physics. Four scenes: `Boot` → `Start` →
  `TeamSelect` → `Match` → `Win` (`src/game/scenes/`).
- **Pure, testable logic** lives in plain CommonJS under
  `src/game/logic/` (`teams.js`, `matchState.js`, `mechanics.js`) so it is
  shared by both the bundled game and the headless Node test runner.
- **Procedural pixel-art**: all textures are generated at boot in
  `src/game/textures.ts` (no binary assets). Player/keeper bodies are
  white and tinted per team. Swap in real sprite sheets later by editing
  only `textures.ts` + `BootScene`.

## Build

- `npm run build` runs `build.mjs` (esbuild) → bundles `src/game/main.ts`
  + Phaser into `public/game.bundle.js`.
- **`public/game.bundle.js` is committed** so deploy paths that skip the
  build still serve a working game. Re-run `npm run build` after changing
  any `src/game/**` file and commit the updated bundle.
- The `Dockerfile` is multi-stage: it runs `npm ci` + `npm run build` in a
  builder stage, then ships production deps + the built `public/`.
- esbuild only transpiles (no type-check). Run `npx tsc --noEmit` for type
  checking if desired (`tsconfig.json` is lenient by design).

## Tests

`npm test` runs `node --test tests/*.test.js` covering MatchState
(scoring/clock/golden-goal), team data, pass/shoot math, and the
possession cooldown. Keep gameplay math in `src/game/logic/*.js` (no
Phaser imports) so it stays unit-testable.

## Controls

Touch: floating virtual joystick (left) + PASS / SHOOT buttons (right).
Keyboard fallback: WASD/arrows move, J/Space pass-or-switch, K/Shift
shoot-or-tackle. Designed for landscape; a rotate-device overlay covers
the match in portrait.
