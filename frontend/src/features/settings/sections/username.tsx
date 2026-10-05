import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';

/**
 * Change username — POST /api/me/username.
 *
 * It lives HERE and not in the profile edit sheet, next to Change password,
 * because it is a credential-gated account action: the endpoint requires the
 * current password (the handle is the sign-in identifier, so moving it on a
 * borrowed session must not be free). The profile sheet's read-only handle
 * row now links here instead of saying the name can never change.
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
  return (
    <div data-settings-section="username" className="hidden">
      <div id="change-username-section">
        <Localized element={<SectionHeading title={catalogText("settings:username_e3b89e9d")}><Message id="settings:your_handle_is_how_you_sign_in_and_the_address_o_72596fbe" /></SectionHeading>} messages={{"title":"settings:username_e3b89e9d"}} />

        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          {/* Filled by Settings._syncUsername() from the session user. */}
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex items-center gap-2 text-[17px]">
            <span className="text-zinc-500 dark:text-zinc-400"><Message id="settings:current_e0d1b682" /></span>
            <span id="cu-current" className="ml-auto font-medium text-zinc-900 dark:text-zinc-100">—</span>
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Localized element={<Input
              id="cu-new"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false} placeholder={catalogText("settings:new_username_0e2b4ad7")}
              box="card"
              ring="bare"
              hint="dim"
            />} messages={{"placeholder":"settings:new_username_0e2b4ad7"}} />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Localized element={<PasswordInput
              id="cu-password"
              autoComplete="current-password" placeholder={catalogText("settings:current_password_72ed2bd7")}
              box="card"
              ring="bare"
              hint="dim"
            />} messages={{"placeholder":"settings:current_password_72ed2bd7"}} />
          </div>
        </div>

        <Button id="cu-save" layout="stacked" variant="pillAccent" size="pillLg" className="mt-3"><Message id="settings:change_username_5912b563" /></Button>

        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3"><Message id="settings:letters_numbers_and_underscores_3_32_characters__1534a76f" /></p>

        <StatusLine id="cu-status" />
      </div>
    </div>
  );
}
