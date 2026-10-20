/**
 * The new Needs you review flow's data, as plain functions (no React, no DOM),
 * so the pictures' crops and the feed's order can be tested on their own.
 *
 * Its rows are the Communities tab's own feed (GET /api/workshop/needs-feed,
 * ../workshop/needs-reel.tsx `NeedsFeedItem`), and its pictures are the
 * change's before & after shots shaped the way every other feed shapes them
 * (`AppView._workshopVisuals`): screens, each a before and an after still of
 * the same viewport with the areas that differ.
 */

// Type only: the reel imports the project screen, which imports this flow.
import type { NeedsFeedItem } from '../workshop/needs-reel';

/**
 * A summary written in Markdown, as one plain paragraph: the reel's own rule
 * (../workshop/needs-reel.tsx plainSummary), kept here so this module does
 * not import the reel at runtime.
 */
export function plainSummary(md: string | null | undefined): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Box = { x: number; y: number; w: number; h: number };
export type Region = {
  n: number;
  b: number[] | null;
  a: number[] | null;
  bMark?: number[] | null;
  aMark?: number[] | null;
};
export type ReviewScreen = {
  viewport: string;
  width: number;
  /** Image pixels per CSS pixel the stills were saved at (1 before density was recorded). */
  density?: number;
  before: { url: string; height: number };
  after: { url: string; height: number };
  regions: Region[];
};
/** What a card's picture is drawn from, best first. */
export type Picture =
  /** The change's own before & after screens (the slider). */
  | { kind: 'shots' }
  /** An older change's single capture pair. */
  | { kind: 'pair' }
  /** A change nobody can see, or whose shots are not taken yet: its benefit, drawn. */
  | { kind: 'benefit'; benefit: BenefitKind; area: AreaKind; token: { before: string; after: string } | null }
  /** A group decision, drawn by its kind. */
  | { kind: 'decision'; decision: DecisionKind };

export type BenefitKind = 'fixed' | 'stability' | 'clarity' | 'more' | 'results' | 'speed' | 'effort' | 'security' | 'behind';
export type DecisionKind = 'close_issue' | 'rename' | 'secret_change' | 'decision';
export type AreaKind = 'agents' | 'proposals' | 'platform' | 'projects' | 'accounts' | 'admin' | 'messages' | 'challenges' | 'app';

export type ReviewItem = {
  key: string;
  kind: 'proposal' | 'governance';
  id: number;
  title: string;
  summary: string;
  epoch: number | null;
  author: string | null;
  at: string | null;
  number: number | null;
  app: NeedsFeedItem['app'];
  stagingUrl: string | null;
  /** The screens to compare, phone screens first when there are any. */
  screens: ReviewScreen[];
  /** An older change's single capture pair, with no regions. */
  pair: { before: string | null; after: string | null } | null;
  ground: string;
  /** The title shot's own still: the shots run's focus crop of the first change, when it has one. */
  titleImage: { url: string; width: number; height: number } | null;
  /** What the card and the hero draw. */
  picture: Picture;
  /** The change in one short line, under its picture on its page. */
  line: string;
  approve: boolean;
  advisory: boolean;
  uncounted: boolean;
};

/**
 * The ground under a change's picture: how much it changes, said in colour.
 * Calm cream for one spot, warm yellow for a few, coral for a lot. The same
 * three grounds the title shots were designed with.
 */
export const GROUNDS = { quiet: '#ECE6CE', notable: '#F7E07A', loud: '#F2958A' } as const;

export function groundFor(screens: ReviewScreen[]): string {
  const spots = screens.reduce((n, s) => n + s.regions.length, 0);
  if (screens.length > 1 || spots >= 4) return GROUNDS.loud;
  if (spots >= 2) return GROUNDS.notable;
  return GROUNDS.quiet;
}

/**
 * The ground under a drawn picture: the colours the benefit cards were
 * designed on, so a list of them is not one long beige wall.
 */
const DRAWN_GROUNDS: Record<BenefitKind | 'decision', string> = {
  fixed: GROUNDS.notable, stability: GROUNDS.notable, clarity: GROUNDS.notable, more: GROUNDS.notable,
  speed: GROUNDS.notable, results: GROUNDS.quiet, effort: GROUNDS.quiet, security: GROUNDS.loud,
  behind: GROUNDS.quiet, decision: GROUNDS.quiet,
};

const BENEFITS: readonly BenefitKind[] = ['fixed', 'stability', 'clarity', 'more', 'results', 'speed', 'effort', 'security', 'behind'];
const AREAS: readonly AreaKind[] = ['agents', 'proposals', 'platform', 'projects', 'accounts', 'admin', 'messages', 'challenges', 'app'];

/** The Homeroom platform's own project: its areas are named; any other project's are "app". */
export const PLATFORM_SLUG = 'usernode-2d5619';

/**
 * Which benefit a change brings, from its words, for a change that declared
 * none (every change from before benefits were declared). The rules follow
 * the research's definitions: Fixed failed every time, Stability failed
 * sometimes; work no member would notice is Behind the scenes. First match
 * wins, so the narrower words come first.
 */
export function guessBenefit(title: string, summary = ''): BenefitKind {
  // The title says what the change is. The summary is read only to spot work
  // nobody would notice ("Nothing in the game changes"), which titles rarely say.
  const fromTitle = benefitRules(title);
  if (fromTitle) return fromTitle;
  const t = ` ${String(summary || '').toLowerCase()} `;
  if (/\bnothing (in the [a-z]+ |people see |)changes\b|\blooks the same\b|\bnothing changes in how\b/.test(t)) return 'behind';
  return 'more';
}

function benefitRules(text: string): BenefitKind | null {
  const t = ` ${String(text || '').toLowerCase()} `;
  const has = (re: RegExp) => re.test(t);
  const starts = (re: RegExp) => re.test(t.trimStart());
  if (has(/\b(tests?|test suite|mock timers?|refactor|lint|typecheck|readme|licen[cs]e|dependenc|upgrade|bump|cleanup|clean up|telemetry)\b/)) return 'behind';
  if (starts(/^(explain|say|says|name|label|word|tell|clarify)\b/)) return 'clarity';
  if (has(/\b(secur|privacy|private|secret|token|permission|leak|trackers|tracking|analytics|password|encrypt|redact|consent)/)) return 'security';
  if (has(/\b(faster|speed up|slow|load less|loads less|lighter|cache|latency|performance|quicker|instant)/)) return 'speed';
  if (has(/\b(crash|crashes|restart|retries|flaky|stall|stuck|hang|timeout|time out|race|intermittent|reliab|recover|survive)\b/)) return 'stability';
  if (has(/\b(fix|fixes|fixed|bug|broken|fails?|failed|failing|wrong|missing|missed|no longer|stop|stops)\b/)) return 'fixed';
  if (has(/\b(one tap|one-tap|fewer|less work|automatic|automatically|shortcut|skip|repeat|remember|quick)\b/)) return 'effort';
  if (has(/\b(clear|clearer|explain|explains|wording|rename|plainly|error|errors|validation|hint)\b/)) return 'clarity';
  if (has(/\b(better|improve|quality|accurate|smarter|ranking|polish|calmer|cleaner|nicer|redesign)/)) return 'results';
  if (starts(/^(add|show|let|lets|give|new|make|allow|support|enable|create|bring)\b/)) return 'more';
  return null;
}

/** Where a change is felt: a Homeroom area, or the project's own app. */
export function guessArea(text: string, slug: string): AreaKind {
  if (slug && slug !== PLATFORM_SLUG) return 'app';
  const t = ` ${String(text || '').toLowerCase()} `;
  const has = (re: RegExp) => re.test(t);
  if (has(/\b(admin)/)) return 'admin';
  if (has(/\b(challenge|season|points|leaderboard)/)) return 'challenges';
  if (has(/\b(agent|mayor|bot|worker|claude|codex|dev chat|dev-chat|session)/)) return 'agents';
  if (has(/\b(proposal|vote|voting|merge|change page|shots|checks?|preview|staging|request)/)) return 'proposals';
  if (has(/\b(message|chat|channel|discussion|thread|notification|inbox|dm)/)) return 'messages';
  if (has(/\b(sign in|sign-in|signin|account|password|email|profile|invite|wallet|log in)/)) return 'accounts';
  if (has(/\b(project|community|communities|workshop|hub|app page|discover)/)) return 'projects';
  return 'platform';
}

/**
 * The change in one short line: its first declared change (written as one
 * sentence for exactly this), else the first sentence of its summary, cut at
 * a word so it never becomes a wall of text. The full summary stays in About.
 */
export function changeLine(claim: string | null | undefined, summary: string | null | undefined, max = 140): string {
  const pick = String(claim || '').trim() || firstSentence(String(summary || ''));
  if (pick.length <= max) return pick;
  const cut = pick.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function firstSentence(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
    // A summary written under headings starts with the heading's words.
    .replace(/^(what changes( for people)?|what this changes|what it does|summary|tl;?dr|overview)\s*[:.\-]?\s+/i, '');
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).trim();
}

/** A title as people read it: the request prefix a bot change carries is dropped. */
export function cleanTitle(title: string): string {
  return String(title || '')
    .replace(/^\s*implement this change in the app:\s*/i, '')
    .replace(/^\s*title:\s*/i, '')
    .trim();
}

/** A phone screen when there is one: this flow is drawn for the phone first. */
export function pickScreens(screens: ReviewScreen[]): ReviewScreen[] {
  const phone = screens.filter((s) => s.viewport === 'mobile' || s.width < 500);
  return phone.length ? phone : screens;
}

type Visuals = {
  screens?: ReviewScreen[];
  before?: string | null;
  after?: string | null;
  protected?: boolean;
} | null;

/** A legacy pair's id is served from /visuals/<id>; a shots url is already a path. */
function pairUrl(value: string | null | undefined, isProtected: boolean): string | null {
  if (!value) return null;
  return isProtected || value.startsWith('/') ? value : `/visuals/${value}`;
}

/**
 * The feed's items as the flow draws them. `shape` is
 * `AppView._workshopVisuals` (passed in so this stays testable).
 */
export function toReviewItems(
  items: NeedsFeedItem[],
  shape: (visuals: unknown, shots: unknown) => Visuals,
): ReviewItem[] {
  return items.map((item) => {
    const change = item.kind !== 'governance';
    const v = change && (item.shots || item.visuals) ? shape(item.visuals || null, item.shots || null) : null;
    const screens = pickScreens(Array.isArray(v?.screens) ? v!.screens! : []);
    const pair = !screens.length && v && (v.before || v.after)
      ? { before: pairUrl(v.before, !!v.protected), after: pairUrl(v.after, !!v.protected) }
      : null;
    const raw = item as NeedsFeedItem & { staging_url?: string | null };
    const shots = (item.shots && typeof item.shots === 'object' ? item.shots : {}) as {
      claims?: Array<{ claim?: string }>;
      artifacts?: Array<{ url?: string; width?: number; height?: number }>;
      impact?: string;
      benefit?: { kind?: string; area?: string; before?: string; after?: string } | null;
    };
    const claim = Array.isArray(shots.claims) && shots.claims[0] ? shots.claims[0].claim || '' : '';
    const summary = plainSummary(item.summary);
    const words = `${item.title || ''} ${summary}`;
    // The title shot's own still: the run's crop of the first change (the
    // shaped `after`), sized from its artifact so the plate keeps its shape.
    const afterUrl = v && typeof v.after === 'string' ? v.after : null;
    const art = afterUrl && Array.isArray(shots.artifacts) ? shots.artifacts.find((a) => a && a.url === afterUrl) : null;
    const titleImage = afterUrl && art && Number(art.width) > 0 && Number(art.height) > 0
      ? { url: afterUrl, width: Number(art.width), height: Number(art.height) }
      : null;
    let picture: Picture;
    if (!change) {
      const k = (item.decision as { kind?: string } | undefined)?.kind;
      picture = { kind: 'decision', decision: k === 'close_issue' || k === 'rename' || k === 'secret_change' ? k : 'decision' };
    } else if (screens.length) picture = { kind: 'shots' };
    else if (pair) picture = { kind: 'pair' };
    else {
      // A declared benefit (visible-changes `benefit`, on the feed row and in
      // its shots) wins over the guess; history has none, so it is guessed.
      const raw2 = (item as unknown as { benefit?: typeof shots.benefit }).benefit || shots.benefit;
      const declared = raw2 && BENEFITS.includes(raw2.kind as BenefitKind) ? raw2 : null;
      const area = declared && AREAS.includes(declared.area as AreaKind) ? declared.area as AreaKind : guessArea(words, item.app?.slug || '');
      picture = {
        kind: 'benefit',
        benefit: declared ? declared.kind as BenefitKind : guessBenefit(item.title || '', summary),
        area,
        token: declared && declared.before && declared.after ? { before: String(declared.before), after: String(declared.after) } : null,
      };
    }
    const ground = picture.kind === 'benefit' ? DRAWN_GROUNDS[picture.benefit]
      : picture.kind === 'decision' ? DRAWN_GROUNDS.decision
      : groundFor(screens);
    return {
      key: `${change ? 'proposal' : 'governance'}:${item.id}`,
      kind: change ? 'proposal' : 'governance',
      id: item.id,
      title: cleanTitle(item.title || ''),
      summary,
      epoch: item.epoch ?? null,
      author: item.author || null,
      at: item.at || null,
      number: item.number ?? null,
      app: item.app,
      stagingUrl: typeof raw.staging_url === 'string' && raw.staging_url ? raw.staging_url : null,
      screens,
      pair,
      ground,
      titleImage,
      picture,
      line: changeLine(claim, summary),
      approve: !!item.approve,
      advisory: !!item.advisory,
      uncounted: !!item.uncounted,
    };
  });
}

/** A region's box on one side, or a mark line's box (zero height). */
export function regionBox(r: Region, side: 'before' | 'after'): Box | null {
  const box = side === 'before' ? r.b : r.a;
  if (box && box.length === 4) return { x: box[0], y: box[1], w: box[2], h: box[3] };
  const mark = side === 'before' ? r.bMark : r.aMark;
  if (mark && mark.length === 3) return { x: mark[0], y: mark[1], w: mark[2], h: 0 };
  return null;
}

/** Everything that differs, on the given sides, with room around it, kept on the screen. */
export function focusBox(screen: ReviewScreen, sides: Array<'before' | 'after'>, pad: number): Box {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const boxes = screen.regions.flatMap((r) => sides.map((s) => regionBox(r, s))).filter((b): b is Box => !!b);
  if (!boxes.length) return { x: 0, y: 0, w: W, h: Math.min(H, W * 0.75) };
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.w)) + pad);
  const y1 = Math.min(H, Math.max(...boxes.map((b) => b.y + Math.max(b.h, 2))) + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export type Placement = { scale: number; tx: number; ty: number };

/**
 * Where the whole screen goes so `box` sits in the middle of a `view`, as
 * large as fits but never past `maxScale`, without showing past the screen's
 * edges when the screen is larger than the view. ONE placement for both
 * sides, so a seam between them never moves what it compares.
 */
export function placeBox(
  screen: ReviewScreen, box: Box, view: { w: number; h: number }, maxScale = 1,
): Placement {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const scale = Math.max(0.05, Math.min(maxScale, view.w / box.w, view.h / box.h));
  const sw = W * scale;
  const sh = H * scale;
  const centre = (size: number, scaled: number, mid: number) => (scaled <= size
    ? (size - scaled) / 2
    : Math.max(size - scaled, Math.min(0, size / 2 - mid * scale)));
  return { scale, tx: centre(view.w, sw, box.x + box.w / 2), ty: centre(view.h, sh, box.y + box.h / 2) };
}

/**
 * The title shot: the after side's changed area, as a plate sized to its own
 * proportions inside the card's room (at most `room.w` by `room.h`).
 * Returns the plate's size and where the screen sits inside it.
 */
export function titleCrop(screen: ReviewScreen, room: { w: number; h: number }): { w: number; h: number; place: Placement } {
  // The biggest thing that changed, with room around it: a union of every
  // change on a busy screen came out as the whole screen, shrunk.
  const big = largestRegion(screen);
  const W = screen.width;
  const H = screen.after.height;
  const pad = 24;
  const box = big
    ? (() => {
      const x0 = Math.max(0, big.x - pad);
      const y0 = Math.max(0, big.y - pad);
      const x1 = Math.min(W, big.x + big.w + pad);
      const y1 = Math.min(H, big.y + Math.max(big.h, 2) + pad);
      return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    })()
    : focusBox(screen, ['after'], 20);
  const k = Math.min(2, room.w / box.w, room.h / box.h);
  const w = Math.round(box.w * k);
  const h = Math.round(box.h * k);
  return { w, h, place: { scale: k, tx: -box.x * k, ty: -box.y * k } };
}

/* ── The seam's feel ───────────────────────────────────────────────────── */

/**
 * iOS-style resistance past an edge: the further the finger goes, the less
 * the seam follows. `c` is the rubber band's stiffness (0.55 feels like iOS).
 */
export function rubberBand(overshoot: number, width: number, c = 0.55): number {
  const d = Math.abs(overshoot);
  const out = (1 - 1 / ((d * c) / width + 1)) * width;
  return overshoot < 0 ? -out : out;
}

/**
 * Soft stops: near a stop the seam is pulled onto it, strongest at the stop
 * and gone by `radius`. Stops are the left and right edges of each changed
 * area (with a little room) and its middle.
 */
export function seamStops(screen: ReviewScreen, place: Placement, width: number): number[] {
  const stops: number[] = [];
  for (const r of screen.regions) {
    for (const side of ['before', 'after'] as const) {
      const b = regionBox(r, side);
      if (!b || b.w <= 0) continue;
      const x0 = b.x * place.scale + place.tx;
      const x1 = (b.x + b.w) * place.scale + place.tx;
      [x0 - 14, (x0 + x1) / 2, x1 + 14].forEach((x) => { if (x > 8 && x < width - 8) stops.push(x); });
    }
  }
  return stops.sort((a, b) => a - b);
}

export function magnet(x: number, stops: number[], radius = 18, strength = 0.8): number {
  let out = x;
  for (const p of stops) {
    const d = x - p;
    const u = Math.abs(d) / radius;
    if (u < 1) {
      const w = (1 - u * u) * (1 - u * u);
      out -= d * strength * w;
    }
  }
  return out;
}

/**
 * The feed's order: changes first, as they came, then group decisions. A run
 * of "Close issue" decisions at the top once buried every change under them.
 */
export function orderForReview(items: ReviewItem[]): ReviewItem[] {
  return [...items.filter((i) => i.kind !== 'governance'), ...items.filter((i) => i.kind === 'governance')];
}

/** The largest changed area on a screen's after side, for a title shot that zooms in on it. */
export function largestRegion(screen: ReviewScreen): Box | null {
  let best: Box | null = null;
  for (const r of screen.regions) {
    const b = regionBox(r, 'after') || regionBox(r, 'before');
    if (b && (!best || b.w * Math.max(b.h, 2) > best.w * Math.max(best.h, 2))) best = b;
  }
  return best;
}

/**
 * The next change after `index` that still has no vote, wrapping round once
 * to the ones behind you; -1 when every other one has a vote from you. Group
 * decisions are skipped: they open their own page and none is voted on here.
 */
export function nextIndex(items: ReviewItem[], index: number, votes: Record<string, unknown> = {}): number {
  for (let step = 1; step < items.length; step++) {
    const i = (index + step) % items.length;
    const it = items[i];
    if (!it || it.kind === 'governance' || votes[it.key]) continue;
    return i;
  }
  return -1;
}

/* ── The title shot's composition (the factory prototype's rules) ─────────
 *
 * Ported from the title-shots factory (research 2026-10-15/16), on what
 * production has: each screen's after still and the areas that differ on it.
 *
 * - ONE piece: its binding side takes 62% of the card, or its real size when
 *   that fits within 92% (never shrunk below real size when real size fits),
 *   centred across and at 48% down.
 * - TWO TO FOUR pieces: a grid at ONE common scale, each piece on its own
 *   plate; of stack, row, 2×2 and lead-left, the layout with the largest
 *   scale wins. Below 0.75× the grid becomes a DECK.
 * - MORE (or a grid that would be too small): a deck, like stacked
 *   notifications. The lead keeps the single rule; up to three plain plates
 *   peek 8px below it, each narrower and melted toward the ground.
 * - A piece is the lowest useful abstraction: the changed area with 16px of
 *   its real surroundings as its plate (flat, house radius, no shadow), never
 *   a thin strip (a strip gets real context above and below it), and never
 *   taller than the card can show (it is cut to a window from its top).
 * - Never pixelated: no piece is shown larger than the pixels captured for
 *   it (`density`, the still's pixels per point; 1 today).
 */

export type TitlePiece = { screen: ReviewScreen; box: Box };
export type TitlePlate = {
  x: number; y: number; w: number; h: number; r: number;
  /** The still, placed so the piece shows inside the plate; null for a deck's back plate. */
  img: { url: string; left: number; top: number; width: number; height: number } | null;
  /** A deck's back plate: one plain tone. */
  fill?: string;
  z: number;
};
export type TitleComposition = { rule: 'single' | 'grid' | 'deck'; plates: TitlePlate[] };

const COVER = { share: 0.62, wide: 0.92, pad: 16, centre: 0.48, minGrid: 0.75, peek: 8, inset: 0.03, radius: 16 };
const VEIL = [0.30, 0.55, 0.80];

function boxArea(b: Box): number { return b.w * Math.max(b.h, 2); }

function near(a: Box, b: Box, gap: number): boolean {
  return a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
}

function union2(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * What a change shows on a screen, as pieces: the areas that belong to a
 * declared change (the unnumbered ones are noise when numbered ones exist),
 * near ones merged, specks dropped, each widened into a readable unit.
 */
export function piecesOf(screens: ReviewScreen[], max = 6): TitlePiece[] {
  const out: TitlePiece[] = [];
  for (const screen of screens) {
    const H = screen.after.height;
    const W = screen.width;
    const all = screen.regions.map((r) => ({ r, b: regionBox(r, 'after') })).filter((x) => x.b && x.b.w > 2) as Array<{ r: Region; b: Box }>;
    const named = all.filter((x) => x.r.n > 0);
    let boxes = (named.length ? named : all).map((x) => x.b);
    // Near areas are one piece; a speck beside a real change is not a piece.
    const merged: Box[] = [];
    for (const b of boxes.sort((p, q) => boxArea(q) - boxArea(p))) {
      const hit = merged.findIndex((m) => near(m, b, 24));
      if (hit >= 0) merged[hit] = union2(merged[hit], b);
      else merged.push(b);
    }
    const biggest = merged.length ? boxArea(merged[0]) : 0;
    boxes = merged.filter((b) => boxArea(b) >= biggest * 0.04);
    for (const b of boxes) {
      // Never a thin strip: a line of text gets the lines around it.
      let { x, y, w, h } = b;
      const minH = Math.min(H, Math.max(56, w / 3.2));
      if (h < minH) { y = Math.max(0, Math.min(H - minH, y - (minH - h) / 2)); h = minH; }
      out.push({ screen, box: { x: Math.max(0, x), y, w: Math.min(W - Math.max(0, x), w), h } });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * How large a piece's still may be shown, in points per point: its saved
 * pixels per point over the display's, so a zoom never stretches pixels the
 * capture does not have. Never below 1: today's 1x stills keep their size.
 */
export function densityOf(screen: ReviewScreen, display = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): number {
  const saved = Number(screen.density) >= 1 ? Number(screen.density) : 1;
  return Math.max(1, saved / display);
}

function padded(p: TitlePiece): Box {
  const pad = COVER.pad; const { box, screen } = p;
  const x = Math.max(0, box.x - pad); const y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(screen.width, box.x + box.w + pad) - x, h: Math.min(screen.after.height, box.y + box.h + pad) - y };
}

/** A piece taller than the card can show at 0.75× is cut to a window from its top. */
function cut(b: Box, cap: number): Box {
  return b.h <= cap ? b : { x: b.x, y: b.y, w: b.w, h: cap };
}

function plateFor(p: TitlePiece, b: Box, s: number, cx: number, cy: number, z: number): TitlePlate {
  const w = b.w * s; const h = b.h * s;
  const x = cx - w / 2; const y = cy - h / 2;
  return {
    x, y, w, h, r: Math.min(COVER.radius, h / 2), z,
    img: { url: p.screen.after.url, left: -b.x * s, top: -b.y * s, width: p.screen.width * s, height: p.screen.after.height * s },
  };
}

function singleScale(b: Box, card: { w: number; h: number }, density: number, maxS?: number): number {
  const framed = COVER.share * Math.min(card.w / b.w, card.h / b.h);
  const real = Math.min(1, COVER.wide * card.w / b.w, COVER.wide * card.h / b.h);
  let s = Math.max(framed, real);
  s = Math.min(s, density, COVER.wide * card.w / b.w, COVER.wide * card.h / b.h);
  return maxS ? Math.min(s, maxS) : s;
}

type Layout = { cells: Array<[number, number, number?]> ; name: string };
function layouts(n: number): Layout[] {
  const L: Layout[] = [{ name: 'stack', cells: [] }, { name: 'row', cells: [] }];
  for (let i = 0; i < n; i++) { L[0].cells.push([0, i]); L[1].cells.push([i, 0]); }
  if (n >= 3) {
    const q: Layout = { name: '2x2', cells: [] }; for (let i = 0; i < n; i++) q.cells.push([i % 2, Math.floor(i / 2)]); L.push(q);
    const ll: Layout = { name: 'lead-left', cells: [[0, 0, n - 1]] }; for (let i = 1; i < n; i++) ll.cells.push([1, i - 1]); L.push(ll);
  }
  return L;
}

function gridFit(boxes: Box[], lay: Layout, s: number) {
  const g = COVER.pad; const cols: number[] = []; const rows: number[] = [];
  boxes.forEach((b, i) => {
    const c = lay.cells[i]; if (c[2]) return;
    cols[c[0]] = Math.max(cols[c[0]] || 0, b.w * s); rows[c[1]] = Math.max(rows[c[1]] || 0, b.h * s);
  });
  if (lay.cells[0][2]) {
    cols[0] = boxes[0].w * s;
    const need = boxes[0].h * s; const have = rows.reduce((a, v) => a + (v || 0), 0) + (rows.length - 1) * g;
    if (need > have) rows[rows.length - 1] = (rows[rows.length - 1] || 0) + need - have;
  }
  for (let i = 0; i < cols.length; i++) cols[i] = cols[i] || 0;
  for (let i = 0; i < rows.length; i++) rows[i] = rows[i] || 0;
  return { W: cols.reduce((a, v) => a + v, 0) + (cols.length - 1) * g, H: rows.reduce((a, v) => a + v, 0) + (rows.length - 1) * g, cols, rows };
}

function mixHex(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const x = p(a); const y = p(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** The title shot: its plates on a card of `card` points, on `ground`. */
export function composeTitle(pieces: TitlePiece[], card: { w: number; h: number }, ground: string): TitleComposition | null {
  if (!pieces.length) return null;
  const cy = card.h * COVER.centre;
  const one = (p: TitlePiece, maxS?: number) => {
    const b = cut(padded(p), (COVER.wide * card.h) / 0.75);
    const s = singleScale(b, card, densityOf(p.screen), maxS);
    return { b, s };
  };
  if (pieces.length === 1) {
    const { b, s } = one(pieces[0]);
    return { rule: 'single', plates: [plateFor(pieces[0], b, s, card.w / 2, cy, 10)] };
  }
  if (pieces.length <= 4) {
    const cap = ((COVER.wide * card.h - COVER.pad) / 2) / 0.75;
    const boxes = pieces.map((p) => cut(padded(p), cap));
    let best: { s: number; lay: Layout } | null = null;
    for (const lay of layouts(boxes.length)) {
      const f0 = gridFit(boxes, lay, 0); const f1 = gridFit(boxes, lay, 1);
      const aw = f1.W - f0.W; const ah = f1.H - f0.H;
      const framed = Math.min((COVER.share * card.w - f0.W) / aw, (COVER.share * card.h - f0.H) / ah);
      const real = Math.min(1, (COVER.wide * card.w - f0.W) / aw, (COVER.wide * card.h - f0.H) / ah);
      const fits = Math.min((COVER.wide * card.w - f0.W) / aw, (COVER.wide * card.h - f0.H) / ah);
      const dens = Math.min(...pieces.map((p) => densityOf(p.screen)));
      const s = Math.min(Math.max(framed, real), fits, dens);
      if (!best || s > best.s + 1e-6) best = { s, lay };
    }
    if (best && best.s >= COVER.minGrid) {
      const { s, lay } = best; const fit = gridFit(boxes, lay, s); const g = COVER.pad;
      const x0 = (card.w - fit.W) / 2; const y0 = cy - fit.H / 2;
      const colX = [x0]; const rowY = [y0];
      for (let i = 1; i < fit.cols.length; i++) colX[i] = colX[i - 1] + fit.cols[i - 1] + g;
      for (let i = 1; i < fit.rows.length; i++) rowY[i] = rowY[i - 1] + fit.rows[i - 1] + g;
      return {
        rule: 'grid',
        plates: pieces.map((p, i) => {
          const c = lay.cells[i];
          let cx = colX[c[0]]; let cw = fit.cols[c[0]];
          if (lay.name === 'stack') { cw = fit.W; cx = x0; }
          const ch = c[2] ? fit.H : fit.rows[c[1]];
          return plateFor(p, boxes[i], s, cx + cw / 2, rowY[c[1]] + ch / 2, 10);
        }),
      };
    }
  }
  // The deck: the lead keeps the single rule, the stack stays inside the
  // wide allowance, and the back plates are plain tones peeking below.
  const n = Math.min(4, pieces.length);
  const lead = pieces[0];
  const lb = cut(padded(lead), (COVER.wide * card.h - (n - 1) * COVER.peek) / 0.75);
  const s = singleScale(lb, card, densityOf(lead.screen), (COVER.wide * card.h - (n - 1) * COVER.peek) / lb.h);
  const H = lb.h * s; const W = Math.max(lb.w * s, 0.66 * card.w);
  const top = cy - (H + (n - 1) * COVER.peek) / 2;
  const front = plateFor(lead, lb, s, card.w / 2, top + H / 2, 10);
  // The lead's plate takes the deck's width, its piece centred in it.
  const leadPlate: TitlePlate = { ...front, x: (card.w - W) / 2, w: W, img: front.img ? { ...front.img, left: front.img.left + (W - lb.w * s) / 2 } : null };
  const plates: TitlePlate[] = [leadPlate];
  for (let i = 1; i < n; i++) {
    const w = W * (1 - 2 * COVER.inset * i);
    plates.push({ x: (card.w - w) / 2, y: top + i * COVER.peek, w, h: H, r: leadPlate.r, img: null, fill: mixHex('#ffffff', ground, VEIL[i - 1]), z: 10 - i });
  }
  return { rule: 'deck', plates };
}
