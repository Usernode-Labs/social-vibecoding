# Dev chat plan — runtime, message model, and timeline

**Status:** Part I (analysis and decision) is accepted direction. Part II
(delivery plan) is proposed; authorizes no implementation.

**Date:** 2026-07-29

**Scope:** the React Dev session conversation only (`dev-conversation`,
`use-dev-session-stream`, `dev-chat-api`, and their eventual successor
`DevTimeline`). Group discussion (WebSocket domain) and hosted child apps are
out of scope. Feeds the Dev/chat compounds batch of `shell-component-audit.md`
and a future execution-plan wave decision in `shell-refinement-guide.md`.

This document has two parts. **Part I** answers what message model and
runtime the Dev conversation should use, cross-checked against a real
battle-tested implementation (`pingdotgg/t3code`) and the shadcn/Vercel AI
ecosystem. **Part II** turns that decision into a scoped, encapsulated
delivery plan for the timeline compound that renders it.

---

# Part I — Runtime and message-model audit

## The question, reframed

The prompt was "shadcn `helpers/ai-sdk` or `helpers/tanstack-ai` — what
delivers the best UX?" Fetching both docs resolves a premise: **both helpers
are deterministic conversation builders** — script a chat in code, stream it
locally with no model, network, or key. They are Storybook/test instruments,
not production transports (the ai-sdk helper's `reconnectToStream()`
deliberately returns null). The `ai-sdk` helper is already doing exactly this
job in `dev-conversation.stories.tsx`.

The real decision underneath is therefore:

1. which **message model** the shell's conversation projection uses;
2. which **runtime** drives production streaming;
3. how deterministic story evidence stays truthful to production.

## Evidence

- Live docs: `ui.shadcn.com/docs/helpers/ai-sdk`, `…/helpers/tanstack-ai`,
  `elements.ai-sdk.dev/overview`, `…/components/chain-of-thought` (fetched
  2026-07-29).
- Installed: `ai@^7.0.40`, `@ai-sdk/react@^4.0.43`, `@shadcn/helpers@0.1.0`
  (exports both `./ai-sdk` and `./tanstack-ai`); **no** `@tanstack/*`
  dependency anywhere in `frontend/package.json`.
- Source: `@/lib/dev-chat-api.ts` (337 lines),
  `@/features/dev/use-dev-session-stream.ts` (131),
  `@/features/dev/dev-conversation.tsx` (121),
  `@/features/dev/dev-conversation.stories.tsx`.
- Cross-check: `pingdotgg/t3code` (15.5k stars, active 2026-07-29) — same
  problem class: long-running agent turns, multiple clients, resumability.

## Current state

What is already right:

- **The server is authoritative and the stream is resumable.** The session bus
  (`/api/sessions/:id/events`) is an `EventSource` with `Last-Event-ID` replay
  and `_seq` dedup, backed by a bounded ring buffer
  (`src/services/session-bus.js`: 500-event in-memory buffer, 5-minute idle
  TTL, restart loss covered by DB rows and the progress log *by documented
  design*). The legacy primary SSE is drained (`dev-chat-api.ts:334-336`) so
  the bus is the single UI source — the AGENTS "no second streaming protocol"
  rule is honored.
- **Presentation uses the official components** (`MessageScroller`, `Message`,
  `Bubble`, `Marker`, `Attachment`) with the scroller owning anchoring.
- **Boundaries hold**: every endpoint is in `@/lib`; the conversation is
  props-only, matching its authority performance contract.

What limits the UX today:

| Gap | Evidence | User cost |
| --- | --- | --- |
| Untyped event grab-bag | `SessionEvent` is `{ type?: string; text?: string; … }` (`use-dev-session-stream.ts:8-16`) | new server events silently drop; no compile-time contract |
| Impoverished message model | reasoning becomes a system `Marker`; build progress lives outside the transcript; estimates in a side channel | the richest moments of an agent turn (thinking, building, checking) render as flat marker soup |
| Transient negative-ID messages | `nextTransientId.current--` | replay/refetch can reorder or duplicate perceived state |
| Reconnect UX punts | "Reconnecting remains in the legacy Dev workspace for now" (`dev-conversation.tsx:117`) | the one moment users most need confidence, the React shell surrenders |
| Story shim | `toConversation()` flattens helper `UIMessage` parts into strings | deterministic evidence exercises a *different shape* than production renders — the gap the helper exists to close |
| Three-channel routing lives in comments | POST SSE (drained), bus SSE, global WS; cross-channel `_seq` dedup rules documented only in prose (`src/routes/sessions.js:1907-1929`, the "#394 swallowed-then-deduped" bug class) | new events land in the wrong channel and silently vanish until someone reads the comment |

## Cross-check: how t3code solves the same problem

t3code drives Claude/Codex/ACP agents from web, desktop, and mobile clients.
Its architecture (`.plans/14-server-authoritative-event-sourcing-cleanup.md`,
`apps/server/src/persistence/*`) is:

- a durable, server-authoritative **OrchestrationEventStore** (SQLite);
- **projections** (`ProjectionThreadMessages`) replayed/snapshotted to clients
  over a WebSocket transport;
- a **typed contracts package** (`@t3tools/contracts` + Effect `Schema`)
  validating every command and event at the boundary;
- structured, first-class turn artifacts in the UI (pending approvals,
  changed-file trees, per-turn diff summaries) rather than text markers.

Notably, t3code uses **neither** the Vercel AI SDK's `useChat` **nor**
TanStack AI (its only TanStack packages are Router and Pacer). Lessons:

1. **The server-authoritative event bus is the right architecture** — it
   independently converges with what Social Vibecoding already has. Do not
   replace it with a client-request chat runtime.
2. **`useChat`'s request/response lifecycle is a poor fit** for long-running,
   server-owned turns with phases, approvals, and multi-client viewers. t3code
   rejected it for exactly this product shape; our turn lifecycle (busy
   phases, server-owned stop, wrap-up protection) matches theirs, not a
   chatbot's.
3. **What t3code adds that we lack is typing and projection purity**: a typed
   event contract at the boundary, and pure event→message projection that can
   be unit-tested and replayed. Our reducer lives inside a `useEffect` with an
   untyped payload.
4. **Structured turn artifacts beat marker text.** Their approvals/diffs/build
   surfaces are first-class components fed by typed events — the UX ceiling we
   should aim at with parts.

## Gap analysis: distance from t3code

The gap is **formalization, not architecture**. Social Vibecoding already has
the t3code shape: server-authoritative turns, a resumable feed, and
refetch-on-terminal reconciliation. t3code's edge is the same architecture
made rigorous.

| # | Gap | t3code | SV today | Effort | Impact | Verdict |
|---|---|---|---|---|---|---|
| 1 | Pure projection layer | server projections, thin client | reducer inside `useEffect`, transient negative IDs | S | High | Do first |
| 2 | Typed event contract | contracts package + schema, both ends | `{ type?: string }` grab-bag; unknown events silently dropped | S–M | High | Do — client union first, server emit-map second |
| 3 | Structured turn artifacts inline | approvals, diff trees, turn summaries as typed UI | artifacts exist (staging, checks, visuals, spec, build lines) but scattered; transcript is marker soup | M | High | Do — the parts rendering; the only gap users see |
| 4 | Atomic snapshot-on-connect | snapshot+replay in one handshake | history fetch and bus subscribe race; dedup + refetch mostly reconcile | S | Med | Do cheaply — subscribe-then-snapshot ordering or snapshot seq in history |
| 5 | Single channel semantics | one WS, one dedup story | three channels, routing rules in comments | S–M (React), L (server) | Med-High | Formalize per-channel ownership in the type union; leave server unification alone |
| 6 | Runtime boundary validation | schema everywhere | manual narrowing | S | Med | Piggyback on #2 only |
| 7 | Durable fine-grained event log | SQLite event store, unbounded replay | in-memory ring by design; coarse rows are durable | L | Low-Med | Defer — legitimate split; revisit only for perfect turn-timeline history |
| 8 | Checkpoint/rollback per turn | git checkpoints with rollback | branch-per-session + PR + governance, coarser grain | XL | Med (feature, not parity) | Decline — product decision |
| 9 | Command router layer | orchestration router + handlers | Express routes with server checks | M | Low | Decline — stylistic at this scale |
| 10 | Provider abstraction (ACP) | multi-provider adapters | one mayor/cc pipeline, deliberately | — | — | Non-gap |

Practically: gaps 1+2+4 are the enabling layer (~one focused week) — replay
becomes provably idempotent, unknown events become visible, the reducer
becomes unit-testable. Gap 3 is the visible payoff on top. Gap 5 costs almost
nothing on the React side once the type union exists, because the union is
where channel ownership gets written down. Everything from 7 down is where the
products genuinely diverge; copying t3code there would be cargo-culting —
their durable store exists because desktop/mobile/web clients attach to
arbitrary historical threads, ours doesn't because one web shell reconciles
against canonical refetches.

## Runtime options

### A. Adopt `useChat` + owned `ChatTransport` as the production runtime

Wrap `startDevChat` + the bus in a custom transport; `useChat` owns state.

- For: one runtime for stories and production; optimistic sends; the
  transport interface has first-class `reconnectToStream`.
- Against: inverts authority — `useChat` assumes the client initiates and owns
  a request-shaped turn, but our turns are server-owned, phase-based,
  stoppable only by the server, and watched read-only by collaborators
  (shared sessions, forks). Fighting that inversion is exactly the complexity
  t3code declined. Adds `@ai-sdk/react` runtime to the production bundle
  (~8.7 KiB headroom). Major-version churn risk (`ai` v7 / `@ai-sdk/react` v4).

### B. Adopt TanStack AI (`helpers/tanstack-ai` + `@tanstack/ai-react`)

- For: AG-UI event protocol is conceptually close to our event bus.
- Against: zero ecosystem synergy — no TanStack package in the frontend today;
  a second chat vocabulary against the already-installed `ai` types; the
  helper adapter has more documented omissions (structured output, custom
  events, assistant files); younger ecosystem. Even t3code, a TanStack Router
  shop, did not adopt TanStack AI.

### C. Owned event-sourced adapter, `UIMessage` parts as the projection model

Keep the resumable EventSource adapter as the runtime (t3code-validated,
AGENTS-mandated). Upgrade what the adapter *produces*: a typed event contract
and a pure projection into AI SDK `UIMessage` parts — the vocabulary the
official shadcn components and the `ai-sdk` helper already speak.

- For: server stays authoritative; reconnect stays `EventSource` +
  `Last-Event-ID` (already durable); the transcript gains typed parts
  (reasoning, files, structured data) that unlock the real UX ceiling;
  stories consume helper `UIMessage`s **directly** — the `toConversation`
  shim is deleted and deterministic evidence becomes production-shaped;
  `UIMessage`/`UIMessagePart` are **type-only imports** from `ai` — zero
  production bundle cost; no new dependency.
- Against: we own the projection code (~a pure function plus tests) and a
  parts-rendering switch in `DevConversation`.

## Decision: Option C

The solution that sings is not a runtime swap — it is giving the conversation
a real message model while keeping the architecture that already matches the
product:

> Server-authoritative resumable bus (unchanged) → typed `DevSessionEvent`
> contract → pure projection → `UIMessage` parts → official shadcn message
> components. The `ai-sdk` helper remains the deterministic evidence tool,
> now with zero translation between story shape and production shape.

TanStack AI is rejected (no synergy; revisit only if TanStack Query/Router
ever enter this stack). `useChat` as production runtime is rejected for the
turn-lifecycle inversion (revisit only if a genuinely request-shaped chat
surface appears — e.g. a one-shot "Explore in dev chat" advisor).

### Projection specification sketch

Typed event union in `@/lib` (discriminated on `type`, unknown types preserved
as an explicit `unrecognized` case for forward compatibility), then one pure
function:

```
projectDevConversation(history: DevSessionMessage[], events: DevSessionEvent[])
  → UIMessage[]
```

| Bus event | UIMessage projection | Rendered by |
| --- | --- | --- |
| `token` | text-delta on the open assistant message | `Bubble` (streaming) |
| `mayor_reasoning` | `reasoning` part on the assistant message | collapsible thinking block |
| `cc_progress` | `data-build` part (append-only lines) | `DevBuildTimeline` inline in the turn |
| `cc_estimate` | `data-estimate` part | turn footer |
| `status` | `data-status` part | `Marker` |
| `error` | `data-error` part + stream state | `Marker` + reconnect affordance |
| attachments (history metadata) | `file` parts | `Attachment` group |
| `done` / `stopped` / `pr_*` / `staging_*` / `checks_ready` / `spec_updated` | finish; trigger the existing canonical refetch | — |

Message identity: server row IDs for history; the open streaming message keys
on the turn, and the terminal refetch reconciles it with the server's
canonical row — replacing the transient negative-ID scheme.

The reconnect story changes from "go back to the legacy workspace" to an
honest state: `EventSource` retries with `Last-Event-ID`, `_seq` dedup makes
replay idempotent inside the pure projection, and the disconnected marker
becomes "Reconnecting…" with the canonical refetch as the safety net.

## Presentation layer: the shadcn kit versus AI Elements

Question examined: is the installed official shadcn chat kit
(`MessageScroller`, `Message`, `Bubble`, `Marker`, `Attachment`) good enough
to render the parts model, or should the shell adopt
[AI Elements](https://elements.ai-sdk.dev) (Vercel's registry — Conversation,
Message, Reasoning, **Chain of Thought**, Task, Tool, and ~40 more)?

Findings:

- AI Elements is built on shadcn *conventions* with deep AI SDK `UIMessage`
  integration — conceptually a perfect match for the recommended projection
  model, and its catalog is exactly the structured-artifact vocabulary the
  t3code comparison points at.
- **But its components sit on Radix UI primitives** (Chain of Thought uses
  Radix Collapsible et al.), while the frozen `b1VlIwYS` baseline retains
  **Base UI** as the primitive base. Installing AI Elements source would
  introduce a second primitive base and a second design vocabulary over Luma —
  both named in the refinement guide's deliberate rejections.
- **Chain of Thought specifically is ahead of our data.** Its model is
  step-by-step reasoning with statuses, search-result badges, and images. The
  server emits `mayor_reasoning` as one full-text wrap-up and `cc_progress` as
  log lines — no step or tool events. Adopting it today would tempt exactly
  the faking this plan already defers ("do not fake tool parts from
  `cc_progress` text"). Content-guidelines fit is conditional too: its step
  labels sit at the Expert layer; internal phase vocabulary must not leak
  into them.

Decision:

1. **Chassis: keep the official kit.** Scroller/message/bubble/attachment are
   installed, governed, and already carry Luma merge dispositions. Nothing in
   AI Elements replaces the chassis better than what the authority already
   owns.
2. **Gap components are owned patterns on Base UI primitives, using AI
   Elements as reference design, not as an install source.** The two real
   gaps for the parts model are a collapsible `Reasoning` block (streamed
   text, keyboard-operable, announced) and the inline build timeline —
   `DevBuildTimeline` already exists and becomes the `data-build` part
   renderer. Port composition ideas from Elements; express them with the
   local Base UI primitives and register them with named states like every
   owned pattern.
3. **Chain of Thought is a recorded future candidate, not a current
   component.** Its adoption trigger is the server emitting structured
   step/tool events — the same trigger as tool-call parts. If that day comes,
   re-evaluate whether the official Base UI registry has grown an equivalent
   first (official-primitive-first rule) before porting the Elements design.

## Deferrals (Part I)

- **Tool-call parts**: not until the server emits structured tool events; do
  not fake tool parts from `cc_progress` text.
- **AI Elements / Chain of Thought**: reference design only. Adoption trigger
  is structured step/tool events from the server, and even then the official
  Base UI registry is checked for an equivalent before porting the Radix-based
  Elements source.
- **`useChat` adoption**: only with a request-shaped surface and a recorded
  decision.
- **TanStack AI**: revisit trigger is TanStack entering the stack for
  data/router reasons, not chat.
- **Group discussion transcript**: different domain (WebSocket, reactions,
  edits); it may later reuse the parts vocabulary but is audited separately.

---

# Part II — Delivery plan: the timeline compound

**Position in the program:** foundation phase (C0) runs early in parallel with
any wave — it touches only `@/lib` and one hook. Presentation phases (C1–C3)
run **after** the Luma merge, successor contracts, Home/Explore, and the
drawer are stabilized — chat is the last product surface before cutover
review, per the accepted sequencing decision. Nothing here may run during the
Luma merge (shared `message-*` primitives).

## Principle

Copy t3code's **seams**, not its surface. What is battle-tested in t3 is the
architecture: pure logic modules with test siblings, a virtualizer hidden
behind a measurement interface, scroll state in refs with generation
counters, and a discriminated row union as the design center. What is not
boring is the specific virtualizer. The plan therefore encapsulates so that:

- every piece of scroll/row complexity lives inside one owned compound;
- the virtualizer is swappable (or removable) behind one file;
- no shell surface outside the Dev session route imports anything from the
  timeline except its top-level component and types.

If encapsulation cannot be maintained at any phase gate, the phase ships its
fallback (the previous phase's state) rather than leaking.

## The module boundary

One folder, treated as a sealed compound:

```
@/features/dev/timeline/
  rows.ts             row union + pure derivation (tested)
  projection.ts       DevSessionEvent[] + history → rows (pure, tested)
  anchoring.ts        measurement-state interface + pure scroll math (tested)
  scroll-engine.ts    modes, refs, generation counters (thin, tested via anchoring)
  DevTimeline.tsx     the ONLY component; the ONLY file allowed to import a
                      virtualizer
  rows/*.tsx          one component per row kind (memoized)
  *.stories.tsx       one story per row kind + streaming + reconnect
```

Encapsulation contract (enforced in review; add a mechanical check only if a
violation actually ships, per the harness rule):

1. Public surface is exactly `DevTimeline`, `DevTimelineRow`, and the
   projection function. Nothing else is exported.
2. Props-only: no endpoint calls, no bridge, no shell-global state. The route
   owns data (`dev-chat-api`) and passes events/history in.
3. The virtualizer import appears in one file. The scroll engine consumes the
   `TimelineListMeasurementState` interface, never the library.
4. Scroll bookkeeping is refs + generation counters — zero React state, so
   the engine cannot cause shell re-renders.
5. The compound registers in the design-system manifest with named states;
   its performance authority entry supersedes `dev-conversation`'s
   (`unbounded`, `streaming`, mount continuity across composer/status
   updates).
6. Bundle: the Dev session route is code-split; the timeline chunk (and any
   virtualizer) never enters the initial bundle. `check:bundle` unchanged.
   `ai` imports stay type-only anywhere outside the projection module.

## The row model (design center)

```ts
type DevTimelineRow =
  | { kind: "message"; message: UIMessage }        // user/assistant, parts inside
  | { kind: "marker"; ... }                        // status/system separators
  | { kind: "work"; lines: BuildLine[]; ... }      // cc_progress group, collapsible
  | { kind: "artifact"; artifact: TurnArtifact }   // staging/check/PR/spec cards
  | { kind: "working"; startedAt: string }         // active-turn indicator
```

Two-level model, per the t3 lesson: **rows contain messages** — a message is
one row kind, not the root abstraction. `UIMessage` parts stay the message
model (official components render them; `@shadcn/helpers/ai-sdk` stories emit
them; type-only import from `ai`). User and assistant rows are separate
components, not one bubble with an `align` prop.

Explicitly out of the row union: turn-fold, minimap, checkpoint/revert,
diff trees, plan approval. These are t3 surface, not SV features — see
"There is no C4."

## Current feature inventory — the parity contract

"Nicely support the current feature list" is checkable: every Dev feature the
shell ships today maps to exactly one home. The timeline compound owns
transcript rendering; everything else stays route-owned and untouched by this
plan.

| Current feature (source) | Home | Timeline row |
| --- | --- | --- |
| User/assistant messages, history (`getDevSession`) | timeline | `message` |
| System/status lines (`status` events) | timeline | `marker` |
| Mayor reasoning wrap-up (`mayor_reasoning`) | timeline | `message` reasoning part (collapsible) |
| Build progress + estimate (`cc_progress`, `cc_estimate`) | timeline | `work` (collapsible; `DevBuildTimeline` inside) |
| Historical + uploaded attachments (`metadata.attachments`, `uploadDevAttachment`) | timeline (display) / route (upload) | `message` file parts |
| Staging ready/failed, recheck (`staging_*`, `recheckDevSession`) | timeline (event) + route (actions) | `artifact` |
| Check state (`check_state`, `checks_ready`) | timeline (event) + route (actions) | `artifact` |
| PR created/updated, promote (`pr_*`, `promoteDevSession`) | timeline (event) + route (action) | `artifact` |
| Spec built/updated, versions, sharing (`spec_updated`, spec endpoints) | timeline (event card) + spec viewer route | `artifact` |
| Visual captures (`DevVisuals`) | timeline (per-turn card) | `artifact` |
| Stream error / reconnect (`error`, EventSource retry) | timeline | `marker` + stream state |
| Active turn indicator, stop (`busy` phases, `stopDevTurn`) | timeline (`working` row) + composer (stop control) | `working` |
| Composer: message, model picker, attachments (`startDevChat`, `getDevModels`) | route — unchanged | — |
| Budget status, saved drafts, completion alerts | route / shell — unchanged | — |
| Session lifecycle, visibility, share/fork (`changeDevSessionLifecycle`, `setDevSessionVisibility`) | route — unchanged | — |
| Dev console | shell overlay — unchanged | — |

GC1 acceptance includes this table: every timeline-owned feature has a named
story state, and every route-owned feature is demonstrated unaffected by the
route's existing fixtures.

## Phases and gates

### C0 — Foundation (early; independent of all waves)

The enabling layer from the Part I gap analysis (#1, #2, #4, #5).
Files: `@/lib/dev-chat-api.ts` types, new `@/lib/dev-session-events.ts`,
`use-dev-session-stream.ts`. No visual change.

- Typed `DevSessionEvent` discriminated union with an explicit
  `unrecognized` case; per-channel ownership recorded in the types (closes
  the "#394 swallowed-then-deduped" comment-encoded routing rules).
- Pure projection (`projectDevConversation`) replacing the `useEffect`
  reducer; transient negative IDs replaced by turn-keyed streaming identity +
  terminal refetch reconciliation.
- Snapshot atomicity: subscribe-then-snapshot ordering (or snapshot seq in
  the history response), closing the history-fetch / bus-subscribe race.
- `startDevChat`, stop, lifecycle, promote, and the drained legacy SSE keep
  byte-identical behavior; no second protocol is introduced.

**Gate GC0:**

- projection unit tests: replay, duplicate `_seq`, out-of-order delivery,
  unknown event types, mid-turn snapshot+refetch reconciliation;
- Playwright reconnect fixture: kill the EventSource mid-turn, assert
  replayed events do not duplicate transcript content;
- snapshot-race fixture: an event arriving inside the connect window is
  neither dropped nor duplicated;
- existing route tests green; zero rendering diff.

### C1 — Row model and structured rendering (after Luma + successor contracts)

`DevTimeline` renders the row union with official components. Still
`MessageScroller` scrolling — no scroll behavior change.

- Reasoning as a collapsible owned pattern on **Base UI** primitives
  (AI Elements is reference design only; no Radix enters `@/components`).
- `cc_progress` becomes collapsible `work` rows (DevBuildTimeline inside);
  estimates in the turn footer; markers stop impersonating messages.
- Turn artifacts (staging ready, checks, PR created, spec updated) become
  `artifact` cards inline in the transcript.
- Markdown, if introduced here, ships with `rehype-sanitize` from the first
  commit — not after.
- `dev-conversation.stories.tsx` renders helper `UIMessage` output with no
  translation layer; the `toConversation` shim is deleted.

**Gate GC1:**

- a story per row kind + streaming + reconnect states, production copy, both
  themes;
- accessibility: reasoning collapse is keyboard-operable and announced;
  stream state changes are polite live-region updates; axe passes both
  themes;
- content: state copy (reconnecting, stopped, estimate) passes the content
  guidelines; no internal vocabulary (`mayor`, `cc`) reaches Glance or Read
  layers — phase names are Expert-layer only;
- the parity-contract table above is satisfied: every timeline-owned row has
  a named state, every route-owned feature is unaffected.

### C2 — Scroll engine (anchor-to-new-turn)

The owned scroll engine replaces `MessageScroller` **inside the Dev timeline
only** (the AGENTS scroller rule transfers to the compound: the timeline owns
anchoring; no route may add a competing scroll hook). Plain DOM list — still
no virtualizer.

- `anchoring.ts`: the measurement-state interface + pure metrics
  (t3's `getAnchoredTurnMetrics` shape), fully unit-tested.
- Three modes: `following-end`, `anchoring-new-turn` (sent message pins to
  viewport top; response grows beneath), `free-scrolling` (any user gesture
  opts out; generation counter invalidates in-flight restores).
- `[overflow-anchor:none]` on the viewport; scroll-to-bottom pill with
  show-debounce/immediate-hide.

**Gate GC2:** interaction fixtures for all three modes and mode transitions
(send during free-scroll, reconnect during anchor, jump-to-latest); no
regression in mount continuity; desktop + narrow mobile.

### C3 — Virtualization (conditional, behind the seam)

**Entry condition, not assumption:** a deterministic 500+ message fixture is
profiled on the C2 plain list (mid-tier mobile CPU throttle). If interaction
stays within budget, C3 is skipped and the authority's `review-later` flag is
discharged with the profile as evidence. Only if it fails:

- Introduce `@legendapp/list` (or the then-best candidate) **pinned exact**,
  imported in `DevTimeline.tsx` only, consuming the same `anchoring.ts` math
  through the measurement interface.
- Per-kind recycling (`getItemType`), context-propagated row state, stable
  `renderItem` with zero closure deps, `useStableRows` referential identity.
- A build-time fallback to the C2 plain list must keep working — the
  virtualizer is removable by reverting one file.

**Gate GC3:** the same C2 interaction fixtures pass virtualized; screen-reader
transcript continuity is explicitly evidenced (virtualization removes
offscreen DOM — this is the a11y risk t3 does not visibly solve); **real
Flutter WebView evidence on iOS and Android** for scroll/anchor behavior —
this gate cannot be self-certified from desktop Chromium; profile shows the
win that justified entry.

### There is no C4

The plan ends at C3. t3-specific surface (turn-fold, minimap, per-message
copy, plan approval, checkpoints) is not adopted, deferred, or queued — it is
**out of scope by decision**. The goal of this plan is the best possible
technical execution of the Dev features Social Vibecoding already ships, not
feature growth. Any future addition reopens this plan with its own recorded
decision; nothing rides in as a "nicety."

## Adopt / adapt / decline (from t3code)

| Adopt as-is (pattern) | Adapt (SV shape) | Decline |
| --- | --- | --- |
| Discriminated row union | role-specific row components over `Bubble` variants | Lexical composer (current composer stays) |
| Pure logic modules + test siblings | `work` rows = `cc_progress` groups | diff renderer (`@pierre/diffs`) — PRs/staging own diffs |
| Measurement-state seam | artifact cards = SV's staging/check/PR/spec | checkpoint/revert rows |
| Refs + generation counters | markdown with `rehype-sanitize` | minimap |
| `getItemType` recycling pools | anchor-to-top-of-new-turn as default follow | provider/model picker machinery (exists) |
| `[overflow-anchor:none]` + pill debounce | scroll-to-bottom pill via existing button pattern | timeline as a 2,000-line single file — rows split per kind |

## Risks and their containment

| Risk | Containment |
| --- | --- |
| Virtualizer immaturity / RN-origin DOM build | conditional entry (C3), exact pin, one-file import, revert-to-C2 fallback |
| WebView behavior unknown | hard host-evidence gate in GC3; static C2 ships to users if it fails |
| A11y regression from virtualization | explicit SR evidence in GC3; C2 keeps full DOM |
| Complexity leaking into shell | sealed folder contract; public surface of three exports; review checklist |
| Schedule risk on the last pre-release milestone | C0 lands months earlier; C1/C2 are independently shippable; every gate has a shippable fallback |
| Scope creep toward t3's feature surface | out of scope by decision ("There is no C4"); the parity inventory is the complete feature list |
| Second primitive base entering the shell | AI Elements is reference design only; no Radix in `@/components` |
| New runtime dependency | no `@tanstack/*` install; `ai` imports type-only outside the projection module; `check:bundle` unchanged |

## Reference implementations

Two named references for the presentation layer. Both are **reference
designs, not install sources** — every component we ship is owned source on
the local official Base UI primitives, per the refinement guide's authority
split.

**t3code chat** (`pingdotgg/t3code`, `apps/web/src/components/chat/`) — the
reference for *interaction architecture*:

| Problem | Reference |
| --- | --- |
| Row union + derivation | `MessagesTimeline.logic.ts` (pure, tested) |
| Scroll math + measurement seam | `timelineScrollAnchoring.ts` |
| Follow/anchor/free state machine | `ChatView.tsx` refs + generation counters |
| Virtualizer integration shape | `MessagesTimeline.tsx` (`getItemType`, context-propagated row state, stable `renderItem`) |
| Referential stability | `useStableRows` / `computeStableMessagesTimelineRows` |
| Markdown hygiene | `react-markdown` + `rehype-sanitize` |

**Vercel AI Elements** (`elements.ai-sdk.dev`) — the reference for *component
composition and states* of part renderers:

| Problem | Reference |
| --- | --- |
| Collapsible reasoning block | `Reasoning` |
| Message/conversation anatomy | `Message`, `Conversation` |
| Task/progress grouping (our `work` rows) | `Task`, `Chain of Thought` (composition only — its step/tool data model is ahead of our server events) |
| Attachment and source presentation | `Attachments`, `Sources` |

Caveats carried over from Part I: Elements components sit on Radix
primitives — no Radix enters `@/components`; port composition onto Base UI.
t3's virtualizer is adopted conditionally (C3) behind the measurement seam,
never as a direct architectural dependency. When either reference and our
authority disagree, the authority wins.

## Relationship to existing authority

- Discharges `dev-conversation`'s `virtualization: review-later` and
  `profile-before-stable` flags with actual evidence (C3 entry profile, or
  its absence if C3 is skipped).
- The compound enters `design-system.manifest.json` at C1 with named states;
  `DevConversation` follows the deprecate → migrate → delete path once the
  route consumes `DevTimeline`.
- Motion stays governed by the Motion wave gate; nothing in this plan
  installs or requires it. `anchoring-new-turn` is scroll positioning, not
  animation.
- Content guidelines apply to every row's copy; phase vocabulary is
  Expert-layer only.
- The helper split stays as is: `@shadcn/helpers/ai-sdk` for deterministic
  evidence, `@shadcn/helpers/tanstack-ai` unused.
- This plan slots into the **Dev/chat compounds** audit batch and would be a
  candidate lane after the successor-contract wave — it must not run during
  the Luma merge (shared `message-*` primitive files).
