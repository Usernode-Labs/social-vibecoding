/**
 * The look picker beside the bell: an admin's way to switch the device's
 * look from any screen. It is drawn in the frame's bar under a look
 * (./frame-app.tsx) and in the platform's header under the standard one
 * (../header/platform-header.tsx), so a look can always be left the way it
 * was entered.
 *
 * It is the choice Settings > Experimental > Look makes, no second one:
 * window.Skin (frontend/src/head.html) keeps it on the device and every
 * island follows through lib/skin.ts. The control is the system's own
 * menu laid over a glyph, unseen: nothing to build, position or translate
 * twice, and it works by keyboard and on a phone as any menu does.
 *
 * REAL ADMINS ONLY, as the Settings menu is (App._realIsAdmin, the answer
 * "view as a member" does not mask). Never on the first render: the
 * prerendered document knows no viewer, so the control arrives after the
 * shell has one.
 */
import { useEffect, useState } from 'react';

import { Icon } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';
import { whenPlatformViewer } from '../../lib/platform-viewer';
import { FRAME_SKINS, isFrameSkin, useLiveSkin, type Skin } from '../../lib/skin';

// Whole literals, so the catalog inventory can see each id asked for.
const NAME: Record<'standard' | (typeof FRAME_SKINS)[number], string> = {
  standard: 'settings:experimental.look.standard',
  glass: 'settings:experimental.look.glass',
  brandkit: 'settings:experimental.look.brandkit',
  workbench: 'settings:experimental.look.workbench',
  paper: 'settings:experimental.look.paper',
  pastel: 'settings:experimental.look.pastel',
  mosaic: 'settings:experimental.look.mosaic',
  sunrise: 'settings:experimental.look.sunrise',
  today: 'settings:experimental.look.today',
  playground: 'settings:experimental.look.playground',
};
const CHOICES = ['standard', ...FRAME_SKINS] as const;

// The platform header's own disc, as its bell wears it (#2798: no fill at rest).
const SHELL = 'relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)] transition-colors hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)] cursor-pointer';

export function LookPickerView({ variant, skin, onPick }: {
  /** 'frame': in the kit's bar, under a look. 'shell': in the platform's header. */
  variant: 'frame' | 'shell';
  skin: Skin;
  onPick: (next: Skin) => void;
}) {
  const t = useMessages('settings');
  const label = t('settings:experimental.look.label');
  // New look ("brand") is not one of this menu's; it reads as Standard here.
  const value = skin === 'standard' || isFrameSkin(skin) ? skin : 'standard';
  return (
    <label className={variant === 'frame' ? 'fr-ib fr-look' : SHELL} title={label} data-look-picker={variant}>
      <Icon name="layers" size={20} />
      <select
        aria-label={label}
        className={variant === 'frame' ? undefined : 'absolute inset-0 h-full w-full cursor-pointer opacity-0'}
        value={value}
        onChange={(event) => onPick(event.target.value as Skin)}
      >
        {CHOICES.map((choice) => <option key={choice} value={choice}>{t(NAME[choice])}</option>)}
      </select>
    </label>
  );
}

export function LookPicker({ variant }: { variant: 'frame' | 'shell' }) {
  const skin = useLiveSkin();
  const [admin, setAdmin] = useState(false);
  useEffect(() => whenPlatformViewer(() => setAdmin((window as any).App?._realIsAdmin === true)), []);
  if (!admin) return null;
  return <LookPickerView variant={variant} skin={skin} onPick={(next) => { window.Skin?.set?.(next); }} />;
}
