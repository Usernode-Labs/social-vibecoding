/**
 * Settings' account block — the native wallet, node and staking rows, above
 * Log out.
 *
 * Admin & moderation was a row here too, under an "Admin" heading. It left
 * Settings in #5281: Settings is about your own account, and on a phone the
 * row was one more line of a fifteen-row list. The console is a place, not a
 * preference, so its entrance is a row on Me (features/profile/
 * account-panel.tsx, `AdminPanel`), shown to admins only, on both layouts.
 *
 * ── Why these live in Settings now ────────────────────────────────────
 *
 * They were the bottom of the Me screen (features/profile/account-panel.tsx
 * until this change): a "Platform" group with Admin & moderation, and an
 * "Account" group with the three native readouts and Log out. The navigation
 * prototype's Me has none of that — a profile card, three stat cards, a
 * "More" list and your contributions — and the spec's table of retired places
 * says where the rest goes: "Me, with Admin and Validator inside Settings".
 * The prototype's Settings closes the same way, with the wallet under Money
 * and the admin console under Admin. Settings already had Log out.
 *
 * ── Where it sits, and why that is safe ───────────────────────────────
 *
 * Inside #settings-footer, above #settings-logout. That node is already where
 * this block belongs on both layouts: under the section list in the desktop
 * sidebar, and under the level-1 menu on a phone — Settings._syncFooter MOVES
 * it between the two columns, and hides it on a phone's level 2, which is
 * exactly when an account row should not show either.
 *
 * The move is why this component renders only INSIDE the footer and never
 * next to it. React inserts and removes nodes relative to a parent: every
 * change here happens inside #settings-footer, which is a valid parent
 * wherever settings.js has put it, while a sibling of the footer would be
 * inserted against a node that may no longer be in the column React thinks
 * it is in. The Log out button beside it is untouched: same element, same
 * id, so the click handler settings.js bound in init() survives.
 *
 * ── First render ──────────────────────────────────────────────────────
 *
 * Nothing until mounted. The footer is in the prerendered shell, and the
 * native stores can be published BEFORE hydration, so reading them during
 * the first render could disagree with the document — React #418 on every
 * route. The block appears from an effect instead, and its rows are never in
 * the shell's markup.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { GroupedList, SectionHeader } from '@/components/ui/grouped-list';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { NodePillRow } from '../header/node-pill-row';
import { nodePillStore } from '../header/node-pill-store';
import { navStore } from '../nav/nav-store.js';
import { WalletRow } from '../header/wallet-row';
import { walletSheetStore } from '../header/wallet-sheet-store';
import { StakingRow } from '../profile/staking-sheet';

/** The two nav hosts' heading insets, phone then desktop (settings-nav.tsx). */
const HEADING = 'px-4 pt-0 pb-1.5 md:px-3 md:pb-1';

export function SettingsAccountRows(): ReactNode {
  const t = useMessages('settings');
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const nodeVisible = (useStoreState(nodePillStore) as { visible: boolean }).visible;
  const walletVisible = (useStoreState(walletSheetStore) as { visible: boolean }).visible;
  // The Node row keeps itself current while Settings is on screen: status
  // events only fire on transitions, so it pulls on reveal and every few
  // seconds after (node-pill.js `setLiveRefresh`), and stops when hidden.
  // The router's last revealed screen (nav-store), which is Settings'
  // own truth: this screen does not publish through the visibility store.
  const settingsVisible = (useStoreState(navStore) as { screen: string | null }).screen === 'settings-screen';
  const liveNode = settingsVisible && nodeVisible;
  useEffect(() => {
    const pill = (window as any).NodePill;
    pill?.setLiveRefresh?.('settings', liveNode);
    return () => { pill?.setLiveRefresh?.('settings', false); };
  }, [liveNode]);
  if (!mounted) return null;
  // The native readouts ship hidden and reveal themselves when the bridge
  // reports the capability; their group heading follows them, so a browser
  // never shows a heading over nothing.
  const native = nodeVisible || walletVisible;
  return (
    <div id="settings-account-rows" className={native ? 'mb-6 space-y-5' : undefined}>
      <section aria-label={t('settings:accountRows.native.name')}>
        {native ? <SectionHeader className={HEADING}>{t('settings:accountRows.native.heading')}</SectionHeader> : null}
        <GroupedList className="mx-0">
          <NodePillRow />
          <WalletRow />
          <StakingRow />
        </GroupedList>
      </section>
    </div>
  );
}
