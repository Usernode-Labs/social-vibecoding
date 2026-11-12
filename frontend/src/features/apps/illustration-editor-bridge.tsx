/**
 * #6601: a waiting card-picture vote's ⋯ menu is drawn by the classic
 * `public/js/app-view.js`, while the Featured illustration editor is React.
 * This module is the seam. It publishes
 * `window.UsernodeReact.illustrationEditor.open(app, onClose)` for the legacy
 * caller and exports the host the shell renders.
 *
 * Why a host component rather than a portal into a detached div: the editor's
 * card is reparented by the native kit (`adoptKitSurface`), so React's
 * delegated events only reach it while the portal container is `document.body`
 * itself. A portal into the main React tree with `document.body` as its
 * container keeps that true, and the host renders nothing until something is
 * open, so the prerendered document is unchanged.
 */
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { FeaturedIllustrationEditor } from './featured-illustration-editor';

interface OpenEditor { app: any; onClose?: () => void }

let current: OpenEditor | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;
const notify = () => { for (const listener of listeners) listener(); };

/** Open the picture editor for `app`. `onClose` runs once the person closes it. */
export function openIllustrationEditor(app: any, onClose?: () => void): void {
  if (!app || !app.slug) return;
  current = { app, onClose };
  notify();
}

/** Close the open editor, if any (its close callback runs too). */
export function closeIllustrationEditor(): void {
  if (!current) return;
  const closing = current;
  current = null;
  notify();
  if (closing.onClose) closing.onClose();
}

/** Rendered by the shell; draws the open editor over `document.body` or nothing. */
export function IllustrationEditorHost() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!state) return null;
  return createPortal(
    <FeaturedIllustrationEditor key={state.app.slug} app={state.app} onClose={closeIllustrationEditor} />,
    document.body,
  );
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.illustrationEditor = { open: openIllustrationEditor, close: closeIllustrationEditor };
}
