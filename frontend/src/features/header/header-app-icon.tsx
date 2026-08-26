/**
 * The app glyph that leads the header — and, with the title beside it, IS the
 * app switcher.
 *
 * The Figma board draws every in-app header the same way: a 28px app icon, the
 * app's name, and a chevron, as one left-aligned cluster. Tapping anywhere in
 * it opens the Apps sheet. This is the icon half; ./header-title-tab.tsx is
 * the name and the chevron, and both call the same `window.AppContext.toggle`.
 *
 * ── Why it is not in the accessibility tree ────────────────────────────
 *
 * The cluster is ONE control to a person looking at it, so it should be one
 * control to a screen reader too. The title tab carries the semantics
 * (`aria-haspopup="dialog"`, the label naming the app); this is `aria-hidden`
 * with `tabIndex={-1}`, so a pointer can hit the icon but a keyboard or AT
 * user meets the tab once rather than the same destination twice.
 *
 * ── It shares the header's icon slot with the back arrow ───────────────
 *
 * ./platform-header.tsx gives the slot one 28px box holding both this and
 * `#back-btn`, and they never draw together — not because either checks the
 * other, but because the states are disjoint. The arrow appears exactly when
 * `App.setBackIcon('arrow')` has run, which is a drilled screen or a dev
 * session, and this returns null for both: a drilled platform screen has no
 * improve target at all (`_enterScreenChrome` clears it), and a session is
 * the `subTab === 'sessions'` case below.
 *
 * ── The app's own artwork, never its initial if it has any ────────────
 *
 * The icon resolves through ../apps/app-card-view's AppIconContent, which is
 * the same three-way `icon_url → icon_emoji → letter` walk Home's launcher and
 * the browse list use. It shipped here as `iconUrl ? <img> : initial`, which
 * skipped the middle branch: an app that had set an emoji got its first letter
 * in the header while Home drew the emoji, so one app wore two faces. A letter
 * is the LAST resort, for an app that has chosen no artwork at all.
 *
 * `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
 * background or text colour of its own — that class is the one tile face in
 * the product and app.css says call sites must not repaint it.
 *
 * ── First render is the prerender ──────────────────────────────────────
 *
 * The improve store ships target-less, so the SSG pass renders nothing here
 * and hydration matches the shipped bar byte for byte. The icon arrives with
 * the app, from `ImproveStatus.setAppOpen`.
 */

import { type ReactNode } from 'react';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';

export function HeaderAppIcon(): ReactNode {
  const { target, slug, name, tab, subTab, iconUrl, iconEmoji } = useStoreState(improveStore);
  const app = { slug, name: name || slug, icon_url: iconUrl, icon_emoji: iconEmoji };
  // No app on screen, or the session bar — which the board draws with the
  // back arrow in this slot and no title tab at all.
  if (!target || !slug || (tab === 'dev' && subTab === 'sessions')) return null;
  return (
    <button
      id="header-app-icon"
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className="w-7 h-7 shrink-0 flex items-center justify-center un-touch-target"
      onClick={() => (window as unknown as {
        AppContext?: { toggle?: () => void };
      }).AppContext?.toggle?.()}
    >
      <span
        data-icon={appIconKind(app)}
        className="app-icon-tile w-7 h-7 rounded-lg overflow-hidden flex items-center justify-center text-xs font-bold [&>span]:text-base"
      >
        <AppIconContent app={app} />
      </span>
    </button>
  );
}
