/**
 * Settings › Privacy: what both of its blocks share (./privacy.tsx and
 * ./usage-analytics.tsx), #5926.
 */

import type { ChangeEventHandler } from 'react';

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
  describedBy?: string;
}

/**
 * A switch with its label and, after the label, a small "On" or "Off", so
 * colour is not the only sign of its state. The word is hidden from screen
 * readers: role="switch" already makes them say on or off.
 */
export function PrivacySwitch({ id, label, checked, disabled, onChange, describedBy }: PrivacySwitchProps) {
  const t = useMessages('settings');
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <Switch
        id={id}
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <span className="text-sm text-zinc-800 dark:text-zinc-200">
        {label}
        <span aria-hidden="true" className="ml-2 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
          {t(checked ? 'settings:privacy.state.on' : 'settings:privacy.state.off')}
        </span>
      </span>
    </label>
  );
}
