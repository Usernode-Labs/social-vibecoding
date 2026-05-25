// Promise-based confirm dialog that works inside Usernode webviews.
//
// Why this exists: native window.confirm() blocks the JS thread and is
// suppressed or no-op'd in several webview hosts the platform runs in
// (mobile in-app browsers, the Usernode wallet shell, etc.). Anything
// destructive that wants a "really?" gate has to use this instead.
//
// Usage:
//   const ok = await ConfirmModal.show({
//     title: 'Archive "fix-foo"?',
//     message: 'This drops Claude\'s memory and closes the PR. It can\'t be undone.',
//     confirmLabel: 'Archive',
//     danger: true,
//   });
//   if (!ok) return;
//
// Styling matches the existing modal pattern (see #share-modal,
// #settings-modal in index.html): centered card on a black/60 scrim,
// Tailwind dark variants, violet primary or red danger button.
//
// Behavior:
//   - Esc cancels, Enter confirms.
//   - Click on the backdrop cancels (mirrors share-modal).
//   - Confirm button gets initial focus so keyboard users can hit
//     Enter immediately; danger dialogs still require an explicit
//     click/Enter — we don't auto-accept.
//   - Calling show() while another dialog is open cancels the prior
//     one (its promise resolves false) and replaces it. Keeps the
//     dialog a singleton so two destructive prompts can't stack.

(function () {
  let rootEl = null;
  let activeReject = null; // resolves the previous open dialog as false

  function ensureRoot() {
    if (rootEl) return rootEl;
    rootEl = document.createElement('div');
    rootEl.id = 'app-confirm-modal';
    // Same scroll-friendly structure as the static modals in index.html
    // (see the long comment on #settings-modal). Outer div is the scroll
    // layer; the `data-modal-backdrop` wrapper centers the panel and
    // grows with content so the dialog can scroll on small viewports if
    // the caller passes a long message.
    rootEl.className = 'hidden fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-black/60';
    rootEl.innerHTML = `
      <div data-modal-backdrop class="flex min-h-full items-center justify-center p-4">
        <div class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
          <h2 data-role="title" class="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100"></h2>
          <p data-role="message" class="text-sm text-zinc-600 dark:text-zinc-400 mb-5 whitespace-pre-line"></p>
          <div class="flex justify-end gap-2">
            <button data-role="cancel" type="button"
              class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"></button>
            <button data-role="confirm" type="button"
              class="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"></button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(rootEl);
    return rootEl;
  }

  function show(opts) {
    const {
      title = 'Are you sure?',
      message = '',
      confirmLabel = 'OK',
      cancelLabel = 'Cancel',
      danger = false,
    } = opts || {};

    // Cancel any in-flight dialog so we don't stack two cards.
    if (activeReject) {
      const prev = activeReject;
      activeReject = null;
      prev();
    }

    const root = ensureRoot();
    root.querySelector('[data-role="title"]').textContent = title;
    root.querySelector('[data-role="message"]').textContent = message;

    const cancelBtn = root.querySelector('[data-role="cancel"]');
    const confirmBtn = root.querySelector('[data-role="confirm"]');
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className =
      'rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ' +
      (danger
        ? 'bg-red-600 hover:bg-red-500'
        : 'bg-violet-600 hover:bg-violet-500');

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        root.classList.add('hidden');
        cancelBtn.removeEventListener('click', onCancel);
        confirmBtn.removeEventListener('click', onConfirm);
        root.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        activeReject = null;
        resolve(result);
      };
      const onCancel = () => cleanup(false);
      const onConfirm = () => cleanup(true);
      const onBackdrop = (e) => {
        if (e.target === root || e.target.dataset.modalBackdrop !== undefined) cleanup(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
        // Only intercept Enter if our confirm button has focus, so we
        // don't hijack Enter from any underlying input the user might
        // still be in.
        else if (e.key === 'Enter' && document.activeElement === confirmBtn) {
          e.preventDefault(); cleanup(true);
        }
      };

      cancelBtn.addEventListener('click', onCancel);
      confirmBtn.addEventListener('click', onConfirm);
      root.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);

      // Expose a way for the next show() call to dismiss us.
      activeReject = () => cleanup(false);

      root.classList.remove('hidden');
      // Defer focus to the next tick so the modal is painted first.
      setTimeout(() => confirmBtn.focus(), 0);
    });
  }

  window.ConfirmModal = { show };
})();
