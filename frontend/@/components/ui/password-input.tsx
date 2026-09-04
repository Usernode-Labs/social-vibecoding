import * as React from 'react';

import { cn } from '@/lib/utils';
import { Input, type InputProps } from '@/components/ui/input';
import { EyeIcon, EyeOffIcon } from '@/components/ui/icons';

/**
 * A password field with a show/hide toggle (#1606).
 *
 * The reported problem was the plain one: "there is no way to make passwords
 * visible when typing them." On a phone keyboard a long password typed blind
 * is a guess, and the only feedback the screens gave was a failed sign-in.
 *
 * ── Why this is a component and not a prop on Input ────────────────────
 *
 * The toggle needs a wrapper element to position against, and `Input` renders
 * exactly one `<input>` — every call site that passes `width="flex"` or drops
 * it into a `flex` row is relying on that. Wrapping inside `Input` would move
 * the box for all forty of its call sites; wrapping here moves it for the
 * thirteen fields that hold a password.
 *
 * ── Why the state lives HERE ───────────────────────────────────────────
 *
 * The platform rule is that a region may become stateful only when its whole
 * subtree is React-owned. The settings sections are not: `settings.js` clears
 * `#cp-current`/`#cp-new`/`#cp-confirm` by id, toggles `.hidden` on
 * `#cp-current-row`, and writes `#cp-status` by hand. Keeping the state in
 * this component makes the stateful region the wrapper `<div>` — whose entire
 * subtree is the input and the button, both rendered here — so a toggle
 * re-renders nothing any other module writes to.
 *
 * The field stays UNCONTROLLED for the same reason: React never sets `value`,
 * so `el.value = ''` from `settings.js` and `ref.current.value` from the auth
 * screens keep working exactly as before. Flipping the `type` attribute
 * preserves what is typed.
 *
 * ── What the call site keeps ───────────────────────────────────────────
 *
 * The `ref` still reaches the `<input>`, the `id` still lands on it, and every
 * `Input` variant (`box`, `hint`, `ring`, …) is forwarded, so the field box is
 * the same one the screen had. The only rendered difference is the wrapper,
 * the right padding the glyph needs, and the button itself.
 *
 * Every class name is a COMPLETE literal — Tailwind's extractor is a regex
 * over source text (tests/tailwind-build.test.js).
 */
export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /**
   * Classes for the positioning wrapper rather than the field. Where a field
   * carried its own width in a flex row, that width belongs to the wrapper —
   * the box the row now lays out — and the field inside it goes full width.
   */
  wrapperClassName?: string;
}

const TOGGLE =
  'absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200';

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, wrapperClassName, ...props }, ref) => {
    const [shown, setShown] = React.useState(false);
    return (
      <div className={cn('relative', wrapperClassName)}>
        <Input
          ref={ref}
          {...props}
          type={shown ? 'text' : 'password'}
          className={cn(className, 'pr-11')}
        />
        {/*
            `type="button"` is load-bearing: four of these fields sit inside a
            <form> whose submit is the sign-in itself, and a bare <button>
            would submit it.
        */}
        <button
          type="button"
          className={TOGGLE}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          title={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown((on) => !on)}
        >
          {shown
            ? <EyeOffIcon className="w-5 h-5" aria-hidden="true" />
            : <EyeIcon className="w-5 h-5" aria-hidden="true" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
