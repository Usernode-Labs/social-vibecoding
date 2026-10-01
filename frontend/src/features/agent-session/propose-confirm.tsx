/**
 * "Propose to group" on a staging card (#3032): the confirmation is a small
 * panel under the button, the way the dev board's vote picker is, rather
 * than the full-screen dialog it was. Same homes as that picker
 * (../dev-board/card/dev-card.tsx VoteButton): a popover anchored to the
 * button on desktop, placed by lib/anchor-popover.ts and dismissed by
 * lib/popover-dismiss.ts (outside click, Escape, scroll); the kit's bottom
 * sheet on touch. Same frame and buttons too (`.dev-vote-pop`,
 * `.dev-vote-sheet`, `.dev-vote-reason-*` in app.css), so a person who has
 * voted recognises it.
 *
 * The panel holds the change's title, editable (#3251): a change named from
 * a raw first message can go to the vote under a clean one. Confirming calls
 * the store's proposeChange, which no longer asks itself, with the typed
 * title only when it differs from the change's own.
 * Rendered after the conversation loads, never in the prerender.
 */

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { clampPopoverHeight, placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { proposeChange } from './store';

const POP_WIDTH = 312;
// The first paint's estimate only; the mounted panel is measured and
// re-placed with its real height (#3595), so a wrapped title line can't
// leave the panel short of where the arithmetic put it.
const POP_HEIGHT = 170;

/** The title route's own cap (MANUAL_SESSION_TITLE_MAX in src/routes/sessions.js). */
export const PROPOSE_TITLE_MAX = 256;

export const PROPOSE_QUESTION = 'Put this up for the group’s vote?';

/** The line under the question: which change, and what happens on the way. */
export function proposeLine(title: string | null | undefined, prNumber: number | null | undefined): string {
  const name = (title || '').trim() || 'This change';
  const pr = prNumber ? ` (PR #${prNumber})` : '';
  return `“${name}”${pr} goes to the vote. Its preview and checks run again on the way.`;
}

/** The title as the server stores it: one line, runs of space made one. */
function tidyTitle(title: string | null | undefined): string {
  return (title || '').replace(/\s+/g, ' ').trim();
}

/** The typed title when it renames the change; null when it leaves it be (unchanged or blank). */
export function renamedTitle(draft: string, title: string | null | undefined): string | null {
  const next = tidyTitle(draft).slice(0, PROPOSE_TITLE_MAX);
  return next && next !== tidyTitle(title) ? next : null;
}

/** The panel, drawn once for both homes. Exported for the tests that render it directly. */
export function ProposeConfirmPanel({ draft, prNumber, headId, goRef, onDraft, onCancel, onPropose }: {
  draft: string;
  prNumber: number | null | undefined;
  headId: string;
  goRef?: RefObject<HTMLButtonElement | null>;
  onDraft: (title: string) => void;
  onCancel: () => void;
  onPropose: () => void;
}) {
  return (
    <>
      <div className="dev-vote-switch-label" id={headId}>{PROPOSE_QUESTION}</div>
      <label className="dev-vote-reason">
        <span className="dev-vote-reason-label">Proposal title</span>
        <input
          type="text"
          className="dev-vote-reason-box"
          value={draft}
          maxLength={PROPOSE_TITLE_MAX}
          placeholder="This change"
          data-agent-session-propose-title
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onPropose(); }
          }}
        />
      </label>
      <p className="px-1 pt-2 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300" data-agent-session-propose-line>
        {proposeLine(draft, prNumber)}
      </p>
      <div className="dev-vote-reason-actions">
        <button type="button" className="dev-vote-reason-cancel" onClick={onCancel}>Cancel</button>
        <button
          ref={goRef}
          type="button"
          className="dev-vote-reason-send dev-vote-reason-send-yes"
          data-agent-session-propose-confirm
          onClick={onPropose}
        >
          Propose
        </button>
      </div>
    </>
  );
}

type Sheet = { dismiss: () => void };
type SheetKit = { sheet?: (opts: { contentEl: HTMLElement; onDismiss: () => void }) => Sheet | null; isTouch?: () => boolean };

export function ProposeButton({ changeId, title, prNumber, className, busy, proposing }: {
  changeId: number;
  title: string | null | undefined;
  prNumber: number | null | undefined;
  className: string;
  busy: boolean;
  proposing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState('');
  // The panel's real height, measured the frame it mounts (#3595): the
  // placement arithmetic needs a size before the panel exists, and the
  // guess below can render short of the real thing — the popover then ran
  // past the bottom of the screen below a button near the fold, and landed
  // ON the Propose button when it flipped above one. The guess is only the
  // first paint; the layout effect re-places it from the measurement.
  const [measuredH, setMeasuredH] = useState<number | null>(null);
  const sheetRef = useRef<Sheet | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const headId = `agent-session-propose-${changeId}`;

  const shut = () => {
    setOpen(false);
    // The kit tears its sheet down and then calls onDismiss, which clears
    // the sheet state, whichever side started the dismissal.
    const sheet = sheetRef.current;
    if (sheet) {
      sheetRef.current = null;
      sheet.dismiss();
    }
  };
  const propose = () => {
    shut();
    void proposeChange(changeId, renamedTitle(draft, title));
  };
  // The touch home: the kit's bottom sheet holding the same panel. False
  // when there is no sheet to be had, and the popover is used instead.
  const openSheet = (kit: SheetKit): boolean => {
    if (typeof kit.sheet !== 'function' || typeof document === 'undefined') return false;
    const panel = document.createElement('div');
    panel.className = 'dev-vote-sheet-host';
    const handle = kit.sheet({
      contentEl: panel,
      onDismiss: () => {
        sheetRef.current = null;
        setSheetEl(null);
      },
    });
    if (!handle || typeof handle.dismiss !== 'function') return false;
    sheetRef.current = handle;
    setSheetEl(panel);
    return true;
  };
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open || sheetRef.current) { shut(); return; }
    // Each opening starts from the change's own title.
    setDraft(tidyTitle(title));
    const kit = (window as unknown as { PlatformUI?: SheetKit }).PlatformUI;
    if (kit && typeof kit.isTouch === 'function' && kit.isTouch() && openSheet(kit)) return;
    setRect(anchorRectOf(event.currentTarget));
    setOpen(true);
  };
  useAnchoredDismiss(open, [btnRef, popRef], shut);
  // A card that goes away under an open sheet takes the sheet with it.
  useEffect(() => () => {
    const sheet = sheetRef.current;
    if (sheet) { sheetRef.current = null; sheet.dismiss(); }
  }, []);
  // Propose takes the focus, so Enter confirms and Escape backs out.
  useEffect(() => {
    if (open || sheetEl) goRef.current?.focus();
  }, [open, sheetEl]);
  // Measure the mounted panel and place it again with its real height
  // before the first paint (#3595) — the same pass the vote picker runs.
  // The title line's wrap moves the height, so a long typed title
  // re-measures too, not just the mount. scrollHeight, not offsetHeight,
  // for the reason the vote picker gives: the measurement must not read
  // the clamp's own capped height, or it loops against the clamp.
  useLayoutEffect(() => {
    if (!open) return;
    const h = popRef.current?.scrollHeight;
    if (h && h !== measuredH) setMeasuredH(h);
  }, [open, draft, measuredH]);

  const pos = open && rect && typeof window !== 'undefined'
    ? placeUnderAnchor(rect, { width: POP_WIDTH, height: measuredH ?? POP_HEIGHT }, { width: window.innerWidth, height: window.innerHeight })
    : null;
  const popMaxH = open && typeof window !== 'undefined'
    ? clampPopoverHeight({ height: measuredH ?? POP_HEIGHT }, { width: window.innerWidth, height: window.innerHeight })
    : undefined;
  const panel = (
    <ProposeConfirmPanel
      draft={draft}
      prNumber={prNumber}
      headId={headId}
      goRef={goRef}
      onDraft={setDraft}
      onCancel={shut}
      onPropose={propose}
    />
  );
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open || !!sheetEl ? 'true' : undefined}
        onClick={toggle}
        data-agent-session-preview-propose
      >
        {proposing ? 'Proposing…' : 'Propose to group'}
      </button>
      {pos ? createPortal(
        <div
          ref={popRef}
          className="dev-vote-pop"
          role="dialog"
          aria-labelledby={headId}
          data-agent-session-propose-pop
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, maxHeight: popMaxH ? `${popMaxH}px` : undefined, overflowY: popMaxH ? 'auto' : undefined }}
          onClick={(event) => event.stopPropagation()}
        >
          {panel}
        </div>,
        document.body,
      ) : null}
      {sheetEl ? createPortal(
        <div className="dev-vote-sheet" role="dialog" aria-labelledby={headId} data-agent-session-propose-sheet>
          {panel}
        </div>,
        sheetEl,
      ) : null}
    </>
  );
}
