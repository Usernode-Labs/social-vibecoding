'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchJson } from './api.ts';
import { BTN } from './tokens.ts';
import { EmptyState, Input, Panel, ScreenHeader, Skeleton, Textarea } from './ui.tsx';

// SQL console — read-only queries against the app database, with the schema
// browser and the query templates beside the editor. POST
// /api/v4/admin/sql-query/execute runs under a restricted role inside
// BEGIN TRANSACTION READ ONLY, which is why this is the one mutating-LOOKING
// control in the programme console that needs no canWrite() gate.
//
// ── React-owned (#1120 slice 25) ──────────────────────────────────────
//
// Second screen through the portal seam admin-topochain.js's _renderSub
// opened, and the one that shows what the seam is worth: the innerHTML
// version kept its schema in a module global (`_sql.schema`) purely so the
// filter box could re-render from it, indexed each button by its position in
// that array so the click handler would not have to resolve a name against
// the filtered view, and re-attached a listener to every button on every
// keystroke. Here the schema is state, the filtered view is derived, and a
// button closes over its own table — the index indirection has nothing left
// to protect against.
//
// Two things deliberately did NOT change:
//
//   - The filter is still client-side over the fetched schema. One request,
//     then keystroke-local narrowing; a request per keystroke would re-fetch
//     ~110 tables of schema per character against the admin API.
//   - A table button still drafts an EXPLICIT-COLUMN select. The server-side
//     validator rejects bare wildcards outright, so a drafted `SELECT *`
//     would be a query the console hands you and then refuses to run — and
//     listing `t.columns` keeps the draft inside the redaction the server
//     already applied to that list.
//
// The result grid is deliberately not the shared list renderer: the columns
// are whatever the query returned, so there is no primary column to title a
// card with and no stable label set.
//
// Ids are like-for-like — `admin-topo-sql-*` are named by four declared
// checks in dapp.json.

type Column = { name: string };
type Table = { name: string; comment?: string | null; columns: Column[] };
type Template = { name: string; description: string; query: string };

type QueryResult =
  | { kind: 'idle' }
  | { kind: 'note'; tone: string; text: string }
  | { kind: 'empty'; ms: number }
  | {
    kind: 'rows';
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    limited: boolean;
    ms: number;
  };

const NOTE_TONES = {
  error: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400',
  warn: 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-400',
  busy: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400',
};

const UNAVAILABLE = <p className="text-xs text-zinc-500 dark:text-zinc-400">Unavailable.</p>;

function ResultBlock({ result }: { result: QueryResult }) {
  if (result.kind === 'idle') return null;
  if (result.kind === 'note') {
    return (
      <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${result.tone}`} role="status">
        {result.text}
      </p>
    );
  }
  if (result.kind === 'empty') {
    return (
      <div className="mt-3">
        <EmptyState title="No rows" body={`The query ran in ${result.ms} ms and matched nothing.`} />
      </div>
    );
  }
  return (
    <>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 mt-3">
        {`${result.rowCount} row(s)${result.limited ? ' (truncated to the limit)' : ''} in ${result.ms} ms`}
      </p>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <tr>
              {result.columns.map((c) => <th key={c} className="px-2 py-1 text-left">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                {result.columns.map((c) => (
                  <td key={c} className="px-2 py-1 text-xs font-mono whitespace-nowrap">
                    {row[c] == null ? '' : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SqlConsoleScreen() {
  const [templates, setTemplates] = useState<Template[] | null | 'error'>(null);
  const [schema, setSchema] = useState<Table[] | null | 'error'>(null);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState('100');
  const [result, setResult] = useState<QueryResult>({ kind: 'idle' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/sql-query/templates');
      if (!alive.current) return;
      setTemplates(!ok || !data?.success ? 'error' : data.data);
    })();
    (async () => {
      // Server order is already alphabetical across the whole schema
      // (db-console-scope.js sorts it); don't re-sort, just render.
      const { ok, data } = await fetchJson('/api/v4/admin/sql-query/schema');
      if (!alive.current) return;
      setSchema(!ok || !data?.success ? 'error' : data.data);
    })();
  }, []);

  const tables = Array.isArray(schema) ? schema : [];
  const needle = filter.trim().toLowerCase();
  // Carries each table's index in the FULL schema alongside it. The click
  // handler no longer needs that index — a button closes over its own table —
  // but two declared checks in dapp.json select
  // `#admin-topo-sql-schema button[data-table]`, so the attribute is part of
  // this screen's contract and is rendered exactly as before.
  const shown = useMemo(
    () => tables
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !needle || t.name.toLowerCase().includes(needle)),
    [tables, needle],
  );

  const run = useCallback(async () => {
    // Read-only by construction server-side, so no canWrite() gate.
    const q = query.trim();
    if (!q) { setResult({ kind: 'note', tone: NOTE_TONES.error, text: 'Enter a query.' }); return; }
    setResult({ kind: 'note', tone: NOTE_TONES.busy, text: 'Running…' });
    const { status, ok, data } = await fetchJson('/api/v4/admin/sql-query/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, limit: Number(limit.trim() || '100') }),
    });
    if (!alive.current) return;
    if (status === 503) {
      setResult({
        kind: 'note',
        tone: NOTE_TONES.warn,
        text: (data && data.error) || 'The SQL console is not available right now.',
      });
      return;
    }
    if (!ok || !data?.success) {
      setResult({ kind: 'note', tone: NOTE_TONES.error, text: (data && data.error) || 'Query failed.' });
      return;
    }
    if (!data.data.length) { setResult({ kind: 'empty', ms: data.execution_time_ms }); return; }
    setResult({
      kind: 'rows',
      columns: data.columns,
      rows: data.data,
      rowCount: data.row_count,
      limited: !!data.limited,
      ms: data.execution_time_ms,
    });
  }, [query, limit]);

  // Never `SELECT *` — see the header note.
  const draft = useCallback((t: Table) => {
    setQuery(`SELECT ${t.columns.map((c) => c.name).join(', ')} FROM ${t.name} LIMIT 100`);
  }, []);

  return (
    <>
      <ScreenHeader
        title="SQL console"
        subtitle="Read-only queries against the app database. Pick a template or a table to start."
      />
      {/* Editor first in the DOM so a phone gets the thing it came for without
          scrolling past two reference lists; `lg:order-*` puts the sidebar back
          on the left once there is room for both. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <div className="lg:order-2">
          <Panel
            title="Query"
            subtitle="SELECT only — bare wildcards are rejected."
            footer={(
              <>
                <button id="admin-topo-sql-run" type="button" className={BTN.primary} onClick={run}>
                  Run query
                </button>
                <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>Limit</span>
                  <input
                    id="admin-topo-sql-limit"
                    type="number"
                    min="1"
                    max="1000"
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                    className="w-24 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </label>
              </>
            )}
          >
            <Textarea
              id="admin-topo-sql-query"
              rows={8}
              placeholder="SELECT ..."
              aria-label="SQL query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Panel>
          <div id="admin-topo-sql-result">
            <ResultBlock result={result} />
          </div>
        </div>
        <div className="lg:order-1 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <Panel title="Templates">
            <div id="admin-topo-sql-templates" className="space-y-1">
              {templates === null ? <Skeleton rows={3} /> : null}
              {templates === 'error' ? UNAVAILABLE : null}
              {Array.isArray(templates) ? templates.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  title={t.description}
                  className={BTN.sidebar}
                  onClick={() => setQuery(t.query)}
                >
                  {t.name}
                </button>
              )) : null}
            </div>
          </Panel>
          <Panel
            title="Schema"
            subtitle="Every table in the app database, including the auth and push tables. Credential columns are hidden. Click one to draft a SELECT."
          >
            {/* The list covers the whole schema (~110 tables — every base table
                in `public`), so a filter box is the difference between a
                browsable panel and a scroll. */}
            <Input
              id="admin-topo-sql-schema-filter"
              type="search"
              placeholder="Filter tables…"
              aria-label="Filter tables"
              autoComplete="off"
              className="mb-2"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <p
              id="admin-topo-sql-schema-count"
              className="mb-1 text-xs text-zinc-500 dark:text-zinc-400"
              role="status"
            >
              {Array.isArray(schema)
                ? (needle ? `${shown.length} of ${tables.length} tables` : `${tables.length} tables`)
                : ''}
            </p>
            <div id="admin-topo-sql-schema" className="space-y-1 max-h-96 overflow-y-auto">
              {schema === null ? <Skeleton rows={3} /> : null}
              {schema === 'error' ? UNAVAILABLE : null}
              {Array.isArray(schema) && !shown.length ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">No table matches that filter.</p>
              ) : null}
              {shown.map(({ t, i }) => (
                <button
                  key={t.name}
                  data-table={i}
                  type="button"
                  title={t.comment || ''}
                  className={`${BTN.sidebar} font-mono justify-between gap-2`}
                  onClick={() => draft(t)}
                >
                  <span className="truncate">{t.name}</span>
                  <span className="shrink-0 text-zinc-500 dark:text-zinc-500">{t.columns.length}</span>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

export { SqlConsoleScreen };
