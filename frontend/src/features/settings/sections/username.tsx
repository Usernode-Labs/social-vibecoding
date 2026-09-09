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
        <SectionHeading title="Username">
          Your @handle is how you sign in and the address of your public builder page.
        </SectionHeading>

        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          {/* Filled by Settings._syncUsername() from the session user. */}
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex items-center gap-2 text-[17px]">
            <span className="text-zinc-500 dark:text-zinc-400">Current</span>
            <span id="cu-current" className="ml-auto font-medium text-zinc-900 dark:text-zinc-100">—</span>
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <Input
              id="cu-new"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="New username"
              box="card"
              ring="bare"
              hint="dim"
            />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <PasswordInput
              id="cu-password"
              autoComplete="current-password"
              placeholder="Current password"
              box="card"
              ring="bare"
              hint="dim"
            />
          </div>
        </div>

        <Button id="cu-save" layout="stacked" variant="pillAccent" size="pillLg" className="mt-3">
          Change username
        </Button>

        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
          Letters, numbers and underscores, 3–32 characters, so people can still
          @mention you. Your old handle is kept reserved for you rather than
          released, so links and mentions that used it keep pointing at you and
          nobody else can take it. You can change your username again after 30 days.
        </p>

        <StatusLine id="cu-status" />
      </div>
    </div>
  );
}
