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
