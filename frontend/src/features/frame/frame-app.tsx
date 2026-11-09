/**
 * The frame's own chrome: the sidebar, the bar and the phone's tab bar the
 * 2026-11-06 screen tour draws around every page (`page()` in the tour's
 * kit), shown while the device's look is one of the frame's nine.
 *
 * Drawn with the kit (frontend/@/components/ui/kit.tsx), so each look's
 * sidebar, bar and tab bar are that look's own: glass's floating pane,
 * Sunrise's ink sidebar, Mosaic's rail of pictures, Pastel's capsule.
 *
 * IT DRAWS; THE SHELL'S OWN NAVIGATION STILL DECIDES. Today's header and
 * tab bar stay mounted, hidden (app.css "THE FRAME IN THE SHELL"), and
 * keep every behaviour they have: the router's writes, the counts, the
 * sheets they open. The bell and the account menu open the kit's own
 * sheets (./frame-sheets.tsx), fed by the same controllers. This island reads the same stores they read (where you
 * are, what is unread, your recent communities) and a press here is handed
 * to the control it stands for there, so nothing is decided twice.
 *
 * WHERE IT SITS. A fixed layer over the screens, at the tab bar's own
 * level, that takes presses only on its sidebar, bar and tab bar; the page
 * area between them is empty and lets the screen under it through. It
 * measures that area and publishes it on <html> (--fr-shell-left, -top,
 * -bottom), which app.css hands to the tokens every screen already lays
 * itself out by (--platform-rail-full, --platform-header-h,
 * --platform-tabs-h), so a screen sits in the page area whichever look
 * drew the chrome. A second, inert copy behind the screens paints what a
 * look gives the page column itself (Paper's white sheet).
 *
 * Nothing renders on the first render (lib/skin.ts says why), and nothing
 * for a visitor who is not signed in: the signed-out frame is its own
 * milestone.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Av, Count, Frame, Icon, Tile, k } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';
import { whenPlatformViewer } from '../../lib/platform-viewer';
import { isFrameSkin, useSkin } from '../../lib/skin';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { navStore } from '../nav/nav-store.js';
import { useRailCommunities } from '../nav/rail-communities';
import { communityScopeStore, goToCommunity } from '../workshop/community-scope';
import { FrameSheets, openFrameSheet } from './frame-sheets';

const MARK = '/brand/homeroom-mark.png';

/** The shell's own control a press here is handed to. */
function press(id: string) {
  document.getElementById(id)?.click();
}

/** A plain click is handled here; a cmd-click or middle-click keeps the address. */
function handing(event: React.MouseEvent<HTMLElement>, run: () => void) {
  if ((window as any).NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  run();
}

/** The text of one of the shell's own nodes, followed as it changes. */
function useNodeText(id: string): string {
  const [text, setText] = useState('');
  useEffect(() => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    const read = () => setText((el.textContent || '').trim());
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [id]);
  return text;
}

/** Whether one of the shell's own nodes is showing (it has no `hidden` class), followed as it changes. */
function useNodeShown(id: string): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    const read = () => setShown(!el.classList.contains('hidden') && !el.hasAttribute('hidden'));
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
    return () => mo.disconnect();
  }, [id]);
  return shown;
}

export function FrameApp() {
  const skin = useSkin();
  const [viewer, setViewer] = useState(false);
  useEffect(() => whenPlatformViewer(() => setViewer(true)), []);
  // The routes that take the shell's navigation away (a running app, the
  // chromeless shots) take this one away with it.
  const routed = useVisibility('platform-tabs', true);
  const on = isFrameSkin(skin) && viewer && routed;
  return on ? <FrameChrome /> : null;
}

/** The chrome itself; FrameApp decides when it is up. Exported for its suite. */
export function FrameChrome() {
  const t = useMessages('core');
  const { tab: routedTab, messages, ai, bot, screen } = useStoreState(navStore);
  const tab = routedTab === 'messages' && bot ? 'ai' : routedTab;
  const scope = useStoreState(communityScopeStore);
  const recents = useRailCommunities();
  const headerTitle = useNodeText('header-title-name');
  // The bar says where you are: the header's own words, else the tab's.
  const tabWord: Record<string, string> = { home: t('core:tabs.home'), ai: t('core:tabs.ai'), messages: t('core:tabs.messages'), me: t('core:tabs.me') };
  const title = headerTitle || (tab ? tabWord[tab] || '' : '');
  const back = useNodeShown('back-btn');
  const unread = useNodeShown('notifications-badge');
  const user = (typeof window === 'undefined' ? undefined : (window as any).App?.user) as { username?: string; avatar_url?: string | null } | undefined;
  const me = user?.username || '';
  // In a community's pages no tab is lit: its row is.
  const inCommunity = screen === 'app-view' ? scope.slug : null;

  // The page area, published for the screens to lay themselves out by.
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
    root.setAttribute('data-frame-chrome', '');
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

  const main = (key: 'home' | 'ai' | 'messages', icon: string, label: string, count: number, href: string) => (
    <a
      className={k('nv main', tab === key && !inCommunity && 'on')}
      href={href}
      aria-current={tab === key && !inCommunity ? 'page' : undefined}
      onClick={(event) => handing(event, () => press(`platform-tab-${key}`))}
    >
      <Icon name={icon} />
      <span className={k('nm')}>{label}</span>
      <Count>{count}</Count>
    </a>
  );
  const tb = (key: 'home' | 'ai' | 'messages' | 'me', icon: string, label: string, count: number, href: string) => (
    <a
      className={k('tb', tab === key && 'on')}
      href={href}
      aria-current={tab === key ? 'page' : undefined}
      onClick={(event) => handing(event, () => press(`platform-tab-${key}`))}
    >
      <Icon name={icon} size={22} />
      {label}
      <Count>{count}</Count>
    </a>
  );

  return (
    <>
      {/* Behind the screens: what a look gives the page column itself. */}
      <div className="fr fr-app fr-shell fr-shell-under" aria-hidden="true">
        <aside className={k('side')} />
        <div className={k('colm')} />
      </div>

      <Frame className="fr-app fr-shell" data-frame-app="">
        <aside className={k('side')} aria-label={t('core:frame.navigation')}>
          <div className={k('brand')}>
            <Tile size={28} src={MARK} color="#0f1116" name={t('core:frame.brand')} />
            <span className={k('bn')}>{t('core:frame.brand')}</span>
          </div>
          {main('home', 'home', t('core:tabs.home'), 0, '#home')}
          {main('ai', 'spark', t('core:tabs.ai'), Number(ai) || 0, '#homeroom-bot')}
          {main('messages', 'chat', t('core:tabs.messages'), Number(messages) || 0, '#messages')}
          <div className={k('cap')}>{t('core:rail.communities')}</div>
          {recents.map((slug) => {
            const c = scope.info[slug];
            const name = c?.name || slug;
            const here = inCommunity === slug;
            return (
              <a
                key={slug}
                className={k('nv rec', here && 'on')}
                href={`#app/${encodeURIComponent(slug)}/workshop`}
                aria-current={here ? 'page' : undefined}
                onClick={(event) => handing(event, () => goToCommunity(slug))}
              >
                <Tile size={22} name={name} src={c?.iconUrl} emoji={c?.iconEmoji} color={c?.iconColor} />
                <span className={k('nm')}>{name}</span>
                <Count>{c && !c.unchosen ? Number(c.needs) || 0 : 0}</Count>
              </a>
            );
          })}
          <a className={k('nv all')} href="#home" onClick={(event) => handing(event, () => goToCommunity(null))}>
            <Icon name="grid" />
            <span className={k('nm')}>{t('core:rail.allPlain')}</span>
          </a>
          <div className={k('sidefoot')}>
            {/* You opens your page; the sliders at the row's end open the
                account menu. One row, as the tour draws it, so the glyph is
                a control inside the link and its press is taken here. */}
            <a
              className={k('nv me', tab === 'me' && !inCommunity && 'on')}
              href="#profile"
              aria-current={tab === 'me' && !inCommunity ? 'page' : undefined}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('[data-frame-menu]')) {
                  event.preventDefault();
                  openFrameSheet('menu');
                  return;
                }
                handing(event, () => press('platform-tab-me'));
              }}
            >
              <Av size={24} name={me || '?'} src={user?.avatar_url} />
              <span className={k('nm')}>{t('core:tabs.me')}</span>
              <span
                data-frame-menu=""
                role="button"
                tabIndex={0}
                aria-label={t('core:frame.menu.open')}
                style={{ display: 'contents' }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  openFrameSheet('menu');
                }}
              >
                <Icon name="sliders" size={18} />
              </span>
            </a>
          </div>
        </aside>

        <div className={k('colm')}>
          <header className={k('bar')}>
            {back ? (
              <button type="button" className={k('ib')} aria-label={t('core:header.back')} onClick={() => press('back-btn')}>
                <Icon name="cl" />
              </button>
            ) : (
              <span className={k('p')}><Tile size={28} src={MARK} color="#0f1116" name={t('core:frame.brand')} /></span>
            )}
            <div className={k('crumb')}>
              <span className={k('ci here keep')}>{title}</span>
            </div>
            <span className={k('sp')} />
            <button type="button" className={k('ib d')} aria-label={t('core:rail.search')} onClick={() => { (window as any).Home?.focusSearch?.(); }}>
              <Icon name="search" />
            </button>
            <button type="button" className={k('ib')} aria-label={t('core:header.notifications')} onClick={() => openFrameSheet('notifications')}>
              <Icon name="bell" />
              {unread ? <span className={k('dot')} /> : null}
            </button>
            <button type="button" className={k('p')} aria-label={t('core:frame.menu.open')} onClick={() => openFrameSheet('menu')} style={{ background: 'none', border: 0 }}>
              <Av size={28} name={me || '?'} src={user?.avatar_url} />
            </button>
          </header>
          <main className={k('pagearea')} ref={areaRef} />
          <nav className={k('tabbar')} aria-label={t('core:frame.navigation')}>
            {tb('home', 'home', t('core:tabs.home'), 0, '#home')}
            {tb('ai', 'spark', t('core:frame.bot'), Number(ai) || 0, '#homeroom-bot')}
            {tb('messages', 'chat', t('core:tabs.messages'), Number(messages) || 0, '#messages')}
            {tb('me', 'user', t('core:tabs.me'), 0, '#profile')}
          </nav>
        </div>
      </Frame>
      <FrameSheets username={me} />
    </>
  );
}
