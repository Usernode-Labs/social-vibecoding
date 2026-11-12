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
 * BESIDE IT, ONE PRESS FLIPS LIGHT AND DARK: a look is judged in both. It
 * is the theme's own switch (window.Theme, as Settings > Theme sets it),
 * and shows the moon while the screen is light and the sun while it is
 * dark, whoever changed it. In the platform's header that switch is
 * everyone's (../header/theme-toggle.tsx), drawn after the picker, so the
 * shell variant leaves its own out.
 *
 * REAL ADMINS ONLY, as the Settings menu is (App._realIsAdmin, the answer
 * "view as a member" does not mask). Never on the first render: the
 * prerendered document knows no viewer, so the control arrives after the
 * shell has one.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

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

// One listener on window.Theme for every picker mounted (the head module
// keeps what it is handed for the page's life).
const themeReaders = new Set<() => void>();
let themeHeard = false;
function subscribeTheme(onChange: () => void): () => void {
  themeReaders.add(onChange);
  if (!themeHeard && typeof window !== 'undefined') {
    themeHeard = true;
    window.Theme?.onChange?.(() => { for (const reader of [...themeReaders]) reader(); });
  }
  return () => { themeReaders.delete(onChange); };
}
/** What is on screen now: with the theme on "System" that is the device's own. */
const isDark = () => document.documentElement.classList.contains('dark');

export function LookPickerView({ variant, skin, onPick, dark, onDark }: {
  /** 'frame': in the kit's bar, under a look. 'shell': in the platform's header. */
  variant: 'frame' | 'shell';
  skin: Skin;
  onPick: (next: Skin) => void;
  /** The screen is dark now; with `onDark`, the toggle beside the look. */
  dark?: boolean;
  onDark?: () => void;
}) {
  const t = useMessages('settings');
  const label = t('settings:experimental.look.label');
  const darkName = t('settings:theme.mode.dark');
  // New look ("brand") is not one of this menu's; it reads as Standard here.
  const value = skin === 'standard' || isFrameSkin(skin) ? skin : 'standard';
  return (
    <>
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
    {onDark ? (
      <button type="button" className={variant === 'frame' ? 'fr-ib' : SHELL} aria-pressed={!!dark} aria-label={darkName} title={darkName} data-look-theme={variant} onClick={onDark}>
        <Icon name={dark ? 'sun' : 'moon'} size={20} />
      </button>
    ) : null}
    </>
  );
}

export function LookPicker({ variant }: { variant: 'frame' | 'shell' }) {
  const skin = useLiveSkin();
  const [admin, setAdmin] = useState(false);
  useEffect(() => whenPlatformViewer(() => setAdmin((window as any).App?._realIsAdmin === true)), []);
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);
  if (!admin) return null;
  return (
    <LookPickerView
      variant={variant}
      skin={skin}
      onPick={(next) => {
        window.Skin?.set?.(next);
        // Another look is another chrome of another height: the browser keeps
        // what was on screen in place, which leaves a phone's page scrolled
        // under the new bar. A look opens at the page's top, as a page does.
        try { window.scrollTo(0, 0); } catch { /* no window to scroll */ }
      }}
      dark={dark}
      // The platform's header draws a switch of its own for everyone
      // (../header/theme-toggle.tsx, #6459), so the shell's picker leaves it out.
      onDark={variant === 'frame' ? () => { window.Theme?.set?.(dark ? 'light' : 'dark'); } : undefined}
    />
  );
}
