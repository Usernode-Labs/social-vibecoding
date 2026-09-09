'use strict';

// The programme console's fetch helpers, lifted out of admin-topochain.js in
// #1120 slice 25 so the React screens and the innerHTML screens share ONE
// copy. AdminTopochain.fetchJson / .send delegate here; nothing about either
// contract changed in the move.

// Safe fetch+parse, never throws — same contract as AdminConsole.fetchJson /
// TopochainChallenges.fetchJson, extended with an options bag so this module
// can also POST/PUT/PATCH/DELETE (the other two only ever GET).
export async function fetchJson(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; ok: boolean; data: any }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
    try { return { status: res.status, ok: res.ok, data: await res.json() }; }
    catch { return { status: res.status, ok: res.ok, data: null }; }
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

// JSON-body convenience wrapper for the mutating verbs.
export async function send(method: string, url: string, body?: unknown) {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return fetchJson(url, opts);
}

// ── Picker sources ─────────────────────────────────────────────────────
//
// Fetches every season-event / season for the <select> pickers and filters
// several screens carry. Both datasets are small and admin-seeded (a handful
// of pages at most), and neither is cached: each picker refetches so a
// just-created event shows up immediately. Lifted out of admin-topochain.js
// with the rest of the shared surface (#1120 slice 29); the module keeps
// `_fetchAllEvents` / `_fetchAllSeasons` as members that delegate here.

async function fetchAllPages(path: string): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  for (let guard = 0; guard < 20; guard += 1) {
    const { ok, data } = await fetchJson(`${path}?page=${page}&per_page=100`);
    if (!ok || !data?.success || !Array.isArray(data.data)) break;
    out.push(...data.data);
    const meta = data.meta;
    if (!meta || page >= meta.total_pages) break;
    page += 1;
  }
  return out;
}

export const fetchAllEvents = () => fetchAllPages('/api/v4/admin/season-events');
export const fetchAllSeasons = () => fetchAllPages('/api/v4/admin/seasons');

export const eventOptions = (events: any[]) =>
  events.map((ev) => ({ value: ev.id, label: `${ev.name} (#${ev.id})` }));
export const seasonOptions = (seasons: any[]) =>
  seasons.map((s) => ({ value: s.id, label: `${s.name} (#${s.id})` }));
