# Group e: Settings (s56 to s73)

Checkout read: `/Users/salah/Dev/lingash/sv-skins`, branch `redesign/skins-2026-11-11`. Nothing was run in a
browser: every "today under a look" line is read from source and `public/css/app.css`.

## 0. How Settings is drawn under a look today (applies to all 18 steps)

There is **no kit page** for Settings. All 18 steps are the standard screen, dressed by CSS.

**Files (shared by every step)**

- Chassis: `frontend/src/features/settings/index.tsx` `SettingsScreen` (l.92): `#settings-root` > `.lg:flex` >
  `#settings-sidebar-col` (`SettingsNavDesktop`, `#settings-footer` with `SettingsAccountRows` and `#settings-logout`)
  and `#settings-content-col` (`SettingsMobileMenu`, `#settings-section-content` with `SettingsPageTitle` + the lazy
  `Sections`).
- Nav: `frontend/src/features/settings/settings-nav.tsx`: `SettingsNavDesktop` (l.748), `SettingsMobileMenu`
  (l.825), `SettingsPageTitle` (l.943), `PURPOSES` / `pagePurpose` (l.966 to 978), `FilterField` (l.360),
  `RecentSearches` (l.460), `RowControls` (l.622, pin and arrows), `GroupHeading` (l.694, fold), `NAV_ICONS` (l.171).
  Fed by `settings-nav-store.js`, written by `Settings._renderNav()` (`settings.js` l.1642).
- Module: `frontend/src/features/settings/settings.js`: `SECTIONS` (l.324), `PAGES` (l.436), `SUBTITLES`, `TAGS`,
  `ICONS`, `DESKTOP_MEDIA` 1024px (l.292), `_syncChrome` (l.1862, sets the header title and back), `_syncFooter`
  (l.1768). Binds every control in the static panes by id, once.
- Panes: `frontend/src/features/settings/sections/index.tsx` `SettingsSections` (order = `SECTIONS` order), one file
  per part under `sections/`.
- Primitives the panes draw with: `frontend/@/components/ui/grouped-list.tsx` (`ui-glist`, `ui-lrow`, `-tx`, `-t`,
  `-s`, `-go`), `field.tsx` `SectionHeading` (`ui-sechead`, `ui-secblurb`), `switch.tsx` `Switch` / `SwitchRow`.
- Look CSS, hand-written: `public/css/app.css` l.27222 to 27256 ("SETTINGS (features/settings/index.tsx)").
- Look CSS, generated: `frontend/looks/looks.json` `wear.roots` l.332 to 352: `card` → `.ui-glist:where(#settings-section-content *)`,
  `title` → `.settings-page-title`, `row` → `.ui-lrow:where(#settings-section-content *)` with parts tx/t/s/go.
- Bar: `frontend/src/features/frame/frame-app.tsx` `FrameChrome` l.121 to 147 reads `#header-title-name`, or
  `framePageStore` (`frame-page-store.ts`, `useFramePage`) when a page publishes a crumb. Settings publishes none.
- Catalog: `frontend/locales/en/settings.json` (`nav.*`, `screen.*`, `frame.purpose.*`, one area per pane).

**Today under a look, desktop (1024px up)**

1. Bar: one crumb, "Settings" (`_syncChrome` sets the page's name only on a phone at level 2).
2. No page head. `#settings-root` 1136px, gap 32px.
3. **Section first**, 720px (`#settings-content-col { order: 1 }`): `.settings-page-title` = the page's name in the
   kit's **title** size (28 to 44px by look), then `.settings-page-purpose` = one sentence from
   `settings:frame.purpose.<page>`, then every part of the page. Sheet fill and shadow removed.
4. **List second**, 320px (`#settings-sidebar-col { order: 2 }`): the standard sidebar untouched: filter field on a
   sticky `--dc-sheet-solid` strip, recent searches, group headings with fold, `settings-nav-item` text buttons with
   glyphs, pin controls on hover, then account rows and Sign out. It keeps `dc-lift dc-lift-session settings-side-sheet`
   (no look rule names it). No kit card, no kit row.
5. Inside a part: only what is built from `GroupedList` / `ListRow` / `SectionHeading` wears the kit (card, row,
   small-caps label, muted blurb). Everything hand-classed keeps the standard look: see the wear table below.

**Today under a look, phone (under 1024px)**: the product's two levels. Level 1 = `#settings-mobile-menu-host`
(`GroupedList` rows, but outside `#settings-section-content`, so they do **not** wear the kit card/row), footer under
it. Level 2 = the section; bar says the page's name with the back arrow; `.settings-page-title` hidden,
`.settings-page-purpose` shown.

**V2 (all steps)**

- Bar crumb: `You › Settings` (s56), `Settings › <page>` (s57 to s73). On a phone only the last crumb shows.
- Desktop only: kit head above both columns, title "Settings", sentence "Your account, your preferences and your tools."
- `cols flip`: **list first, 360px; open section second, max 680px**.
- List: kit search field "Find a setting", then one kit `Sec` per group (small-caps label) holding one card of rows:
  glyph, name, trailing meta ("2 linked", "24 linked", "2 connected"), chevron, the open page lit.
- Section: page name at 22px/700 (`sub22`), **no sentence of the look's own**, then parts as `sec plain`: small-caps
  label, 13px note, card(s) of rows. Radio rows for exclusive choices, switch rows (name, sentence, switch at the end),
  fields in a card, links, quiet/bad small buttons.
- Phone: list is the page (s56); a section is its own page under the bar's back arrow, page name at 22px kept, no
  "Settings" head.

## 1. Gap shared by every step (do once)

| # | Change | Where | Reuse |
|---|---|---|---|
| G1 | Flip the columns: list `order: 1; flex: 0 0 360px`, section `order: 2; flex: 0 1 680px` | app.css l.27235 to 27236 | CSS only |
| G2 | Add the page head above the columns (desktop, look only): title + sentence | `index.tsx` before the `.lg:flex` div (l.143): a static, always-rendered element, `display:none` in the standard look and under 1024px. No skin hook in the chassis (prerender; `tests/settings-frame.test.js` forbids `isFrameSkin` there). Title = `settings:screen.title`; sentence = **new** id, e.g. `settings:frame.head.purpose` | Wear: add its class to `looks.json` `wear.roots.title.to`; sentence styled like `.fr-purpose` |
| G3 | Page name becomes 22px/700, shown on a phone too | Take `.settings-page-title` out of `wear.roots.title.to` (looks.json l.336); hand rule 22px/700/-.02em; drop the `min-width:1024px` wrapper of `display:block` (app.css l.27243) | `SettingsPageTitle` already draws it for every page under a look |
| G4 | Remove the look's own sentence | `SettingsPageTitle` l.948 to 964 (drop `frame`, `purpose`), `PURPOSES`, `pagePurpose`, the 19 `settings:frame.purpose.*` entries, `.settings-page-purpose` rules (app.css l.27245, 27247 and the standard `display:none`) | The sentence v2 shows on one-part pages is the part's own blurb, already in the DOM |
| G5 | One-part pages whose part heading repeats the page name: hide that heading under a look | Parts `linked-accounts`, `phones`, `agent-files`, `language`, `tour`, `guide`, `about`, `experimental`: `[data-settings-section="…"] > div > .ui-sechead:first-child { display:none }` under a look | CSS only; the blurb stays as v2's note |
| G6 | Bar crumbs | Publish to `framePageStore` (`features/frame/frame-page-store.ts`): `[You, Settings]` at phone level 1, `[Settings, <page label>]` otherwise; `onBack` = what the back button does now (`Settings._upHref()` / `#profile`). Simplest seat: `SettingsPageTitle` (already knows the active item) via `useFramePage`, or `Settings._syncChrome` calling `framePageStore.set` | Labels: `core:tabs.me`, `settings:screen.title`, the nav item's `label` |
| G7 | List as kit cards of rows (desktop sidebar and phone menu) | Desktop: `SettingsNavDesktop` draws bare buttons (`item.className` comes from `settings.js`); either wear CSS on `#settings-nav-desktop` (group div → card, `.settings-nav-item` → row, `[aria-current="page"]` → `.fr-on`, heading → cap) or add `ui-glist`/`ui-lrow`-style stable names. Phone: extend `wear.roots.card/row` scope from `#settings-section-content *` to also `#settings-mobile-menu-host *`. Sidebar sheet: put away `#settings-sidebar-col.settings-side-sheet` fill/shadow and the sticky strip's `--dc-sheet-solid` ground | Status meta: `RowTrailing` (l.544) already draws `item.status` ("2 linked"); style as `.fr-meta` |
| G8 | Filter field as the kit's search | `FilterField` l.360: wear CSS on its input (kit `.search .inp`), keep its node and listeners | Placeholder is `settings:nav.filter.field` = "Find a setting" already |
| G9 | Parts not built from `GroupedList`/`ListRow` do not wear the kit | See wear table | |
| G10 | Dividers between parts: `mt-6 pt-6 border-t` wrappers (theme, accessibility, privacy, alerts, experimental) | Under a look: no hairline, kit stack gap (24px) | CSS only |

**Constraint that shapes G9**: most panes are STATIC (`sections/index.tsx` header comment): `settings.js` binds their
controls by id once, so a pane must not swap its nodes when the look changes. Only `ProfileSection`, `ThemeSection`,
`AccessibilitySection`, `PrivacySection` (+ `ContactPreferencesSection`, `UsageAnalyticsSection`),
`LinkedPhonesSection`, `BuildingTime`, `SocialIdentity`, `DeleteAccount`, `BlockedAppsList`, and the `*-list.tsx`
islands are React-owned and may branch on `isFrameSkin(useLiveSkin())`. For static panes the route is: add stable
class names in the shared markup (both looks) and dress them from `looks.json` wear, exactly as `ui-glist` was done.

**Wear table (what keeps the standard look inside a part today)**

| Pattern | Used by | V2 form | Suggested fix |
|---|---|---|---|
| `rounded-2xl bg-white dark:bg-zinc-900` hand card | `profile.tsx` l.80, `usage.tsx` l.47/70, `api-key.tsx` l.28/40, `openrouter.tsx` l.60 | kit card | name them (`ui-glist` or a new `ui-card`) and add to `wear.roots.card.to` |
| `ROW_CLASS = 'rounded-lg bg-white … px-3 py-2 text-xs'` one mini card per item | `agent-files-list.tsx` l.47, `app-permissions-list.tsx` l.36, `grants-list.tsx` l.56, `cli-tokens-list.tsx` l.39, `local-agents-list.tsx` l.33, `notification-prefs-list.tsx` l.46 | rows in one card, name 15/650, line 13px | React islands: wrap list in one card and draw rows as `ui-lrow` (or branch on the look) |
| `SwitchRow` (`switch.tsx` l.44): label = switch first, then name; description is a sibling `<p>` below | `alerts.tsx`, `dev-console.tsx`, `admin-preview.tsx`, `experimental.tsx` (x3) | one card, row = name + sentence, switch at the end | static panes: wrap `SwitchRow` + its `<p>` in a named row/card wrapper in the shared markup; CSS grid puts the switch at the end. Do not move the `<input>` |
| label + `un-switch` at the end, `space-y-3` no card | `alerts.tsx` 10 push categories (`data-mobile-push-category`) | 10 rows in one card | name the `div.space-y-3` as card and each label as row |
| `PrivacySwitch` (`privacy-text.tsx` l.13): switch first | `privacy.tsx`, `contact-preferences.tsx` | switch row, On/Off word after the name | React-owned: can branch; the On/Off word is already drawn (l.29) |
| Segmented `theme-seg` radiogroup | `theme.tsx` `ThemeControl`, `accessibility.tsx` `TextSizeControl` | three radio rows in a card | React-owned: branch on the look, keep `role="radio"`, `data-theme-mode` / `data-text-size-option`, ids |
| `ROW_FIRST`/`ROW_NEXT` rows without a card | `privacy.tsx` radios, `linked-phones.tsx` `DeviceRow` | rows in a card | React-owned: wrap in card, rows as `ui-lrow` |
| `Switch` look | everywhere | kit `tog` 44x26 | wear `.un-switch` under a look (new wear root `tog`) |
| `Select variant="plain"`, `Input`, `PasswordInput` | language, experimental Look, openrouter, api-key, username/email/password editors, connectors URL | kit `inp` inside a card, label above, hint below | new wear roots for the input/select primitives, scoped to `#settings-section-content` |
| Buttons: `Button` variants, raw `rounded-md border` / `rounded border` / `rounded-full bg-zinc-900` | tour, alerts test, agent-files Upload, openrouter defaults, api-key Save, connectors Copy/Test, lists' Revoke/Disconnect | kit `btn`, `btn sm quiet`, `btn sm bad`, `btn bad block` | extend `wear.roots.btn.to` with Settings' buttons, or give `Button` a stable name per variant |
| `h4` group labels (`GROUP_HEAD`, `GROUP_LABEL`, raw h4) and the 15px `px-1 pb-1` labels | linked-phones, connectors "Your AI tools", agent-files, social-identity "Weekly credits", building-time, usage spend | kit cap (`cap sub`) | add `ui-sechead` (or a `ui-subhead`) name |
| Help paragraphs `text-xs text-zinc-500 mt-2` | switch descriptions, notes | row sentence or 13px `secnote` | add `ui-secblurb` name or fold into the row wrapper |

**Kit/CSS needs (shared)**: `frontend/looks/kit.css` has `.tog`, `.chk`, `.chk.round`, `.inp`, `.field`, `.hint`,
`.link`, `.search`, `.lead`, `.pill`, `.cap`. It lacks: `.cols.flip` (360px + 680px; `kit.tsx` `Cols` has no such
prop and Settings does not use `Cols` anyway), `.sub22`, `.secnote`, `.sec.plain`, `.cap.sub`, a wrapping row (v2's
`gE-w`: `align-items:flex-start`, title and line unclamped: today `.fr-row .fr-t/.fr-s` are `nowrap` + ellipsis, which
would cut every switch sentence), a meter bar (v2 `gE-meter`), a bullet list in a card (`gE-list`, `gE-cap2`), a mono
value (`gE-code`), a bad-toned link. `looks.json` wear needs new roots for `tog`, `inp`/field, `chk round`, and wider
`btn`. After any `frontend/looks/` change run `node scripts/build-looks-css.js` before `build:css`.

**Tests that pin the shared part**

- `tests/settings-frame.test.js`: every assertion (column order and widths, the title wear selector text
  `:is(.settings-page-title,#first-session-make-title,…`, `pagePurpose('account')`, `.settings-page-purpose` rules,
  exact `wear.roots.row` object, exact `ui-*` class strings in `grouped-list.tsx` and `field.tsx`). Rewrite.
- `tests/looks-css.test.js` (committed generated section must match the compiler).
- `tests/settings-screen.test.js` (SECTIONS vs wrappers, chassis strings, list classes), `tests/settings-nav-pins.test.js`,
  `tests/settings-menu-status.test.js`, `tests/settings-menu-subtitles.test.js`, `tests/settings-search-recents.test.js`,
  `tests/settings-sign-out.test.js`, `tests/desktop-layout-audit-6.test.js` (all read `settings-nav.tsx`).
- `tests/shell-id-inventory.test.js` + `tests/baselines/shell-markup.json` (ids and `data-*` names: a new id or
  `data-*` on the head needs an `ADDED_IDS` entry; a class does not), `tests/mount-on-reveal.test.js`,
  `tests/me-page.test.js`, `tests/qa-sweep-shared-polish.test.js` (read `index.tsx`).
- `tests/section-heading-primitives.test.js` (the `SectionHeading` / `SectionHeader` literals).
- `tests/language-extraction.test.js` / `language-packs.test.js` (catalog ids added and removed).
- `dapp.json` checks select `#settings-section-content [data-settings-section=…]` and many `#settings/<key>` routes:
  ids, `data-*`, `hidden` semantics must stay.

**Size (shared)**: G1 to G6 = M (CSS + one chassis element + one store write + test rewrite). G7/G8 = M. G9 = L
(the wear table is most of the work, and it is per primitive, not per step).
**Risks**: static panes (id-bound listeners; no node swaps); the chassis is in the prerender (hydration: the head must
be the same markup on first render in every look); `#settings-footer` is physically moved between columns by
`_syncFooter`; `looks.json` `:where()` scoping keeps `.row+.row` one selector, a second scope must keep that form;
`settings-frame.test.js` pins CSS text character for character; `tests/no-glass-one-scheme.test.js` (no live blur).

## 2. Per step: only what differs

Every step: **Files** = section 0 + the pane files named; **Gap** = G1 to G10 + the lines below.

### s56-settings
- Files: `settings-nav.tsx` `SettingsNavDesktop` / `SettingsMobileMenu`; `settings.js` `_renderNav`, `_groupedSections`.
- Today: desktop opens the first page (Account) beside the sidebar; phone = level-1 menu, standard rows.
- Gap: G1, G2, G6, G7, G8. Content already matches: same six groups and rows, same status words. V2 draws no row
  subtitle (today: none on desktop, four on the phone from `Settings.SUBTITLES`: hide `.ui-lrow-s` in the menu under a
  look, or keep, see questions). Not in the mock but in the product: Pinned group, pin/arrow controls, group fold,
  recent searches, "Beta" tag on Experimental, account rows + Sign out, gated rows (Homeroom Wallet, Homeroom app).
- Tests: the settings-nav suites above.
- Size M. Risk: `item.className` is computed in `settings.js` and asserted by vm suites.

### s57-settings-account
- Files: `sections/profile.tsx` `ProfileSection`; `username.tsx`, `email.tsx`, `password.tsx` (`SignInRow` in
  `sign-in-row.tsx`, `ROW_ACTION`, `ROW_EDITOR`); `sections/delete-account.tsx` + `../delete-account.tsx` `DeleteAccount`.
- Today: title + sentence; Profile label, blurb, white hand card (avatar 44, name, handle, "Edit profile", chevron);
  Sign-in label (drawn by the username part) over three kit cards, one per part (Username, Email & recovery,
  Password), as v2 draws them; Delete account label, blurb, standard danger button.
- Gap: profile card → kit card/row with `Av`, link "Edit profile", no chevron (React-owned, may branch). Row actions
  (`ROW_ACTION` buttons `#cu-edit` etc.) → kit link style. Inline editors (`#cu-form`, email, password forms) → kit
  fields/buttons by wear. Delete button → `btn bad block` (`DeleteAccount` l.55 form is React-owned). Content matches.
- Tests: `settings-email-row.test.js`, `password-visibility-toggle.test.js`, `return-to-next.test.js`,
  `username-change.test.js`, `delete-account-retry.test.js`, `capture-outcomes.test.js`.
- Size M.

### s58-settings-linked-accounts
- Files: `sections/connectors.tsx` `LinkedAccountsSection` (l.791); `social-identity.tsx` `SocialIdentityView`
  (l.789), `TierRow`, `ProviderRow`; `social-identity-store.js`.
- Today: "Linked accounts" label (repeats the page), blurb, h4 "Weekly credits" (15px grey), kit card (tier row,
  GitHub, X rows), tier note, scope note.
- Gap: G5 hides the repeated label; h4 `#github-link-credits-label` → kit cap, and v2 puts the blurb **under** it
  (DOM has it above: CSS `order` or accept). "Connected" → kit `pill ok` (see `tests/social-identity-connected-badge.test.js`
  for the present badge). X setup admin line and the two notes exist (`#github-link-tier-note`, `#github-link-scope`).
- Tests: `github-link.test.js`, `social-identity*.test.js`, `dev-flow-link-github.test.js`.
- Size S to M.

### s59-settings-contact-privacy
- Files: `sections/privacy.tsx` `PrivacySection` (radios l.147 to 177), `privacy-text.tsx` `PrivacySwitch`,
  `contact-preferences.tsx`, `usage-analytics.tsx`. All React-owned.
- Today: four parts with kit labels and blurbs; radios, switches and the usage lists are bare (no card), split by hairlines.
- Gap: radios → radio rows in one card (`chk round`); each switch → switch row in a card, switch at the end, On/Off
  word after the name; Usage data → one card with two sub-captions and bullet lists, the two closing lines as notes,
  the address as a link; "Texts need a verified phone number" (`[data-settings-contact-no-phone]`) as a note. G10.
- Tests: `settings-privacy-pane.test.js`, `contact-opt-ins-ui.test.js`, `usage-analytics.test.js`.
- Size M. Risk: the three suites pin class strings and order.

### s60-settings-phones
- Files: `sections/linked-phones.tsx` `LinkedPhonesSection`, `DeviceRow` (l.170), `GROUP_HEAD`, `GROUP_NOTE`,
  `UNLINK_CLASS`. React-owned.
- Today: repeated label, blurb, h4 Phones + note + bare rows, h4 Browsers + note + bare rows.
- Gap: G5; h4s → caps; rows into one card per group (`ui-lrow`, wrapping); action as bad-toned link; "This browser"
  → kit pill; the confirm state (Cancel + confirm, l.183) must keep working in the row.
- Tests: `settings-linked-phones-pane.test.js`, `settings-menu-status.test.js`.
- Size S to M.

### s61-settings-ai
- Files: `sections/usage.tsx` (+ `features/header/ai-budget.tsx` `AiBudgetRow`), `building-time.tsx` `BuildingTime`,
  `sections/openrouter.tsx`, `sections/api-key.tsx`.
- Today: Usage label; white hand card (credit row); building time (15px label, kit card with summary, bar, request
  rows, Show all); `#settings-spend` hand card; OpenRouter and API key parts in standard hand cards, pills, raw buttons.
- Gap: hand cards → kit card; "Homeroom bot building time" → `cap sub`; bar → kit meter in `--fr-lit`; OpenRouter:
  included-key violet box (`#settings-openrouter-included`) → plain row; key field + "Test & save", filter + Favorites
  + Refresh, model select + star, Reasoning effort select, two default buttons → kit fields and `btn sm` / `quiet`,
  all inside **one** card; API key → one field + Save + hint in a card. Static panes: wear only, no node moves.
- Tests: `ai-credit-row.test.js`, `building-time.test.js`, `reset-time.test.js`, `openrouter-managed-keys.test.js`,
  `openrouter-harness.test.js`, `password-visibility-toggle.test.js`, `return-to-next.test.js`,
  `qa-sweep-shared-polish.test.js`, `coding-agent-reasoning-default.test.js`.
- Size L. Risk: `settings.js` toggles `hidden` on a dozen ids here; wrappers that become the card must not be among them.

### s62-settings-connectors
- Files: `sections/connectors.tsx` `ConnectorsSection` (l.299), `ToolCard` (l.247), `Disclosure` (l.143),
  `GuidedSetup`; `connectors-list.tsx`; `connector-setup-steps.tsx`; `sections/cli.tsx`; `cli-setup-guide.tsx`;
  `cli-tokens-list.tsx`.
- Today: tool cards already are `GroupedList` + `ListRow` (wear the kit). URL field, Copy, Test, "How it works"
  `<details>`, h4 "Your AI tools", connection rows, CLI guide and token mini cards keep the standard look.
- Gap: URL → kit field (code) with `btn sm` + `btn sm quiet`; "How it works" → kit link; h4 → `cap sub`; Disconnect /
  Revoke → `btn sm bad`; CLI guide → one card of three numbered rows (`lead` 1/2/3) with code lines + Copy; tokens →
  rows in one card. Name is "Connectors & CLI" in the product (s56's mock says "Connectors", a mock slip).
- Tests: `settings-connectors-panel.test.js`, `connector-setup-*.test.js`, `connector-chat-links.test.js`,
  `connector-permission-rules.test.js`, `cli-auth.test.js`, `launchpad.test.js`, `tap-targets-contrast-aria.test.js`,
  `platform-brand-strings.test.js`, `section-heading-primitives.test.js`.
- Size M to L (largest pane, 828 lines, heavily pinned).

### s63-settings-agent-files
- Files: `sections/agent-files.tsx` (static; form `#agent-files-form`), `agent-files-list.tsx`, `agent-files-store.js`.
- Today: repeated label, blurb; two h4 + small Upload button rows; lists of mini cards or an empty line.
- Gap: G5; each kind = one card, row = name (Instructions / Skills) + the empty line or its files, `btn sm quiet`
  Upload at the end. Uploaded files (not in the mock) as further rows of that card. The name/description form stays.
- Tests: `agent-files-list-aria.test.js`, `user-agent-files.test.js`, `return-to-next.test.js`, `tap-targets-contrast-aria.test.js`.
- Size S to M.

### s64-settings-theme
- Files: `sections/theme.tsx` `ThemeControl`, `RailPinnedRow`. React-owned.
- Today: Theme label + blurb, segmented control (max-w-xs), hairline, switch + sentence (desktop only).
- Gap: three radio rows in a card; second card with the sidebar switch row. G10.
- Tests: `nav-rail-pinned.test.js`, `look-picker.test.js`, `shell-id-inventory.test.js` (`drawer-theme-track`,
  `data-theme-mode`), dapp check on `#settings/theme`.
- Size S.

### s65-settings-accessibility
- Files: `sections/accessibility.tsx` `TextSizeControl`, `HighContrastRow`. React-owned.
- Gap: same as s64 (three radio rows; High contrast as a switch row in its own card, no label).
- Tests: `accessibility-prefs.test.js`, `shell-id-inventory.test.js`.
- Size S (do with s64).

### s66-settings-language
- Files: `sections/language.tsx` (static; `#settings-locale` bound by `settings.js`).
- Gap: G5; the select inside a kit card as a kit field (wear only).
- Tests: `user-locale.test.js`, `language-runtime.test.js`.
- Size S.

### s67-settings-alerts
- Files: `sections/alerts.tsx` (static), `notification-prefs-list.tsx` `NotificationPrefsList`, `notification-prefs-store.js`.
- Today: three labelled parts; bare switch rows; raw test button; per-app list as mini cards.
- Gap: part 1 = card with one switch row (sentence under the name) + `btn sm quiet` "Send a test alert" under it;
  part 2 = one card of ten switch rows; part 3 = one card of the default categories as switch rows, then a card
  "Apps set differently" (overrides or the empty line). G10. `[data-mobile-push-status]` line stays as a note.
- Tests: `settings-mobile-push.test.js`, `devchat-alerts.test.js`, `topochain-profile-web.test.js`, dapp `#settings/alerts`.
- Size M. Risk: the ten labels are selected by `data-mobile-push-category` and filled by `settings.js`.

### s68-settings-app-permissions
- Files: `sections/app-permissions.tsx` + `app-permissions-list.tsx`; `sections/app-ai.tsx` + `grants-list.tsx`;
  `sections/blocked-apps.tsx` `BlockedAppsList`.
- Gap: each list → one kit card: an empty list is one quiet line; a grant row = app name, "Cap $" field, mono
  "$x / $y today", `btn sm bad` Revoke. No app tile (v2 says so).
- Tests: `settings-screen.test.js` (grants-list), `shell-id-inventory.test.js`, dapp `#settings/app-permissions`.
- Size S to M.

### s69-settings-developer
- Files: `sections/dev-console.tsx`, `sections/admin-preview.tsx` (static; inner `#settings-admin-section` is a capability gate).
- Gap: each part = card with one switch row (the `<p>` description becomes the row's sentence). An empty
  admin-preview wrapper must draw no card for non-admins.
- Tests: `settings-screen.test.js`.
- Size S.

### s70-settings-tour
- Files: `sections/tour.tsx` `TourSection`, `replay()`.
- Gap: G5; `Button#settings-tour-replay` → kit `btn`; hint as note. Content matches.
- Tests: `home-tour.test.js`, dapp `#settings/tour`.
- Size S.

### s71-settings-guide
- Files: `sections/guide.tsx` (already `GroupedList` + `ListRow` + `SectionHeader`).
- Gap: G5 only; check `SectionHeader` (not `SectionHeading`) reads as the kit cap, and rows wrap (they pass
  `subtitleClassName="whitespace-normal"`, which the kit's `.fr-row .fr-s { white-space: nowrap }` wear may override).
- Tests: `settings-guide.test.js`.
- Size S. Closest to done.

### s72-settings-about
- Files: `sections/about.tsx` `PlatformVersionRow` (l.109, `#drawer-row-platform-version`, `.drawer-ver-row`),
  `AppVersionRow`, `NativeAppVersionRow`, `LegalLinks` (l.148).
- Gap: G5; version rows into one card (mono meta); Legal = cap + one card of four links. The version pill slot is
  filled from outside (`#platform-version-pill-slot`): wear only.
- Tests: dapp `#settings/about` (5 checks), `shell-id-inventory.test.js`.
- Size S.

### s73-settings-experimental
- Files: `sections/experimental.tsx` (static), `interface-mode-control.tsx`, `local-agents-list.tsx`.
- Gap: G5; Advanced mode, AI progress estimate, Session bridge, New look as four switch rows in **one** card (today:
  separate blocks split by hairlines); `#settings-look-section` = second card with the Look field + hint. The gated
  local-agents part (not in the mock) keeps its place under them.
- Tests: `glass-skin.test.js`, `interface-mode.test.js`, `session-bridge-preference.test.js`,
  `ai-progress-estimate.test.js`, `suggest-shortcut.test.js`, `homeroom-bot-for-everyone.test.js`, `look-picker.test.js`.
- Size M. Risk: this pane holds the look switch itself: it re-dresses while open.

## 3. Shared work, once

1. Chassis and CSS: G1 to G6 (flip, head, 22px name, drop `frame.purpose`, hide repeated labels, crumbs).
2. Kit additions in `frontend/looks/kit.css`: wrapping row, `secnote`, `sub22`, `cap.sub`, meter, bad link, mono value.
3. New stable names on shared primitives + `looks.json` wear roots: switch → `tog`, input/select → `inp`, buttons →
   `btn` kinds, a generic `ui-card`; widen card/row scope to `#settings-mobile-menu-host`.
4. A switch-row wrapper for static panes (name + sentence + switch at the end) used by alerts, developer, experimental.
5. A look-aware radio-row list for React-owned panes (theme, accessibility, privacy).
6. One "rows in one card" treatment for the six `*-list.tsx` islands sharing `ROW_CLASS`.
7. Rewrite `tests/settings-frame.test.js`; regenerate the looks section (`node scripts/build-looks-css.js`).

## 4. Suggested order

1. s56 with G1 to G8 (the frame every other step sits in).
2. s71, s70, s72, s66 (near done; prove G5 and the card/field/button wear).
3. s64 + s65 (radio rows), then s59 (radio + switch rows + lists).
4. s69, s73, s67 (the static switch-row wrapper).
5. s57, s58, s60 (rows, links, pills).
6. s63, s68 (the list islands).
7. s62, then s61 (largest, most pinned, most ids toggled by `settings.js`).

## 5. Open questions

1. **Sign out and the account rows** (`#settings-footer`: wallet / node / staking rows, Sign out) are in today's
   list column and in no v2 mock. Keep under the list as today (assumed), or move?
2. **Nav features absent from the mock**: Pinned group and pin/arrow controls (#5997), group fold, recent searches,
   the "Beta" tag, the four phone subtitles (#5995; v2's WHY says "no sentence under every row"). Assumed kept,
   subtitles included, since v2 says content from today.
3. **Desktop crumb at `#settings`**: s56 shows `You › Settings` with Account open, s57 `Settings › Account` for the
   same desktop state. Proposed: desktop always `Settings › <page>`; `You › Settings` only at phone level 1.
4. **Gated pages with no mock**: Homeroom Wallet (`wallet`) and Homeroom app (`usernode`, with its diagnostics and
   `usernode-ui.tsx`). They get the shared layout; their insides need a decision (wear only assumed).
5. **Radio rows and switch-at-end rows are a control change** the plan's Notes ruled out on 11 Nov ("the controls
   stay the product's"). V2 now asks for them: confirm the earlier ruling is lifted, and that the standard look keeps
   its segmented controls.
6. **Static panes cannot swap markup per look.** Is adding neutral wrapper elements and `ui-*` names to the shared
   (standard-look) markup acceptable, provided the standard look renders the same? It is the only route that keeps
   `settings.js`'s id bindings.
7. **768 to 1023px**: Settings is the phone's two levels there (by `DESKTOP_MEDIA`) while the frame's sidebar is
   open. V2 has only a desktop and a phone drawing; assumed unchanged.
8. Mock data not in the product today and assumed illustrative, not required: none found. Every label in the 18
   mocks maps to an existing catalog id except the head's sentence (G2, one new id).
