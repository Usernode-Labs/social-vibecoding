/**
 * The image viewer, opened on demand from the legacy code (#3908).
 *
 * Messages and group chat own an <ImageViewer> each, held open by their own
 * state. The screenshots a rendered markdown body carries — an issue body, a
 * Discussion post, a proposal's description — are legacy markup written by
 * DevChat.renderMarkdown, and nothing there holds viewer state. This host is
 * that owner: it renders nothing until opened, then shows the same
 * full-screen viewer those two screens do — original image on the dimmed
 * backdrop, Download, dismissed by the backdrop, the ✕, a swipe down, Back
 * or Escape.
 *
 * public/js/app-view.js opens it by name —
 * `window.UsernodeReact.imageViewer.open(url, alt)` — the seam useDialog
 * publishes for the shell dialogs (features/dialogs/use-dialog.ts). The
 * imperative surface is one method: `open` sets this component's state, and
 * the viewer's own dismissal clears it. The legacy caller never writes into
 * the viewer's nodes, so the overlay stays React-owned.
 *
 * Mounted once from Shell.tsx, beside the staging overlays: an island that
 * renders nothing until opened adds nothing to the prerendered document, so
 * the shell markup, its baseline and the hydration match are unchanged.
 */

import { useEffect, useState } from 'react';

import { ImageViewer } from './image-viewer';

export function ImageViewerHost() {
  const [shot, setShot] = useState<{ url: string; text: string } | null>(null);

  useEffect(() => {
    // Published from the mount effect rather than module scope because the
    // caller reads it inside a click handler — long after hydration — so
    // nothing needs to queue (mount.ts's module-scope bridges do, and their
    // headers explain why this one does not).
    const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
    const bridge = (host.UsernodeReact ||= {});
    bridge.imageViewer = {
      /** A plain click on a rendered screenshot: its URL, and its alt text. */
      open(url: string, text: string) {
        setShot({ url, text });
      },
    };
  }, []);

  if (!shot) return null;
  return <ImageViewer src={shot.url} alt={shot.text} onClose={() => setShot(null)} />;
}
