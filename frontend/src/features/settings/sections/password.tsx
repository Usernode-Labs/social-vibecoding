import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';

import { pressButton, returnKeyHandler } from '../../../lib/return-to-next';

/**
 * Change password (issue #282). Default form calls POST /api/me/password
 * (current password required). In the Homeroom native app with a linked
 * wallet, a "Don't have a password? Create one" link switches to the
 * wallet-backed creation mode (cp-wallet-mode shown, current password hidden),
 * which signs a wallet-check challenge and calls POST
 * /api/me/wallet-change-password. settings.js wires the mode switch and both
 * submit paths.
 *
 * Return walks the fields (#3907: the iOS app has no keyboard chevrons any
 * more): current, new, confirm, and Return in confirm presses whichever of
 * the two submits is showing, so it takes the same path a tap does. In
 * wallet mode the current-password row is hidden and simply skipped.
 */
function submitShown(): void {
  if (!pressButton(document.getElementById('cp-save'))) pressButton(document.getElementById('cp-wallet-save'));
}

export function PasswordSection() {
  return (
    <div data-settings-section="password" className="hidden">
      <div id="change-password-section" onKeyDown={returnKeyHandler({ submit: submitShown })}>
        <Localized element={<SectionHeading title={catalogText("settings:change_password_3f9c991f")}><Message id="settings:set_a_new_password_for_web_login_if_an_admin_gav_58cc01f8" /></SectionHeading>} messages={{"title":"settings:change_password_3f9c991f"}} />
        {/* One card, the three fields as its rows. */}
        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div id="cp-current-row" className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Localized element={<PasswordInput
              id="cp-current"
              autoComplete="current-password"
              enterKeyHint="next"
              placeholder={catalogText("settings:current_password_72ed2bd7")}
              box="card"
              ring="bare"
              hint="dim"
            />} messages={{"placeholder":"settings:current_password_72ed2bd7"}} />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Localized element={<PasswordInput
              id="cp-new"
              autoComplete="new-password"
              enterKeyHint="next"
              placeholder={catalogText("settings:new_password_at_least_8_characters_b4ae3c2a")}
              box="card"
              ring="bare"
              hint="dim"
            />} messages={{"placeholder":"settings:new_password_at_least_8_characters_b4ae3c2a"}} />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Localized element={<PasswordInput
              id="cp-confirm"
              autoComplete="new-password"
              enterKeyHint="done"
              placeholder={catalogText("settings:confirm_new_password_bf000421")}
              box="card"
              ring="bare"
              hint="dim"
            />} messages={{"placeholder":"settings:confirm_new_password_bf000421"}} />
          </div>
        </div>
        {/* Default (password) submit */}
        <Button id="cp-save" layout="stacked" variant="pillAccent" size="pillLg" className="mt-3"><Message id="settings:change_password_3f9c991f" /></Button>
        {/* Wallet (signature) submit — shown only in wallet mode */}
        <Button id="cp-wallet-save" layout="hiddenStacked" variant="pillAccent" size="pillLg"><Message id="settings:sign_change_password_a94ed048" /></Button>
        {/*
            Mode switches. cp-wallet-mode is itself hidden unless the user
            is in the native app with a linked wallet (settings.js).
        */}
        <p id="cp-wallet-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-wallet" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400"><Message id="settings:don_t_have_a_password_create_one_d4a22819" /></a>
        </p>
        <p id="cp-password-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-password" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400"><Message id="settings:use_current_password_instead_c852abcb" /></a>
        </p>
        <StatusLine id="cp-status" />
      </div>
    </div>
  );
}
