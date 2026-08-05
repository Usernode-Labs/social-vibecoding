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
// Hidden entirely when the bridge lacks the `getWalletState` capability
// (desktop, child-app iframes, old app builds).
(function () {
  'use strict';

  const REFRESH_MS = 60000;

  const WalletSheet = {
    _state: null,     // last getWalletState snapshot
    _records: null,   // last getTransactionRecords items
    _sheet: null,
    _timer: null,

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
      if (!window.NativeChrome) return;
      if (!(await NativeChrome.has('getWalletState'))) return;

      const row = document.getElementById('drawer-row-wallet');
      if (row) {
        row.classList.remove('hidden');
        row.addEventListener('click', () => {
          if (window.App && App.HeaderMenu && App.HeaderMenu.close) {
            App.HeaderMenu.close();
          }
          WalletSheet._openSheet();
        });
      }

      await WalletSheet._refreshState();
      WalletSheet._renderChip();
      WalletSheet._timer = setInterval(async () => {
        await WalletSheet._refreshState();
        WalletSheet._renderChip();
        if (WalletSheet._sheet) WalletSheet._renderSheetBody();
      }, REFRESH_MS);
    },

    async _refreshState() {
      try {
        WalletSheet._state = await window.usernode.getWalletState();
      } catch (_) { /* keep last snapshot */ }
    },

    async _refreshRecords() {
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

    // The existing native transfer flow accepts whole numeric amounts.
    // Never let Number/parseInt silently reinterpret what the user typed: a
    // transfer amount must survive this boundary exactly.
    _parseAmount(value) {
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
      const amount = Number(value);
      return Number.isSafeInteger(amount) ? amount : null;
    },

    // Kept the historical name from the header-chip era; now paints the
    // balance readout on the drawer row.
    _renderChip() {
      const balanceEl = document.getElementById('drawer-wallet-balance');
      if (!balanceEl) return;
      balanceEl.textContent =
        `${WalletSheet._fmtBalance()} ${WalletSheet._symbol()}`;
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
        onDismiss: () => { WalletSheet._sheet = null; },
      });
      WalletSheet._renderSheetBody();

      await Promise.all([
        WalletSheet._refreshState(),
        WalletSheet._refreshRecords(),
      ]);
      WalletSheet._renderChip();
      WalletSheet._renderSheetBody();
    },

    _renderSheetBody() {
      const body = document.getElementById('wallet-sheet-body');
      if (!body) return;
      const s = WalletSheet._state || {};
      body.textContent = '';

      // Balance
      const balance = document.createElement('div');
      balance.className = 'text-3xl font-bold mb-1';
      balance.textContent = `${WalletSheet._fmtBalance()} ${WalletSheet._symbol()}`;
      body.appendChild(balance);

      // Address row: short address + copy
      const addrRow = document.createElement('div');
      addrRow.className = 'flex items-center gap-2 mb-4 text-sm ' +
        'text-zinc-500 dark:text-zinc-400';
      const addr = document.createElement('span');
      addr.className = 'font-mono';
      addr.textContent = WalletSheet._shortAddr(s.address);
      addrRow.appendChild(addr);
      if (s.address) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'text-violet-500 hover:text-violet-400 text-xs ' +
          'font-medium';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(s.address);
            PlatformUI.toast('Address copied');
          } catch (_) {
            PlatformUI.toast('Could not copy address');
          }
        });
        addrRow.appendChild(copyBtn);
      }
      body.appendChild(addrRow);

      // Send / Receive actions
      const actions = document.createElement('div');
      actions.className = 'flex gap-2 mb-4';
      const mkBtn = (label, primary, onClick) => {
        const b = document.createElement('button');
        b.className = primary
          ? 'flex-1 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 ' +
            'text-white text-sm font-semibold'
          : 'flex-1 py-2 rounded-lg border border-zinc-300 ' +
            'dark:border-zinc-700 text-sm font-semibold ' +
            'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 ' +
            'dark:hover:bg-zinc-800';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      };
      actions.appendChild(mkBtn('Send', true, () => WalletSheet._showSend()));
      actions.appendChild(mkBtn('Receive', false,
        () => WalletSheet._showReceive()));
      body.appendChild(actions);

      // Expandable areas (send form / receive QR)
      const expand = document.createElement('div');
      expand.id = 'wallet-sheet-expand';
      body.appendChild(expand);

      // Receipts
      const recTitle = document.createElement('div');
      recTitle.className = 'text-sm font-semibold text-zinc-500 ' +
        'dark:text-zinc-400 mt-2 mb-1';
      recTitle.textContent = 'Recent';
      body.appendChild(recTitle);
      body.appendChild(WalletSheet._renderReceipts());
    },

    _renderReceipts() {
      const wrap = document.createElement('div');
      const items = WalletSheet._records;
      if (items == null) {
        const loading = document.createElement('div');
        loading.className = 'text-sm text-zinc-400 py-2';
        loading.textContent = 'Loading…';
        wrap.appendChild(loading);
        return wrap;
      }
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-sm text-zinc-400 py-2';
        empty.textContent = 'No transactions sent from this session yet.';
        wrap.appendChild(empty);
        return wrap;
      }
      for (const r of items.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between py-2 border-b ' +
          'border-zinc-100 dark:border-zinc-800 text-sm';
        const left = document.createElement('div');
        left.className = 'min-w-0';
        const line1 = document.createElement('div');
        line1.className = 'font-medium truncate';
        line1.textContent =
          `Sent ${r.amount} ${WalletSheet._symbol()} to ` +
          WalletSheet._shortAddr(r.to);
        const line2 = document.createElement('div');
        line2.className = 'text-xs text-zinc-400';
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
        line2.textContent = `${when} · ${status}`;
        left.appendChild(line1);
        left.appendChild(line2);
        row.appendChild(left);
        wrap.appendChild(row);
      }
      return wrap;
    },

    // -- send / receive -------------------------------------------------

    _clearExpand() {
      const expand = document.getElementById('wallet-sheet-expand');
      if (expand) expand.textContent = '';
      return expand;
    },

    _showReceive() {
      const expand = WalletSheet._clearExpand();
      const s = WalletSheet._state;
      if (!expand || !s || !s.address) return;
      const box = document.createElement('div');
      box.className = 'flex flex-col items-center gap-2 p-4 mb-4 rounded-lg ' +
        'border border-zinc-200 dark:border-zinc-800';
      const qrEl = document.createElement('div');
      qrEl.className = 'bg-white p-2 rounded';
      box.appendChild(qrEl);
      const addr = document.createElement('div');
      addr.className = 'font-mono text-xs break-all text-center ' +
        'text-zinc-500 dark:text-zinc-400';
      addr.textContent = s.address;
      box.appendChild(addr);
      expand.appendChild(box);
      if (window.QRCode) {
        // eslint-disable-next-line no-new
        new QRCode(qrEl, { text: s.address, width: 160, height: 160 });
      }
    },

    _showSend() {
      const expand = WalletSheet._clearExpand();
      if (!expand) return;
      const form = document.createElement('div');
      form.className = 'flex flex-col gap-2 p-4 mb-4 rounded-lg border ' +
        'border-zinc-200 dark:border-zinc-800';

      const toInput = document.createElement('input');
      toInput.placeholder = 'Recipient address (ut1…)';
      toInput.className = 'w-full px-3 py-2 rounded-lg border ' +
        'border-zinc-300 dark:border-zinc-700 bg-transparent text-sm ' +
        'font-mono';
      const amtInput = document.createElement('input');
      amtInput.placeholder = 'Amount';
      amtInput.inputMode = 'numeric';
      amtInput.className = toInput.className.replace(' font-mono', '');
      const sendBtn = document.createElement('button');
      sendBtn.className = 'py-2 rounded-lg bg-violet-600 hover:bg-violet-500 ' +
        'text-white text-sm font-semibold disabled:opacity-50';
      sendBtn.textContent = 'Send';
      const note = document.createElement('div');
      note.className = 'text-xs text-zinc-400';
      note.textContent = 'You will confirm this transaction on the next ' +
        'screen.';

      sendBtn.addEventListener('click', async () => {
        const to = toInput.value.trim();
        const amount = WalletSheet._parseAmount(amtInput.value);
        if (!to || !to.startsWith('ut1')) {
          PlatformUI.toast('Enter a valid ut1… address');
          return;
        }
        if (amount == null) {
          PlatformUI.toast('Enter a positive whole-number amount (digits only)');
          return;
        }
        sendBtn.disabled = true;
        try {
          // Fire-and-forget on the inclusion side: the native confirm
          // sheet is the interaction, and the receipts list will pick the
          // tx up once the app observes it.
          await window.sendTransaction(to, amount, '', {
            waitForInclusion: false,
            confirmTitle: 'Send from wallet',
            confirmSubtitle:
              `Sending ${amount} ${WalletSheet._symbol()} to ` +
              WalletSheet._shortAddr(to),
          });
          PlatformUI.toast('Transaction submitted');
          WalletSheet._clearExpand();
          await WalletSheet._refreshRecords();
          WalletSheet._renderSheetBody();
        } catch (err) {
          console.warn('[wallet-sheet] send failed:', err);
          PlatformUI.toast('Send failed: ' +
            ((err && err.message) || 'unknown error'));
          sendBtn.disabled = false;
        }
      });

      form.appendChild(toInput);
      form.appendChild(amtInput);
      form.appendChild(sendBtn);
      form.appendChild(note);
      expand.appendChild(form);
      toInput.focus();
    },
  };

  window.WalletSheet = WalletSheet;
  WalletSheet.init();
})();
