---
name: react-shell-migration
description: Convert a legacy platform-shell region or public JavaScript owner into a React-owned component without changing rendered behavior. Use for step-3 shell migration work, stateful-island conversions, legacy module relocation, deep innerHTML host replacement, or migration sequencing. Do not use for ordinary React feature work outside the legacy shell.
---

# React Shell Migration

Apply every always-on shell, ownership, generated-artifact, and design-system rule in `AGENTS.md`. Before choosing or sizing a migration chunk, read `references/migration-state.md` for the current inventory, sequencing, plan deviations, and staging fixtures.

## Convert one ownership boundary at a time

1. Identify every module that writes inside the target subtree. Use `rg` over `public/js/**`, relocated feature modules, and tests; do not infer ownership from markup alone.
2. Convert the region only when its entire subtree can become React-owned. Keep controller-filled hosts and kit-mutated classes on their documented legacy seams.
3. Preserve the initial empty or hidden markup exactly. Load data in effects so server prerender and hydration agree.
4. Preserve ids, class strings, `hidden` semantics, `data-*` attributes, script order, and stylesheet order unless the requested product change explicitly requires a difference.
5. Route screen visibility through `frontend/src/lib/visibility-store.ts`; do not toggle `.hidden` from code outside React.

## Relocate legacy modules without rewriting them

When the converted markup is owned by a `public/js/**` module:

1. Move the module to `frontend/src/features/<area>/`.
2. Keep its remaining `window.X = X` publication, guarded by `if (typeof window !== 'undefined')` because the prerender pass evaluates the module graph in Node.
3. Replace its `DOMContentLoaded` bootstrap with an `init()` call from the island's `useIsomorphicLayoutEffect`.
4. Re-point every test that reads the old path in the same commit.
5. Record the script retirement in `RETIRED_SCRIPTS` and `SHELL_ASSETS`, and update the script-order count when applicable.

Treat this as a move before any separately requested rewrite.

## Validate the chunk

Run the structural inventory, selector-resolution, script-order, hydration/console, and feature-specific tests that cover the target. Never refresh the structural baseline merely to make a conversion pass; record each deliberate difference in the reviewed retirement/addition maps with its reason.

Then check the two things the suite cannot see, because both have already shipped:

1. **Count the controls the legacy renderer emitted.** Diff the classes the old template produced against what the island renders. The group chat's transcript lost its edit, save and add-reaction buttons on every message and every system row this way — the store modelled `bookmarked` and `canEdit`, and the component rendered neither. No test failed; nothing looked broken until someone opened a chat with messages in it.
2. **Run `node scripts/audit-react-ownership.mjs`** against a dev server, with the new host added to its `OWNED` list. It instruments `innerHTML`, `insertAdjacentHTML` and `appendChild` in a real browser and reports every legacy write landing inside a subtree the island reconciles. That is the one-owner rule made checkable: a violation does not throw and usually paints correctly, right up until the next store update repaints from a model that never heard about it.

Neither is optional for a conversion that ships. Both bugs above were found by doing this after the fact.
