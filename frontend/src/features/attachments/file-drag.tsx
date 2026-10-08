/**
 * Dragging files onto a composer (#4065): when to show the drop zone, the
 * zone itself, and the one line that explains the files a drop left out.
 *
 * ── Every composer already took a drop; none of them showed it ────────
 *
 * The group chat, the dev chat, the agent session and "Suggest an
 * improvement" each attach a dropped file through their own upload path, and
 * those paths stay theirs. What they lacked is the outline Messages draws
 * while a file is held over its box (`.messages-drop-overlay`), so a person
 * could not tell where letting go would land. This module is that outline and
 * the state behind it, shared, so the five drop zones look the same.
 *
 * ── A depth count, not `currentTarget === target` ──────────────────────
 *
 * `dragenter` and `dragleave` fire for every child the pointer crosses, so a
 * zone that clears on any leave from itself flickers over its own textarea.
 * The tracker counts enters against leaves and clears at zero; a drop,
 * `dragend`, Escape or the window losing focus clears it outright, so a drag
 * that ends somewhere unexpected cannot leave an outline behind.
 *
 * Only a drag carrying FILES counts: text or a link dragged into the field
 * keeps the browser's own behaviour (it is inserted where it lands).
 *
 * ── The classic scripts reach it through the bridge ────────────────────
 *
 * public/js/group-chat.js and dev-chat.js (a moved classic script, still
 * evaluated as one in its tests) cannot import, so the tracker and the
 * summary are published on `window.UsernodeReact.fileDrag`. They publish a
 * `dragging` flag into their composer stores and the React composer draws
 * the zone: the module writes no markup.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';

import { refusalSummary } from './refusal-summary';

export { refusalSummary };

interface DragLike {
  dataTransfer?: DataTransfer | { types?: ArrayLike<string> | null; files?: ArrayLike<File> | null; dropEffect?: string } | null;
  preventDefault?: () => void;
}

/** True only while the drag carries files (not text, not a link). */
export function isFileDrag(event: DragLike | null | undefined): boolean {
  const types = event?.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

export interface FileDragTracker {
  enter(event: DragLike): void;
  over(event: DragLike): void;
  leave(event: DragLike): void;
  /** Clear the zone (a drop, or the drag ending elsewhere). */
  reset(): void;
  dispose(): void;
}

export interface FileDragTrackerOptions {
  /** Read at every event: a zone that cannot take a drop never lights. */
  isDisabled?: () => boolean;
  onChange: (dragging: boolean) => void;
}

// Every live tracker, so one set of window listeners can clear them all when
// a drag ends anywhere: dropped, cancelled with Escape, or the window left.
const live = new Set<FileDragTracker>();
let windowWired = false;

function wireWindow() {
  if (windowWired || typeof window === 'undefined') return;
  windowWired = true;
  const clearAll = () => { for (const tracker of Array.from(live)) tracker.reset(); };
  window.addEventListener('drop', clearAll);
  window.addEventListener('dragend', clearAll);
  window.addEventListener('blur', clearAll);
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearAll(); });
}

export function createFileDragTracker({ isDisabled, onChange }: FileDragTrackerOptions): FileDragTracker {
  let depth = 0;
  const disabled = () => !!isDisabled?.();
  const tracker: FileDragTracker = {
    enter(event) {
      if (!isFileDrag(event) || disabled()) return;
      event.preventDefault?.();
      depth += 1;
      if (depth === 1) onChange(true);
    },
    over(event) {
      if (!isFileDrag(event)) return;
      const off = disabled();
      if (off && depth) tracker.reset();
      const transfer = event.dataTransfer as { dropEffect?: string } | null | undefined;
      // A zone that is off shows the "no" cursor and is left to the window
      // guard (lib/file-drop-guard.ts), which keeps the page from opening it.
      if (transfer) transfer.dropEffect = off ? 'none' : 'copy';
      if (!off) event.preventDefault?.();
    },
    leave(event) {
      if (!isFileDrag(event) || depth === 0) return;
      depth -= 1;
      if (depth === 0) onChange(false);
    },
    reset() {
      if (depth === 0) return;
      depth = 0;
      onChange(false);
    },
    dispose() {
      live.delete(tracker);
      depth = 0;
    },
  };
  live.add(tracker);
  wireWindow();
  return tracker;
}

export interface UseFileDragOptions {
  disabled?: boolean;
  /** The dropped files, when the zone is on. Omit to only draw the zone. */
  onFiles?: (files: File[]) => void;
}

/** A drop zone on a React element: its state and the four handlers. */
export function useFileDrag({ disabled = false, onFiles }: UseFileDragOptions) {
  const [dragging, setDragging] = useState(false);
  const opts = useRef({ disabled, onFiles });
  opts.current = { disabled, onFiles };
  const tracker = useMemo(
    () => createFileDragTracker({ isDisabled: () => opts.current.disabled, onChange: setDragging }),
    [],
  );
  useEffect(() => () => tracker.dispose(), [tracker]);
  useEffect(() => { if (disabled) tracker.reset(); }, [disabled, tracker]);
  const handlers = {
    onDragEnter: (event: ReactDragEvent) => tracker.enter(event),
    onDragOver: (event: ReactDragEvent) => tracker.over(event),
    onDragLeave: (event: ReactDragEvent) => tracker.leave(event),
    onDrop: (event: ReactDragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      tracker.reset();
      if (opts.current.disabled || !opts.current.onFiles) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) opts.current.onFiles(files);
    },
  };
  return { dragging: dragging && !disabled, handlers };
}

/**
 * The outline itself. It lies over its parent, which must be positioned
 * (app.css gives each composer card `position: relative`), and takes no
 * pointer events, so the drop still lands on the composer under it.
 */
export function DropOverlay({ label = 'Drop files to attach', className = 'attach-drop-overlay' }: { label?: string; className?: string }) {
  return <div className={className} aria-hidden="true" data-drop-overlay="">{label}</div>;
}

/**
 * A zone on an element this component does not draw: the listeners go on
 * the node `host()` finds and only the outline is React's. For "Suggest an improvement", whose
 * form the controller (feedback-controller.js) owns and whose own `drop`
 * listener does the attaching. Only this small component re-renders on a
 * drag, so the dialog around it is never reconciled for one.
 */
export function HostDropOverlay({ host, label, isDisabled }: { host: () => HTMLElement | null; label: string; isDisabled?: () => boolean }) {
  const [dragging, setDragging] = useState(false);
  const disabledRef = useRef(isDisabled);
  disabledRef.current = isDisabled;
  useEffect(() => {
    const el = host();
    if (!el) return undefined;
    const tracker = createFileDragTracker({ isDisabled: () => !!disabledRef.current?.(), onChange: setDragging });
    const enter = (event: Event) => tracker.enter(event as DragEvent);
    const over = (event: Event) => tracker.over(event as DragEvent);
    const leave = (event: Event) => tracker.leave(event as DragEvent);
    const drop = () => tracker.reset();
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
      tracker.dispose();
    };
    // Found once, after the first commit: the host is a node the caller's
    // markup renders and never replaces.
  }, []);
  return dragging ? <DropOverlay label={label} /> : null;
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.fileDrag = { isFileDrag, createFileDragTracker, refusalSummary };
}
