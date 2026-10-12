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

export type DiagramRecord = RenameDiagram | FlowDiagram | ChangesDiagram | NumbersDiagram | MermaidDiagram;

/** Who supplied a picture, as its foot says. */
export type DiagramSource = 'author' | 'decision' | 'files';

/** The label over a diagram is its kind: a message id, read with `t` when it is drawn. */
export const DIAGRAM_LABELS: Record<DiagramRecord['kind'], string> = {
  rename: 'project:diagram.kind.rename',
  flow: 'project:diagram.kind.flow',
  changes: 'project:diagram.kind.changes',
  numbers: 'project:diagram.kind.numbers',
  mermaid: 'project:diagram.kind.mermaid',
};

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
    default: return t('project:diagram.text.mermaid');
  }
}
