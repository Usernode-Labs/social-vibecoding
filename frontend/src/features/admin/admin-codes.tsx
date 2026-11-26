'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { BTN } from './topochain/tokens.ts';
import { Badge, EmptyState, Field, Figures, List, ScreenHeader } from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';

// Invite links (#admin/codes) — activation codes, sent as links to Homeroom
// itself. One per person: whoever signs up from /welcome/<code> is let in at
// once, with no waitlist and no project attached (src/services/access-links.js).
//
// A code is either available or spent; a spent one keeps its row so the
// account it let in is traceable, struck through with who used it and when.
// The admin's note says who a link is for; nobody else sees it. Two copy
// affordances on an available code: the link (the way to send it), and the
// raw code, which the older #register/<code> form still takes by hand.
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
  note?: string | null;
  created_by_username?: string | null;
  used_by_username?: string;
  used_at?: string;
}

/** The address an admin sends (src/routes/access-links.js). */
function welcomeLink(code: string): string {
  return `${location.origin}/welcome/${encodeURIComponent(code)}`;
}

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

/** Spent once it has a time: an account removed later clears `used_by`
 * (ON DELETE SET NULL) but not the time, and the link stays spent. */
function isUsed(code: Code): boolean {
  return !!code.used_by_username || !!code.used_at;
}

// The list is the shared table (26 Nov 2026). Each link was a hand-drawn grey
// row, so this page's rows matched no other list in the console.
const CODE_COLUMNS: Column<Code>[] = [
  {
    label: 'Who it is for',
    primary: true,
    cell: (code) => (
      <span className={code.note ? 'font-medium' : 'text-zinc-500 dark:text-zinc-400'}>
        {code.note || 'No note'}
      </span>
    ),
  },
  {
    label: 'Status',
    cell: (code) => (isUsed(code) ? (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {code.used_by_username ? <>{'Used by '}<strong>{code.used_by_username}</strong></> : 'Used'}
        {code.used_at ? ` on ${new Date(code.used_at).toLocaleDateString()}` : ''}
      </span>
    ) : <Badge tone="mint" label="Available" />),
  },
  {
    label: 'Code',
    cell: (code) => (
      <code className={`font-mono text-xs ${isUsed(code) ? 'line-through text-zinc-500 dark:text-zinc-400' : 'text-violet-700 dark:text-violet-400'}`}>{code.code}</code>
    ),
  },
  {
    label: 'Made by',
    cell: (code) => (code.created_by_username ? `made by ${code.created_by_username}` : ''),
  },
];

function CodesSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [making, setMaking] = useState(false);
  const note = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await (window as any).AdminConsole.fetchJson('/api/admin/codes');
    if (!alive.current || !Array.isArray(data)) return;
    setCodes(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const make = useCallback(async () => {
    setMaking(true);
    try {
      await fetch('/api/admin/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.current?.value || '' }),
      });
      if (note.current) note.current.value = '';
      await load();
    } finally {
      if (alive.current) setMaking(false);
    }
  }, [load]);

  // Counted from the list the page already has: no second read.
  const usedCount = codes ? codes.filter(isUsed).length : null;
  const figures: Figure[] = [
    { key: 'available', label: 'Available', value: codes && usedCount !== null ? (codes.length - usedCount).toLocaleString() : null, tone: 'green' },
    { key: 'used', label: 'Used', value: usedCount === null ? null : usedCount.toLocaleString(), tone: 'sky' },
  ];

  return (
    <>
      <ScreenHeader
        title="Invite links"
        subtitle="One link per person. Whoever signs up from it gets in right away: no waitlist, and no project needed."
      />
      <Figures id="admin-code-figures" items={figures} />
      {canWrite ? (
        <form className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!making) make(); }}>
          <Field label="Who is it for?" htmlFor="admin-code-note" className="min-w-[12rem] flex-1">
            <input ref={note} id="admin-code-note" type="text" maxLength={200} autoComplete="off"
              className={AdminUI.input} placeholder="Name, and why (only admins see this)" />
          </Field>
          <button id="admin-generate-code-btn" type="submit" className={BTN.primary} disabled={making}>
            Make link
          </button>
        </form>
      ) : null}
      <div id="admin-code-list">
        {codes && codes.length ? (
          <List<Code>
            items={codes}
            columns={CODE_COLUMNS}
            rowKey={(c) => c.id}
            actions={(code) => (isUsed(code) ? null : (
              <>
                {/* The way to send it: /welcome/<code>, the sign-up sheet that
                    skips the waitlist (src/routes/access-links.js). */}
                <CopyButton className={`admin-share-code-btn ${BTN.rowPrimary}`}
                  label="Copy link" done="Link copied!"
                  value={welcomeLink(code.code)} />
                {/* The raw code, for the older #register/<code> form. */}
                <CopyButton className={`admin-copy-code-btn ${BTN.row}`}
                  label="Copy code" done="Copied!" value={code.code} />
                {canWrite ? (
                  <button type="button" className={`admin-delete-code-btn ${BTN.rowDanger}`}
                    data-id={code.id} aria-label="Delete code"
                    onClick={async () => {
                      await fetch(`/api/admin/codes/${code.id}`, { method: 'DELETE' });
                      load();
                    }}>×</button>
                ) : null}
              </>
            ))}
          />
        ) : null}
      </div>
      <div id="admin-code-empty" className={codes && !codes.length ? '' : 'hidden'}>
        <EmptyState title="No invite links yet." />
      </div>
    </>
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
