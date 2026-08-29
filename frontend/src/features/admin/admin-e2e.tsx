'use strict';

import { useMemo, useState } from 'react';

// The shared admin class-string registry — imported, not read off the
// global, so the dependency survives bundling (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { E2E_RUN, E2E_AREAS, E2E_CASES } from './e2e-results-data.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// End-to-end coverage section of the admin console (#admin/e2e).
//
// The platform has 300+ unit tests and 365 declared dapp tests, and both
// answer the same question: "does this component still behave?" Neither
// answers the question an operator actually asks before a release —
// "has anyone walked the product end to end, on production, recently,
// and what did they find?" That evidence has historically lived in a
// chat log and then evaporated. This section is where it stops
// evaporating.
//
// It is a REPORT, not a runner: nothing here executes a test. The
// dataset is generated (see ./e2e-results-data.js) from the same table
// that writes docs/e2e-use-cases.md, so the repo document and this
// screen cannot drift. Re-running the sweep means regenerating both.
//
// Read the three status groups as different kinds of claim:
//   pass     — someone exercised it and watched it work.
//   fail     — someone exercised it and it broke. These are the point.
//   blocked  — could not be run because something else is down.
//   pending  — needs a human hand (a password, an OAuth consent, a
//              phone, a passport) and has not been done yet.
//   skipped  — deliberately not run, with the reason recorded.
//
// PERMISSIONS: read-only, and visible to any admin (full or view-only).
// It reads no API at all — the data is compiled in — so there is nothing
// to gate beyond reaching the console.
//
// ── React-owned, and the first section that is (#1120 slice 6) ─────────
//
// The module still presents the `{ render(host), destroy() }` shape
// `AdminConsole._renderSection` dispatches through, but `render` mounts a
// portal from the MAIN React tree instead of assigning `innerHTML`. Nothing
// else writes below `#admin-section-content` while a section is live — every
// path into that host (`_renderSection`, `_renderMobileMenu`) runs
// `_teardownActiveSection()` first — so the whole subtree is React's for the
// life of the mount, which is the ownership rule in AGENTS.md satisfied at
// the section boundary rather than at some node inside it.
//
// Three things the conversion buys, and they are the reason to do the other
// twenty-nine sections the same way:
//
//   * The filter is STATE, not a repaint. `repaintList()` and
//     `repaintSummary()` rebuilt two `innerHTML` blocks on every keystroke,
//     which is also why the search box needed a delegated listener on a
//     re-created element and why `generation` existed at all.
//   * Nothing is escaped by hand. `esc()` guarded five interpolations here;
//     React escapes text children by construction, so the class of bug it
//     was defending against cannot be written.
//   * The class strings are unchanged. This is a renderer swap, not a
//     restyle: every `AdminUI.*` recipe interpolated into the old template
//     is a `className` here, so the rendered markup is like-for-like down
//     to the ids (`admin-e2e-summary`, `-q`, `-clear`, `-list`) that survive
//     only to keep this diff honest.
//
// The console keeps the registry rather than reaching for
// `@/components/ui/**` — see tests/admin-ui-registry.test.js. Same
// vocabulary as the shell since the reskin, still its own recipes, because
// an operator console is a denser surface than a phone screen and the two
// should be restylable apart.

interface E2ECase {
  id: string;
  area: string;
  name: string;
  flow: string;
  notes: string;
  status: string;
  gate: string;
  method: string;
}

interface E2EArea {
  key: string;
  title: string;
  blurb: string;
}

const CASES = E2E_CASES as readonly E2ECase[];
const AREAS = E2E_AREAS as readonly E2EArea[];
const RUN = E2E_RUN as { ran: string; environment: string; total: number; counts: Record<string, number> };

// Status → badge recipe. `fail` is deliberately the loudest thing on the
// screen: a red pill among green ones is the whole reason to open this.
const STATUS_BADGE: Record<string, string> = {
  pass: AdminUI.badge.success,
  fail: AdminUI.badge.destructive,
  blocked: AdminUI.badge.warn,
  pending: AdminUI.badge.default,
  skipped: AdminUI.badge.outline,
};

const METHOD_LABEL: Record<string, string> = {
  browser: 'Browser-auto',
  api: 'API-auto',
  phone: 'Phone-in-loop',
  assist: 'User-assist',
  unit: 'Unit-pinned',
  manual: 'Manual',
};

const GATE_LABEL: Record<string, string> = {
  guest: 'Guest',
  user: 'User',
  admin: 'Admin',
  alt: '2 accounts',
  device: 'Device',
  creds: 'Ext. creds',
};

const STATUS_ORDER = ['fail', 'blocked', 'pending', 'pass', 'skipped'];

function CaseRow({ c }: { c: E2ECase }) {
  const badge = STATUS_BADGE[c.status] || AdminUI.badge.default;
  return (
    <tr className={AdminUI.trHover}>
      <td className={`${AdminUI.td} font-mono text-xs text-zinc-500 dark:text-zinc-300 whitespace-nowrap align-top`}>{c.id}</td>
      <td className={`${AdminUI.td} align-top`}>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.name}</span>
        <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-1">{c.flow}</p>
        {c.notes ? <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-1">{c.notes}</p> : null}
      </td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-300`}>{GATE_LABEL[c.gate] || c.gate}</td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-300`}>{METHOD_LABEL[c.method] || c.method}</td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap`}><span className={badge}>{c.status}</span></td>
    </tr>
  );
}

function AreaTable({ area, cases }: { area: E2EArea; cases: readonly E2ECase[] }) {
  return (
    <section className="mb-6">
      <h3 className={`${AdminUI.sectionTitle} mb-1`}>
        <span className="font-mono text-azure-700 dark:text-azure-300 mr-2">{area.key}</span>{area.title}
      </h3>
      <p className={`${AdminUI.cardDescription} mb-3`}>{area.blurb}</p>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>ID</th>
              <th className={AdminUI.th}>Use case</th>
              <th className={AdminUI.th}>Gate</th>
              <th className={AdminUI.th}>Method</th>
              <th className={AdminUI.th}>Status</th>
            </tr>
          </thead>
          <tbody>{cases.map((c) => <CaseRow key={c.id} c={c} />)}</tbody>
        </table>
      </div>
    </section>
  );
}

function E2ESection() {
  // Per-mount state. The portal entry is dropped on destroy() and a fresh
  // one created on the next render(), so React remounts this component and
  // the filter cannot leak across visits — what the module's `generation`
  // counter used to be for.
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => CASES.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    if (!needle) return true;
    return `${c.id} ${c.name} ${c.flow} ${c.notes}`.toLowerCase().includes(needle);
  }), [statusFilter, needle]);

  const counts = RUN.counts || {};
  // Failures first and always rendered, even at zero — "0 failures" is
  // information an operator wants stated, not implied by an absent tile.
  const tiles = STATUS_ORDER.filter((s) => s === 'fail' || counts[s]);

  const areas = AREAS
    .map((area) => ({ area, cases: visible.filter((c) => c.area === area.key) }))
    .filter((g) => g.cases.length > 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className={AdminUI.cardTitle}>End-to-end coverage</h2>
        <span className={AdminUI.badge.outline}>{RUN.environment} · {RUN.ran}</span>
      </div>
      {/* One child per run. A bare whitespace expression would split the text
          around it into adjacent children — see tests/shell-build.test.js. */}
      <p className={`${AdminUI.muted} mb-4 max-w-3xl`}>
        {`A record of the last full manual sweep of the product against production: ${RUN.total} `
          + 'catalogued user-facing flows, what was exercised, and what broke. Unit and dapp '
          + 'tests answer “does this component still behave?”; this answers “has anyone walked '
          + 'the product end to end, and what did they find?” It reports, it does not run: the '
          + 'data is generated alongside '}
        <span className={AdminUI.kbd}>docs/e2e-use-cases.md</span>
        {' so the two cannot drift.'}
      </p>
      <div id="admin-e2e-summary" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        {tiles.map((s) => {
          const n = counts[s] || 0;
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              data-e2e-status={s}
              aria-pressed={active}
              onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
              className={`${AdminUI.card} px-4 py-3 text-left transition-colors ${active ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`}
            >
              <span className={`block text-2xl font-semibold tabular-nums ${s === 'fail' && n ? 'text-red-700 dark:text-red-200' : 'text-zinc-900 dark:text-zinc-100'}`}>{n}</span>
              <span className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-300">{s}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          id="admin-e2e-q"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Filter by id, name or note…"
          className={`${AdminUI.input} max-w-sm`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          id="admin-e2e-clear"
          type="button"
          className={AdminUI.btn.outlineSm}
          onClick={() => { setStatusFilter(null); setQuery(''); }}
        >
          Clear filters
        </button>
      </div>
      <div id="admin-e2e-list">
        {areas.length
          ? areas.map((g) => <AreaTable key={g.area.key} area={g.area} cases={g.cases} />)
          : <p className={`${AdminUI.muted} py-8 text-center`}>No use case matches that filter.</p>}
      </div>
    </>
  );
}

let host: Element | null = null;

const AdminE2E = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <E2ESection />);
  },

  destroy() {
    // Nothing polls and nothing is in flight — the teardown is purely about
    // not carrying this section's filter state into the next mount of it,
    // which dropping the portal entry does: the next render() gets a new
    // `seq` and therefore a fresh component instance.
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminE2E = AdminE2E;

export { AdminE2E };
