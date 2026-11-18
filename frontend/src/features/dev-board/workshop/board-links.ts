/**
 * The board, under the Standard (WIP) look: what an item is tied to, shown
 * while the pointer (or the keyboard) is on it.
 *
 * A change says which requests it is for ("for #6464"), and a request has
 * the changes made for it. On the board those sit in different columns, so
 * the tie is easy to miss. Resting on a card draws it: a ring round each
 * card it is tied to that is on the board now, and a curved line from the
 * request to each change made for it, ending in a point on that change.
 *
 * NOTHING IS WRITTEN TO THE BOARD. The rows are React's (./work-row.tsx),
 * and they say what they are in three attributes it renders under this
 * look: `data-ws-noun`, `data-ws-num` and `data-ws-for`. Everything drawn
 * is in one layer of this module's own, appended to <body>: an SVG that
 * takes no pointer events, laid over the page while a card is rested on
 * and removed when the pointer leaves, the page scrolls or a button goes
 * down. So a re-render of the board cannot disagree with it.
 */

const ROW = '#dev-kanban [data-ws-row][data-ws-num]';
const NS = 'http://www.w3.org/2000/svg';
/** How long the pointer rests on a card before its ties are drawn, so crossing the board draws nothing. */
const REST_MS = 140;

type Tie = { from: Element; to: Element };

function nums(value: string | null): string[] {
  return (value || '').split(',').map((n) => n.trim()).filter(Boolean);
}

/** The cards tied to `row`, each as request → change. */
export function tiesOf(row: Element, rows: Element[]): Tie[] {
  const noun = row.getAttribute('data-ws-noun');
  const num = row.getAttribute('data-ws-num') || '';
  if (noun === 'request') {
    return rows
      .filter((r) => r !== row && r.getAttribute('data-ws-noun') === 'change' && nums(r.getAttribute('data-ws-for')).includes(num))
      .map((r) => ({ from: row, to: r }));
  }
  if (noun === 'change') {
    const wanted = nums(row.getAttribute('data-ws-for'));
    return rows
      .filter((r) => r !== row && r.getAttribute('data-ws-noun') === 'request' && wanted.includes(r.getAttribute('data-ws-num') || ''))
      .map((r) => ({ from: r, to: row }));
  }
  return [];
}

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** A ring round a card, a little outside its edge. */
function ring(box: DOMRect, cls: string): SVGElement {
  return el('rect', {
    class: cls, x: box.left - 1.5, y: box.top - 1.5, width: box.width + 3, height: box.height + 3, rx: 11.5, ry: 11.5,
  });
}

/** An arrow's line, where it starts, and where and which way its head sits. */
type Arrow = { d: string; from: [number, number]; to: [number, number]; angle: number };

/**
 * The arrow from one card to another: out of the side of the first that
 * faces the second and into the facing side of the second, on one soft S
 * that leaves and arrives level, so it never cuts across a card. It stops
 * a little short of the second card, where its head sits. Two cards of one
 * column are joined round their shared side.
 */
function arrow(a: DOMRect, b: DOMRect): Arrow {
  const ay = a.top + a.height / 2;
  const by = b.top + b.height / 2;
  if (Math.abs(a.left - b.left) < 8) {
    const x = a.right + 4;
    const out = x + 30 + Math.min(26, Math.abs(by - ay) / 10);
    const end = x + 4;
    return { d: `M ${x} ${ay} C ${out} ${ay}, ${out} ${by}, ${end} ${by}`, from: [x, ay], to: [end, by], angle: 180 };
  }
  const right = b.left > a.left;
  const x1 = right ? a.right + 4 : a.left - 4;
  const x2 = right ? b.left - 4 : b.right + 4;
  // The bend is most of the gap, so the line leaves level, turns once in the
  // gutter between the columns, and arrives level.
  const bend = Math.max(22, Math.abs(x2 - x1) * 0.62);
  const c1 = right ? x1 + bend : x1 - bend;
  const c2 = right ? x2 - bend : x2 + bend;
  return { d: `M ${x1} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${x2} ${by}`, from: [x1, ay], to: [x2, by], angle: right ? 0 : 180 };
}

/** Start drawing ties on the board; the function it returns stops it and clears what is drawn. */
export function watchBoardLinks(): () => void {
  let layer: SVGElement | null = null;
  let timer = 0;
  let watch = 0;
  let on: Element | null = null;
  /** Where the drawn cards were when they were drawn, to notice the board moving under the drawing. */
  let drawnAt = '';

  const wipe = () => {
    window.clearInterval(watch);
    if (layer) { layer.remove(); layer = null; }
  };
  const clear = () => {
    window.clearTimeout(timer);
    on = null;
    wipe();
  };
  const place = (nodes: Element[]) => nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  }).join(';');

  const draw = (row: Element) => {
    const rows = [...document.querySelectorAll(ROW)];
    const ties = tiesOf(row, rows);
    if (!ties.length) return;
    const svg = el('svg', { class: 'wip-board-links', 'aria-hidden': 'true', width: window.innerWidth, height: window.innerHeight });
    const defs = el('defs', {});
    svg.appendChild(defs);
    svg.appendChild(ring(row.getBoundingClientRect(), 'wip-board-link-ring wip-board-link-ring-on'));
    ties.forEach((tie, i) => {
      const other = tie.from === row ? tie.to : tie.from;
      const line = arrow(tie.from.getBoundingClientRect(), tie.to.getBoundingClientRect());
      // The line comes up out of nothing at the request and is whole by its
      // head: a fade along its own length (the gradient runs start to end).
      const fade = el('linearGradient', {
        id: `wip-board-link-fade-${i}`, gradientUnits: 'userSpaceOnUse',
        x1: line.from[0], y1: line.from[1], x2: line.to[0], y2: line.to[1],
      });
      fade.appendChild(el('stop', { class: 'wip-board-link-fade-from', offset: 0 }));
      fade.appendChild(el('stop', { class: 'wip-board-link-fade-to', offset: 0.55 }));
      defs.appendChild(fade);
      svg.appendChild(ring(other.getBoundingClientRect(), 'wip-board-link-ring'));
      svg.appendChild(el('circle', { class: 'wip-board-link-dot', cx: line.from[0], cy: line.from[1], r: 2.5 }));
      svg.appendChild(el('path', { class: 'wip-board-link-line', d: line.d, stroke: `url(#wip-board-link-fade-${i})`, pathLength: 1 }));
      // The target is marked with a point, not a head: a point has no
      // direction to get wrong where the line turns into a card.
      svg.appendChild(el('circle', { class: 'wip-board-link-end', cx: line.to[0], cy: line.to[1], r: 3.5 }));
    });
    document.body.appendChild(svg);
    layer = svg;
    // THE BOARD CAN MOVE UNDER THE DRAWING with no scroll to say so (a column
    // filling in, a card growing a tag). While it is up, the cards are looked
    // at a few times a second, and the drawing is made again where they are
    // now.
    const drawn = [row, ...ties.map((tie) => (tie.from === row ? tie.to : tie.from))];
    drawnAt = place(drawn);
    watch = window.setInterval(() => {
      // The board draws its rows again when its data is read again, so the
      // card under the pointer may be a new node for the same item: the
      // drawing follows the item, not the node.
      if (!row.isConnected) {
        const again = [...document.querySelectorAll(ROW)].find((r) => (
          r.getAttribute('data-ws-num') === row.getAttribute('data-ws-num')
          && r.getAttribute('data-ws-noun') === row.getAttribute('data-ws-noun')
        ));
        wipe();
        if (again) { on = again; draw(again); } else clear();
        return;
      }
      if (drawn.every((n) => n.isConnected) && place(drawn) === drawnAt) return;
      wipe();
      draw(row);
    }, 250);
  };

  const rest = (event: Event) => {
    const target = event.target as Element | null;
    const row = target && target.closest ? target.closest(ROW) : null;
    if (row === on) return;
    clear();
    if (!row) return;
    on = row;
    timer = window.setTimeout(() => { if (on === row && row.isConnected) draw(row); }, REST_MS);
  };

  document.addEventListener('mouseover', rest, true);
  document.addEventListener('focusin', rest, true);
  document.addEventListener('scroll', clear, true);
  document.addEventListener('mousedown', clear, true);
  window.addEventListener('resize', clear);
  window.addEventListener('blur', clear);
  return () => {
    document.removeEventListener('mouseover', rest, true);
    document.removeEventListener('focusin', rest, true);
    document.removeEventListener('scroll', clear, true);
    document.removeEventListener('mousedown', clear, true);
    window.removeEventListener('resize', clear);
    window.removeEventListener('blur', clear);
    clear();
  };
}
