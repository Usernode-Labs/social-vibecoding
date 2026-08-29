'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Activation codes (#admin/codes) — the invite codes that open registration.
//
// A code is either available or spent; a spent one keeps its row so the
// account it let in is traceable, struck through with who used it and when.
// Two copy affordances on an available code: the raw code, and a register
// link with the code baked in.
//
// PERMISSIONS: visible to any admin. Generate and delete are gated on
// AdminConsole.canWrite() (canAdminWrite); the server enforces the same on
// /api/admin/codes independently.
//
// ── Second section out of the chassis (#1120 slice 17) ────────────────
//
// Same move as admin-overview.tsx: the section leaves admin-console.js for a
// module behind SECTION_MODULES, and the chassis's `switch` loses another
// arm. See the header there for why the sections go first and the chassis
// last.
//
// The three per-button `querySelectorAll(...).forEach(addEventListener)`
// passes are gone — they ran after every repaint, over nodes the same repaint
// had just created — and so is the "Copied!" label that was written straight
// onto `btn.textContent` with a `setTimeout` to put it back. That timer now
// belongs to the row that owns the button, so it is cleared when the row goes
// away instead of firing into a detached node.

interface Code {
  id: number;
  code: string;
  used_by_username?: string;
  used_at?: string;
}

// 4px, not the control step: these rows fill a `${AdminUI.card} p-4`, so the
// concentric inner is 20 − 16. Same recipe as admin-overview.tsx's ROW/TILE.
const ROW = 'flex flex-wrap items-center justify-between gap-3 p-2.5 rounded bg-zinc-100 dark:bg-zinc-800';
const LINK_BTN = 'text-xs text-zinc-500 dark:text-zinc-300 transition-colors';

/**
 * A copy button that says so for a moment. The timer lives with the button,
 * so unmounting the row cancels it — the old shape reset `btn.textContent`
 * from a `setTimeout` that outlived the repaint.
 */
function CopyButton({ className, label, done, value }: {
  className: string; label: string; done: string; value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button type="button" className={className} data-code={value}
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}>
      {copied ? done : label}
    </button>
  );
}

function CodeRow({ code, canWrite, onDelete }: {
  code: Code; canWrite: boolean; onDelete: () => void;
}) {
  const used = !!code.used_by_username;
  return (
    <div className={ROW}>
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
        <code className={`font-mono text-sm ${used ? 'text-zinc-500 dark:text-zinc-300 line-through' : 'text-azure-700 dark:text-azure-300'}`}>{code.code}</code>
        {used ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-300">
            {'Used by '}<strong className="text-zinc-500 dark:text-zinc-300">{code.used_by_username}</strong>
            {` on ${new Date(code.used_at as string).toLocaleDateString()}`}
          </span>
        ) : <span className={AdminUI.badge.success}>Available</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!used ? (
          <CopyButton className={`admin-copy-code-btn ${LINK_BTN} hover:text-azure-800 dark:hover:text-azure-300`}
            label="Copy" done="Copied!" value={code.code} />
        ) : null}
        {!used ? (
          // In-SPA register route (fold-auth-pages-into-SPA); the old
          // /register.html?code=… form still works via the redirect stub.
          <CopyButton className={`admin-share-code-btn ${LINK_BTN} hover:text-meadow-700 dark:hover:text-meadow-200`}
            label="Share link" done="Link copied!"
            value={`${location.origin}/#register/${encodeURIComponent(code.code)}`} />
        ) : null}
        {!used && canWrite ? (
          <button type="button" className={`admin-delete-code-btn ${LINK_BTN} hover:text-red-700 dark:hover:text-red-200`}
            data-id={code.id} aria-label="Delete code"
            onClick={async () => {
              await fetch(`/api/admin/codes/${code.id}`, { method: 'DELETE' });
              onDelete();
            }}>×</button>
        ) : null}
      </div>
    </div>
  );
}

function CodesSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [codes, setCodes] = useState<Code[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await (window as any).AdminConsole.fetchJson('/api/admin/codes');
    if (!alive.current || !Array.isArray(data)) return;
    setCodes(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Activation Codes</h2>
        {canWrite ? (
          <button id="admin-generate-code-btn" type="button" className={AdminUI.btn.primary}
            onClick={async () => {
              await fetch('/api/admin/codes', { method: 'POST' });
              load();
            }}>Generate Code</button>
        ) : null}
      </div>
      <div id="admin-code-list" className="space-y-2">
        {(codes || []).map((c) => <CodeRow key={c.id} code={c} canWrite={canWrite} onDelete={load} />)}
      </div>
      <p id="admin-code-empty"
        className={`text-sm text-zinc-500 dark:text-zinc-300${codes && !codes.length ? '' : ' hidden'}`}>
        No activation codes yet.
      </p>
    </div>
  );
}

let host: Element | null = null;

const AdminCodes = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <CodesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminCodes = AdminCodes;

export { AdminCodes };
