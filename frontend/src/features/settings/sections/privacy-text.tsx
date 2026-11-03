/**
 * Settings › Privacy: what its blocks share (./privacy.tsx,
 * ./contact-preferences.tsx and ./usage-analytics.tsx), #5926.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type ReactNode } from 'react';

import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../../lib/i18n/react';

/**
 * The small text under a choice or a switch: 13px at the default text size,
 * in rem so the Accessibility text size scales it, and zinc-400 in the dark
 * theme, which clears 4.5:1 on the dark card where zinc-500 did not. Lines
 * stop at about 65 characters.
 */
export const HELP = 'text-[0.8125rem] leading-relaxed max-w-[65ch] text-zinc-500 dark:text-zinc-400';

export interface PrivacySwitchProps {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  /** The id of the description, which is what describes the switch. */
  describedBy?: string;
  /** The small text under the label. Inside the label, so it toggles too. */
  description?: ReactNode;
}

/**
 * A switch with its label and, after the label, a small "On" or "Off", so
 * colour is not the only sign of its state. The word is hidden from screen
 * readers: role="switch" already makes them say on or off.
 *
 * The whole row is the label, so pressing the description toggles the switch
 * as well (#5926). It is spans because a label holds no paragraphs. aria-label
 * keeps the switch's name to the label's words: the description, inside the
 * <label>, would otherwise be read as its name and again as its description.
 * pt-1 sets the first line level with the taller switch.
 */
export function PrivacySwitch({ id, label, checked, disabled, onChange, describedBy, description }: PrivacySwitchProps) {
  const t = useMessages('settings');
  return (
    <label className="flex items-start gap-2 cursor-pointer select-none">
      <Switch
        id={id}
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <span className="min-w-0 pt-1">
        <span className="block text-sm text-zinc-800 dark:text-zinc-200">
          {label}
          <span aria-hidden="true" className="ms-2 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
            {t(checked ? 'settings:privacy.state.on' : 'settings:privacy.state.off')}
          </span>
        </span>
        {description ? <span id={describedBy} className={`block ${HELP} mt-1 space-y-1`}>{description}</span> : null}
      </span>
    </label>
  );
}

const SAVED_MS = 3000;

/**
 * "Saved" for about three seconds after a save worked. `clear` goes at the
 * start of the next save, so a second "Saved" is a change a screen reader
 * says again. A save that finishes after the page has gone starts no timer.
 */
export function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const clear = useCallback(() => { stop(); setSaved(false); }, [stop]);
  const flash = useCallback(() => {
    if (!mounted.current) return;
    stop();
    setSaved(true);
    timer.current = setTimeout(() => { timer.current = null; setSaved(false); }, SAVED_MS);
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);

  return { saved, flash, clear };
}

/**
 * The line that says a save worked, or, where a block has no alert of its own,
 * what went wrong. It is always there and only its words come and go: a screen
 * reader announces a change inside a status region it already knows about, and
 * can miss one that arrives with its words. Empty, it takes no room.
 */
export function SaveStatus({ id, saved, error = '' }: { id?: string; saved: boolean; error?: string }) {
  const t = useMessages('settings');
  let className: string | undefined;
  if (error) className = 'text-xs mt-3 text-red-700 dark:text-red-400';
  else if (saved) className = `${HELP} mt-3`;
  return <p id={id} role="status" className={className}>{error || (saved ? t('settings:privacy.saved') : null)}</p>;
}
