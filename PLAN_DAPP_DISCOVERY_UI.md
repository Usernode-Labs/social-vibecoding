# Implementation Plan: dApp Discoverability — Home IA, App Detail Page, Listing Metadata

Status: approved plan, ready to implement
Delivery: one branch, one PR (work packages = commits, see §10)
Date: July 10, 2026
Prerequisite reading: `UX_DAPP_DISCOVERY_AUDIT.md` (repo root) for the full UX rationale. This plan is self-contained; the audit is background only.

---

## 1. Context for the implementing agent

This repo is **social-vibecoding**: a Node/Express + Postgres platform where users discover, use, and collaboratively build small web apps ("dapps"). The frontend is vanilla JS (no framework) served from `public/`, with hash-based routing (`#app/<slug>/<tab>`). It runs both standalone in a browser and embedded inside the Usernode mobile app.

Key existing surfaces:

- **Home** (`public/js/home.js`, mounted in `public/index.html`): a grid of app cards with a search bar. Cards show icon, name, status dot, and an active-user count. Sections: "Your apps" (apps where the viewer is a collaborator OR has favorited) then everything else.
- **App view** (`public/js/app-view.js`): opens an app in an iframe (`App` tab) or shows the dev/governance board (`Dev` tab) with a "General chat" card, proposals, sessions, and merged PRs.
- **Routing** (`public/js/app.js`): `App.navigateToApp(slug, tab, ref, subTab)` drives `#app/<slug>/app`, `#app/<slug>/dev`, `#app/<slug>/full` (chromeless). `App.restoreFromHash` parses the hash on load/popstate.
- **API** (`src/routes/apps.js`): `GET /api/apps` (list with per-viewer flags), `GET /api/apps/:slug`, `POST /api/apps/:slug/favorite`, `PUT /api/favorites/order`, plus create/secrets/visibility/admin endpoints.
- **Votes/merges** (`src/routes/votes.js`): `GET /api/apps/:slug/merged` pages merged proposals out of `chat_sessions` (`status = 'merged'`, author in `user_id`).
- **Schema** (`src/db/schema.sql`): single evolving file; migrations are appended as idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. Tables of interest: `apps`, `app_favorites` (with `sort_order`), `app_collaborators`, `chat_sessions`, `users`.
- **Deploy manifest** (`src/services/app-manifest.js`): reads each app repo's `dapp.json` at deploy time and reconciles name, icon, secrets, visibility, tests into the DB.
- **Tests** (`tests/`): Node test files run via `npm test`. Several pin current home behavior and MUST be updated (see §8).

### The problem being solved

The home screen behaves like a launcher for people who already know the apps. It does not answer "what is this app for and why should I open it." Specifically:

- Search matches only name and slug (`Home.matchesQuery`, `public/js/home.js` ~line 102) — searching "wallet" or "game" dead-ends.
- Cards carry no purpose line or category; meaning hides behind a per-card hamburger menu.
- There is no app detail page: tapping a card launches the iframe immediately, with no pre-open confidence layer.
- There is no listing metadata at all: no category, no tagline, nowhere to edit them.

### The solution (agreed, do not re-litigate)

Four coordinated changes, delivered as **one PR** on a single branch, implemented bottom-up as four ordered work packages (§4–§7). Each work package should be its own commit (or small commit group) with tests green at each commit, so the PR remains reviewable and bisectable:

1. **Backend**: add `category` + `tagline` listing metadata to `apps`, expose through the list/detail APIs, add a collaborator-gated edit endpoint, extend search.
2. **Home screen**: search across name/slug/tagline/category; a "Create an app" section (permission-gated); a "Favorites" section with rich rows; per-category horizontally scrollable rails with a peeking next card.
3. **App detail page**: new route showing identity (icon, name, category, tagline, active count), actions (Open, Improve, favorite heart, More → Add to home screen / Fork), and a Builders list (people with merged PRs and their counts).
4. **Listing editor**: an "App listing" card on the Dev board opening a minimal edit screen for category + tagline.

---

## 2. Copy specification (final — use exactly these strings)

All copy below has been reviewed against the product content guidelines. Do not improvise alternatives. When you must write a string not listed here, follow §3.

### Home screen

| Surface | String |
|---|---|
| Header title | keep existing `dApps` (out of scope to rename; it is referenced by the mobile host) |
| Search placeholder | `Search apps…` (keep existing) |
| Search empty state | `No matches. Try a category like games or tools` |
| Create section button | `Create an app` |
| Favorites section header | `Favorites` |
| Favorites section subtitle (small, muted) | `Apps you saved or build` |
| Category rail headers | `Games`, `Tools` |
| Active-user count on cards/rows | `74 active` (number + the word `active`; singular/plural does not change the word) |

Spelling note: **Favorites** (US), matching `app_favorites`, `is_favorited` in schema and API. Never "Favourites" in UI or code.

### App detail page

| Surface | String |
|---|---|
| Primary action | `Open` |
| Secondary action (navigates to Dev tab) | `Improve` |
| Favorite toggle | heart icon only; `aria-label`: `Add to favorites` / `Remove from favorites` |
| Overflow trigger | `More` |
| Overflow item, Android | `Add to home screen` |
| Overflow item, iOS | `Add to Usernode widget` |
| Overflow item | `Fork` |
| Contributors section header | `Builders` |
| Per-builder count | `22 changes merged` (use `1 change merged` for singular) |
| Active count | `74 active` with Read-layer explanation below the fold or as row detail: `People who used this app in the last 10 days` |
| Missing tagline fallback | render nothing (no placeholder text) |

### Dev board + listing editor

| Surface | String |
|---|---|
| Dev board card title | `App listing` |
| Dev board card subtitle | `Edit the category and tagline people see when they find this app` |
| Edit screen title | `App listing` |
| Field label | `Category` |
| Category chips | `Game`, `Tool` |
| Field label | `Tagline` |
| Tagline helper text | `One line saying what people do with this app. Up to 80 characters` |
| Save button | `Save` |
| Saved confirmation | `Listing updated` |

### Category vocabulary

Exactly two categories at launch. Stored values (DB, API, dapp.json): `game`, `tool`. Display: chip singular `Game` / `Tool`; rail header plural `Games` / `Tools`. `category` may be NULL (unset); apps with NULL category appear in no rail but still appear in search and Favorites.

---

## 3. Content style rules (for any string not specified above)

The implementing agent does not have access to the full brand guidelines, so conform to this distilled ruleset:

1. **Sentence case everywhere** — titles, headings, section headers, buttons, chips. Never ALL CAPS, never Title Case. Brand names keep their casing (`Usernode`, `ZK Passport`).
2. **The user is the actor.** Lead with the user's verb: `Open`, `Save`, `Create an app`. Never "we did X for you" or passive "X was done."
3. **Truth before brevity.** Never let a shorter label build a wrong mental model. (This is why the count reads `74 active`, not `74 users` — the metric is a 10-day active count, not total users.)
4. **No period on solitary sentences** in labels, helpers, or dialog bodies. Periods only when 2+ sentences.
5. **No em dashes** in UI copy. No ellipses in buttons (allowed in in-progress states and the search placeholder). No `please`, `just`, `simply`, `easy`, `amazing`, `seamless`. No "Oops".
6. **Errors are specific and supportive**: what happened + what to do next. E.g. `Could not save the listing. Check your connection and try again`.
7. **Numerals** for numbers (`3`, not `three`). Oxford commas in lists of 3+. Contractions are fine.
8. **Vocabulary**: prefer run, own, build, save, open, prove; avoid ecosystem, leverage, seamless, decentralized-as-decoration.

---

## 4. Work package 1 — Backend: listing metadata + search fields

### Schema (`src/db/schema.sql`)

Append, following the existing idempotent pattern:

```sql
-- Discovery listing metadata (PLAN_DAPP_DISCOVERY_UI.md). Nullable:
-- apps without a listing still work everywhere; NULL category means
-- the app appears in no category rail.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS category VARCHAR(16);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS tagline  VARCHAR(80);
```

Enforce `category IN ('game','tool')` in the route (a CHECK constraint would complicate future category additions; validate server-side instead).

### API changes (`src/routes/apps.js`)

1. **`GET /api/apps`** — add `category` and `tagline` to the selected columns and returned rows. Respect all existing visibility gating unchanged (private apps must not leak metadata; they are already omitted entirely — keep it that way).
2. **`GET /api/apps/:slug`** — same two fields in the detail response.
3. **New `PATCH /api/apps/:slug/listing`** — body `{ category?: 'game'|'tool'|null, tagline?: string|null }`.
   - Auth: viewer must be a collaborator on the app (same gate style as other mutating routes in this file — find how e.g. the rename route resolves collaborator/admin permission via `appAccess` and reuse it).
   - Validate: category in the allowed set or null; tagline trimmed, ≤ 80 chars, no control characters; strings are stored as plain text (frontend already escapes on render — verify the card renderer escapes, since taglines are user input; follow the escaping pattern used for app names).
   - Respond with the updated `{ category, tagline }`.
4. **New `GET /api/apps/:slug/builders`** — returns `{ builders: [{ user_id, username, merged_count }] }` sorted by `merged_count` desc.
   - Source: `SELECT cs.user_id, u.username, COUNT(*)::int AS merged_count FROM chat_sessions cs JOIN users u ON u.id = cs.user_id WHERE cs.app_id = $1 AND cs.status = 'merged' GROUP BY cs.user_id, u.username ORDER BY merged_count DESC` (verify column names against `schema.sql`; `chat_sessions.status = 'merged'` is the same predicate `GET /api/apps/:slug/merged` in `src/routes/votes.js` uses).
   - Auth gate: same read-access rule as `GET /api/apps/:slug` (view access, not collab access — this list appears on the public-facing detail page). Check how `appAccess.getAppForUser` is called with `'view'` vs `'collab'` and use the view-level gate.

### dapp.json seeding (`src/services/app-manifest.js`)

Support an optional top-level `listing` block in app repos' `dapp.json`:

```json
{ "listing": { "category": "game", "tagline": "Guess the number before your friends do" } }
```

Reconcile rule: **seed only, never overwrite.** At deploy, write `listing.category` / `listing.tagline` into the DB **only when the DB column is currently NULL**. UI edits (PATCH above) always win over the manifest. Invalid values in the manifest are ignored with a warn log, never a deploy failure. Follow the module's existing read/validate/reconcile structure for fields like `icon`.

### Tests (new, in `tests/`)

- `PATCH /listing` rejects non-collaborators (403/404 per the file's convention), rejects bad category, rejects >80-char tagline, persists valid input.
- `GET /api/apps` includes `category`/`tagline` and still omits private apps for non-viewers entirely.
- `GET /:slug/builders` aggregates counts correctly and respects view gating.
- Manifest seeding: NULL columns get seeded; non-NULL columns are untouched by a redeploy.

---

## 5. Work package 2 — Home screen: search, create CTA, Favorites, category rails

All in `public/js/home.js` (+ minor `public/index.html`, `public/css/app.css`).

### Search (`Home.matchesQuery`, ~line 102)

Extend the case-insensitive substring match to also cover `app.tagline` and `app.category` (both may be undefined). Matching `"game"` must match apps with `category === 'game'`; also let the plural forms match (`"games"` → category `game`): simplest is to test the query against the category with a trailing-`s` tolerance, or match query against both `'game'`/`'games'` display strings. Keep the empty-query-matches-all behavior.

Empty state: when a non-empty query yields zero results, render `No matches. Try a category like games or tools` (the current empty-state element is `#empty-state` in `index.html`; there is also permission-dependent empty-state logic in `Home.applyEmptyStateForPermissions` — do not break the zero-apps case).

### Section layout (`Home.render`, `Home.partitionApps`)

New vertical order inside `#app-list`:

1. **(existing pinned/widget strip, if rendered — leave as is)**
2. **Create an app** — a single full-width button/section, rendered **only when `Home.canCreate()`** (exists, checks `App.user?.canCreateApps`). Reuse the existing create-modal wiring (`Home.wireCreateButtons` / `App.showCreateModal`).
3. **Favorites** — header `Favorites`, subtitle `Apps you saved or build`. Membership rule is UNCHANGED from today's "Your apps": `Home.isYours(app)` = `is_collaborator || is_favorited` (~line 79). Keep `partitionApps` ordering (favorite_order asc, NULLs after, stable). Keep drag-to-reorder working (the DnD code throughout the second half of home.js is scoped to "Your apps" cards — it must now target Favorites rows; if row layout makes DnD awkward, keep DnD only on the grid-card form factor and note it in the PR).
   - Row content (full-width rows, not tiles): icon, name (bold), category chip (`Game`/`Tool`, omit when NULL), `N active`, tagline (single line, truncated with ellipsis). Keep the existing status dot and the existing hamburger menu trigger.
4. **Category rails** — one horizontally scrollable rail per category that has ≥1 visible non-favorite app: header `Games` then `Tools`. Cards inside a rail use the same rich row content as Favorites rows but sized so **the next card visibly peeks in from the right edge** (mobile: card width ≈ 85% of the container; desktop: fixed ~340px cards). Use CSS `overflow-x: auto` + `scroll-snap-type: x mandatory` + `scroll-snap-align: start`; hide scrollbars per the app's existing CSS conventions if a pattern exists.
5. **Everything else** — apps with NULL category that are not favorites: keep a plain section (reuse the current grid) headered `All apps` so nothing becomes unreachable.

While a search query is active, replace the sectioned layout with a single flat result list (rich rows), which is simpler than filtering rails.

### Card tap behavior

- **Favorites rows**: tap opens the app directly (current behavior, `App.navigateToApp(slug)`) — one-tap launch for returning users is a deliberate rule.
- **Rail cards, search results, All apps**: tap navigates to the new **app detail page** (work package 3): `App.navigateToApp(slug, 'detail')`. Since the detail route lands in a later commit of the same PR, either implement work package 3's route stub first or keep direct-open in this commit and flip the tap target in the work-package-3 commit — the final PR state must route through the detail page.

### Do not break

- The wholesale `innerHTML` re-render on each keystroke must keep the search input outside `#app-list` (already true — preserve it).
- Escaping: taglines are user-controlled; render them through the same escaping helper used for app names.
- The per-card hamburger menu (`Home.openCardMenu`, `Home.menuItemsFor`) stays functional on every card/row form factor.
- Update UI strings that said "Your apps" in the menu (`Add to Your apps` / `Remove from Your apps` / `✓ In Your apps`, ~lines 1213–1221) to `Add to favorites` / `Remove from favorites` / `✓ In favorites`, and the informational tooltip `You build this app, so it is always in Your apps.` → `You build this app, so it is always in your favorites` (sentence case, no trailing period).

---

## 6. Work package 3 — App detail page

### Routing (`public/js/app.js`)

Add a `detail` tab segment: `#app/<slug>/detail`. Wire it through `App.restoreFromHash` (~line 1752 onward, where `#app/<slug>/full` and other segments are parsed) and `App.navigateToApp(slug, 'detail')`. Header title becomes the app name (the pattern for this exists in `navigateToApp` / `setHeaderTitle`). Back navigates home.

### View (new file `public/js/app-detail.js`, or a section in `app-view.js` if the codebase's conventions favor it — inspect and match)

Data: `GET /api/apps/:slug` (identity, category, tagline, active users, favorite state, running status, permissions) + `GET /api/apps/:slug/builders`.

Layout, top to bottom:

1. **Identity block**: icon (reuse the icon-precedence renderer from home: custom image → emoji → first letter), name, category chip, `N active`, tagline.
2. **Action row**:
   - `Open` (primary) → `App.navigateToApp(slug, 'app')`. Disabled with the app's plain-language status when the app is not running (reuse whatever status strings the card menu shows today rather than inventing new ones).
   - `Improve` → `App.navigateToApp(slug, 'dev')`. Show only when the viewer can access the Dev tab (mirror the existing gate that decides whether the Dev tab renders).
   - Heart toggle → `POST /api/apps/:slug/favorite` (exists). Filled when `is_favorited`; `aria-label` per §2. For collaborator apps that are "always yours," show the filled heart disabled with tooltip `You build this app, so it is always in your favorites`.
   - `More` overflow:
     - `Add to home screen` / `Add to Usernode widget`: reuse the existing bridge logic — `Home._probeShortcutSupport`, `Home._menuAddShortcut`, `Home._shortcutPayloadFor` (search home.js for these). Keep the existing gates exactly: only shown when the bridge reports support AND the app is running AND the app is in the viewer's favorites/membership. Label depends on what the bridge probe reports (Android `pinned-shortcut` → home screen; iOS `widget` → Usernode widget). Extract these helpers into a shared module if importing from `Home` is ugly.
     - `Fork`: opens the existing create/import flow prefilled with this app's repo if such a mechanism exists; **investigate `App.showCreateModal` and the import path first** — if no fork-prefill mechanism exists, render `Fork` only for users with create permission and open the import modal unprefilled, and note the limitation in the PR description. Do not build a new fork backend in this PR.
3. **Builders**: header `Builders`; one row per builder: avatar/initial, username, `N changes merged` (`1 change merged` singular). Empty state: omit the section entirely when there are no merged PRs.

### Tests

- Route renders for a public app; 404-style handling for slugs the viewer cannot see (must not leak existence — mirror how other routes/views handle gated slugs).
- Builders list renders counts; section absent with zero merges.
- Add a smoke entry to the root `dapp.json` `tests` array (the deploy-time UI tests): e.g. `{ "name": "App detail page renders", "path": "/?demo=1#app/<seeded-slug>/detail", "expectText": "Builders" }` — check how existing entries pick seeded slugs (`usernode-2d5619` appears in current entries) and follow that.

---

## 7. Work package 4 — Listing editor on the Dev board

### Dev board card (`public/js/app-view.js`, `renderDevView` ~line 479)

Add an `App listing` card in the card list, adjacent to the existing `General chat` card (~line 557–573), same visual pattern (title + chevron). Title `App listing`, subtitle `Edit the category and tagline people see when they find this app`. Render only for collaborators (the Dev board already knows collaborator state — reuse it).

### Edit screen

Route `#app/<slug>/dev/listing` (follow how `#app/<slug>/dev/settings` and `#app/<slug>/dev/chat` sub-tabs are parsed in `app.js` ~line 1996–2008 and handled in `renderDevView(subTab, ref)`).

Content, minimal:

- Title `App listing`
- `Category` label + two toggle chips `Game` / `Tool`, single-select, tap the selected chip again to clear (category is nullable)
- `Tagline` label + helper `One line saying what people do with this app. Up to 80 characters` + single-line text input, `maxlength="80"`, live character counter
- `Save` button → `PATCH /api/apps/:slug/listing`; on success show `Listing updated` via the app's existing toast/confirmation pattern (search for how other saves confirm; `confirm-modal.js` and existing toasts are candidates) and navigate back to the Dev board. On failure: `Could not save the listing. Check your connection and try again`

### Tests

- Non-collaborators do not see the card and cannot reach the route.
- Save round-trips: edit → PATCH → home cards show the new tagline/category.

---

## 8. Existing tests that pin old behavior — update, don't delete

These encode current product decisions this plan deliberately changes:

- `tests/home-your-apps-partition.test.js` — asserts "Your apps" = collaborator OR favorite (rule KEEPS, label changes to Favorites) and that search matches name/slug only (extend expectations to tagline/category).
- `tests/home-card-menu.test.js` — asserts no pills/labels on the card face and one hamburger trigger. Card faces now legitimately carry category chip + tagline + active count; update assertions to the new face contract while keeping the "one menu trigger, no inline star/lock/delete buttons" invariants.
- `tests/home-card-icon.test.js` — icon precedence (custom image → emoji → letter) must keep passing on the new row/rail renderers.
- `tests/home-app-activity-counts.test.js` — API count fields unchanged; keep passing.
- Root `dapp.json` `tests` array: the entry `"Home 'Your apps' section renders"` uses `expectSelector: ".app-card[data-yours='true']"` — keep a `data-yours`/equivalent attribute on Favorites rows or update the selector + name (`Home Favorites section renders`).

Invariants that MUST keep passing untouched: private/self-hosted app non-disclosure, favorite persistence + ordering, access gating on Dev/admin actions, shortcut-bridge safety (unsupported hosts hide the action; iframe relay refuses shortcut calls).

---

## 9. Explicitly out of scope

- Renaming the `dApps` header/tab or the `Dev` tab.
- Descriptions, screenshots, tags, creator profiles, trust scores, ranking changes (activity ordering stays).
- A fork backend (PR 3 only wires whatever import/create flow already exists).
- Any change to visibility rules, wallet flows, or the chromeless `#app/<slug>/full` mode.
- More than two categories.

## 10. Working agreements

- **One PR.** Create one feature branch off `main` and open a single PR containing all four work packages.
- **Implementation order within the branch: work package 1 → 2 → 3 → 4** (backend first — everything downstream consumes its fields and endpoints). Commit per work package, with `npm test` green and the app bootable at each commit (`npm start` or the compose dev setup — see `README.md` / `docker-compose.dev.yml`), so the PR is reviewable commit-by-commit and bisectable.
- **Test updates travel with the commit that changes the behavior** (e.g. the home-card test updates from §8 belong in the work-package-2 commit, not a final cleanup commit).
- The PR description should summarize the four work packages, link this plan file, and call out any deviations (e.g. the fork-prefill limitation in §6, or drag-and-drop scoping in §5).
- Vanilla JS, no new dependencies, match the existing code style in each file (the codebase comments explain *why*, heavily — match that).
- Escape all user-provided strings (taglines especially) with the existing escaping helpers.
- All UI copy from §2 verbatim; anything new per §3.
- Line references in this plan are approximate — always re-locate by symbol name (`matchesQuery`, `partitionApps`, `renderDevView`, `restoreFromHash`), not line number.
