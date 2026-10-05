import { t as tr } from "../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Share dialog (#share-modal).
 *
 * The app's public URL, a copy button, and an "Open in new tab" link.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. The render output is still
 * byte-identical to what the shell shipped — same ids, same class strings,
 * same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html in
 * this commit are the proof.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `AppView.openShareModal` / `.closeShareModal` / `.copyShareUrl` were
 * public/js/app-view.js:13170-13218; the close-button and backdrop listeners
 * (including the `modalDismissGuarded` ghost-click check, which lives in
 * `useDialog` now) were public/js/app.js's `bindEvents`.
 * `AppView.openShareModal()` survives as a one-line forward — the drawer's
 * Share row and the app-view header both call it by name.
 *
 * `resolveDevHost` is reached as a global for the same reason every other
 * legacy name here is: public/js/dev-host.js is a classic script that
 * publishes `window.resolveDevHost`, and a bundle module cannot import it.
 * It rewrites `http://localhost:<port>` URLs to whatever hostname the browser
 * is actually on, so a phone on the LAN gets a link that resolves.
 *
 * The URL field stays UNCONTROLLED (a ref, not `value`): a controlled input
 * renders a `value` attribute in the prerender pass and this document is
 * compared against the hand-written shell attribute for attribute.
 *
 * ── Who can open the link (#3657) ─────────────────────────────────────
 *
 * The link is the app's own address for every audience, and the line under
 * the title says who it opens for, read off the running app's record:
 * `view_visibility` (or, where only that is to hand, the derived `audience`,
 * whose 'open' is exactly view-public). A private community or a Just you
 * project opens for its members only, so the dialog says so and offers the
 * way to add people: "Invite people" hands over to the Homeroom menu's
 * invite pane (the same door the project hub's Invite uses). A public one
 * opens for anyone with an account. `shareAudience` is pure and unit-tested.
 */

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { ArrowRightIcon, UserGroupIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useDialog } from './use-dialog';

export type ShareAudience = 'members' | 'public';

/**
 * Who the shared link opens for. Anything that is not positively view-public
 * reads as members-only: saying "only members" about an app that is in fact
 * public costs a little reach, while saying "anyone" about a private one is
 * a promise the link will not keep.
 */
export function shareAudience(app: { view_visibility?: unknown; audience?: unknown } | null | undefined): ShareAudience {
  if (!app) return 'members';
  if (app.view_visibility === 'public') return 'public';
  if (app.view_visibility == null && app.audience === 'open') return 'public';
  return 'members';
}

export const SHARE_COPY: Readonly<Record<ShareAudience, string>> = Object.freeze({
  get members() { return tr("core:only_members_can_open_it_invite_people_to_let_th_a75f15f8"); },
  get public() { return tr("core:anyone_with_a_homeroom_account_can_open_it_791fd9c3"); },
});

/**
 * The Homeroom menu's invite pane for the app in context (the project hub's
 * Invite does the same). Reached as a global, like the hub reaches it, and
 * opened straight onto the pane, once (AppContext.openInvite).
 */
function openInvitePane(): void {
  const ctx = (window as unknown as {
    AppContext?: { openInvite?: () => Promise<void> };
  }).AppContext;
  if (!ctx) return;
  void ctx.openInvite?.();
}

export function ShareDialog() {
  useUiLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState('');
  const [copyLabel, setCopyLabel] = useState(tr("core:copy_e21f935f"));
  const [audience, setAudience] = useState<ShareAudience>('members');
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by "Invite people" and read once the dialog's exit has landed: the
  // kit cannot present the menu's sheet while it is still taking this
  // dialog down, so the hand-off waits for onClose (which rides the exit).
  const inviteNext = useRef(false);

  const dialog = useDialog('share', {
    onOpen: () => {
      inviteNext.current = false;
      setAudience(shareAudience(window.AppView?.appData as { view_visibility?: unknown; audience?: unknown } | undefined));
      const raw = (window.AppView?.appData?.url as string) || '';
      const url = raw && window.resolveDevHost ? window.resolveDevHost(raw) : raw;
      if (inputRef.current) inputRef.current.value = url;
      setHref(url);
      setCopyLabel(tr("core:copy_e21f935f"));
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
    onClose: () => {
      if (flashRef.current) clearTimeout(flashRef.current);
      flashRef.current = null;
      setCopyLabel(tr("core:copy_e21f935f"));
      if (inviteNext.current) {
        inviteNext.current = false;
        openInvitePane();
      }
    },
  });

  function invite() {
    inviteNext.current = true;
    dialog.close();
  }

  // Verbatim from AppView.copyShareUrl: try the async clipboard first, fall
  // back to select + execCommand for browsers/contexts where
  // navigator.clipboard isn't available (e.g. http: localhost in some
  // browsers), then flash the outcome on the button for 1.5s.
  async function copy() {
    const input = inputRef.current;
    const url = input?.value || '';
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      /* falls through to the execCommand path below */
    }
    if (!ok && input) {
      try {
        input.focus();
        input.select();
        ok = document.execCommand('copy');
      } catch {
        /* both paths refused — say so on the button */
      }
    }
    setCopyLabel(ok ? 'Copied!' : tr("core:copy_failed_5b50e7a6"));
    if (flashRef.current) clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setCopyLabel('Copy'), 1500);
  }

  return (
    <DialogRoot
      id="share-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="md" relative>
        <Localized element={<button
          id="share-close"
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors" aria-label={catalogText("core:close_share_bfc83eec")}
          onClick={() => dialog.close()}
        >
          <XIcon className="w-5 h-5" />
        </button>} messages={{"aria-label":"core:close_share_bfc83eec"}} />
        <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100"><Message id="core:share_this_app_27b2c870" /></h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          {SHARE_COPY[audience]}
        </p>
        <div className="flex gap-2">
          <Localized element={<Input
            id="share-url-input"
            ref={inputRef}
            type="text"
            readOnly={true}
            width="flex1"
            mono aria-label={catalogText("core:share_url_04db8a9c")}
          />} messages={{"aria-label":"core:share_url_04db8a9c"}} />
          <Button id="share-copy-btn" className="whitespace-nowrap" onClick={copy}>
            {copyLabel}
          </Button>
        </div>
        <div className={audience === 'members' ? 'mt-4 flex items-center justify-between gap-3' : 'mt-4 flex justify-end'}>
          {audience === 'members' ? (
            <Button
              type="button"
              layout="iconRow"
              variant="neutral"
              size="narrow"
              ink="neutral"
              onClick={invite}
            >
              <UserGroupIcon className="w-4 h-4" aria-hidden="true" /><Message id="core:invite_people_27bf0f2d" /></Button>
          ) : null}
          <a
            id="share-open-link"
            href={href || '#'}
            target="_blank"
            rel="noopener"
            className="text-sm text-violet-700 hover:text-violet-400 transition-colors inline-flex items-center gap-1 dark:text-violet-400"
          ><Message id="core:open_in_new_tab_e0af5c0b" /><ArrowRightIcon className="w-4 h-4" />
          </a>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
