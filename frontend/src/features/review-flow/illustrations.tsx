/**
 * The review flow's drawn pictures: one object per benefit, one per kind of
 * group decision.
 *
 * Every card in the new Needs you carries a picture. A change with before and
 * after shots has its shots; everything else (a change nobody can see, a
 * change whose shots are not taken yet, a group decision) gets one of these,
 * so the feed never falls back to a card of text.
 *
 * The look is the benefit-card system: each object outlined in ink on a cream
 * fill, the part that got better in sage, a hard ink shadow offset down and to
 * the right with no blur, and behind it a dotted construction circle with two
 * square anchor handles (the brand kit's vector-construction look). A small
 * mono label sits top left ("BENEFIT · AREA"), and a number token ("259 s" |
 * "200 s") may sit under the object.
 *
 * These are scenes, not glyphs: they are drawn on their own 200-unit board,
 * at card and hero size, and share nothing with the 24-grid outline set in
 * @/components/ui/icons.tsx. That is why this file owns one raw svg element of its
 * own; tests/shell-icon-set.test.js names it and pins what it may hold.
 *
 * Every word on the picture comes from the caller, already translated.
 */

import { useId, type ReactNode } from 'react';

export type BenefitKind = 'fixed' | 'stability' | 'clarity' | 'more' | 'results' | 'speed' | 'effort' | 'security' | 'behind';
export type DecisionKind = 'close_issue' | 'rename' | 'secret_change' | 'decision';
export type IllustrationKind = { benefit: BenefitKind } | { decision: DecisionKind };

export const BENEFIT_KINDS: readonly BenefitKind[] = ['fixed', 'stability', 'clarity', 'more', 'results', 'speed', 'effort', 'security', 'behind'];
export const DECISION_KINDS: readonly DecisionKind[] = ['close_issue', 'rename', 'secret_change', 'decision'];

const INK = '#1b1b1d';
const CREAM = '#FFFEEA';
const SAGE = '#A9CF97';
const FAINT = 'rgba(27,27,29,0.34)';

/* ── Geometry ────────────────────────────────────────────────────────────
 *
 * The layout is measured on the 358 × 268 card and scales as one piece.
 * The board is 200 units square and centred on the construction circle; at
 * card size one unit is one pixel.
 */

const CARD_W = 358;
const CARD_H = 268;
/** Circle centre and radius on the card, without and with a token. */
const RING = { plain: { cy: 129, r: 92, k: 1.08 }, token: { cy: 101, r: 76, k: 0.96 } };
const TOKEN_TOP = 186;
const TOKEN_H = 28;
/** Below this, the picture is a thumbnail: the object alone. */
const COMPACT = 120;
const STROKE = 2.75;
const SHADOW = 6;
const HANDLE_ANGLES = [-34, 146];

/** Pen for one drawing: stroke width and the ground (for holes). */
interface Pen { sw: number; ground: string }

/** One layer of an object; `flat` layers cast no shadow. */
type Layer = { node: ReactNode; flat?: boolean };
type Drawing = (p: Pen) => Layer[];

const f = (n: number) => Math.round(n * 100) / 100;
const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (r: number, deg: number): [number, number] => [f(r * Math.cos(rad(deg))), f(r * Math.sin(rad(deg)))];

/** A rounded rectangle as a subpath, for shapes with holes (even-odd). */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
    + `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** A circle as a subpath. */
function ring(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
}

/** A five-point star, one point up. */
function star(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const [x, y] = polar(i % 2 ? inner : outer, -90 + i * 36);
    pts.push(`${f(cx + x)},${f(cy + y)}`);
  }
  return pts.join(' ');
}

/** A four-point sparkle with gently pinched sides. */
function sparkle(cx: number, cy: number, a: number): string {
  const b = f(a * 0.2);
  return `M${cx} ${cy - a}Q${cx + b} ${cy - b} ${cx + a} ${cy}Q${cx + b} ${cy + b} ${cx} ${cy + a}`
    + `Q${cx - b} ${cy + b} ${cx - a} ${cy}Q${cx - b} ${cy - b} ${cx} ${cy - a}Z`;
}

/** A gear: `n` flat-topped teeth, an axle hole (even-odd). */
function gear(cx: number, cy: number, tip: number, root: number, n: number, phase: number, hole: number): string {
  const step = 360 / n;
  const wRoot = step * 0.27;
  const wTip = step * 0.17;
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = phase + i * step;
    const p = (r: number, deg: number) => { const [x, y] = polar(r, deg); return `${f(cx + x)} ${f(cy + y)}`; };
    d += `${i === 0 ? 'M' : 'L'}${p(root, a - wRoot)}L${p(tip, a - wTip)}L${p(tip, a + wTip)}L${p(root, a + wRoot)}`;
    d += `A${root} ${root} 0 0 1 ${p(root, a + step - wRoot)}`;
  }
  return `${d}Z${ring(cx, cy, hole)}`;
}

const outline = (sw: number) => ({ stroke: INK, strokeWidth: sw, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const });

/** The part that improved: sage, and what the hero's replay animates. */
function Gain({ children }: { children: ReactNode }) {
  return <g className="rf-ill-gain">{children}</g>;
}

/* ── The objects ─────────────────────────────────────────────────────── */

const BULB_GLASS = 'M-16 22C-16 10-37 0-37-24A37 37 0 1 1 37-24C37 0 16 10 16 22Z';
const BULB_FILAMENT = 'M-10 21V-2L-7-12L-3.5-5L0-12L3.5-5L7-12L10-2V21';
const BULB_TIP = 'M-11 44H11L7 51H-7Z';
const SHACKLE = 'M-30-12V-32A30 30 0 0 1 30-32V-12H16V-32A16 16 0 0 0-16-32V-12Z';
const BOLT = 'M5-17L-8 3H0L-4 17L9-4H1Z';
const CHECK = 'M19 32L27 40L41 24';
const TAG = 'M-56-8L-40-28H48Q56-28 56-20V20Q56 28 48 28H-40L-56 8Z';
const TAG_BAND = 'M-56-8L-40-28H-22V28H-40L-56 8Z';
const TAG_STRING = 'M-38 0C-58-4-72-28-56-46';
const KEY_SHAFT = 'M-14-7H54V7H50V19H42V7H35V15H27V7H-14Z';
const DART_FLIGHT = 'M-2-6L13-10Q19 0 13 10L-2 6Z';
const BALLOT_TICK = 'M-7-35L-2-29L7-41';
const KNIFE_TOOL = 'M-4-4.5H58Q63-4.5 63 0Q63 4.5 58 4.5H-4Z';
const KNIFE_BLADE = 'M-4-4H56L72-4Q66 5 52 5H-4Z';
const KNIFE_LONG = 'M-4-4H62L78-4Q72 5 58 5H-4Z';

const BENEFITS: Record<BenefitKind, Drawing> = {
  fixed: ({ sw }) => [{
    node: (
      <g transform="translate(0 5)">
        <Gain><path className="rf-ill-sage" d={BULB_GLASS} fill={SAGE} {...outline(sw)} /></Gain>
        <path d={BULB_FILAMENT} fill="none" {...outline(sw * 0.85)} />
        <rect x={-21} y={22} width={42} height={10} rx={4} fill={CREAM} {...outline(sw)} />
        <rect x={-18} y={33} width={36} height={10} rx={4} fill={CREAM} {...outline(sw)} />
        <path d={BULB_TIP} fill={INK} {...outline(sw * 0.6)} />
      </g>
    ),
  }],

  stability: ({ sw }) => [
    {
      node: (
        <>
          <path d={rr(-78, -24, 74, 48, 24) + rr(-66, -12, 50, 24, 12)} fillRule="evenodd" fill={CREAM} {...outline(sw)} />
          <path d={rr(4, -24, 74, 48, 24) + rr(16, -12, 50, 24, 12)} fillRule="evenodd" fill={CREAM} {...outline(sw)} />
        </>
      ),
    },
    { node: <Gain><rect className="rf-ill-sage" x={-29} y={-7.5} width={58} height={15} rx={7.5} fill={SAGE} {...outline(sw)} /></Gain> },
  ],

  clarity: ({ sw }) => [
    {
      node: (
        <>
          <circle cx={-8} cy={8} r={52} fill={CREAM} {...outline(sw)} />
          <circle cx={-8} cy={8} r={37} fill="none" {...outline(sw * 0.9)} />
          <circle cx={-8} cy={8} r={22} fill="none" {...outline(sw * 0.9)} />
          <Gain><circle className="rf-ill-sage" cx={-8} cy={8} r={10} fill={SAGE} {...outline(sw * 0.9)} /></Gain>
        </>
      ),
    },
    { node: <line x1={-8} y1={8} x2={28} y2={-28} {...outline(sw * 1.05)} />, flat: true },
    { node: <path transform="translate(27 -27) rotate(-45)" d={DART_FLIGHT} fill={CREAM} {...outline(sw)} /> },
  ],

  more: ({ sw }) => {
    const pivot = 'translate(-34 24)';
    return [
      { node: <path transform={`${pivot} rotate(-19)`} d={KNIFE_LONG} fill={CREAM} {...outline(sw)} /> },
      { node: <path transform={`${pivot} rotate(-50)`} d={KNIFE_BLADE} fill={CREAM} {...outline(sw)} /> },
      {
        node: (
          <Gain>
            <g transform={`${pivot} rotate(-82)`}>
              <path className="rf-ill-sage" d={KNIFE_TOOL} fill={SAGE} {...outline(sw)} />
              <circle cx={54} cy={0} r={2.2} fill={INK} />
            </g>
          </Gain>
        ),
      },
      {
        node: (
          <>
            <rect x={-46} y={13} width={92} height={22} rx={11} fill={CREAM} {...outline(sw)} />
            <circle cx={-34} cy={24} r={3.6} fill={INK} />
            <line x1={-20} y1={24} x2={33} y2={24} stroke={FAINT} strokeWidth={sw * 0.9} strokeLinecap="round" />
          </>
        ),
      },
    ];
  },

  results: ({ sw }) => [
    { node: <Gain><polygon className="rf-ill-sage" points={star(0, 4, 55, 25)} fill={SAGE} {...outline(sw)} /></Gain> },
    {
      flat: true,
      node: (
        <>
          <path d={sparkle(-56, -32, 9)} fill={CREAM} {...outline(sw * 0.8)} />
          <path d={sparkle(52, -42, 12)} fill={CREAM} {...outline(sw * 0.8)} />
          <path d={sparkle(54, 46, 7)} fill={CREAM} {...outline(sw * 0.8)} />
        </>
      ),
    },
  ],

  speed: ({ sw }) => {
    const c = 10;
    const ticks: ReactNode[] = [];
    for (let i = 0; i < 12; i++) {
      const [x1, y1] = polar(i % 3 ? 36 : 32, i * 30 - 90);
      const [x2, y2] = polar(40, i * 30 - 90);
      ticks.push(<line key={i} x1={x1} y1={y1 + c} x2={x2} y2={y2 + c} {...outline(sw * (i % 3 ? 0.7 : 0.85))} />);
    }
    const [wx, wy] = polar(33, 190 - 90);
    const [hx, hy] = polar(29, 205 - 90);
    return [
      {
        node: (
          <>
            <rect x={-5} y={-45} width={10} height={12} fill={CREAM} {...outline(sw)} />
            <rect x={-12} y={-55} width={24} height={11} rx={3.5} fill={CREAM} {...outline(sw)} />
            <rect transform={`translate(0 ${c}) rotate(45)`} x={-5} y={-58} width={10} height={14} rx={3} fill={CREAM} {...outline(sw)} />
            <circle cx={0} cy={c} r={45} fill={CREAM} {...outline(sw)} />
            <Gain><path className="rf-ill-sage" d={`M0 ${c}V${c - 33}A33 33 0 1 1 ${wx} ${f(wy + c)}Z`} fill={SAGE} /></Gain>
            {ticks}
            <line x1={0} y1={c} x2={hx} y2={f(hy + c)} {...outline(sw * 1.05)} />
            <circle cx={0} cy={c} r={4.5} fill={INK} />
          </>
        ),
      },
      {
        flat: true,
        node: (
          <>
            <line x1={-63} y1={-2} x2={-52} y2={-2} {...outline(sw * 1.05)} />
            <line x1={-68} y1={10} x2={-52} y2={10} {...outline(sw * 1.05)} />
            <line x1={-63} y1={22} x2={-52} y2={22} {...outline(sw * 1.05)} />
          </>
        ),
      },
    ];
  },

  effort: ({ sw }) => [{
    node: (
      <>
        <rect x={49} y={-13} width={13} height={26} rx={4} fill={CREAM} {...outline(sw)} />
        <rect x={-60} y={-32} width={114} height={64} rx={13} fill={CREAM} {...outline(sw)} />
        <Gain><rect className="rf-ill-sage" x={-50} y={-22} width={76} height={44} rx={7} fill={SAGE} {...outline(sw)} /></Gain>
        <path d={BOLT} transform="translate(-1 0)" fill="none" {...outline(sw * 0.9)} />
      </>
    ),
  }],

  security: ({ sw }) => [{
    node: (
      <g transform="translate(0 6)">
        <path d={SHACKLE} fill={CREAM} {...outline(sw)} />
        <Gain><rect className="rf-ill-sage" x={-44} y={-16} width={88} height={64} rx={14} fill={SAGE} {...outline(sw)} /></Gain>
        <circle cx={0} cy={10} r={6.5} fill={INK} />
        <rect x={-2.75} y={10} width={5.5} height={18} rx={2.75} fill={INK} />
      </g>
    ),
  }],

  behind: ({ sw }) => [
    { node: <path d={gear(-18, 14, 41, 32, 10, -59, 11)} fillRule="evenodd" fill={CREAM} {...outline(sw)} /> },
    { node: <Gain><path className="rf-ill-sage" d={gear(28, -26, 25, 19, 7, 139, 7)} fillRule="evenodd" fill={SAGE} {...outline(sw)} /></Gain> },
  ],
};

const DECISIONS: Record<DecisionKind, Drawing> = {
  close_issue: ({ sw }) => [
    {
      node: (
        <g transform="translate(-7 -3)">
          <rect x={-40} y={-50} width={76} height={92} rx={8} fill={CREAM} {...outline(sw)} />
          <line x1={-26} y1={-28} x2={20} y2={-28} {...outline(sw * 1.1)} />
          <line x1={-26} y1={-12} x2={4} y2={-12} {...outline(sw * 1.1)} />
        </g>
      ),
    },
    {
      node: (
        <g transform="translate(-7 -3)">
          <Gain><circle className="rf-ill-sage" cx={30} cy={32} r={24} fill={SAGE} {...outline(sw)} /></Gain>
          <path d={CHECK} fill="none" {...outline(sw * 1.25)} />
        </g>
      ),
    },
  ],

  rename: ({ sw, ground }) => [
    {
      node: (
        <g transform="translate(4 4) rotate(-10)">
          <path d={TAG} fill={CREAM} {...outline(sw)} />
          <Gain><path className="rf-ill-sage" d={TAG_BAND} fill={SAGE} {...outline(sw)} /></Gain>
          <circle cx={-38} cy={0} r={5.5} fill={ground} {...outline(sw * 0.9)} />
          <line x1={-6} y1={-7} x2={40} y2={-7} {...outline(sw * 1.1)} />
          <line x1={-6} y1={9} x2={22} y2={9} {...outline(sw * 1.1)} />
        </g>
      ),
    },
    { flat: true, node: <path transform="translate(4 4) rotate(-10)" d={TAG_STRING} fill="none" {...outline(sw)} /> },
  ],

  secret_change: ({ sw, ground }) => [{
    node: (
      <g transform="translate(4 2) rotate(-28)">
        <path d={KEY_SHAFT} fill={CREAM} {...outline(sw)} />
        <Gain><circle className="rf-ill-sage" cx={-34} cy={0} r={25} fill={SAGE} {...outline(sw)} /></Gain>
        <circle cx={-42} cy={0} r={7.5} fill={ground} {...outline(sw)} />
      </g>
    ),
  }],

  decision: ({ sw }) => [
    {
      node: (
        <Gain>
          <g transform="rotate(-8 0 -16)">
            <rect className="rf-ill-sage" x={-17} y={-56} width={34} height={46} rx={4} fill={SAGE} {...outline(sw)} />
            <path d={BALLOT_TICK} fill="none" {...outline(sw * 1.1)} />
          </g>
        </Gain>
      ),
    },
    {
      node: (
        <>
          <rect x={-46} y={-8} width={92} height={58} rx={7} fill={CREAM} {...outline(sw)} />
          <rect x={-52} y={-18} width={104} height={14} rx={5} fill={CREAM} {...outline(sw)} />
          <rect x={-24} y={-13.5} width={48} height={4.5} rx={2.25} fill={INK} />
          <line x1={-16} y1={20} x2={16} y2={20} {...outline(sw * 1.1)} />
        </>
      ),
    },
  ],
};

/* ── The picture ─────────────────────────────────────────────────────── */

export function Illustration(props: {
  kind: IllustrationKind;
  /** e.g. "Fixed" and "Agents", already translated by the caller; area optional */
  label: { main: string; area?: string | null };
  token?: { before: string; after: string } | null;
  ground: string;
  width: number;
  height: number;
  /** Hero only: replay the benefit once on mount (respects reduced motion). */
  play?: boolean;
  className?: string;
}): ReactNode {
  const { kind, label, token, ground, width, height, play, className } = props;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const shadowId = `rf-ill-shadow-${uid}`;
  const draw = 'benefit' in kind ? BENEFITS[kind.benefit] : DECISIONS[kind.decision];
  const compact = Math.min(width, height) < COMPACT;
  const showToken = !compact && !!token && !!(token.before || token.after);
  const area = label.area || '';
  const spoken = [label.main, area, showToken && token ? `${token.before} → ${token.after}` : '']
    .filter(Boolean).join(', ');

  const s = Math.min(width / CARD_W, height / CARD_H);
  const oy = (height - CARD_H * s) / 2;
  const geo = showToken ? RING.token : RING.plain;

  // A thumbnail is the object alone, drawn a little bolder so it holds up.
  const sw = compact ? 5 : STROKE;
  const shadow = compact ? 8 : SHADOW;
  const k = compact ? 1 : geo.k;
  const layers = draw({ sw: sw / k, ground });

  const stage = compact
    ? { left: 0, top: 0, w: width, h: height, box: '-79 -79 164 164' }
    : { left: width / 2 - 100 * s, top: oy + (geo.cy - 100) * s, w: 200 * s, h: 200 * s, box: '-100 -100 200 200' };

  const classes = ['rf-ill', play ? 'rf-ill-play' : '', className || ''].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={spoken} style={{ width, height, background: ground }}>
      <svg
        className="rf-ill-stage"
        aria-hidden="true"
        focusable="false"
        viewBox={stage.box}
        width={f(stage.w)}
        height={f(stage.h)}
        style={{ left: f(stage.left), top: f(stage.top) }}
      >
        <defs>
          <filter id={shadowId} x={-120} y={-120} width={240} height={240} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feOffset in="SourceAlpha" dx={f(shadow / k)} dy={f(shadow / k)} result="drop" />
            <feFlood floodColor={INK} />
            <feComposite in2="drop" operator="in" result="ink" />
            <feMerge>
              <feMergeNode in="ink" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {compact ? null : (
          <g>
            <circle cx={0} cy={0} r={geo.r} fill="none" stroke={FAINT} strokeWidth={1} strokeDasharray="2 3" />
            {HANDLE_ANGLES.map((deg) => {
              const [x, y] = polar(geo.r, deg);
              return <rect key={deg} x={f(x - 3)} y={f(y - 3)} width={6} height={6} fill={CREAM} stroke="rgba(27,27,29,0.55)" strokeWidth={1} />;
            })}
          </g>
        )}
        <g transform={k === 1 ? undefined : `scale(${k})`}>
          {layers.map((layer, i) => (
            <g key={i} filter={layer.flat ? undefined : `url(#${shadowId})`}>{layer.node}</g>
          ))}
        </g>
      </svg>
      {compact ? null : (
        <span className="rf-ill-label" aria-hidden="true" style={{ left: f(18 * s), top: f(oy + 14 * s), fontSize: f(11 * s), maxWidth: f(width - 36 * s) }}>
          {label.main}
          {area ? <span className="rf-ill-area">{` · ${area}`}</span> : null}
        </span>
      )}
      {showToken && token ? (
        <span className="rf-ill-token" aria-hidden="true" style={{ top: f(oy + TOKEN_TOP * s), height: f(TOKEN_H * s), fontSize: f(15 * s) }}>
          {token.before ? <span className="rf-ill-before" style={{ padding: `0 ${f(12 * s)}px` }}>{token.before}</span> : null}
          {token.after ? <span className="rf-ill-after" style={{ padding: `0 ${f(12 * s)}px` }}>{token.after}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
