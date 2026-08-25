// MOVED in #1079 chunk B. This file was public/js/wallet-sheet.js;
// #header-menu-panel became a React island and this module owns nodes inside
// it, so it moved into the bundle with the region it writes to. Its legacy
// window publication and layout-effect init seam remain load-bearing.
//
// Wallet drawer row + wallet sheet — the app's native wallet surface
// absorbed into SV chrome (app-as-SV-chrome migration, NATIVE-BRIDGE.md).
// Lived in the header as a balance chip originally; moved into the
// hamburger drawer to keep the header uncluttered.
//
// Row: balance readout at the top of the drawer. Tap opens a bottom
// sheet with the full balance, the user's address (copy + QR receive),
// recent dapp-transaction receipts (`usernode.getTransactionRecords`),
// and a Send form. Send routes through the bridge's `sendTransaction`,
// so the app's NATIVE confirm sheet still appears — the trust boundary
// is unchanged (Apple Pay model).
//
// Present for every native top frame, even while wallet state is unavailable.
// Desktop and child-app iframes keep the row hidden. Delegation itself is an
// optional v4 capability and affects only the card inside this Wallet sheet.
import { walletSheetStore, WALLET_EMPTY } from './wallet-sheet-store';
import { mountWalletSheet, unmountWalletSheet } from './wallet-sheet-body';

(function () {
  'use strict';

  const REFRESH_MS = 60000;

  const WalletSheet = {
    _state: null,     // last getWalletState snapshot
    _records: null,   // last getTransactionRecords items
    _sheet: null,
    _timer: null,
    _walletSupported: false,
    _recordsSupported: false,
    _stakingSupported: false,
    _stakingPending: false,
    _refreshPending: false,
    _stateError: null,
    // Was `hidden` on the row element; the component renders the class now.
    _visible: false,

    // #977: the sheet is a second surface, so it presents once the drawer has
    // finished leaving rather than rising across its exit. close() resolves
    // immediately when nothing is open, and the guard keeps the sheet working
    // with no HeaderMenu at all. Was an addEventListener on the row; the
    // component's onClick dispatches here by name.
    openFromRow() {
      const closed = (window.App && App.HeaderMenu && App.HeaderMenu.close)
        ? App.HeaderMenu.close()
        : null;
      Promise.resolve(closed).then(() => WalletSheet._openSheet());
    },

    /** The address copy. Clipboard + toast are the module's, as before. */
    async copyAddress() {
      const addr = (WalletSheet._state || {}).address;
      if (!addr) return;
      try {
        await navigator.clipboard.writeText(addr);
        PlatformUI.toast('Address copied');
      } catch (_) {
        PlatformUI.toast('Could not copy address');
      }
    },

    /** The staking card's Retry. */
    async retryState() {
      if (WalletSheet._refreshPending) return;
      WalletSheet._refreshPending = true;
      WalletSheet._publish();
      await WalletSheet._refreshState();
      WalletSheet._refreshPending = false;
      WalletSheet._renderChip();
    },

    /**
     * The Send form's submit. The TRUST BOUNDARY is unchanged: this still goes
     * through `window.sendTransaction`, so the app's native confirm sheet is
     * still the interaction, and the receipts list picks the tx up once the
     * app observes it. Returns whether the form should close.
     */
    async sendFromSheet(to, amount) {
      try {
        await window.sendTransaction(to, amount, '', {
          waitForInclusion: false,
          confirmTitle: 'Send from wallet',
          confirmSubtitle:
            `Sending ${amount} ${WalletSheet._symbol()} to ` +
            WalletSheet._shortAddr(to),
        });
        PlatformUI.toast('Transaction submitted');
        await WalletSheet._refreshRecords();
        WalletSheet._publish();
        return true;
      } catch (err) {
        console.warn('[wallet-sheet] send failed:', err);
        PlatformUI.toast('Send failed: ' +
          ((err && err.message) || 'unknown error'));
        return false;
      }
    },

    // Drops any snapshot read before the current web participant was handed
    // to native. Reopening refreshes from the newly admitted identity.
    _setSessionWalletAdmission(admitted) {
      if (admitted !== true) {
        WalletSheet._state = null;
        WalletSheet._records = null;
        WalletSheet._renderChip();
        if (WalletSheet._sheet) WalletSheet._renderSheetBody();
        // FIXME(#514): an already-admitted native read may still finish after
        // this clear; cancelling/fencing in-flight native operations is
        // intentionally deferred.
        return Promise.resolve();
      }
      return Promise.all([
        WalletSheet._refreshState(),
        WalletSheet._refreshRecords(),
      ]).then(() => {
        WalletSheet._renderChip();
        if (WalletSheet._sheet) WalletSheet._renderSheetBody();
      });
    },

    async init() {
      if (!window.NativeChrome || !window.usernode ||
          window.usernode.isNative !== true) return;

      // Present for every native top frame — wallet state affects the row's
      // CONTENTS, never whether it is there.
      WalletSheet._visible = true;
      WalletSheet._publish();

      await WalletSheet._refreshCapabilities();
      if (WalletSheet._walletSupported) await WalletSheet._refreshState();
      WalletSheet._renderChip();
      WalletSheet._timer = setInterval(async () => {
        if (!WalletSheet._walletSupported) return;
        await WalletSheet._refreshState();
        WalletSheet._renderChip();
        if (WalletSheet._sheet) WalletSheet._renderSheetBody();
      }, REFRESH_MS);
    },

    async _refreshCapabilities() {
      const bridgeInfo = await NativeChrome.getInfo();
      if (!bridgeInfo || bridgeInfo.degraded === true) return;
      const capabilities = Array.isArray(bridgeInfo.capabilities)
        ? bridgeInfo.capabilities : [];
      WalletSheet._walletSupported =
        capabilities.includes('getWalletState');
      WalletSheet._recordsSupported =
        capabilities.includes('getTransactionRecords');
      WalletSheet._stakingSupported =
        Number(bridgeInfo.version) >= 4 &&
        capabilities.includes('manageStaking');
    },

    async _refreshState() {
      try {
        const next = await window.usernode.getWalletState();
        const readError = NativeChrome.lastReadError
          ? NativeChrome.lastReadError('getWalletState') : null;
        if (next) {
          WalletSheet._state = next;
          WalletSheet._stateError = null;
        } else if (readError) {
          WalletSheet._stateError = readError.message ||
            'Could not refresh wallet state.';
        }
      } catch (err) {
        // Keep the last valid snapshot; the error is intentionally inline and
        // non-blocking so Send/Receive and navigation remain usable.
        WalletSheet._stateError = (err && err.message) ||
          'Could not refresh wallet state.';
      }
    },

    async _refreshRecords() {
      if (!WalletSheet._recordsSupported) return;
      try {
        const resp = await window.usernode.getTransactionRecords();
        WalletSheet._records = (resp && Array.isArray(resp.items))
          ? resp.items : [];
      } catch (_) {
        WalletSheet._records = WalletSheet._records || [];
      }
    },

    _fmtBalance() {
      const s = WalletSheet._state;
      if (!s || s.tokenAmount == null) return '—';
      return Number(s.tokenAmount).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      });
    },

    _symbol() {
      const s = WalletSheet._state;
      return (s && s.tokenSymbol) || 'UT';
    },

    _shortAddr(addr) {
      if (!addr || addr.length <= 16) return addr || '—';
      return addr.slice(0, 8) + '…' + addr.slice(-6);
    },

    _isDelegated(staking) {
      return !!staking && staking.delegate != null;
    },

    _formatDelegatedSince(value) {
      if (!value) return null;
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return null;
      return date.toLocaleString();
    },

    // Kept the historical name from the header-chip era; now paints the
    // balance readout on the drawer row.
    // The row's balance write. Kept as its own name because forty call sites
    // reach for it, but there is one publish underneath — the row and the
    // sheet read the same model and cannot disagree for a frame.
    _renderChip() {
      WalletSheet._publish();
    },

    /** The whole view model, in one place. See ./wallet-sheet-store.ts. */
    _publish() {
      const s = WalletSheet._state || {};
      walletSheetStore.set({
        visible: WalletSheet._visible,
        balanceLabel: `${WalletSheet._fmtBalance()} ${WalletSheet._symbol()}`,
        address: s.address || null,
        shortAddress: WalletSheet._shortAddr(s.address),
        walletSupported: WalletSheet._walletSupported,
        stateError: WalletSheet._stateError || null,
        staking: WalletSheet._stakingView(s.staking),
        stakingPending: WalletSheet._stakingPending,
        refreshPending: WalletSheet._refreshPending,
        receipts: WalletSheet._receiptViews(),
      });
    },

    /**
     * The block-production card's state. `staking == null` is wallet setup
     * still running, which is NOT "not delegated" and must not render as it.
     */
    _stakingView(staking) {
      if (!WalletSheet._stakingSupported) return { kind: 'absent' };
      if (staking === null || staking === undefined) return { kind: 'pending' };
      if (!WalletSheet._isDelegated(staking)) return { kind: 'local' };
      return {
        kind: 'delegated',
        delegate: WalletSheet._shortAddr(staking.delegate),
        since: WalletSheet._formatDelegatedSince(staking.delegated_since) || '',
      };
    },

    /** Receipts, worded here — the confirmed / pending / unknown ladder. */
    _receiptViews() {
      const items = WalletSheet._records;
      if (items == null) return null;
      return items.map((r, i) => {
        const when = r.sentAt ? new Date(r.sentAt).toLocaleString() : '';
        let status;
        if (r.onChainStatus === 'confirmed' || r.confirmedAt) {
          status = r.blockHeight != null
            ? `confirmed · block ${Number(r.blockHeight).toLocaleString()}`
            : 'confirmed';
        } else if (r.status === 'queued') {
          status = 'pending';
        } else {
          status = r.status || 'unknown';
        }
        return {
          key: String(r.id != null ? r.id : `${r.to}-${r.sentAt}-${i}`),
          line1: `Sent ${r.amount} ${WalletSheet._symbol()} to ${WalletSheet._shortAddr(r.to)}`,
          line2: `${when} · ${status}`,
        };
      });
    },

    // -- sheet ----------------------------------------------------------

    async _openSheet() {
      if (WalletSheet._sheet) return;

      const panel = document.createElement('div');
      panel.className = 'px-4 pb-4 max-h-[75vh] overflow-y-auto';
      const title = document.createElement('div');
      title.className = 'text-lg font-bold py-3';
      title.textContent = 'Wallet';
      panel.appendChild(title);
      const bodyEl = document.createElement('div');
      bodyEl.id = 'wallet-sheet-body';
      panel.appendChild(bodyEl);

      WalletSheet._sheet = PlatformUI.sheet({
        contentEl: panel,
        // Drop the portal BEFORE the kit discards the node it lives in.
        onDismiss: () => {
          unmountWalletSheet(bodyEl);
          WalletSheet._sheet = null;
        },
      });
      // The store already holds what the body draws, so the mount paints the
      // current snapshot with no separate first render.
      mountWalletSheet(bodyEl);

      await Promise.all([
        WalletSheet._refreshCapabilities(),
      ]);
      await Promise.all([
        WalletSheet._walletSupported
          ? WalletSheet._refreshState() : Promise.resolve(),
        WalletSheet._refreshRecords(),
      ]);
      WalletSheet._renderChip();
      WalletSheet._renderSheetBody();
    },

    // `_renderSheetBody`, `_renderStakingCard`, `_button`, `_renderReceipts`,
    // `_clearExpand`, `_showReceive` and `_showSend` were roughly forty
    // `createElement` calls rebuilt from scratch on every repaint — and there
    // are many repaints: the 60s refresh, the admission reset, three inside
    // `_manageStaking`, one per send. They are ./wallet-sheet-body.tsx now and
    // the store repaints them, so a refresh landing mid-typing no longer
    // discards a half-entered address.
    _renderSheetBody() {
      WalletSheet._publish();
    },

    async _manageStaking() {
      if (!WalletSheet._stakingSupported || WalletSheet._stakingPending) return;
      WalletSheet._stakingPending = true;
      WalletSheet._stateError = null;
      WalletSheet._publish();
      try {
        // No validator address or desired state crosses this boundary. Native
        // owns the entire management flow and resolves after its screen closes.
        const staking = await window.usernode.manageStaking();
        if (staking && typeof staking === 'object') {
          WalletSheet._state = Object.assign({}, WalletSheet._state || {}, {
            staking,
          });
          WalletSheet._publish();
        }
        await WalletSheet._refreshState();
      } catch (err) {
        WalletSheet._stateError = (err && err.message) ||
          'Could not open delegation management.';
      } finally {
        WalletSheet._stakingPending = false;
        WalletSheet._renderChip();
      }
    },
  };

  // Same as node-pill.js: published here, initialised from the island's layout
  // effect so the `hidden` it lifts off #drawer-row-wallet lands after React
  // has hydrated that node.
  // `typeof window` guard: the shell's markup is PRERENDERED in Node
  // (frontend/scripts/build-shell.mjs), which imports this island's module
  // graph. Same guard as features/notifications/notifications.js.
  if (typeof window !== 'undefined') window.WalletSheet = WalletSheet;
})();
