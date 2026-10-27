/**
 * #platform-side-strip-top — the header's back button, in the side strip.
 *
 * On an iPhone Duo the system puts every app's back button in the column of
 * chrome down the screen's edge, under the clock (../../lib/side-strip.ts
 * says when there is one). The phone's own apps do it, WhatsApp does it, and
 * a Homeroom that kept its back at the top-left corner of a 382pt page was
 * the one app on the phone with it somewhere else. So while the strip is
 * up, app.css hides `#back-btn` and shows this, at the strip's top.
 *
 * ── A second element, not the first one moved ─────────────────────────
 *
 * `#back-btn` cannot simply be positioned out into the strip. The header
 * draws its glass with a `clip-path` (app.css, "FAKED GLASS"), and a clip
 * cuts a fixed descendant too, which is the point of it there. And the
 * header is React's: moving its node would be a second owner.
 *
 * ── It says what `#back-btn` says, and does what it does ──────────────
 *
 * The glyph, the words and the address come from `useBackSlot`, the hook
 * `#back-btn` renders from, so the two cannot disagree. A press is handed to
 * `#back-btn` itself: its click handler in public/js/app.js is the one place
 * that knows which screen claims the press (Settings' sections, Browse's
 * detail, a running app's ✕) before it follows the href. A modified click
 * (a new tab) is the browser's, as it is there.
 *
 * Ships `hidden` with no href, as `#back-btn` does on the prerender (the
 * store starts at 'none'), so hydration agrees. app.css draws it only while
 * the strip is up and the header is showing.
 *
 * ── And the drawer's arrow beside it ──────────────────────────────────
 *
 * On a community's page (and in a conversation) the phone's back is not
 * `#back-btn` but the drawer's arrow, up one level (../nav-drawer/
 * header-drawer.tsx DrawerBack), and `#back-btn` is empty there. It is the
 * same control to a reader, so it moves too: a second DrawerBack renders
 * here, drawn from the same live depth as the header's (it fades in with
 * the level, and renders nothing off the drawer), and app.css hides the
 * header's while the strip is up. The two are never both showing.
 */

import { ChevronLeftIcon, HomeIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { useBackSlot } from '../header/platform-header';
import { drawerStore } from '../nav-drawer/drawer-store';
import { DrawerBack } from '../nav-drawer/header-drawer';
import { messagesDrawerStore } from '../nav-drawer/messages-drawer';

/**
 * The veil over a drawer while it runs under the strip (app.css, THE VEIL
 * OVER THE DRAWER UNDER THE STRIP; it was a blur, which stuttered the
 * slides, and is a fill now). Out while a level is: Communities off
 * its page (the places, or your communities, peeking under the strip), or
 * Messages on its list (a conversation peeking beside it; app.css leaves it
 * out when the list is alone). It takes the drawer's LEVEL, not its live
 * depth, and app.css fades it over the slide's own 300ms and curve.
 *
 * NOT FROM THE LIVE DEPTH, and that was tried: written from the depth
 * channel the veil's opacity was set by script on every frame of a slide,
 * which runs on the main thread, while the slide itself runs on the
 * compositor. A screen swap's frames held the veil while the page slid on
 * under it. A transition keeps both on the compositor; a finger's pan moves
 * the level only when it lets go, and the veil follows then.
 *
 * Out is an attribute rendered from the stores, both empty on the
 * prerender, so the first render is the shipped one.
 */
function StripFrost() {
  const communities = useStoreState(drawerStore);
  const messages = useStoreState(messagesDrawerStore);
  const out = communities.on ? communities.level !== 2 : messages.on && messages.level === 0;
  return <div className="platform-side-strip-frost" aria-hidden="true" {...(out ? { 'data-out': '' } : {})} />;
}

function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function StripBack() {
  const t = useMessages();
  const { mode, href } = useBackSlot();
  const Glyph = mode === 'arrow' ? ChevronLeftIcon : mode === 'close' ? XIcon : HomeIcon;
  const label = mode === 'arrow' ? t('core:header.back')
    : mode === 'close' ? t('core:header.closeApp') : t('core:header.home');
  return (
    <>
      {/* The strip's ground under a screen's sheet (app.css, THE STRIP'S
          GROUND UNDER A SHEET): drawn, never pressed. */}
      <div className="platform-side-strip-ground" aria-hidden="true" />
      {/* …and the veil over a drawer while it runs under the strip. */}
      <StripFrost />
      <div id="platform-side-strip-top" className="platform-side-strip-top">
        <a
          id="platform-side-strip-back"
          className={'platform-side-strip-back' + (mode === 'none' ? ' hidden' : '')}
          // A running app's ✕ is not drawn in the strip: its tabs stay up
          // beside the app there, and leaving is one of them (app.css).
          data-back={mode}
          aria-label={label}
          {...(href ? { href } : {})}
          onClick={(event) => {
            if (isModifiedClick(event)) return;
            event.preventDefault();
            document.getElementById('back-btn')?.click();
          }}
        >
          <Glyph className="platform-side-strip-glyph" aria-hidden="true" />
        </a>
        <DrawerBack />
      </div>
    </>
  );
}
