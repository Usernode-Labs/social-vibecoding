/**
 * The Dev board card, as a plain view model.
 *
 * ── Why a model and not props per card type ───────────────────────────
 *
 * Six card renderers (issue, proposal, governance, own session, shared
 * session, merged) plus the settled close-issue row all assemble the SAME
 * four bands through one shared builder, and they have five consumers (the
 * feed, the kanban board, the In-progress strip, the Completed list and the
 * topic head). A card cannot convert before its consumers and a consumer
 * cannot convert before the cards it draws — so what converts is the shape
 * they share, and each renderer becomes a builder for it.
 *
 * ── The rule about where vocabulary lives ─────────────────────────────
 *
 * Everything here is RESOLVED data. `DEV_CARD_ICONS`, `ASSIGNEE_AVATAR_TINTS`,
 * `CATEGORY_CUSTOM_TINTS`, `_WORK_TONE_CLS`, `_priorityMeta`, `_categoryMeta`,
 * `statusPillState`, `blockReasons` — every table and every derivation stays
 * in app-view.js, and the builder puts the ANSWER in the model: the icon
 * arrives as its tint classes and its SVG path, a chip as its label and its
 * tint. Nothing in this feature re-derives a class name.
 *
 * That is not tidiness. app-view.js is a classic script this bundle cannot
 * import, and Tailwind's extractor is a regex over source text (AGENTS.md) —
 * so a palette copied over here would exist in two places, with only one of
 * them able to change colour. Resolved-data-in, markup-out keeps the tables
 * on the side that owns them and still compiles every class, because the
 * literals stay where they always were.
 *
 * ── What is deliberately still a string ───────────────────────────────
 *
 * `KudosSlot`. `Kudos.renderButton` builds the markup and `Kudos.attach`
 * binds it, `Kudos._refreshButton` writes the count into it afterwards and
 * `Kudos._renderPopover` fills the hover card — four writers in another
 * module. That is the controller-host seam AGENTS.md documents: React
 * renders the host once, empty, with a constant className and never looks
 * inside it. Nothing else on a card needs one.
 */

/** A resolved type-chip: the tint classes and the SVG path, from DEV_CARD_ICONS. */
export interface CardIconSpec {
  /** The OpenMoji mark for this card type; `path` remains the fallback. */
  emoji?: string;
  tint: string;
  path: string;
  /** #250 — the whole chip animates while an auto-solve run is generating. */
  pulse?: boolean;
  title?: string;
  small?: boolean;
}

/**
 * One segment of the meta line, joined with ' · '.
 *
 * Structured rather than pre-joined HTML because three of the four kinds
 * carry an interactive or tinted element (the PR/issue number link, the ★
 * bounty count, a merged card's revert link) and a card that concatenated
 * them would have to trust a caller's escaping.
 */
export type MetaPart =
  | { t: 'text'; s: string }
  | { t: 'link'; href: string; s: string; cls: string; title?: string }
  | { t: 'span'; s: string; cls: string; title?: string };

/** The composite status pill's derived state — AppView.statusPillState verbatim. */
export interface StatusPillState {
  tier: number;
  key: string;
  label: string;
  tone: string;
  fill?: boolean | 'full-yes' | 'full-no';
  yes: number;
  no: number;
  majority: number;
  advisory: number;
  lock: boolean;
  dot?: boolean;
  spinner?: boolean;
  countdown?: number;
  suffix?: string;
  reject?: boolean;
  title?: string;
  reasons?: { key: string; label: string; detail: string; soft?: boolean }[];
}

/**
 * A named call back into AppView, with its arguments.
 *
 * The cards used to carry `onclick="AppView.castVote(12, 'yes', '<sha>')"` in
 * their markup, which is what an innerHTML card had instead of a closure. A
 * React card could hold the closure — but the model has to survive being
 * published through a plain store (lib/plain-store.js), so it stays
 * serialisable and the component dispatches by name. `AppView` is the only
 * receiver, and an unknown name is a no-op rather than a throw.
 */
export interface ActionRef {
  fn: string;
  args?: (string | number | boolean | null)[];
}

/** The icon Preview affordance, in its three states. */
export type PreviewSpec =
  | { state: 'live'; sessionId: number; url: string; title: string; iconOnly: boolean }
  | { state: 'building'; title: string; iconOnly: boolean }
  | { state: 'error'; title: string; iconOnly: boolean };

/** A text pill in the action band, or a disabled one that explains itself. */
export interface ActionSpec {
  key: string;
  label: string;
  /** Rendered as text, so a label with an entity in it arrives decoded. */
  title?: string;
  cls?: string;
  disabled?: boolean;
  act?: ActionRef;
  /**
   * Append the clicked button itself to the call — the model can't hold a
   * node, and `promoteImportedSession(id, this)` disables its button for
   * the duration of the POST.
   */
  passNode?: boolean;
  /** The kudos button — a controller host, see the header. */
  kudos?: number;
  /**
   * The LABELLED Preview affordance, for the topic head's action list. The
   * card's own eye rides in `actionPreview` / the rail instead; this is the
   * same component with `iconOnly: false`, and it covers the two states
   * that are a badge rather than a button (building, unavailable).
   */
  preview?: PreviewSpec;
  /** #313/#827 — "Explore in dev chat", claimed by a delegated handler. */
  explore?: number;
}

/** Everything that can appear in the status band, as a tagged union. */
export type BadgeSpec =
  /** A plain tinted chip: work state, imported, paused, checks, console errors. */
  | { t: 'chip'; key: string; cls: string; label: string; title?: string; spinner?: boolean; data?: Record<string, string> }
  /** The same chip with a click — the work-state chip that opens its target. */
  | { t: 'chipBtn'; key: string; cls: string; hover: string; label: string; title?: string; spinner?: boolean; data?: Record<string, string>; act: ActionRef }
  /** 💬 N. Always rendered, hidden at 0, so a live bump has a target. */
  | { t: 'chat'; key: string; count: number }
  /** A metadata chip (priority / assignee / category). */
  | { t: 'attr'; key: string; field: 'priority' | 'assignee' | 'category'; targetType: string; targetRef: string | number; cls: string; hover: string; title: string; count: number; readonly: boolean; label: AttrLabel }
  /** Closes #N — in-app (button) or on GitHub (anchor). */
  | { t: 'issueChip'; key: string; n: number; prefix: string; cls: string; title: string }
  | { t: 'issueLink'; key: string; n: number; href: string; verb: string; cls: string; title: string }
  /** MergeStatus.badgeHtml's descriptor, as data. */
  | { t: 'ms'; key: string; tone: string; label: string; title?: string; spinner?: boolean; glyph?: string; votes?: { yes: number; majority: number; reached: boolean } }
  /** BuildVenues.chipHtml — where this session's turns run. */
  | { t: 'venue'; key: string; label: string; title: string };

/** The three shapes an attribute chip's label takes. */
export type AttrLabel =
  | { kind: 'glyph'; glyph: string; text: string }
  | { kind: 'dot'; cls: string; text: string }
  | { kind: 'avatar'; tint: string; initial: string; text: string }
  | { kind: 'avatarEmpty'; text: string };

/** The title band: the text, plus the two things that ride beside it. */
export interface TitleSpec {
  text: string;
  /** A tinted run BEFORE the title — "↩ Revert of". */
  lead?: { s: string; cls: string };
  /** A muted run AFTER it — the close-issue row's author. */
  trail?: { s: string; cls: string };
  /** #133/#556 — the author-only inline edit pencil, topic head only. */
  edit?: { issue: number };
  /**
   * #665 — the inline title editor, replacing `beginIssueTitleEdit`'s
   * innerHTML write into the title div. While set the band renders an
   * uncontrolled input seeded with `initial`; save/cancel stay module
   * methods that read `#dev-issue-title-input` by id, exactly as before,
   * and `#dev-issue-title-error` stays a module-written node.
   */
  editing?: { issue: number; initial: string };
  /** The full text, for the clamp's own tooltip. */
  title: string;
}

/** An extra row under the four bands (the work note, the admin claim list). */
export type ExtraSpec =
  | { t: 'note'; key: string; text: string; workState: string }
  | { t: 'claims'; key: string; claims: { username: string; userId: number; issue: number }[] };

/** The card's right-edge rail: ⋯ at the top, the eye at the bottom. */
export interface RailSpec {
  /** The registry key `_cardMenuTriggerHtml` registered the descriptors under. */
  menuKey?: string;
  chevron: boolean;
  preview?: PreviewSpec | null;
}

export interface DevCardModel {
  /** Stable across repaints — the React key and the store's identity. */
  key: string;
  /** The outer element's full class attribute. */
  cls: string;
  /** data-* and title on the outer element, exactly as the string card wrote them. */
  attrs: Record<string, string>;
  icon: CardIconSpec | null;
  title: TitleSpec;
  meta: MetaPart[];
  /** The composite pill. `inline` is the detail head's capsule variant. */
  pill?: { state: StatusPillState; inline: boolean } | null;
  /** Closes-#N pills — their own opt because they lead the band, outside the cap. */
  linked: BadgeSpec[];
  badges: BadgeSpec[];
  chatCount: number | null;
  actions: ActionSpec[];
  /** The eye, when it rides in the action band rather than the rail. */
  actionPreview?: PreviewSpec | null;
  rail: RailSpec;
  extra: ExtraSpec[];
  /** Board cards reserve every band; the detail head collapses empty ones. */
  dense: boolean;
  /** The detail head, which shows every chip rather than the first four. */
  uncapped: boolean;
}

// ── The two list surfaces, as view models ─────────────────────────────

/** A collapsed archived-sessions row (the toggle's list). */
export interface ArchivedRow {
  id: number;
  label: string;
  /** The muted card shell's full class attribute, from the module's constants. */
  cls: string;
  icon: CardIconSpec;
}

/** A section divider (the In-progress groups' captions). */
export interface DividerSpec {
  label: string;
  title: string;
}

/**
 * One row of a card column — the feed's pinned-sessions block and the
 * kanban In-progress column share the shape.
 */
export type ListRow =
  | { t: 'card'; key: string; card: DevCardModel; commentsFor?: number | null }
  | { t: 'divider'; key: string; d: DividerSpec }
  | { t: 'note'; key: string; text: string }
  | { t: 'archived'; key: string; rows: ArchivedRow[] };

/** A list surface's trailing affordance. */
export type FooterSpec =
  | { kind: 'showMore'; n: number }
  | { kind: 'loadMerged'; loading: boolean; n?: number | null }
  | { kind: 'github'; href: string }
  | { kind: 'moreCompleted'; n: number };

export interface DevFeedView {
  /**
   * True until the board's first fetch lands. The stream draws placeholder
   * cards and the empty note is withheld — see ../card/skeleton.tsx for why
   * "No activity yet" on a screen that is still loading is worse than slow.
   */
  loading?: boolean;
  /** The pinned own-sessions block above the stream. Empty draws nothing. */
  block: ListRow[];
  /** The no-activity note, with its load-failure prefix. */
  emptyNote: { loadFailed: boolean } | null;
  entries: ListRow[];
  footer: FooterSpec | null;
}

export interface KanbanColView {
  key: string;
  title: string;
  count: number;
  hint?: string | null;
  rows: ListRow[];
  /** The no-cards note ('Nothing here yet' / 'No matching cards'), or null. */
  empty?: string | null;
  footer: FooterSpec | null;
}

export interface DevKanbanView {
  activeTab: string;
  cols: KanbanColView[];
  /**
   * True until the board's first fetch lands. Every column draws placeholder
   * cards, and its count draws as a bar rather than `· 0` — an empty board
   * and an unloaded one look identical otherwise, which is the bug.
   */
  loading?: boolean;
}
