# Content guidelines

UX writing rules for the Social Vibecoding platform shell. Every user-facing
string passes through here: titles, labels, buttons, body text, errors, status
rows, empty states, and accessible names. Accessible names are copy.

## Optional content contract and mechanical gate

This document is the human authority. The optional machine-readable contract
for a registered, text-bearing pattern lives in `authority.json` and resolves
into `catalog.json`. It records only five reviewable facts: `layer`
(`glance`, `read`, or `expert`), canonical terms, required states, the
visible-label/accessibility-name rule, and named failure modes reviewed.

Run `npm run check:content` for a narrow ratchet. It catches only static,
high-confidence failures: shell dApp casing, a customer-facing Dev action
where Improve is required, a Notifications label targeting Activity, banned
filler, button ellipses outside an in-progress label, static visible-label /
accessible-name mismatches, and visible migration/legacy-shell copy. It does
not judge tone, intent, hierarchy, or technical Expert copy. Exact temporary
exceptions belong in `content-exceptions.json`; do not quietly rewrite old
copy simply to make the first check pass.

Scope matches the design authority: the platform shell only, not child apps.

## Stance

The reader is a curious adult who builds, runs, and votes on apps with their
community. They opted in; they are capable. Copy treats them as someone acting
with intention, never as someone being processed.

**Accessible without dumbing down.** Plain language is respect, not
simplification of the reader. Simplicity is about placement, not vocabulary:
plain words at Glance, real names at Expert. We never replace a true concept
with a babyfied one; we put it at the right layer.

**Default tone:** calm, concrete, declarative.
**Celebratory** only on agency moments (shipped, merged, won) — one exclamation
max. **Errors:** what happened, what to do next. No blame, no "oops".

## Hierarchy

When principles conflict, resolve in this order:

1. **Truth** — never inaccurate, never misleading.
2. **Specificity** — named things over abstractions.
3. **Empowerment** — the user's verb, when it stays specific.
4. **House style.**

An inaccurate-but-empowering line loses to a passive-but-specific one.

## Principles

### 1. The user is the actor

Lead with the user's verb: you built, you voted, you shipped. Not "the
proposal was submitted" — "you submitted the proposal".

### 2. Truth before brevity

Test every shortened phrase alone: does the reader still hold a correct mental
model? Short-and-wrong is fatal.

### 3. Context already spoke

Never restate what the route, section, or previous screen established. A badge
inside "Your apps" doesn't say "Your app". Descriptions are exceptions, not
defaults — each one present must earn its place. If a control's purpose is
visible, don't narrate it.

### 4. Three layers, deliberately separated

| Layer | Surfaces | Length | Vocabulary |
|---|---|---|---|
| **Glance** | nav labels, titles, buttons, badges, step names | 1–4 words | words every user knows |
| **Read** | descriptions, empty states, alerts, confirmations | 1–2 plain sentences | at most one technical term, only if it carries weight |
| **Expert** | Dev console, node details, logs, IDs, timings | as long as accuracy demands | precise terms, no translation |

Each layer is true and complete on its own. Don't bury required information in
Expert; don't smuggle Expert jargon into Glance. This is how the guidelines
stay accessible without dumbing down: plainness lives at Glance, precision
lives at Expert, and neither is sacrificed for the other.

### 5. Real names, one name each

`Wallet`, `node`, `vote`, `proposal`, `merge`, `session`: say them. The reader
chose to be here. One canonical name per concept — no synonyms across surfaces:

| Concept | Canonical | Never |
|---|---|---|
| The platform's hosted apps | dApp, dApps | dapp, dapps, DApp, DApps |
| Personal launch surface | Home | Dashboard |
| Catalog and discovery | Explore | App Store, All apps |
| Sessions and proposals | Work | Your work (as a label) |
| Community competition | Challenges | Community |
| Attention and event history | Activity | Notifications (as a product label) |
| Infrastructure health | Node | Status |
| Using an app | Use, Open | Launch, View |
| Contributing to an app | Improve | Dev (as a user-facing label), Edit, Contribute |
| Governance item (database) | proposal | issue |
| GitHub item | issue | proposal |

`Improve` supersedes the `Dev` labels in the navigation proposal's chrome
mocks; routes (`/apps/:slug/dev`) and technical surfaces (the Dev console,
Dev sessions in Expert contexts) keep their names — URLs and diagnostics are
not user-facing labels.

### 6. House style

- Sentence case everywhere; brand names keep their casing.
- No period on solitary sentences in labels, bullets, dialog body.
- No em dashes; use commas, periods, or a new sentence.
- No ellipses in buttons; reserved for in-progress states.
- Serial commas in lists of 3+.
- Contractions when natural (`it's`, `can't`); spell out for emphasis (`do not`).
- Numerals (`3`, not `three`).
- Banned: `please`, `just`, `simply`, `easy`, `amazing`, `seamless`.
- The visible label and the accessible name of a control are identical, or the
  visible label is a prefix of the accessible name. Icon-only controls still
  have copy: their accessible name, matched by their tooltip.

## Vocabulary

| Lean in | Avoid |
|---|---|
| build, run, own, ship, open, vote, propose, review, earn | leverage, engage, empower (as filler) |
| your app, your node, your session, your vote | "we'll X for you" constructions |
| community, collaborators, humans | ecosystem, stakeholders |
| working, ready, merged, failed | seamless, powerful, revolutionary |

## Failure modes

Named so reviewers can flag them by name.

| Pattern | Shell example | Why it fails |
|---|---|---|
| **System-as-actor** | `The proposal was submitted` | drops the user out of their own action |
| **Cosmetic brevity** | a wrong-but-short status label | breaks the mental model to save a word |
| **Context restatement** | `Apps you saved or built.` under "Your apps" | the section title already said it |
| **Defensive reassurance** | `This never changes who can access an app` | answers a fear nobody voiced; if the fear is real, fix the design |
| **Internal-state leak** | `Return to the legacy shell while this migration route is being diagnosed` | migration and infrastructure vocabulary shown to users |
| **Mechanism-as-content** | `Starting primary SSE stream` | names what the system does, not what the user gets (`Reconnecting`) |
| **Performative apology** | `Oops! Something went wrong` | empty calories, no fix path |
| **Vague link text** | `Learn more` | no antecedent; screen-reader hostile |
| **Begging** | `Please tap Continue to proceed` | asks permission we don't need |

## Worked example — Apps load failure

Current: alert titled `Apps could not be loaded`, body
`Request failed (500). Return to the legacy shell while this migration route
is being diagnosed.`

Failures: **internal-state leak**, **system-as-actor**, and no next action.

| Layer | Copy |
|---|---|
| Glance (alert title) | `Apps didn't load` |
| Read (body) | `Check your connection and try again.` + a Retry action |
| Expert | status code and request detail in the Dev console, not the alert |

Note what the rewrite forced: a Retry control. Copy review is design review —
when the honest next step has no affordance, the copy change creates the
requirement.

## In review

1. Name the layer for each string.
2. Flag violations by failure-mode name.
3. Resolve conflicts by the hierarchy.

## Placement

Copy is a design-system surface, like tokens. This file lives beside
`tokens.json` and applies to every registered pattern's strings and story
states. Successor-pattern reviews (`PageHeader`, `HomeAppShortcut`,
`ExploreAppCard`, `PlatformNavigation`) check new strings against it.

---

*Adapted from the Usernode native content guidelines; informed by Material 3,
Apple HIG, and the Microsoft Style Guide, overruled where this product demands.
Shell examples come from `docs/shell-component-audit.md`.*
