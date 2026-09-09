'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BTN, PANEL_CLS } from './tokens.ts';
import { Input, Panel, ScreenHeader, Select, Textarea } from './ui.tsx';

// API tester — the programme console's "send a request with your own session"
// screen. Same-origin requests, so the platform still applies every gate it
// would apply to the real client; this only saves opening a second tool.
//
// ── React-owned (#1120 slice 24) ──────────────────────────────────────
//
// The first of admin-topochain.js's eleven screens through the portal seam,
// and picked first because it is the smallest and owns no shared state: the
// endpoint catalog, the method, the path and the body are this screen's and
// nothing else reads them.
//
// What the conversion retires is the module's four-way DOM handshake. The
// path INPUT was the single source of truth for what got sent; the select
// wrote into it, `_syncApiTarget` read both back out to repaint one <span>,
// and `_onApiEndpointChange` toggled a `hidden` class on the row between
// them. All four functions existed to keep four nodes agreeing about two
// values. Here `endpoint` and `path` are state, the target line and the row's
// visibility are derived, and the handshake has nothing left to do.
//
// The catalog load keeps its two failure branches verbatim, because both are
// the point: a tester that cannot list the surface still has to be usable, so
// the free-text path is left exactly as it was and the note says why the list
// is gone. `alive` is the "operator navigated away mid-fetch" guard the old
// `document.body.contains(sel)` probe stood in for.
//
// Ids are like-for-like with the innerHTML version — `admin-topo-api-*` are
// named by tests/topochain-admin-screens.test.js and by dapp.json's declared
// checks.

const API_CUSTOM = '__custom__';

type Route = { method: string; path: string; group: string; has_params?: boolean };

const labelOf = (r: Route) => `${r.method} ${r.path}`;

// The five verbs the method select offers. A catalog route with anything else
// leaves the select alone rather than being written into it — the innerHTML
// version guarded the same way (`[...methodSel.options].some(...)`), and
// without it the select would hold a value none of its options carry.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Normalised for sending: the field may be empty, or missing its leading
// slash. Ported from AdminTopochain._apiTargetPath.
function normalisePath(raw: string): string {
  let p = (raw || '').trim();
  if (!p) p = '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

type Result =
  | { kind: 'idle' }
  | { kind: 'note'; tone: string; text: string }
  | { kind: 'response'; ok: boolean; status: number; statusText: string; body: string };

const NOTE_TONES = {
  error: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400',
  busy: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400',
};

function ResultBlock({ result }: { result: Result }) {
  if (result.kind === 'idle') return null;
  if (result.kind === 'note') {
    return (
      <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${result.tone}`} role="status">
        {result.text}
      </p>
    );
  }
  const okTone = result.ok
    ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
    : 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-400';
  return (
    <div className={`mt-4 ${PANEL_CLS} overflow-hidden`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold">Response</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${okTone}`}>
          {`HTTP ${result.status} ${result.statusText}`}
        </span>
      </header>
      <pre className="text-xs font-mono bg-zinc-50 dark:bg-zinc-950 p-4 overflow-x-auto whitespace-pre-wrap max-h-[32rem]">
        {result.body}
      </pre>
    </div>
  );
}

// The endpoint select's options, grouped exactly as the catalog reports them:
// one <optgroup> per group, in first-seen order, with Custom… last.
function EndpointOptions({ routes }: { routes: Route[] }) {
  const groups: string[] = [];
  routes.forEach((r) => { if (!groups.includes(r.group)) groups.push(r.group); });
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {routes.filter((r) => r.group === g).map((r) => (
            <option key={labelOf(r)} value={labelOf(r)}>{labelOf(r)}</option>
          ))}
        </optgroup>
      ))}
      <option value={API_CUSTOM}>Custom…</option>
    </>
  );
}

function ApiTesterScreen() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [note, setNote] = useState('Loading the endpoint list…');
  const [endpoint, setEndpoint] = useState(API_CUSTOM);
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/admin/seasons');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // GET /api/v4/admin/api-catalog — every route this build actually mounted,
  // introspected from Express's router stack server-side (see
  // src/routes/topochain/admin/api-catalog.js). Nothing here is a hardcoded
  // list, so a route added or renamed anywhere under src/routes/topochain/
  // appears in this select with no client change.
  useEffect(() => {
    (async () => {
      let loaded: Route[] | null = null;
      try {
        const res = await fetch('/api/v4/admin/api-catalog', { credentials: 'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        loaded = Array.isArray(data.data) ? data.data : [];
      } catch (err: any) {
        // A tester that can't list the surface still has to be usable: leave
        // the free-text path exactly as it was and say why the list is gone.
        if (!alive.current) return;
        setRoutes([]);
        setNote(`Could not load the endpoint list (${err.message}). Enter a path by hand.`);
        return;
      }
      // The operator may have navigated away while the fetch was in flight.
      if (!alive.current) return;
      setRoutes(loaded);
      if (!loaded.length) {
        setNote('No /api/v4 endpoints were reported. Enter a path by hand.');
        return;
      }
      setNote(`${loaded.length} endpoint${loaded.length === 1 ? '' : 's'} mounted in this build`
        + '. Pick “Custom…” to send any other path.');
      // Default to the Seasons index — this screen lives under Seasons, and
      // it is a parameter-free GET, so it is safe to have preselected.
      const preferred = loaded.find((r) => r.method === 'GET' && r.path === '/admin/seasons')
        || loaded.find((r) => r.method === 'GET' && !r.has_params)
        || loaded[0];
      setEndpoint(labelOf(preferred));
      if (METHODS.includes(preferred.method)) setMethod(preferred.method);
      setPath(preferred.path);
    })();
  }, []);

  const picked = useMemo(
    () => routes.find((r) => labelOf(r) === endpoint) || null,
    [routes, endpoint],
  );
  // A `:id`-style route can't be fired as written, so the field stays OPEN
  // (prefilled) for exactly those — the operator substitutes the value in
  // place. A concrete route hides it: the select is the target. Custom… has
  // no route at all, so the field is the only way to say where to send.
  const showPath = endpoint === API_CUSTOM || !!(picked && picked.has_params);
  const target = `${method} /api/v4${normalisePath(path)}`;

  const onEndpoint = useCallback((value: string) => {
    setEndpoint(value);
    if (value === API_CUSTOM) return;
    const sp = value.indexOf(' ');
    const verb = sp > 0 ? value.slice(0, sp) : 'GET';
    if (METHODS.includes(verb)) setMethod(verb);
    setPath(sp > 0 ? value.slice(sp + 1) : value);
  }, []);

  const send = useCallback(async () => {
    const sending = normalisePath(path);
    const opts: RequestInit = { method, credentials: 'same-origin' };
    if (method !== 'GET' && method !== 'DELETE') {
      const raw = body.trim();
      if (raw) {
        try { JSON.parse(raw); } catch {
          setResult({ kind: 'note', tone: NOTE_TONES.error, text: 'Body must be valid JSON.' });
          return;
        }
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = raw;
      }
    }
    setResult({ kind: 'note', tone: NOTE_TONES.busy, text: 'Sending…' });
    try {
      const res = await fetch(`/api/v4${sending}`, opts);
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON, show raw */ }
      if (!alive.current) return;
      setResult({
        kind: 'response',
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        body: pretty,
      });
    } catch (err: any) {
      if (!alive.current) return;
      setResult({ kind: 'note', tone: NOTE_TONES.error, text: `Network error: ${err.message}` });
    }
  }, [method, path, body]);

  return (
    <>
      <ScreenHeader
        title="API tester"
        subtitle="Same-origin requests sent with your own session. The platform still applies its own gates."
      />
      <Panel
        title="Request"
        subtitle="Pick a mounted /api/v4 endpoint (or Custom…), then a method and an optional JSON body."
        footer={(
          <button id="admin-topo-api-send" type="button" className={BTN.primary} onClick={send}>
            Send request
          </button>
        )}
      >
        <div className="min-w-0">
          <label
            htmlFor="admin-topo-api-endpoint"
            className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
          >
            Endpoint
          </label>
          <Select
            id="admin-topo-api-endpoint"
            value={endpoint}
            onChange={(e) => onEndpoint(e.target.value)}
          >
            <EndpointOptions routes={routes} />
          </Select>
          <p
            id="admin-topo-api-catalog-note"
            className="mt-1 text-xs text-zinc-500 dark:text-zinc-400"
            role="status"
          >
            {note}
          </p>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]">
          <div className="sm:w-32">
            <label
              htmlFor="admin-topo-api-method"
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
            >
              Method
            </label>
            <Select
              id="admin-topo-api-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </div>
          <div className={showPath ? 'min-w-0' : 'min-w-0 hidden'} id="admin-topo-api-path-row">
            <label
              htmlFor="admin-topo-api-path"
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
            >
              {'Path '}
              <span className="font-mono font-normal text-zinc-500 dark:text-zinc-400">(prefixed with /api/v4)</span>
            </label>
            <Input
              id="admin-topo-api-path"
              type="text"
              className="font-mono"
              placeholder="/admin/seasons"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {'Target '}
          <span id="admin-topo-api-target" className="font-mono text-zinc-700 dark:text-zinc-300">
            {target}
          </span>
        </p>
        <div className="mt-4">
          <label
            htmlFor="admin-topo-api-body"
            className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
          >
            {'JSON body '}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">(ignored for GET)</span>
          </label>
          <Textarea
            id="admin-topo-api-body"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      </Panel>
      <div id="admin-topo-api-result">
        <ResultBlock result={result} />
      </div>
    </>
  );
}

export { API_CUSTOM, ApiTesterScreen };
