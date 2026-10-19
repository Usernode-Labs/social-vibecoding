import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { GroupedList } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { useMessages } from '../../../lib/i18n/react';
import {
  EDITOR_ACTIONS, EDITOR_NOTE, ROW_ACTION, ROW_EDITOR, SignInRow,
} from './sign-in-row';

/**
 * Username, the first of the Account page's sign-in rows (#5281,
 * ./sign-in-row.tsx). It reads "Username, @handle" with a Change link, and
 * the change form (POST /api/me/username) opens under it.
 *
 * It lives HERE and not in the profile edit sheet, next to Password,
 * because it is a credential-gated account action: the handle is the
 * sign-in identifier, so moving it on a borrowed session must not be free.
 * An account with a password confirms with it (#cu-password-row). An account
 * with none, which signs in with an emailed code, confirms with a code sent
 * to its verified address instead (#cu-code-row, POST
 * /api/me/username/code). settings.js shows the one that fits from
 * /api/auth/me's hasPassword; the server decides which it accepts, from the
 * account and never from the request.
 *
 * Static like every other section under ./sections — no state, no props, no
 * effects. ../settings.js binds these controls by id ONCE in init(); a
 * re-rendered pane is a pane whose listeners silently stopped firing.
 *
 * The two costs of a rename are spelled out in the copy rather than left for
 * the user to discover: the old handle is retired permanently (it does not
 * return to the pool, so nobody can inherit their @mentions or profile
 * links), and there is a cooldown before the next change. Both are enforced
 * server-side in src/services/usernames.js — this is disclosure, not
 * validation.
 */
export function UsernameSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="username" className="hidden">
      <div id="change-username-section">
        <SectionHeading title={t('settings:signIn.title')} />
        <GroupedList className="mx-0">
          <SignInRow
            title={t('settings:username.title')}
            // Filled by Settings._renderChangeUsernameSection() from the
            // session user.
            value={<span id="cu-current">—</span>}
            action={(
              <button id="cu-edit" type="button" className={ROW_ACTION} aria-expanded="false" aria-controls="cu-form">
                {t('settings:account.change')}
              </button>
            )}
          />
          <div id="cu-form" className={`${ROW_EDITOR} hidden`}>
            <Input
              id="cu-new"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t('settings:username.newPlaceholder')}
            />
            <div id="cu-password-row">
              <PasswordInput
                id="cu-password"
                autoComplete="current-password"
                placeholder={t('settings:username.passwordPlaceholder')}
              />
            </div>
            {/* An account with no password: a code to its verified email. */}
            <div id="cu-code-row" className="hidden space-y-2">
              <p className={EDITOR_NOTE}>{t('settings:username.codePrompt')}</p>
              <div className="flex gap-2">
                <Input
                  id="cu-code"
                  width="flex"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder={t('settings:username.codePlaceholder')}
                />
                <Button id="cu-send-code" type="button" variant="pillNeutral" size="pill" ink="neutral" className="shrink-0">
                  {t('settings:username.sendCode')}
                </Button>
              </div>
            </div>
            <div className={EDITOR_ACTIONS}>
              <Button id="cu-save" type="button" variant="pillAccent" size="pill">
                {t('settings:username.submit')}
              </Button>
              <Button id="cu-cancel" type="button" variant="pillNeutral" size="pill" ink="neutral">
                {t('core:common.cancel')}
              </Button>
            </div>
            <p className={EDITOR_NOTE}>
              {t('settings:username.rules')}
            </p>
            <StatusLine id="cu-status" />
          </div>
        </GroupedList>
      </div>
    </div>
  );
}
