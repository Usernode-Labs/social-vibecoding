/**
 * The diagram record (#4490), shared with #4098's explanations: the browser's
 * half of src/services/diagram.js. The server validates a record before it is
 * stored; this reads one defensively before it is drawn, so a value of the
 * wrong shape draws nothing rather than half a picture.
 *
 * Text only. Every field is a string or a number React prints as text; the
 * Mermaid kind's source is turned into SVG by the vendored library under
 * strict settings and cleaned by DOMPurify (./mermaid.ts).
 *
 * The record's own words are its author's and stay as written; the words
 * Homeroom puts around them (the kind's label, the line a screen reader
 * hears) are `project:diagram.*` messages, read when they are drawn.
 */

import { listText, t } from '../i18n/runtime';

export type DiagramOp = 'added' | 'changed' | 'removed';

export type RenameDiagram = { version: 1; kind: 'rename'; from: string; to: string; places?: string[]; note?: string };
export type FlowDiagram = { version: 1; kind: 'flow'; before: string[]; after: string[]; note?: string };
export type ChangesDiagram = { version: 1; kind: 'changes'; rows: { op: DiagramOp; what: string; detail?: string }[] };
export type NumbersDiagram = { version: 1; kind: 'numbers'; unit?: string; rows: { label: string; before: number; after: number }[] };
export type MermaidDiagram = { version: 1; kind: 'mermaid'; source: string };

/** #6832: the three pictures for a change that changes nothing on screen. */
export type SeenDiagram = {
  version: 1; kind: 'seen'; where: string; look: SeenLook;
  before: { title: string; lines?: string[] }; after: { title: string; lines?: string[] };
};
export type MomentDiagram = {
  version: 1; kind: 'moment';
  before: { date: string; ref: string; lasted?: string; events: string[] };
  after: { events: string[] };
};
export type Step = { pic: string; caption: string; note?: string; retry?: boolean };
export type StepsDiagram = { version: 1; kind: 'steps'; before: Step[]; after: Step[] };

export type DiagramRecord =
  | RenameDiagram | FlowDiagram | ChangesDiagram | NumbersDiagram | MermaidDiagram
  | SeenDiagram | MomentDiagram | StepsDiagram;

/** Who supplied a picture, as its foot says. */
export type DiagramSource = 'author' | 'decision' | 'files';

/** The label over a diagram is its kind: a message id, read with `t` when it is drawn. */
export const DIAGRAM_LABELS: Record<DiagramRecord['kind'], string> = {
  rename: 'project:diagram.kind.rename',
  flow: 'project:diagram.kind.flow',
  changes: 'project:diagram.kind.changes',
  numbers: 'project:diagram.kind.numbers',
  mermaid: 'project:diagram.kind.mermaid',
  seen: 'project:diagram.kind.seen',
  moment: 'project:diagram.kind.moment',
  steps: 'project:diagram.kind.steps',
};

export type SeenLook = 'status' | 'notice' | 'message' | 'count';
export const SEEN_LOOKS: readonly SeenLook[] = ['status', 'notice', 'message', 'count'];

/**
 * #6832: the fixed picture set a "steps" row is made from, the same list the
 * server keeps (src/services/diagram.js `SCENES`). One drawing per name in
 * ./scene.tsx; a name here that has none draws nothing.
 */
export const SCENES = [
  'two-edits', 'text-twice', 'text-once', 'merged', 'checked', 'retry', 'builds', 'cant-build',
  'handed-back', 'person', 'bell', 'card', 'vote',
] as const;

/** The kinds that are a picture for a change that changes nothing on screen. */
export const NONE_KINDS = ['seen', 'moment', 'steps'] as const;

/** Whether a record is one of #6832's pictures (a complete one, for its card). */
export function isNonePicture(d: unknown): boolean {
  const rec = readDiagram(d);
  return !!rec && (NONE_KINDS as readonly string[]).includes(rec.kind);
}

const MAX_TEXT = 60;

function str(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

function strs(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map((x) => str(x));
  return out.every((x): x is string => !!x) ? out : null;
}

/** A value as a record this version draws, or null. */
export function readDiagram(v: unknown): DiagramRecord | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (d.version !== 1) return null;
  const note = str(d.note) || undefined;
  switch (d.kind) {
    case 'rename': {
      const from = str(d.from);
      const to = str(d.to);
      const places = d.places == null ? [] : strs(d.places, 8);
      if (!from || !to || !places) return null;
      return { version: 1, kind: 'rename', from, to, ...(places.length ? { places } : {}), ...(note ? { note } : {}) };
    }
    case 'flow': {
      const before = strs(d.before, 6);
      const after = strs(d.after, 6);
      if (!before || !after || !before.length || !after.length) return null;
      return { version: 1, kind: 'flow', before, after, ...(note ? { note } : {}) };
    }
    case 'changes': {
      if (!Array.isArray(d.rows) || !d.rows.length || d.rows.length > 6) return null;
      const rows = d.rows.map((r) => {
        const row = (r || {}) as Record<string, unknown>;
        const op = row.op === 'added' || row.op === 'changed' || row.op === 'removed' ? row.op : null;
        const what = str(row.what);
        const detail = str(row.detail) || undefined;
        return op && what ? { op, what, ...(detail ? { detail } : {}) } : null;
      });
      return rows.every(Boolean) ? { version: 1, kind: 'changes', rows: rows as ChangesDiagram['rows'] } : null;
    }
    case 'numbers': {
      if (!Array.isArray(d.rows) || !d.rows.length || d.rows.length > 6) return null;
      const unit = str(d.unit, 12) || undefined;
      const rows = d.rows.map((r) => {
        const row = (r || {}) as Record<string, unknown>;
        const label = str(row.label);
        const before = Number(row.before);
        const after = Number(row.after);
        return label && Number.isFinite(before) && Number.isFinite(after) ? { label, before, after } : null;
      });
      return rows.every(Boolean) ? { version: 1, kind: 'numbers', ...(unit ? { unit } : {}), rows: rows as NumbersDiagram['rows'] } : null;
    }
    case 'mermaid': {
      const source = typeof d.source === 'string' && d.source.trim() && d.source.length <= 2000 ? d.source : null;
      return source ? { version: 1, kind: 'mermaid', source } : null;
    }
    case 'seen': {
      const where = str(d.where);
      const look = SEEN_LOOKS.includes(d.look as SeenLook) ? (d.look as SeenLook) : null;
      const side = (v: unknown) => {
        if (!v || typeof v !== 'object') return null;
        const s = v as Record<string, unknown>;
        const title = str(s.title);
        const lines = s.lines == null ? [] : strs(s.lines, 2);
        return title && lines ? { title, ...(lines.length ? { lines } : {}) } : null;
      };
      const before = side(d.before);
      const after = side(d.after);
      if (!where || !look || !before || !after) return null;
      return { version: 1, kind: 'seen', where, look, before, after };
    }
    case 'moment': {
      const b = (d.before || {}) as Record<string, unknown>;
      const a = (d.after || {}) as Record<string, unknown>;
      const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
      const ref = typeof b.ref === 'string' && /^(?:PR|request|change) #\d+$/.test(b.ref) ? b.ref : null;
      const lasted = str(b.lasted) || undefined;
      const events = (v: unknown) => {
        const out = strs(v, 4);
        return out && out.length ? out : null;
      };
      const beforeEvents = events(b.events);
      const afterEvents = events(a.events);
      if (!date || !ref || !beforeEvents || !afterEvents) return null;
      return {
        version: 1, kind: 'moment',
        before: { date, ref, ...(lasted ? { lasted } : {}), events: beforeEvents },
        after: { events: afterEvents },
      };
    }
    case 'steps': {
      const step = (v: unknown): Step | null => {
        if (!v || typeof v !== 'object') return null;
        const s = v as Record<string, unknown>;
        const pic = typeof s.pic === 'string' && (SCENES as readonly string[]).includes(s.pic) ? s.pic : null;
        const caption = str(s.caption, 24);
        if (!pic || !caption || caption.split(' ').length > 3) return null;
        const note = str(s.note) || undefined;
        return { pic, caption, ...(note ? { note } : {}), ...(s.retry === true ? { retry: true } : {}) };
      };
      const row = (v: unknown): Step[] | null => {
        if (!Array.isArray(v) || !v.length || v.length > 5) return null;
        const out = v.map(step);
        if (!out.every((s): s is Step => !!s)) return null;
        return out.filter((s) => s.note).length > 1 ? null : out;
      };
      const before = row(d.before);
      const after = row(d.after);
      if (!before || !after) return null;
      return { version: 1, kind: 'steps', before, after };
    }
    default:
      return null;
  }
}

/** A figure as the Numbers kind prints it: up to two decimals, then the unit. */
export function figure(n: number, unit?: string): string {
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return unit ? `${s} ${unit}` : s;
}

/** One sentence of a change row, per kind of change, with and without its detail. */
const CHANGE_TEXT: Record<DiagramOp, { plain: string; detail: string }> = {
  added: { plain: 'project:diagram.text.added', detail: 'project:diagram.text.addedDetail' },
  changed: { plain: 'project:diagram.text.changed', detail: 'project:diagram.text.changedDetail' },
  removed: { plain: 'project:diagram.text.removed', detail: 'project:diagram.text.removedDetail' },
};

/** Whole sentences, one after another, as the label reads them. */
function sentences(parts: readonly string[]): string {
  if (!parts.length) return '';
  return parts.reduce((first, second) => t('project:diagram.text.sentences', { first, second }));
}

/** A flow's steps in order: "Vote, then Checks, then Closes". */
function steps(list: readonly string[]): string {
  if (!list.length) return '';
  return list.reduce((first, second) => t('project:diagram.text.then', { first, second }));
}

/**
 * A diagram as a line of text, for a screen reader's label and anywhere that
 * cannot draw one.
 */
export function diagramText(d: DiagramRecord): string {
  switch (d.kind) {
    case 'rename': return d.places
      ? t('project:diagram.text.renameIn', { from: d.from, to: d.to, places: listText(d.places) })
      : t('project:diagram.text.rename', { from: d.from, to: d.to });
    case 'flow': return t('project:diagram.text.flow', { before: steps(d.before), after: steps(d.after) });
    case 'changes': return sentences(d.rows.map((r) => (r.detail
      ? t(CHANGE_TEXT[r.op].detail, { what: r.what, detail: r.detail })
      : t(CHANGE_TEXT[r.op].plain, { what: r.what }))));
    case 'numbers': return sentences(d.rows.map((r) => t('project:diagram.text.numbers', {
      label: r.label, before: figure(r.before, d.unit), after: figure(r.after, d.unit),
    })));
    case 'seen': {
      // Whole sentences joined by one full stop, never two.
      const said = (side: { title: string; lines?: string[] }) => [side.title, ...(side.lines || [])]
        .map((part) => part.replace(/[.!]$/, '')).join('. ');
      return t('project:diagram.text.seen', { where: d.where, before: said(d.before), after: said(d.after) });
    }
    case 'moment': return t('project:diagram.text.moment', {
      date: d.before.date, ref: d.before.ref, events: listText(d.before.events), now: listText(d.after.events),
    });
    case 'steps': return t('project:diagram.text.steps', {
      before: d.before.map((s) => s.caption).join(', '), after: d.after.map((s) => s.caption).join(', '),
    });
    default: return t('project:diagram.text.mermaid');
  }
}
