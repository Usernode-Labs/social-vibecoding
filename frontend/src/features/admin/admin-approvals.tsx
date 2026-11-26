'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { changeHref } from '../../lib/change-href';
// The shared admin kit (26 Nov 2026): the header, the tabs, the table and the
// badges are the ones every other admin page is drawn with.
import { Badge, ScreenHeader, TABLE, TabPanel, Tabs } from './topochain/ui.tsx';

// Approvals (#admin/approvals, #6643).
//
// Changes held for an admin (src/services/release-holds.js): a change that
// trips one of that module's rules does not go live until a full admin other
// than its author votes yes on it. This screen lists the ones still waiting,
// oldest first, and what became of the ones before them, read from
// GET /api/admin/release-holds.
//
// Nothing is decided here. An admin answers by voting on the change itself,
// with the same buttons as everyone else: their yes lifts the hold, their no
// closes the change and its request. So the screen is read only and open to
// every admin, and each row is a link to the change.

type Outcome = 'waiting' | 'approved' | 'declined' | 'fixed' | 'closed' | 'notice';

interface Hold {
  id: number;
  sessionId: number;
  appSlug: string;
  appName: string;
  title: string;
  prNumber: number | null;
  author: string | null;
  rules: string[];
  reasons: string[];
  outcome: Outcome;
  note: string | null;
  decidedBy: string | null;
  heldAt: string | null;
  decidedAt: string | null;
  needsAnotherAdmin: boolean;
}

export interface ApprovalsPayload {
  waiting: Hold[];
  history: Hold[];
  rules: { key: string; words: string }[];
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  declined: 'Declined',
  fixed: 'No longer needed',
  closed: 'Closed first',
  notice: 'Told, not held',
};

// An outcome is repeated down the history, so it takes the kit's soft tones.
const OUTCOME_TONE: Record<Outcome, string> = {
  waiting: 'sky',
  approved: 'mint',
  declined: 'zinc',
  fixed: 'zinc',
  closed: 'zinc',
  notice: 'zinc',
};

type ApprovalsTab = 'waiting' | 'history';
const TABS_ID = 'admin-approvals-tabs';

function when(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** How long a hold has waited, in the largest whole unit. */
export function waited(iso: string | null, now: number = Date.now()): string {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

function ChangeCell({ hold }: { hold: Hold }) {
  return (
    <>
      {/* Built from the row's own slug, session id and PR number, never from a URL the API handed over. */}
      <a className={AdminUI.btn.link} href={changeHref(hold.appSlug, hold.sessionId, hold.prNumber)}>
        {hold.prNumber != null ? `#${hold.prNumber} ` : ''}{hold.title || 'Untitled change'}
      </a>
      <div className={`${AdminUI.muted} text-xs`}>
        {hold.appName || 'Unknown project'}{hold.author ? ` · by @${hold.author}` : ''}
      </div>
    </>
  );
}

function Reasons({ hold }: { hold: Hold }) {
  return (
    <ul className="list-none m-0 p-0">
      {hold.reasons.map((reason) => <li key={reason}>{reason}</li>)}
    </ul>
  );
}

export function ApprovalsView({ payload, tab, onTab, now }: {
  payload: ApprovalsPayload | null;
  tab: 'waiting' | 'history';
  onTab: (t: 'waiting' | 'history') => void;
  now?: number;
}) {
  const waiting = payload?.waiting || [];
  const history = payload?.history || [];
  return (
    <div>
      <ScreenHeader
        title="Approvals"
        subtitle={(
          <span id="admin-approvals-about">
            A change that carries risk is held: it cannot go live until an admin other than its author votes yes on
            it. Open the change and vote there. Your yes lets it through once its votes and checks allow; your no,
            with a reason, closes it and the request it was built for. Without an answer it stays held.
          </span>
        )}
        actions={(
          <span className={AdminUI.cardDescription} id="admin-approvals-count">
            {payload ? (waiting.length ? `${waiting.length} waiting` : 'Nothing waiting') : 'Loading…'}
          </span>
        )}
      />
      {/* The shared tabs, in place of two buttons that swapped a table. Both
          tables stay in the page; the one not open is hidden. */}
      <Tabs<ApprovalsTab>
        id={TABS_ID}
        label="Approvals"
        value={tab}
        onChange={onTab}
        tabs={[
          { key: 'waiting', label: `Waiting${waiting.length ? ` (${waiting.length})` : ''}`, id: 'admin-approvals-tab-waiting' },
          { key: 'history', label: 'History', id: 'admin-approvals-tab-history' },
        ]}
      />
      {/* The tables are written out with the kit's classes, not its list: each
          row and each table keeps a hook the list has no place for. */}
      <TabPanel tabsId={TABS_ID} tab="waiting" active={tab === 'waiting'}>
        <div className={TABLE.wrap}>
          <table className={`${TABLE.table} min-w-[40rem]`} id="admin-approvals-waiting">
            <thead className={TABLE.thead}>
              <tr>
                <th className={`${TABLE.th} min-w-[14rem]`}>Change</th>
                <th className={`${TABLE.th} min-w-[16rem]`}>Why it is held</th>
                <th className={TABLE.th}>Waiting</th>
                <th className={TABLE.th}>Your vote</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((hold) => (
                <tr className={TABLE.tr} key={hold.id} data-release-hold-row={hold.id}>
                  <td className={TABLE.td}><ChangeCell hold={hold} /></td>
                  <td className={TABLE.td}><Reasons hold={hold} /></td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{waited(hold.heldAt, now)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>
                    {hold.needsAnotherAdmin
                      ? <Badge tone="sky" label="Needs another admin" />
                      : <a className={AdminUI.btn.link} href={changeHref(hold.appSlug, hold.sessionId, hold.prNumber)}>Open to vote</a>}
                  </td>
                </tr>
              ))}
              {payload && waiting.length === 0 ? (
                <tr>
                  <td className={TABLE.td} colSpan={4} id="admin-approvals-empty">
                    No change is waiting for an admin.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </TabPanel>
      <TabPanel tabsId={TABS_ID} tab="history" active={tab === 'history'}>
        <div className={TABLE.wrap}>
          <table className={`${TABLE.table} min-w-[40rem]`} id="admin-approvals-history">
            <thead className={TABLE.thead}>
              <tr>
                <th className={TABLE.th}>When</th>
                <th className={`${TABLE.th} min-w-[14rem]`}>Change</th>
                <th className={`${TABLE.th} min-w-[14rem]`}>Why it was held</th>
                <th className={`${TABLE.th} min-w-[12rem]`}>What happened</th>
              </tr>
            </thead>
            <tbody>
              {history.map((hold) => (
                <tr className={TABLE.tr} key={hold.id} data-release-hold-row={hold.id} data-outcome={hold.outcome}>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{when(hold.decidedAt || hold.heldAt)}</td>
                  <td className={TABLE.td}><ChangeCell hold={hold} /></td>
                  <td className={TABLE.td}><Reasons hold={hold} /></td>
                  <td className={TABLE.td}>
                    <Badge tone={OUTCOME_TONE[hold.outcome] || 'zinc'} label={OUTCOME_LABEL[hold.outcome] || hold.outcome} />
                    {hold.decidedBy ? <div className={`${AdminUI.muted} text-xs mt-1`}>{`by @${hold.decidedBy}`}</div> : null}
                    {hold.note ? <div className="text-xs mt-1">{hold.note}</div> : null}
                  </td>
                </tr>
              ))}
              {payload && history.length === 0 ? (
                <tr>
                  <td className={TABLE.td} colSpan={4} id="admin-approvals-history-empty">
                    No change has been held yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </TabPanel>
      {payload?.rules?.length ? (
        <p className={`${AdminUI.muted} mt-3`} id="admin-approvals-rules">
          {`A change is held when: ${payload.rules.map((r) => r.words.charAt(0).toLowerCase() + r.words.slice(1)).join('; ')}.`}
        </p>
      ) : null}
    </div>
  );
}

function ApprovalsSection() {
  const console_ = () => (window as any).AdminConsole;
  const [payload, setPayload] = useState<ApprovalsPayload | null>(null);
  const [tab, setTab] = useState<'waiting' | 'history'>('waiting');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson('/api/admin/release-holds');
    if (alive.current && data && typeof data === 'object') setPayload(data as ApprovalsPayload);
  }, []);

  useEffect(() => { load(); }, [load]);

  return <ApprovalsView payload={payload} tab={tab} onTab={setTab} />;
}

let host: Element | null = null;

const AdminApprovals = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <ApprovalsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminApprovals = AdminApprovals;

export { AdminApprovals };
