/**
 * The grouping the Workshop screen draws, shared with the all-apps picker
 * panel (#3363): the three audience sections, their recency order, and the
 * three-then-five-then-fewer fold. The screen (`index.tsx`) re-exports these
 * so its existing import path keeps working; the panel imports them here,
 * because `index.tsx` already imports the panel (workshop-chrome.tsx) and
 * the helpers cannot be read back from it.
 */

export type Audience = 'open' | 'invited' | 'solo';

export type WorkshopRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  audience?: Audience | string;
  member_count?: number;
  last_active_at?: string | null;
  /** Homeroom's own row: its channel is #general. */
  self_hosted?: boolean;
  /** A ?demo=1 fixture row (see orderRows). */
  demo?: boolean;
  working: number;
  needs: number;
};

/**
 * The three sections, in the order they are drawn, with the words a person
 * sees. `community` / `audience` are internal: AGENTS.md, "Communities own
 * projects". The glyphs say who else is there — a crowd, a lock (you were let
 * in), one person.
 */
export const SECTIONS: ReadonlyArray<{ key: Audience; label: string; noun: string }> = [
  { key: 'open', label: 'Public communities', noun: 'Public community' },
  { key: 'invited', label: 'Private communities', noun: 'Private community' },
  { key: 'solo', label: 'Just you', noun: 'Just you' },
];

/** How many rows a section shows before "Show N more". */
export const SECTION_LIMIT = 3;

/**
 * How many more rows each press of "Show N more" reveals (#3269). A long
 * section opened all at once turned three rows into thirty, and the next
 * section went off the bottom of the screen; five at a time keeps the list
 * something you read down rather than something you scroll past.
 */
export const SECTION_STEP = 5;

/**
 * The fold for a section of `total` rows with `limit` of them out: how many
 * show, what the fold row says, and the limit a press moves to. Pure, so the
 * three-then-five-then-fewer sequence is tested without a click.
 */
export function sectionFold(total: number, limit: number): { shown: number; label: string | null; next: number } {
  const shown = Math.min(total, Math.max(SECTION_LIMIT, limit));
  if (total <= SECTION_LIMIT) return { shown: total, label: null, next: SECTION_LIMIT };
  const hidden = total - shown;
  if (!hidden) return { shown, label: 'Show fewer', next: SECTION_LIMIT };
  return { shown, label: `Show ${Math.min(hidden, SECTION_STEP)} more`, next: shown + SECTION_STEP };
}

/**
 * The viewer's communities, most recently active first.
 *
 * Exported and pure so tests can drive the ordering without a fetch. A row
 * with no `last_active_at` sorts after every dated one, and two rows the
 * clock cannot tell apart keep the server's order (its activity order):
 * `sort` is stable and this comparator answers 0 for them.
 *
 * A ?demo=1 FIXTURE ROW (`demo: true`, src/routes/apps.js's demoIconApps)
 * LEADS ITS SECTION. The declared checks find those rows on this screen, and
 * a section shows only its three most recent: on a staging clone the
 * viewer's real memberships were all joined when the backfill ran, which is
 * more recent than any fixed fixture time, so the fixture fell behind "Show
 * N more" and the checks found nothing. Real rows never carry the flag.
 */
export function orderRows(apps: WorkshopRow[]): WorkshopRow[] {
  const at = (row: WorkshopRow) => {
    const t = row.last_active_at ? Date.parse(row.last_active_at) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return apps.slice().sort((a, b) => {
    if (!!a.demo !== !!b.demo) return a.demo ? -1 : 1;
    const x = at(a);
    const y = at(b);
    if (x === y) return 0;
    return y > x ? 1 : -1;
  });
}

/**
 * The rows split into the three sections, each in recency order, empty
 * sections left out. An audience the client does not know is read as 'open'
 * — the server's own default — so a row can never fall out of the screen.
 */
export function groupRows(rows: WorkshopRow[]): Array<{ key: Audience; label: string; rows: WorkshopRow[] }> {
  const known = (a: unknown): Audience => (a === 'invited' || a === 'solo' ? a : 'open');
  const ordered = orderRows(rows);
  return SECTIONS
    .map((section) => ({
      key: section.key,
      label: section.label,
      rows: ordered.filter((row) => known(row.audience) === section.key),
    }))
    .filter((section) => section.rows.length > 0);
}
