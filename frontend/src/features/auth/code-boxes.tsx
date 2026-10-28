/**
 * Six boxes over one real one-time-code field: how every six-digit code in the
 * sign-in and sign-up flow is asked for (#5989). The sign-in sheet's emailed
 * code drew this markup first (#5253); it lives here now so the waitlist's
 * confirmation, the phone codes and the sign-up screen's emailed code show the
 * same thing.
 *
 * The boxes are one field, not six: the keyboard's suggestion from a text or
 * mail and a paste still fill all six in one go, and whatever looks for the
 * field by its id (dapp.json's checks, the e2e steps) finds it unchanged. The
 * real field sits transparent over the boxes, so the caret and the selection
 * are the browser's own.
 *
 * `digits` is what the screen holds and draws; `onDigits` hears every change,
 * already cleaned by `codeDigits`. A screen that clears its field from code
 * (`.value = ''` fires no input event) must clear its digits state too, or the
 * boxes keep showing the old ones.
 */

import { useState, type RefObject } from 'react';

import { ONE_TIME_CODE_FIELD } from './shared';

/** The code's length (routes/auth.js sends six digits). */
export const CODE_LENGTH = 6;

/** What is typed or pasted into the code, as the six digits it can be: a pasted "583 914" or "Code: 583914" fills all six. */
export function codeDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

// White cards with the sheets' hairline, the one the next digit goes into
// ringed in the accent while the field has focus.
const CODE_BOX = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100';
const CODE_BOX_NEXT = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 ring-2 ring-violet-600 dark:bg-zinc-900 dark:ring-violet-400 dark:text-zinc-100';
// The one real field, over the boxes: its text, caret and selection are the
// boxes' own, so none of them is drawn twice.
const FIELD = 'absolute inset-0 h-full w-full border-0 bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent';

export type CodeBoxesProps = {
  /** The real field's id, which every caller keeps: checks and tests select on it. */
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The digits to draw, cleaned by `codeDigits`. */
  digits: string;
  onDigits: (digits: string) => void;
  /** How much the field takes in, so a pasted "Code: 583 914" reaches `codeDigits` whole. */
  maxLength?: number;
};

export function CodeBoxes({ id, inputRef, digits, onDigits, maxLength = CODE_LENGTH }: CodeBoxesProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="relative">
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <span key={i} className={focused && i === Math.min(digits.length, CODE_LENGTH - 1) ? CODE_BOX_NEXT : CODE_BOX}>{digits[i] || ''}</span>
        ))}
      </div>
      <input
        ref={inputRef}
        id={id}
        {...ONE_TIME_CODE_FIELD}
        enterKeyHint="go"
        maxLength={maxLength}
        onInput={(e) => {
          const clean = codeDigits(e.currentTarget.value);
          if (e.currentTarget.value !== clean) e.currentTarget.value = clean;
          onDigits(clean);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={FIELD}
      />
    </div>
  );
}
