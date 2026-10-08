'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Small changes (#admin/small-changes).
//
// The watch-only small-change tag (src/services/small-change.js): for each
// proposal head a checks run settles on, whether the change is clearly small
// and undoable. This screen is where the team watches it: the latest tags,
// what ruled the others out, and the last week's totals, read from
// GET /api/admin/small-change-tags. Nothing about votes, merges, checks or
// cards reads a tag, and the screen says so.
//
// Read only, so it is open to every admin, like the endpoint. The verdict
// filter works over the rows already loaded; there is nothing to write.

type Verdict = 'small' | 'not_small' | 'vetoed' | 'unavailable';

interface Tag {
  id: number;
  sessionId: number;
  app: { slug: string; name: string } | null;
  prNumber: number | null;
  title: string | null;
  headSha: string;
  verdict: Verdict;
  kind: string | null;
  reason: string | null;
  vetoes: string[];
  filesChanged: number | null;
  linesChanged: number | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface SmallChangesPayload {
  mode: 'on' | 'off';
  model: string;
  limits: { maxFiles: number; maxLines: number };
  lastWeek: Record<Verdict, number> & { costUsd: number; vetoes: Record<string, number> };
  tags: Tag[];
}

const LIMIT = 200;

export const VERDICT_LABEL: Record<Verdict, string> = {
  small: 'Small',
  not_small: 'Not small',
  vetoed: 'Ruled out',
  unavailable: 'Not decided',
};

const VERDICT_BADGE: Record<Verdict, string> = {
  small: AdminUI.badge.success,
  not_small: AdminUI.badge.secondary,
  vetoed: AdminUI.badge.outline,
  unavailable: AdminUI.badge.warn,
};

export const KIND_LABEL: Record<string, string> = {
  fix: 'fix',
  wording: 'wording',
  look: 'look',
  addition: 'small addition',
};

// Each rule-based veto in plain words, in services/small-change.js VETOES order.
export const VETO_LABEL: Record<string, string> = {
  flagged_risky: 'needs a Yes from another member',
  protected_manifest: 'changes a protected dapp.json block',
  removed_check: 'removes a dapp.json test',
  manifest_unreadable: 'dapp.json does not read',
  schema_or_data_sql: 'SQL that changes a schema or writes data',
  dependencies: 'changes dependencies',
  build_or_ci: 'changes the build or CI',
  deleted_file: 'deletes a file',
  too_large: 'too large',
  incomplete_diff: 'diff too big to read whole',
};

// Why a head could not be decided, in plain words.
const ERROR_LABEL: Record<string, string> = {
  no_key: 'no OpenRouter key for the bot',
  compare_failed: 'GitHub compare failed',
  unparseable: 'the model gave no usable answer',
};

function vetoWords(codes: string[]): string {
  return codes.map((c) => VETO_LABEL[c] || c).join(', ');
}

function why(tag: Tag): string {
  if (tag.verdict === 'vetoed') return vetoWords(tag.vetoes || []);
  if (tag.verdict === 'unavailable') return tag.error ? (ERROR_LABEL[tag.error] || tag.error) : 'not decided';
  return tag.reason || '';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${Number(n) === 1 ? '' : 's'}`;
}

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  return v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The week's totals as one sentence; a verdict with none is left out. */
export function weekLine(week: SmallChangesPayload['lastWeek'] | undefined): string {
  if (!week) return '';
  const parts = (Object.keys(VERDICT_LABEL) as Verdict[])
    .filter((v) => Number(week[v]) > 0)
    .map((v) => `${week[v]} ${VERDICT_LABEL[v].toLowerCase()}`);
  if (!parts.length) return 'Nothing tagged in the last 7 days.';
  const cost = usd(week.costUsd);
  return `Last 7 days: ${parts.join(', ')}${cost && Number(week.costUsd) > 0 ? `, ${cost} in model calls` : ''}.`;
}

/** What ruled heads out this week, most common first. */
export function vetoLine(week: SmallChangesPayload['lastWeek'] | undefined): string {
  const entries = Object.entries(week?.vetoes || {}).filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) return '';
  return `Ruled out this week for: ${entries.map(([code, n]) => `${VETO_LABEL[code] || code} (${n})`).join(', ')}.`;
}

export function SmallChangesView({ payload, verdict, onVerdict }: {
  payload: SmallChangesPayload | null;
  verdict: Verdict | '';
  onVerdict: (v: Verdict | '') => void;
}) {
  const tags = (payload?.tags || []).filter((t) => !verdict || t.verdict === verdict);
  const limits = payload?.limits;
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Small changes</h2>
        <span className={AdminUI.cardDescription}>
          {payload ? (payload.mode === 'off' ? 'Off' : `On, using ${payload.model}`) : 'Loading…'}
        </span>
      </div>
      <p className={`${AdminUI.muted} mb-2`} id="admin-small-changes-about">
        Watch only. When a proposal&apos;s checks finish, each version is tagged as small and undoable (a fix,
        a wording or look change, or a small optional addition) or not. Rules run first and rule out anything
        risky or bigger than {limits ? `${limits.maxFiles} files or ${limits.maxLines} changed lines` : 'a few files'};
        only what passes them is asked of the model. Nothing about votes, merges, checks or cards reads these tags.
      </p>
      {payload?.mode === 'off' ? (
        <p className={`${AdminUI.muted} mb-2`} id="admin-small-changes-off">
          The tagger is off: SMALL_CHANGE_TAG_MODE is set to off, so new versions are not tagged.
        </p>
      ) : null}
      <p className="text-sm mb-1" id="admin-small-changes-week">{payload ? weekLine(payload.lastWeek) : ''}</p>
      {payload && vetoLine(payload.lastWeek) ? (
        <p className={`${AdminUI.muted} mb-3`} id="admin-small-changes-vetoes">{vetoLine(payload.lastWeek)}</p>
      ) : null}
      <div className="flex items-center gap-2 mb-3">
        <label className={AdminUI.label} htmlFor="admin-small-changes-filter">Show</label>
        {/* The recipe is full width; the wrapper sets how wide. */}
        <div className="w-48">
          <select
            id="admin-small-changes-filter"
            className={AdminUI.select}
            value={verdict}
            onChange={(e) => onVerdict(e.target.value as Verdict | '')}
          >
            <option value="">Every tag</option>
            <option value="small">Small</option>
            <option value="not_small">Not small</option>
            <option value="vetoed">Ruled out</option>
            <option value="unavailable">Not decided</option>
          </select>
        </div>
      </div>
      <div className={AdminUI.tableWrap}>
        <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-small-changes-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>When</th>
              <th className={`${AdminUI.th} min-w-[14rem]`}>Change</th>
              <th className={AdminUI.th}>Tag</th>
              <th className={`${AdminUI.th} min-w-[16rem]`}>Why</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr className={AdminUI.trHover} key={tag.id} data-small-change-tag={tag.id} data-verdict={tag.verdict}>
                <td className={`${AdminUI.td} whitespace-nowrap`}>{when(tag.createdAt)}</td>
                <td className={AdminUI.td}>
                  {tag.app ? (
                    // Built from the row's own slug and session id, never from a URL the API handed over.
                    <a
                      className={AdminUI.btn.link}
                      href={`#app/${encodeURIComponent(tag.app.slug)}/dev/proposals/${Number(tag.sessionId)}`}
                    >{tag.prNumber != null ? `#${tag.prNumber} ` : ''}{tag.title || 'Untitled change'}</a>
                  ) : (tag.title || 'Untitled change')}
                  <div className={`${AdminUI.muted} text-xs`}>
                    {tag.app ? tag.app.name : 'Unknown project'} · <span className="font-mono">{String(tag.headSha).slice(0, 7)}</span>
                    {tag.filesChanged != null ? ` · ${count(tag.filesChanged, 'file')}, ${count(tag.linesChanged ?? 0, 'line')}` : ''}
                    {usd(tag.costUsd) ? ` · ${usd(tag.costUsd)}` : ''}
                  </div>
                </td>
                <td className={`${AdminUI.td} whitespace-nowrap`}>
                  <span className={VERDICT_BADGE[tag.verdict] || AdminUI.badge.secondary}>{VERDICT_LABEL[tag.verdict] || tag.verdict}</span>
                  {tag.verdict === 'small' && tag.kind ? (
                    <div className={`${AdminUI.muted} text-xs mt-1`}>{KIND_LABEL[tag.kind] || tag.kind}</div>
                  ) : null}
                </td>
                <td className={AdminUI.td}>{why(tag)}</td>
              </tr>
            ))}
            {payload && tags.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={4} id="admin-small-changes-empty">
                  {verdict
                    ? `No ${VERDICT_LABEL[verdict].toLowerCase()} tags among the latest ${LIMIT}.`
                    : 'No tags yet. A proposal is tagged when its checks finish.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SmallChangesSection() {
  const console_ = () => (window as any).AdminConsole;
  const [payload, setPayload] = useState<SmallChangesPayload | null>(null);
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson(`/api/admin/small-change-tags?limit=${LIMIT}`);
    if (alive.current && data && typeof data === 'object') setPayload(data as SmallChangesPayload);
  }, []);

  useEffect(() => { load(); }, [load]);

  return <SmallChangesView payload={payload} verdict={verdict} onVerdict={setVerdict} />;
}

let host: Element | null = null;

const AdminSmallChanges = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <SmallChangesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminSmallChanges = AdminSmallChanges;

export { AdminSmallChanges };
