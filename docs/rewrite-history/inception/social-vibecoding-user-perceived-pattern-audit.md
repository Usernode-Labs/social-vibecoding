# Social Vibecoding user-perceived pattern audit

**Version:** 0.1 — 2026-07-28
**Purpose:** durable input to a later design-system and migration decision. This is a description of what users currently encounter—not a framework recommendation, component catalogue, visual critique, or migration plan.

## Evidence and method

- **Code index:** production `main` at `808f7da68ddd563563bc7152fb6db3e0ee9933ae`; its hash routes and render modules identify the visible surfaces and behavioral seams.
- **Visual evidence:** 155 curated Android-emulator screenshots were reviewed.
  The 73 shell-facing captures used by this rewrite are preserved in
  [`../visual-baseline`](../visual-baseline/). Screenshot paths below retain
  their original guide-relative naming.
- **Rule:** a screenshot proves what was visible in the named state, not a hidden route or whether an attempted action succeeded. `primary` captures are reliable evidence; diagnostic/duplicate/excluded captures are called out as such.
- **Coverage:** platform shell, account/community, wallet/node, Flutter-native settings/benchmark/profile, platform-hosted emoji apps, and Dev/workspace flows. The captures are mobile Android evidence; they do not establish desktop behavior.

## Executive model

Users currently experience three layers, each with a different degree of sharedness:

```text
Platform shell
  catalogue, global actions, sheets, account/native bridge, feedback
      ↓ hosts
Application frame
  App/Dev switch, hosted-app loading and escape paths, developer workspace
      ↓ contains
App-owned products
  each child app's visual identity, content model and specialised interactions
```

The audit identifies **15 shared or potentially shared interaction patterns**, **5 domain compound patterns**, and a set of intentionally app-specific product experiences. The central boundary is important: child apps visibly share a host and interaction contracts, but do **not** currently share one visual language.

## Pattern classification

- **Shared platform pattern:** observed across unrelated platform surfaces and meaningful to most users.
- **Shared application/workspace pattern:** shared by hosted apps through the Social Vibecoding App/Dev experience.
- **Domain compound pattern:** a coherent, stateful workflow; should not be flattened into a generic visual atom.
- **App-owned pattern:** valid product UI, but evidence does not support treating it as a platform-wide standard.
- **Native companion pattern:** Flutter-rendered surface adjacent to the web platform; included because users perceive one product, even though its implementation differs.

---

## A. Shared platform patterns

| ID | Pattern | User-perceived contract | Observed states and evidence | Current code that carries it | Classification |
|---|---|---|---|---|---|
| P-01 | **Catalogue app tile browser** | Browse/search a two-column launcher of apps; each item conveys identity, availability, membership and a local action affordance. | Light/dark catalogues: `03-platform-shell/01--light.png`, `03-platform-shell/04--dark.png`; emoji inventory: `10-emoji-apps/00-catalog/01--emoji-inventory.png`. | `home.js` (`renderAppCard`, `renderAppPillsHtml`), `index.html#app-list`. | Shared platform |
| P-02 | **Icon action header** | A persistent compact utility strip offers cross-platform actions rather than a conventional page-title-first app bar. | Catalogue header: `03-platform-shell/01--light.png`; hosted-app frame: `09-app-entry-and-recipebot/05--app-tab-loaded.png`. | `index.html#platform-header`, `app.js`, `header-layout.js`, `notifications.js`, `work-drawer.js`. | Shared platform |
| P-03 | **Root mobile sheet** | Open temporary context without losing the catalogue/app underneath: dimmed backdrop, rounded top corners, grab handle, close control, vertically divided content. | Navigation: `03-platform-shell/02--light.png`, `03-platform-shell/03--dark.png`; Work: `03-platform-shell/07--sessions-and-proposals.png`; Notifications: `03-platform-shell/08--grouped-list.png`; wallet/node: `06-wallet-and-node/01--empty-missing-address.png`, `06-wallet-and-node/03--offline-stacked-over-wallet.png`. | `platform-ui.js`, `node-pill.js`, `wallet-sheet.js`, `work-drawer.js`, `notifications.js`. | Shared platform |
| P-04 | **Grouped navigation/settings row** | Scan full-width rows with leading icon/identity, label, optional subtitle, and trailing value, status or navigation affordance. | Web navigation sheet: `03-platform-shell/02--light.png`; native settings: `07-native-settings-and-diagnostics/01--guest-top.png`, `07-native-settings-and-diagnostics/04--lower-sections-native-guest.png`. | Static shell rows in `index.html`; native settings Flutter routes; dynamic settings in `settings.js`. | Shared interaction family; two visual languages currently |
| P-05 | **Contextual overflow action** | Each app tile can expose a local action menu separate from opening the app. | Tile overflow: `03-platform-shell/01--light.png`; action sheet: `09-app-entry-and-recipebot/01--app-action-sheet.png`. | `home.js`, `platform-ui.js`. | Shared platform |
| P-06 | **Creation/import modal workflow** | Begin one of two app-acquisition modes, complete fields/visibility choices, then commit or cancel. | Create: `09-app-entry-and-recipebot/02--create-new.png`; Import: `09-app-entry-and-recipebot/03--import-existing.png`. | Static modal roots in `index.html`, orchestration in `app.js`. | Shared platform workflow |
| P-07 | **Feedback form modal** | Submit feedback about either the platform or a selected app while retaining background context. | Empty platform target: `03-platform-shell/05--platform-target-empty.png`; focused keyboard state: `03-platform-shell/06--focused-with-keyboard.png`; app target: `09-app-entry-and-recipebot/08--representative-app-target.png`. | Static feedback markup and `app.js` handlers. | Shared platform workflow |
| P-08 | **Personal work list** | Review in-flight personal work as compact rows that carry app, task, relative age and lifecycle status. | `03-platform-shell/07--sessions-and-proposals.png`. | `work-drawer.js` (`renderPendingSection`, `renderSessionsSection`, `renderProposalsSection`). | Shared platform |
| P-09 | **Grouped notification feed** | Review updates grouped by app, with a count badge and a summarized latest event; expand only when needed. | `03-platform-shell/08--grouped-list.png`. | `notifications.js` (`renderGroup`, `renderRow`). | Shared platform |
| P-10 | **Semantic state chip / compact status** | Quickly identify availability, counts, role, lifecycle, approval, check, vote and deployment state without opening detail. | Catalogue dots/counts: `03-platform-shell/01--light.png`; notification counts: `03-platform-shell/08--grouped-list.png`; Dev cards: `20-development/01-recipebot-workspace/03--list.png`. | `merge-status.js`, `home.js`, `app-view.js`, `notifications.js`. | Shared interaction family |
| P-11 | **Async/no-data/degraded state** | Understand whether content is loading, empty, unavailable, offline, or needs a retry; continue to see the surrounding context. | App cold load: `10-emoji-apps/01-supply-line/01--blank-loading-initial.png` and equivalent captures across all emoji apps; admin loading: `04-admin-moderation/01--overview-loading.png`; empty community filter: `05-community-account/04--top-prs-this-week.png`; unavailable preview is diagnostic only: `20-development/04-gym-tracker-deep-dev/02--private-preview-unavailable.png`. | Every major render module; `offline.js`; `app-view.js`; `admin-console.js`. | Shared interaction family, currently varied |
| P-12 | **Account/node/wallet status surface** | Inspect native node availability, wallet balance/receipts and device/account state from the platform. | Wallet: `06-wallet-and-node/01--empty-missing-address.png`; stacked node-offline sheet: `06-wallet-and-node/03--offline-stacked-over-wallet.png`. | `native-chrome.js`, `node-pill.js`, `wallet-sheet.js`, Flutter bridge. | Shared platform/native bridge |
| P-13 | **Read-only administration shell** | Navigate operational sections under a persistent capability warning; inspect operational metrics, people, limits and sensitive actions. | Overview loading/loaded: `04-admin-moderation/01--overview-loading.png`, `04-admin-moderation/02--overview-loaded.png`; users: `/03--users-view-only.png`; export warning: `/07--database-export-warning.png`. | `admin-console.js`, `app.js#admin` route. | Shared platform domain |
| P-14 | **Community ranking/history view** | Switch between ranked PRs/users and personal activity, use tab/time filters, scan rank cards/rows and status. | Top PRs/users: `05-community-account/01--top-prs-all-time.png`, `/02--top-users.png`; history: `/03--my-history.png`. | `leaderboard.js`, `profile.js`, `challenges.js`. | Shared platform domain |
| P-15 | **Season/challenge progression view** | Browse a season/collection of challenges with category, completion and reward state. | `05-community-account/05--season-list.png`; native profile/leaderboard: `08-native-benchmark-and-profile/05--completed-challenges-empty.png`, `/06--leaderboard.png`. | `challenges.js`, native retained routes. | Shared platform/community domain |

## B. Shared hosted-application and Dev-workspace patterns

| ID | Pattern | User-perceived contract | Observed states and evidence | Current code that carries it | Classification |
|---|---|---|---|---|---|
| W-01 | **Hosted app frame and App/Dev mode switch** | Enter an app in its product view, then switch into the platform’s developer workspace without losing app identity. The platform keeps header controls and a bottom App/Dev switch. | RecipeBot App/Dev: `09-app-entry-and-recipebot/05--app-tab-loaded.png`, `/06--developer-tab.png`; Supply Line: `10-emoji-apps/01-supply-line/03--new-match-loaded-after-long-wait.png`, `/04--developer-list.png`. | `app-view.js` (`renderAppTab`, `renderDevView`), `app.js` hash routes. | Shared application/workspace |
| W-02 | **Developer workspace shell** | See a DEV context with a view selector, contextual add/action control, fixed App/Dev switch and one work-content region. | RecipeBot list/kanban/PM: `20-development/01-recipebot-workspace/02--pm-landing.png`, `/03--list.png`, `/04--kanban.png`; Appraise kanban: `20-development/06-appraise-deep-dev/02--kanban-issues.png`. | `app-view.js`. | Shared workspace |
| W-03 | **General-chat entry card** | Start/read the general conversation from a prominent navigable work card before the task list. | RecipeBot: `20-development/01-recipebot-workspace/02--pm-landing.png`; Supply Line: `20-development/03-emoji-app-dev-landings/01--supply-line.png`; Appraise: `20-development/06-appraise-deep-dev/02--kanban-issues.png`. | `app-view.js`, `group-chat.js`. | Shared workspace |
| W-04 | **Lifecycle work item** | Inspect and act on an issue, proposal, governance item or session through one information-dense card: type/status icon, title, metadata, semantic chips, chevron and action pills. | RecipeBot list/kanban: `20-development/01-recipebot-workspace/03--list.png`, `/04--kanban.png`; Gym in-progress: `20-development/04-gym-tracker-deep-dev/01--in-progress-issue.png`; Social ready session: `20-development/05-social-vibecoding-deep-dev/08--session-ready-actions.png`; Appraise failure: `20-development/06-appraise-deep-dev/12--merged-proposal-failed-preview-checks-redacted.png`. | `app-view.js` (`_renderIssueRow`, `_renderProposalCard`, `_renderGovCard`, session/merged renderers), `merge-status.js`. | Shared domain compound |
| W-05 | **Alternate work-set projections** | Change the same underlying work set between list, kanban and PM representations. On mobile, kanban is a counted status-tab view with one column visible—not a shrunken desktop board. | RecipeBot list/kanban: `20-development/01-recipebot-workspace/03--list.png`, `/04--kanban.png`; Appraise Issues/Done: `20-development/06-appraise-deep-dev/02--kanban-issues.png`, `/03--kanban-done.png`. | `app-view.js` (`_renderFeedInner`, `_renderKanbanInner`, `_renderPmInner`). | Shared domain compound |
| W-06 | **Work filtering strip** | Narrow work with a keyword plus priority/category/assignee controls and a personal-vote filter while retaining the current view. | `20-development/01-recipebot-workspace/03--list.png`, `/04--kanban.png`; `20-development/06-appraise-deep-dev/02--kanban-issues.png`. | `app-view.js` (`_renderKanbanFilterBar`). | Shared workspace |
| W-07 | **Threaded work detail + persistent reply composer** | Open a work item, inspect its lifecycle/context/evidence, then reply from a fixed bottom composer with attachments and send action. | Active issue: `20-development/06-appraise-deep-dev/05--active-issue.png`; vote detail: `20-development/05-social-vibecoding-deep-dev/01--proposal-vote.png`; general chat: `20-development/06-appraise-deep-dev/15--general-chat.png`. | `app-view.js` topic views; `group-chat.js`; `dev-chat.js`. | Shared domain compound |
| W-08 | **Explicit governance/lifecycle state** | See actionable vote/approval/check/merge/closed/blocked/failed state, including why an item cannot progress. | Vote state: `20-development/05-social-vibecoding-deep-dev/01--proposal-vote.png`; completed/ready: `/08--session-ready-actions.png`; failed preview checks: `20-development/06-appraise-deep-dev/12--merged-proposal-failed-preview-checks-redacted.png`. | `merge-status.js`, `app-view.js`, `kudos.js`, `proposal-discuss.js`. | Shared workspace/domain |
| W-09 | **Inline work-property chooser** | Change/view priority, category or assignee from a compact anchored chooser, without leaving the card/detail context. | Active issue: `20-development/06-appraise-deep-dev/05--active-issue.png`; choosers: `/06--priority-chooser.png`, `/07--category-chooser.png`, `/08--assignee-chooser.png`. | `app-view.js` attribute popover code. | Shared workspace |
| W-10 | **Consequential work/configuration dialog** | Complete a focused operation in a modal: membership/visibility, import, secrets, fork, close, confirmation; preserve context behind dimming. | Management: `20-development/02-app-management/01--members-and-visibility.png`, `/03--import-pull-request-loading.png`, `/06--app-secrets.png`, `/08--fork-app-confirmation.png`; close proposal: `20-development/01-recipebot-workspace/11--close-proposal-confirmation.png`. | Static modal roots, `app-view.js`, `app-secrets.js`, `confirm-modal.js`, `platform-ui.js`. | Shared workspace |
| W-11 | **Long-running agent session workspace** | Follow an agent session with a state banner, model/cost context, rich scroll content, suggested prompt chips, attachments, persistent composer and outcome actions. | New session: `20-development/01-recipebot-workspace/07--new-change-session-composer.png`; completed/ready states: `20-development/05-social-vibecoding-deep-dev/06--completed-session.png`, `/08--session-ready-actions.png`. | `dev-chat.js`, `app-view.js`, `cc-progress-summary.js`, `streaming-markdown.js`. | Shared domain compound |
| W-12 | **Private preview / visual-comparison evidence** | Inspect a staged change in a browser-like private-preview mode and compare labelled before/after evidence before testing, promoting or opening an external resource. | Private preview: `20-development/05-social-vibecoding-deep-dev/03--private-preview.png`; comparison: `/04--visual-compare.png`, `/05--visual-compare-before-after.png`. | `app-view.js`, `screenshot-select.js`, `build-log.js`. | Shared workspace/domain |
| W-13 | **Capability/status banner** | Know when an app or workspace is locked, awaiting approval, offline, or otherwise constrained before attempting work. | Locked Social landing: `20-development/03-emoji-app-dev-landings/06--social-vibecoding.png`; preview unavailable is diagnostic evidence only: `20-development/04-gym-tracker-deep-dev/02--private-preview-unavailable.png`. | `app-view.js`, `offline.js`, native bridge. | Shared workspace |

## C. Native companion patterns

These are implementation-distinct Flutter surfaces, but users reach them from the shared product and therefore perceive them as part of the same experience.

| ID | Pattern | User-perceived contract | Evidence | Classification |
|---|---|---|---|---|
| N-01 | **Native grouped settings page** | Android-native back/title bar, grouped white cards, section labels, icons, subtitles, chevrons and switches; includes action-needed callouts. | `07-native-settings-and-diagnostics/01--guest-top.png`, `/04--lower-sections-native-guest.png`, `/05--debug-enabled.png`. | Native companion |
| N-02 | **Native option picker sheet** | Choose an appearance/season through a bottom-sheet list with selected indicator and explanatory copy where needed. | Appearance: `07-native-settings-and-diagnostics/03--appearance-picker.png`; season: `08-native-benchmark-and-profile/07--season-picker.png`. | Native companion |
| N-03 | **Diagnostic/utility empty page** | Inspect a tool-specific page with dense search/filter or a sparse legal message and an explicit no-data state. | Logs: `07-native-settings-and-diagnostics/06--http-logs-empty.png`; Terms: `/07--no-terms.png`. | Native companion |
| N-04 | **Benchmark lifecycle and report** | Start a quick/full measurement, follow determinate progress/telemetry, then inspect a detailed result report. | Ready: `08-native-benchmark-and-profile/01--ready.png`; running: `/02--running-50-percent.png`; results: `/04--complete-results.png`. | Native domain compound |
| N-05 | **Native profile / season leaderboard** | Inspect personal identity/points, choose season, switch profile tabs and scan ranked rows. | `08-native-benchmark-and-profile/05--completed-challenges-empty.png`, `/06--leaderboard.png`. | Native companion |

## D. App-owned product patterns — deliberately not unified

The emoji applications share the hosted frame but visibly keep diverse product identities. The following are **not** candidates for a single platform visual pattern based on current evidence:

| App / pattern | What users encounter | Evidence |
|---|---|---|
| Supply Line | New-match setup, resume card, tutorial/live tactical game canvas and mobile controls. | `10-emoji-apps/01-supply-line/03--new-match-loaded-after-long-wait.png`, `/05--resume-match-persisted.png`, `/06--tutorial-live-match.png` |
| Game Corner | Editorial daily-game home, profile/statistics and app settings. | `10-emoji-apps/02-game-corner/02--daily-game-home.png`, `/03--settings-sheet.png`, `/04--signed-in-profile.png` |
| RecipeBot | Culinary search/tags/recipe cards, keyboard-help overlay and account/AI-usage menu. | `10-emoji-apps/03-recipebot/02--recipe-home.png`, `/03--keyboard-shortcuts-sheet.png`, `/04--account-ai-usage-menu.png` |
| Community Tier Lists | Feed/ranking surface, selected-item placement and tap-friendly alternative to drag. | `10-emoji-apps/04-community-tier-lists/02--list-feed-home.png`, `/03--programming-languages-ranking.png`, `/04--first-item-placed.png` |
| Gym Tracker | Empty workout start and workout setup. | `10-emoji-apps/05-gym-tracker/02--empty-workout-home.png` |
| Todo List | Empty list start, compact create prompt and markdown import dialog. | `10-emoji-apps/06-todo-list/02--empty-lists-home.png`, `/03--create-list-prompt.png`, `/04--import-markdown-dialog.png` |
| MyPage | Empty page start, public-directory tabs/filters and page-type chooser. | `10-emoji-apps/08-mypage/02--empty-my-pages.png`, `/03--directory.png`, `/04--new-page-chooser.png` |

What **is** shared across these apps is narrower: hosted App/Dev frame, platform action header, app loading/degraded boundary, direct escape path, and the expectation that empty/start states provide a clear next action. Styling, content hierarchy and specialised interactions are app-owned.

## Cross-cutting state inventory

These states are observed across more than one family and must remain explicit in future analysis:

| State | Evidence of occurrence |
|---|---|
| Loading / initialisation | Admin placeholders; blank hosted-app canvas; native benchmark progress. |
| Empty / no data | Community filtered ranking, wallet activity, Todo/Gym/MyPage starts, kanban column. |
| Offline / unavailable | Node offline; locked workspace; diagnostic unavailable preview. |
| Read-only / capability-gated | Admin warning, locked Social Dev landing, native guest settings. |
| Consequential confirmation | Create/import, fork, close proposal, sensitive secrets/export. |
| Lifecycle success / pending / failed | Work cards, votes/checks, session completion, preview check failures. |
| Mobile keyboard / input focus | Feedback keyboard capture; persistent thread/session composers. |
| Theme | Light/dark catalogue and navigation-sheet evidence. |

## What the code is codifying

The code is not only raw markup. It currently carries several real behavioral contracts:

1. **Hash-addressable page state** — catalogue, community, account, admin, app, Dev, topic/session and chromeless hosted-app routes in `public/js/app.js`.
2. **One platform shell with mode switches** — static roots in `public/index.html` plus mount/unmount work in `home.js`, `app-view.js`, `leaderboard.js`, `challenges.js`, `profile.js`, and `admin-console.js`.
3. **A native bridge boundary** — node, wallet, profile/settings and device capability states are surfaced by `native-chrome.js`, `node-pill.js` and `wallet-sheet.js`.
4. **A work-lifecycle vocabulary** — issue/proposal/governance/session renderers in `app-view.js` and state derivation in `merge-status.js`.
5. **Several partial shared presentation seams** — `PlatformUI` for sheets/dialogs/toasts/transitions, `renderAppCard`, notification/work renderers, markdown pipeline, and the native interaction kit.

It also codifies accidental duplication: visual controls and status/async presentation are repeated as template strings and utility classes across large feature modules. That fact is a reason to investigate a system; it is not proof that every duplication should become a component.

## Evidence gaps and safe next use

1. **Desktop is not visually evidenced.** Do not infer desktop navigation, table, kanban or overlay behavior from Android screenshots.
2. **Not every child app is captured as a full workflow.** The inventory is representative, not a universal app taxonomy.
3. **Diagnostic captures are not happy-path acceptance examples.** In particular, unavailable preview and some loading/no-op screenshots establish observed failure/degraded states only.
4. **Accessibility is not proved visually.** Focus order, keyboard semantics, screen-reader output, zoom and contrast require separate inspection/testing.
5. **The next artifact should be a pattern decision register.** For every pattern above, record whether it is truly shared, a compound product pattern, app-local, native-only, legacy, or intentionally divergent—after human visual review. Only then evaluate a future component implementation.
