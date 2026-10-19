import { Button } from '@/components/ui/button';
import { StatusLine } from '@/components/ui/field';
import { GroupedList } from '@/components/ui/grouped-list';
import { PasswordInput } from '@/components/ui/password-input';
import { useMessages } from '../../../lib/i18n/react';
import {
  EDITOR_ACTIONS, EDITOR_NOTE, EDITOR_TITLE, ROW_ACTION, ROW_EDITOR, SignInRow,
} from './sign-in-row';

import { pressButton, returnKeyHandler } from '../../../lib/return-to-next';

/**
 * Change password (issue #282). Default form calls POST /api/me/password
 * (current password required, except for an account with none yet, #4595:
 * settings.js hides that row when /api/auth/me says hasPassword is false,
 * and shows "Add a password" over the section and on its button, #4891). In the Homeroom native app with a linked
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
  const t = useMessages('settings');
  return (
    <div data-settings-section="password" className="hidden">
      <div id="change-password-section" onKeyDown={returnKeyHandler({ submit: submitShown })}>
        {/*
            #5281: the last of the Account page's sign-in rows
            (./sign-in-row.tsx). "Password, Set" with Change, or, for an
            account with none, "Not set" with Add; the form opens under it.
            Each wording is rendered once and settings.js shows the one that
            fits (`_setChangePasswordMode`), as it does the current-password
            row, so this stays a static render.
        */}
        <GroupedList className="mx-0">
          <SignInRow
            title={t('settings:password.rowTitle')}
            value={(
              <>
                <span id="cp-state-set">{t('settings:password.stateSet')}</span>
                <span id="cp-state-unset" className="hidden">{t('settings:password.stateNotSet')}</span>
              </>
            )}
            action={(
              <button id="cp-edit" type="button" className={ROW_ACTION} aria-expanded="false" aria-controls="cp-form">
                <span id="cp-edit-change">{t('settings:account.change')}</span>
                <span id="cp-edit-add" className="hidden">{t('settings:account.add')}</span>
              </button>
            )}
          />
          <div id="cp-form" className={`${ROW_EDITOR} hidden`}>
            {/*
                #4891: an account with no password (it signs in with an
                emailed code) is offered "Add a password", the words the
                sign-up step sends it here with.
            */}
            <h4 className={EDITOR_TITLE}>
              <span id="cp-title-change">{t('settings:password.title')}</span><span id="cp-title-add" className="hidden">{t('settings:password.titleAdd')}</span>
            </h4>
            <p className={EDITOR_NOTE}>{t('settings:password.intro')}</p>
            <div id="cp-current-row">
              <PasswordInput
                id="cp-current"
                autoComplete="current-password"
                enterKeyHint="next"
                placeholder={t('settings:password.currentPlaceholder')}
              />
            </div>
            <PasswordInput
              id="cp-new"
              autoComplete="new-password"
              enterKeyHint="next"
              placeholder={t('settings:password.newPlaceholder')}
            />
            <PasswordInput
              id="cp-confirm"
              autoComplete="new-password"
              enterKeyHint="done"
              placeholder={t('settings:password.confirmPlaceholder')}
            />
            <div className={EDITOR_ACTIONS}>
              {/* Default (password) submit */}
              <Button id="cp-save" type="button" variant="pillAccent" size="pill">
                <span id="cp-save-change">{t('settings:password.submit')}</span><span id="cp-save-add" className="hidden">{t('settings:password.submitAdd')}</span>
              </Button>
              {/* Wallet (signature) submit — shown only in wallet mode */}
              <Button id="cp-wallet-save" type="button" layout="hidden" variant="pillAccent" size="pill">
                {t('settings:password.submitWithWallet')}
              </Button>
              <Button id="cp-cancel" type="button" variant="pillNeutral" size="pill" ink="neutral">
                {t('core:common.cancel')}
              </Button>
            </div>
            {/*
                Mode switches. cp-wallet-mode is itself hidden unless the user
                is in the native app with a linked wallet (settings.js).
            */}
            <p id="cp-wallet-mode" className="hidden text-xs">
              <a id="cp-use-wallet" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400">
                {t('settings:password.useWallet')}
              </a>
            </p>
            <p id="cp-password-mode" className="hidden text-xs">
              <a id="cp-use-password" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400">
                {t('settings:password.usePassword')}
              </a>
            </p>
            <StatusLine id="cp-status" />
          </div>
        </GroupedList>
      </div>
    </div>
  );
}
