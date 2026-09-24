/**
 * "Are you sure?" for React code, through the platform's own confirm dialog
 * (QA 2026-09-24 Q15).
 *
 * public/js/confirm-modal.js is the one the rest of the platform already
 * uses: `window.ConfirmModal.show()`, a thin adapter over
 * `PlatformUI.confirm`, which is the native kit's alert card. It exists
 * because `window.confirm()` blocks the page and is suppressed or ignored in
 * several of the webview hosts the platform runs in, so a Leave / Remove /
 * Block behind it could do nothing at all there, and on the desktop it drew
 * the browser's grey box instead of the app's dialog.
 *
 * Resolves true only when the viewer chose the confirm button. The browser's
 * confirm is the last resort, for a document where neither script loaded
 * (the same fallback confirm-modal.js keeps).
 */

export type ConfirmOptions = {
  title: string;
  message?: string;
  /** The confirm button's label: say what it does ("Leave", "Block"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Draws the confirm button as destructive. */
  danger?: boolean;
};

type ConfirmHost = {
  ConfirmModal?: { show?: (opts: ConfirmOptions) => Promise<boolean> | boolean };
};

export async function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const host = (typeof window !== 'undefined' ? window : null) as (Window & ConfirmHost) | null;
  if (!host) return false;
  const show = host.ConfirmModal?.show;
  if (typeof show === 'function') {
    try { return !!(await show(opts)); } catch { return false; }
  }
  try {
    return host.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
  } catch {
    return false;
  }
}
