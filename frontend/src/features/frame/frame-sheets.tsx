/**
 * The frame's sheets on the chrome: Notifications and the account menu, as
 * the 2026-11-06 screen tour draws them (its steps s05 to s07) with the
 * kit's one sheet (frontend/@/components/ui/kit.tsx Sheet).
 *
 * Like the chrome they open from (./frame-app.tsx), they draw and do not
 * decide. Notifications reads the rows the bell's own controller already
 * keeps (../notifications/notifications-store.js, each row built by that
 * controller's rowView) and hands a press to it; the menu's rows call the
 * shell's own entry points. Nothing here fetches or stores anything.
 *
 * NOTIFICATIONS, three groups in a fixed order: what needs an answer (the
 * row ends in the blue word), then news (it ends in the time), then what
 * was already seen. Mark all read is the sheet's one button.
 *
 * THE MENU, small and anchored to the corner: you (profile, settings, the
 * theme as a switch on a row), Homeroom (invite, about), then sign out.
 */
import { useCallback, useEffect, useState } from 'react';

import { Av, Btn, Card, Lead, Meta, Pill, Row, Sec, Sheet, Tile, Tog } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';
import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { swatchFor } from '../messages/format';
import { notificationsStore } from '../notifications/notifications-store.js';
import { documentBuildId } from '../../lib/asset-url';
import { homeroomHomeScreen, openHomeroomInBrowser, type HomeroomHomeScreen } from '../mobile-install/homeroom-home-screen';
import { InstallStepsSheet } from '../mobile-install/install-steps-sheet';
import type { MobileOs } from '../mobile-install/detect';

type Which = 'notifications' | 'menu' | null;
export const frameSheetStore = createStore({ open: null as Which });
export function openFrameSheet(which: Which): void { frameSheetStore.set({ open: which }); }

/** One row of the bell's list, the fields these sheets read (rowView in ../notifications/notifications.js). */
export type NotificationView = {
  id: number;
  unread: boolean;
  time: string;
  label: string;
  segments?: Array<{ t: string; v: string }>;
  needsYou?: boolean;
  who?: string | null;
  appLine?: string | null;
  appName?: string | null;
  appIconUrl?: string | null;
  appIconEmoji?: string | null;
};

const EARLIER_SHOWN = 20;
const controller = () => (window as any).Notifications as {
  refresh?: () => unknown; markAllRead?: () => unknown; _onItemClick?: (id: number) => unknown;
} | undefined;

function NotificationRow({ view, asks, onDone }: { view: NotificationView; asks: boolean; onDone: () => void }) {
  const t = useMessages('notifications');
  const subject = (view.segments || []).map((s) => s.v).join('');
  const where = view.appLine || view.appName || '';
  const lead = view.appName
    ? <Tile name={view.appName} src={view.appIconUrl} emoji={view.appIconEmoji} />
    : view.who ? <Av size={40} name={view.who} color={swatchFor(view.who)} /> : <Lead icon="bell" />;
  return (
    <Row
      lead={lead}
      title={asks && subject ? `${view.label}: ${subject}` : subject || view.label}
      line={asks ? [where, view.time].filter(Boolean).join(' · ') : (subject ? [view.label, where].filter(Boolean).join(' · ') : where) || undefined}
      right={asks ? <Pill kind="act">{t('notifications:frame.answer')}</Pill> : <Meta>{view.time}</Meta>}
      onClick={() => { onDone(); controller()?._onItemClick?.(view.id); }}
    />
  );
}

export function NotificationsFrameSheet({ onClose, rows }: { onClose: () => void; rows?: NotificationView[] | null }) {
  const t = useMessages('notifications');
  const tc = useMessages('core');
  const stored = useStoreState(notificationsStore) as { screenList: NotificationView[] | null };
  const list = rows ?? stored.screenList;
  // The bell's own read: the same one its sheet starts with.
  useEffect(() => { controller()?.refresh?.(); }, []);

  const all = list || [];
  const asks = all.filter((r) => r.unread && r.needsYou);
  const news = all.filter((r) => r.unread && !r.needsYou);
  const earlier = all.filter((r) => !r.unread).slice(0, EARLIER_SHOWN);
  // No sentence until the bell's read has landed: the empty state's words
  // on a list still loading would say nothing had ever arrived.
  const purpose = !list ? undefined
    : asks.length > 0 ? t('notifications:frame.purposeNeeds', { count: asks.length })
      : all.length > 0 ? t('notifications:frame.purposeNews') : t('notifications:frame.purposeEmpty');
  const group = (label: string, items: NotificationView[], asking: boolean) => (items.length > 0 ? (
    <Sec label={label}>
      <Card>{items.map((view) => <NotificationRow key={view.id} view={view} asks={asking} onDone={onClose} />)}</Card>
    </Sec>
  ) : null);

  return (
    <Sheet
      kind="right"
      title={t('notifications:frame.title')}
      purpose={purpose}
      onClose={onClose}
      closeLabel={tc('core:common.close')}
      secondary={asks.length + news.length > 0
        ? <Btn kind="quiet" block icon="check" onClick={() => { controller()?.markAllRead?.(); }}>{t('notifications:frame.markAllRead')}</Btn>
        : null}
    >
      {group(t('notifications:frame.needsAnswer'), asks, true)}
      {group(t('notifications:frame.news'), news, false)}
      {group(t('notifications:frame.earlier'), earlier, false)}
    </Sheet>
  );
}

export function AccountMenuSheet({ onClose, username = '', homeScreen = null, build = null }: {
  onClose: () => void;
  username?: string;
  /** A phone browser's way to its home screen (steps, or the browser from the installed app); null elsewhere. */
  homeScreen?: HomeroomHomeScreen;
  /** The build this document is, beside About. */
  build?: string | null;
}) {
  const t = useMessages('core');
  const win = (typeof window === 'undefined' ? {} : window) as any;
  const [dark, setDark] = useState(false);
  const [steps, setSteps] = useState<MobileOs | null>(null);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains('dark'));
    read();
    win.Theme?.onChange?.(read);
  }, [win]);
  const go = (run: () => void) => () => { onClose(); run(); };
  return (
    <Sheet kind="pop" title={username} purpose={username ? t('core:frame.menu.handle', { username }) : undefined} onClose={onClose} closeLabel={t('core:common.close')}>
      <Sec>
        <Card>
          <Row sm lead={<Lead icon="user" />} title={t('core:frame.menu.profile')} go onClick={go(() => document.getElementById('platform-tab-me')?.click())} />
          <Row sm lead={<Lead icon="sliders" />} title={t('core:tabs.settings')} go onClick={go(() => win.App?.navigateToSettings?.())} />
          <Row
            sm
            lead={<Lead icon="moon" />}
            title={t('core:frame.menu.darkTheme')}
            right={<Tog on={dark} label={t('core:frame.menu.darkTheme')} onChange={(next) => { win.Theme?.set?.(next ? 'dark' : 'light'); setDark(next); }} />}
          />
        </Card>
      </Sec>
      <Sec label={t('core:frame.brand')}>
        <Card>
          <Row sm lead={<Lead icon="users" />} title={t('core:frame.menu.invite')} go onClick={go(() => { void win.AppContext?.openInvite?.(); })} />
          <Row sm lead={<Lead icon="edit" />} title={t('core:frame.menu.suggest')} go onClick={go(() => { win.Improve?.giveFeedback?.(); })} />
          {homeScreen ? (
            <Row
              sm
              lead={<Lead icon="dl" />}
              title={t('core:frame.menu.homeScreen')}
              go
              onClick={() => {
                if (homeScreen.via === 'browser') { onClose(); openHomeroomInBrowser(); return; }
                setSteps(homeScreen.os);
              }}
            />
          ) : null}
          <Row sm lead={<Lead icon="info" />} title={t('core:frame.menu.about')} right={build ? <Meta>{build}</Meta> : undefined} go onClick={go(() => win.App?.navigateToSettings?.('about'))} />
        </Card>
      </Sec>
      <Sec>
        <Card>
          <Row sm lead={<Lead icon="door" />} title={t('core:frame.menu.signOut')} onClick={go(() => { void win.Settings?.logout?.(); })} />
        </Card>
      </Sec>
      {steps ? <InstallStepsSheet os={steps} onClose={() => setSteps(null)} /> : null}
    </Sheet>
  );
}

/** Whichever of the two is open, if any. Mounted by the chrome. */
export function FrameSheets({ username }: { username: string }) {
  const { open } = useStoreState(frameSheetStore) as { open: Which };
  const close = useCallback(() => openFrameSheet(null), []);
  // A sheet is over the page it was opened on: a move to another address
  // (a row's link, Back) puts it away.
  useEffect(() => {
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, [close]);
  if (open === 'notifications') return <NotificationsFrameSheet onClose={close} />;
  if (open === 'menu') return <AccountMenuSheet onClose={close} username={username} homeScreen={homeroomHomeScreen()} build={documentBuildId()} />;
  return null;
}
