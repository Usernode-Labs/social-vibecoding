/**
 * A six-digit code as six boxes (#5989), one per digit, over ONE real field.
 *
 * The sign-in sheet's email code drew its code this way first (#5253): six
 * cards under an invisible <input> that still carries every one-time-code
 * attribute (./shared.ts ONE_TIME_CODE_FIELD), so the keyboard's code
 * suggestion, Messages' and Mail's autofill and a paste all land in one
 * field and fill every box, while a reader sees one labelled field rather
 * than six. #5989 asks for the same on every digit code of the sign-in and
 * sign-up flows, so the pattern lives here and the sheet's phone code, the
 * first run's Add a phone code and the sign-in screen's email code draw it.
 *
 * The field stays UNCONTROLLED on purpose: every caller reads the code off
 * its ref (`codeField.current.value`) and clears it the same way, so the
 * real field keeps being the thing they hold. The boxes only mirror it:
 * `onInput` normalises what was typed or pasted to its digits (a pasted
 * "583 914" or "Code: 583914" fills all six), writes them back into the
 * field and redraws the boxes, and the box the next digit goes into is
 * ringed while the field has focus. A caller that clears the field through
 * its ref tells the boxes with `clearKey`: a new key resets what they show.
 */

import { type RefObject, useEffect, useState } from 'react';

import { ONE_TIME_CODE_FIELD } from './shared';

/** The code's length (routes/auth.js sends six digits). */
export const CODE_LENGTH = 6;

/** What is typed or pasted into the code, as the six digits it can be: a pasted "583 914" or "Code: 583914" fills all six. */
export function codeDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

// The six boxes: white cards with the sheets' hairline, the one the next
// digit goes into ringed in the accent while the field has focus.
export const CODE_BOX = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100';
export const CODE_BOX_NEXT = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 ring-2 ring-violet-600 dark:bg-zinc-900 dark:ring-violet-400 dark:text-zinc-100';
/** The real field, laid over the boxes and invisible: it is what the keyboard and autofill write to. */
export const CODE_FIELD_OVER_BOXES = 'absolute inset-0 h-full w-full border-0 bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent';

export type CodeBoxesProps = {
  /** The real field's id: what the label's `htmlFor` and every check name. */
  id: string;
  /** The caller's ref to the real field; it reads the code off it. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** The field's label, for readers only: the boxes say nothing to them. */
  label: string;
  /** Said after each change, with the digits the field now holds. */
  onDigits?: (digits: string) => void;
  /** Bump it when the caller cleared the field through its ref, so the boxes empty too. */
  clearKey?: number | string;
  /** The `data-*` attribute each box carries, for checks and tests; `data-code-box` by default. */
  boxAttr?: string;
  className?: string;
};

export function CodeBoxes({ id, inputRef, label, onDigits, clearKey, boxAttr = 'data-code-box', className }: CodeBoxesProps) {
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  // The caller cleared the real field (a new code was sent, the step was
  // left): what the boxes show follows it.
  useEffect(() => { setCode(inputRef.current?.value ? codeDigits(inputRef.current.value) : ''); }, [clearKey, inputRef]);
  const next = Math.min(code.length, CODE_LENGTH - 1);
  return (
    <div className={className ? `relative ${className}` : 'relative'}>
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <span key={i} {...{ [boxAttr]: i }} className={focused && i === next ? CODE_BOX_NEXT : CODE_BOX}>{code[i] || ''}</span>
        ))}
      </div>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        ref={inputRef}
        id={id}
        {...ONE_TIME_CODE_FIELD}
        enterKeyHint="go"
        maxLength={6}
        onInput={(e) => {
          const el = e.currentTarget;
          const digits = codeDigits(el.value);
          if (el.value !== digits) el.value = digits;
          setCode(digits);
          onDigits?.(digits);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={CODE_FIELD_OVER_BOXES}
      />
    </div>
  );
}
