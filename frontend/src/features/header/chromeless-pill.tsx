/**
 * #chromeless-pill — the floating "Open in Homeroom" affordance shown while the
 * platform header is hidden (`/app/<slug>/full`). App._mountChromelessPill /
 * _unmountChromelessPill in app.js, as a component (#1079 chunk B).
 *
 * ALSO THE WAY OUT OF WEBVIEW MODE (request #6701): a phone member's own
 * choice, from the Homeroom mark menu, to hide the header and the tab bar on
 * every route. The menu that turned it on went with the header, so this pill
 * is up wherever the mode is (App._applyChrome publishes it for both
 * reasons), on Homeroom's own pages too, and a tap turns the mode off where
 * you are. On Homeroom's own pages it rests higher (app.css, the
 * `data-webview-mode` block): a page's message box ends in its Send button,
 * in this corner.
 *
 * Visually matching the bridge's share-view pill (public/usernode-bridge.js
 * __USERNODE_PLATFORM_LINK__) so users see one consistent affordance. Unlike
 * the bridge pill it is NOT dismissible — in chromeless mode it's the only way
 * into the full platform view. The slug is read at CLICK time, not at render,
 * so the pill survives app-to-app navigation without a remount — the same
 * reason the imperative version read App.currentApp inside its handler.
 *
 * The inline styles came across as-is rather than becoming utilities: they use
 * env(safe-area-inset-*) in calc(), which Tailwind has no class for, and the
 * pill has to keep matching the bridge's hard-coded pill exactly.
 */

import { useState, type CSSProperties } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { useVisibility } from '../../lib/visibility-store';

const PILL_STYLE: CSSProperties = {
  position: 'fixed',
  right: 'calc(12px + env(safe-area-inset-right,0px))',
  bottom: 'calc(12px + env(safe-area-inset-bottom,0px))',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  background: 'rgba(15,20,32,0.82)',
  color: '#e7edf7',
  borderRadius: '999px',
  padding: '6px 12px',
  font: '12px/1.2 -apple-system,system-ui,sans-serif',
  textDecoration: 'none',
  boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
};

const GLYPH_STYLE: CSSProperties = { fontSize: '11px', opacity: 0.75 };

export function ChromelessPill() {
  // Published by App.setChromeless. Unpublished reads as undefined, which
  // useVisibility resolves to this `false` — i.e. the shipped markup, which
  // had no pill in it at all.
  const chromeless = useVisibility('chromeless-pill', false);
  const webview = useVisibility('webview-mode', false);
  const [hover, setHover] = useState(false);
  const t = useMessages();

  if (!chromeless) return null;

  return (
    <a
      id="chromeless-pill"
      href="#"
      aria-label={webview ? t('core:chromeless.openWebviewLabel') : t('core:chromeless.openAppLabel')}
      style={{ ...PILL_STYLE, opacity: hover ? 1 : 0.85 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(ev) => {
        ev.preventDefault();
        // Webview mode first: off, and the bars are back on this page. Read
        // at click time, like the slug below.
        const wasWebview = !!window.App?.webviewMode;
        if (wasWebview) window.App?.setWebviewMode?.(false);
        const slug = window.App?.currentApp;
        // The full-screen route's own exit, as before; in Webview mode alone
        // there is no route to leave, on an app or on a Homeroom page.
        if (slug && (window.App?.chromeless || !wasWebview)) {
          // The explicit route entry point clears the mode while keeping the
          // already-loaded iframe mounted (same app, same tab).
          window.App?.openAppTab?.(slug, 'app');
        }
      }}
    >
      <span>{t('core:chromeless.open')}</span>
      <span style={GLYPH_STYLE} aria-hidden="true">
        {'↗'}
      </span>
    </a>
  );
}
