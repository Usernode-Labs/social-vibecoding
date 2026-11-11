/**
 * The frame's chrome for a visitor who is not signed in, as the 2026-11-06
 * screen tour draws every guest page and stand-alone page (`page()` in guest
 * mode and `solo()` in the tour's kit): one bar and the page under it. No
 * sidebar and no tab bar, because a visitor has no places of their own yet.
 *
 * The bar holds the brand (or, while an app or a project is open, its
 * name), a way back where the screen has one, and the landing's own two
 * ways in: Sign in, and on a desktop Sign up.
 *
 * IT DRAWS; THE SCREEN STILL DECIDES, as ./frame-app.tsx does for a member.
 * The anonymous screens (../auth/) keep their own header and back disc,
 * unseen under a look (app.css, "THE GUEST'S FRAME"), and a press here is
 * handed to the control it stands for there. What the bar shows is read off
 * those nodes as they change, so a button the landing adds or takes away
 * (pinning an open app to this device) is added or taken away here too.
 *
 * Up while one of the anonymous shell's screens is: the landing (with the
 * app or the public project a visitor opened inside it), sign-in, register,
 * the waitlist form, "more ways", and the waiting room. An account still in
 * line is signed in and not let in yet: the member's chrome has nothing to
 * show it, so it keeps this bar, with its name on it and, in the waiting
 * room, Sign out.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Av, Btn, Frame, Icon, Tile, k } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';
import { isFrameSkin, useSkin } from '../../lib/skin';
import { useVisibility } from '../../lib/visibility-store';
import { swatchFor } from '../messages/format';

const MARK = '/brand/homeroom-mark.png';

/** One of the landing bar's own buttons, as the kit's bar repeats it. */
export type GuestAction = { key: string; label: string; primary: boolean; pressed: boolean | null };

/**
 * What the bar says, read off the screen that is up. `who` is an account
 * still in line: signed in, not let in yet. `trail` is what follows the
 * brand or the name: a project's Workshop, then a request by its number.
 */
export type GuestBar = { back: boolean; crumb: string; trail?: string[]; actions: GuestAction[]; who?: string };

const EMPTY: GuestBar = { back: false, crumb: '', actions: [] };

/** The account a waiting-room session belongs to; '' for a visitor. */
function sessionName(): string {
  const user = (window as any).App?.user as { username?: unknown } | null | undefined;
  return typeof user?.username === 'string' ? user.username : '';
}
const shown = (el: Element | null) => !!el && !el.classList.contains('hidden') && !el.hasAttribute('hidden');

/** The landing's bar: its back, its title when that is a name, its buttons. */
function readLanding(root: HTMLElement): GuestBar {
  const title = root.querySelector('#landing-header-title');
  const host = root.querySelector('[data-landing-actions]');
  const actions: GuestAction[] = [];
  if (shown(host)) {
    host!.querySelectorAll('button').forEach((button, i) => {
      const primary = button.hasAttribute('data-landing-sign-up');
      // Sign up is hidden on a phone by its own class; the kit's `d` says the same.
      if (!primary && !shown(button)) return;
      const pressed = button.getAttribute('aria-pressed');
      actions.push({ key: String(i), label: (button.textContent || '').trim(), primary, pressed: pressed == null ? null : pressed === 'true' });
    });
  }
  // A place the landing names for the bar alone (a gated address, a public
  // project's tab): unseen words in its header, the head in the brand's place.
  const places = [...root.querySelectorAll('#landing-header [data-guest-place]')];
  const words = (kind: string) => places.filter((el) => el.getAttribute('data-guest-place') === kind).map((el) => (el.textContent || '').trim()).filter(Boolean);
  return {
    back: shown(root.querySelector('#landing-back-btn')),
    // The wordmark is a picture: the bar draws the brand itself then.
    crumb: title && !title.querySelector('svg') ? (title.textContent || '').trim() : words('head')[0] || '',
    trail: words('trail'),
    actions,
    who: sessionName(),
  };
}

/** The waiting room: whose it is, and Sign out, which the room keeps at its foot. */
function readWaiting(root: HTMLElement): GuestBar {
  const out = root.querySelector('#waiting-logout');
  return {
    back: false,
    crumb: '',
    actions: out ? [{ key: 'logout', label: (out.textContent || '').trim(), primary: false, pressed: null }] : [],
    who: sessionName(),
  };
}

/** A stand-alone screen's own way back: the shared disc, or "more ways"'s plain link. */
const SOLO_BACK = '[data-auth-back], :scope > a[href="#landing"]';

/** Any other anonymous screen: a way back, and the brand. */
function readSolo(root: HTMLElement): GuestBar {
  return { back: !!root.querySelector(SOLO_BACK), crumb: '', actions: [] };
}

const same = (a: GuestBar, b: GuestBar) => a.back === b.back && a.crumb === b.crumb && (a.trail || []).join('\n') === (b.trail || []).join('\n') && (a.who || '') === (b.who || '') && a.actions.length === b.actions.length
  && a.actions.every((x, i) => x.label === b.actions[i].label && x.primary === b.actions[i].primary && x.pressed === b.actions[i].pressed);

/** The bar of the screen with that id, followed as the screen changes it. */
function useGuestBar(id: string): GuestBar {
  const [bar, setBar] = useState<GuestBar>(EMPTY);
  useEffect(() => {
    const root = document.getElementById(id);
    if (!root) return undefined;
    const read = () => {
      const next = id === 'auth-landing-screen' ? readLanding(root) : id === 'auth-waiting-screen' ? readWaiting(root) : readSolo(root);
      setBar((prev) => (same(prev, next) ? prev : next));
    };
    read();
    // The screen mounts its inside after its root, and the landing's header
    // changes as an app opens: its direct children, then the header's own tree.
    const mo = new MutationObserver(() => {
      const header = root.querySelector('#landing-header');
      if (header && header !== watched) {
        watched = header;
        mo.observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-pressed'] });
      }
      read();
    });
    let watched: Element | null = root.querySelector('#landing-header');
    mo.observe(root, { childList: true });
    if (watched) mo.observe(watched, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-pressed'] });
    return () => mo.disconnect();
  }, [id]);
  return bar;
}

/** Hand a press to the screen's own control. */
function pressIn(id: string, selector: string, nth = 0) {
  const nodes = document.getElementById(id)?.querySelectorAll<HTMLElement>(selector);
  nodes?.[nth]?.click();
}

const SCREENS = ['auth-landing-screen', 'auth-login-screen', 'auth-register-screen', 'auth-waitlist-screen', 'auth-more-screen', 'auth-waiting-screen'] as const;

/** Mounted by the shell beside FrameApp: nothing on the first render, nothing under the standard look. */
export function GuestFrame() {
  const skin = useSkin();
  // One hook per screen, every render (never behind a condition).
  const up = [
    useVisibility(SCREENS[0], false), useVisibility(SCREENS[1], false), useVisibility(SCREENS[2], false),
    useVisibility(SCREENS[3], false), useVisibility(SCREENS[4], false), useVisibility(SCREENS[5], false),
  ];
  const at = up.indexOf(true);
  return isFrameSkin(skin) && at > -1 ? <GuestChrome screen={SCREENS[at]} /> : null;
}

function GuestChrome({ screen }: { screen: (typeof SCREENS)[number] }) {
  const bar = useGuestBar(screen);
  // The page area, published for the screen to lay itself out by.
  const areaRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const area = areaRef.current;
    if (!area) return undefined;
    const publish = () => {
      const r = area.getBoundingClientRect();
      root.style.setProperty('--fr-shell-left', `${Math.max(0, Math.round(r.left))}px`);
      root.style.setProperty('--fr-shell-top', `${Math.max(0, Math.round(r.top))}px`);
      root.style.setProperty('--fr-shell-bottom', `${Math.max(0, Math.round(window.innerHeight - r.bottom))}px`);
    };
    root.setAttribute('data-frame-chrome', 'guest');
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(area);
    window.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
      root.removeAttribute('data-frame-chrome');
      for (const name of ['--fr-shell-left', '--fr-shell-top', '--fr-shell-bottom']) root.style.removeProperty(name);
    };
  }, []);
  return (
    <GuestChromeView
      bar={bar}
      areaRef={areaRef}
      onBack={() => pressIn(screen, screen === 'auth-landing-screen' ? '#landing-back-btn' : SOLO_BACK)}
      onAction={(action) => (action.key === 'logout' ? pressIn(screen, '#waiting-logout') : pressIn(screen, '[data-landing-actions] button', Number(action.key)))}
    />
  );
}

/** The chrome itself. Exported for its suite. */
export function GuestChromeView({ bar, onBack, onAction, areaRef }: {
  bar: GuestBar;
  onBack: () => void;
  onAction: (action: GuestAction) => void;
  areaRef?: React.Ref<HTMLElement>;
}) {
  const t = useMessages('core');
  const trail = bar.trail || [];
  return (
    <>
      {/* Behind the screen: what a look gives the page column itself. */}
      <div className="fr fr-app fr-noside fr-shell fr-shell-under" aria-hidden="true">
        <div className={k('colm')} />
      </div>
      <Frame className="fr-app fr-noside fr-shell" data-frame-app="guest">
        <div className={k('colm')}>
          <header className={k('bar')}>
            {bar.back ? (
              <button type="button" className={k('ib')} aria-label={t('core:header.back')} onClick={onBack}>
                <Icon name="cl" />
              </button>
            ) : null}
            {bar.crumb ? null : (
              <span className={k('brand')} style={{ margin: 0, padding: 0 }}>
                <Tile size={28} src={MARK} color="#0f1116" name={t('core:frame.brand')} />
                {t('core:frame.brand')}
              </span>
            )}
            {bar.crumb || trail.length ? (
              <div className={k('crumb')}>
                {/* Flat children: on a phone the kit keeps only the last one. */}
                {bar.crumb ? <span className={k('ci', !trail.length && 'here keep')}>{bar.crumb}</span> : null}
                {trail.map((word, i) => (
                  <Fragment key={`${i}:${word}`}>
                    {i > 0 || bar.crumb ? <Icon name="cr" size={14} /> : null}
                    <span className={k('ci', i === trail.length - 1 && 'here keep')}>{word}</span>
                  </Fragment>
                ))}
              </div>
            ) : null}
            <span className={k('sp')} />
            {bar.who ? (
              <div className={k('crumb')}>
                <span className={k('ci here keep')}>
                  <Av size={24} name={bar.who} color={swatchFor(bar.who)} />
                  <span className={k('d')}>@{bar.who}</span>
                </span>
              </div>
            ) : null}
            {bar.actions.map((action) => {
              const button = (
                <Btn key={action.key} kind={action.primary ? '' : 'line'} small aria-pressed={action.pressed == null ? undefined : action.pressed} onClick={() => onAction(action)}>
                  {action.label}
                </Btn>
              );
              // The tour keeps one way in on a phone's bar: the primary one is the page's own button there.
              return action.primary ? <span key={action.key} className={k('d')}>{button}</span> : button;
            })}
          </header>
          <main className={k('pagearea')} ref={areaRef} />
        </div>
      </Frame>
    </>
  );
}
