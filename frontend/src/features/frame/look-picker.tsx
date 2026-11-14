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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Icon } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';
import { whenPlatformViewer } from '../../lib/platform-viewer';
import { MENU_SKINS, useLiveSkin, type Skin } from '../../lib/skin';

// Whole literals, so the catalog inventory can see each id asked for.
const NAME: Record<'standard' | (typeof MENU_SKINS)[number], string> = {
  standard: 'settings:experimental.look.standard',
  brand: 'settings:experimental.look.brand',
  glass: 'settings:experimental.look.glass',
  paper: 'settings:experimental.look.paper',
  pastel: 'settings:experimental.look.pastel',
  mosaic: 'settings:experimental.look.mosaic',
  sunrise: 'settings:experimental.look.sunrise',
};
const CHOICES = ['standard', ...MENU_SKINS] as const;

// The platform header's own disc, as its bell wears it (#2798: no fill at rest).
const SHELL = 'relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)] transition-colors hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)] cursor-pointer';
// The look label carries no un-touch-target: its ::after hit box would paint
// over the select and take every press, so the select brings its own 44px
// square instead (#6648).
const SHELL_LOOK = 'relative w-7 h-7 flex items-center justify-center rounded-full border border-transparent text-[color:var(--brand-ink)] transition-colors hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)] cursor-pointer';

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
  // Every look is one of this menu's; anything else reads as Standard here.
  const value = (CHOICES as readonly string[]).includes(skin) ? skin : 'standard';
  // Under a look, a phone's bar has room for one such disc beside the
  // title (the two left it about 85px): the pair is the desktop's, and a
  // phone gets one button whose small menu holds both (fr-d and fr-p are
  // the kit's own "desktop only" and "phone only").
  const frame = variant === 'frame';
  const fold = frame && !!onDark;
  return (
    <>
    <label className={frame ? (fold ? 'fr-ib fr-look fr-d' : 'fr-ib fr-look') : SHELL_LOOK} title={label} data-look-picker={variant}>
      <Icon name="layers" size={20} />
      <select
        aria-label={label}
        className={frame ? undefined : 'absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer opacity-0'}
        value={value}
        onChange={(event) => onPick(event.target.value as Skin)}
      >
        {CHOICES.map((choice) => <option key={choice} value={choice}>{t(NAME[choice])}</option>)}
      </select>
    </label>
    {onDark ? (
      <button type="button" className={frame ? 'fr-ib fr-d' : SHELL} aria-pressed={!!dark} aria-label={darkName} title={darkName} data-look-theme={variant} onClick={onDark}>
        <Icon name={dark ? 'sun' : 'moon'} size={20} />
      </button>
    ) : null}
    {fold ? <LookFold value={value} onPick={onPick} dark={!!dark} onDark={onDark!} /> : null}
    </>
  );
}

/** A phone's one control for both: a disc, and under it a small menu with Look and Theme. */
function LookFold({ value, onPick, dark, onDark }: { value: Skin; onPick: (next: Skin) => void; dark: boolean; onDark: () => void }) {
  const t = useMessages('settings');
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement | null>(null);
  // A press anywhere else, or Escape, puts the menu away.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [open]);
  const name = t('settings:experimental.look.fold');
  return (
    <span ref={host} className="fr-lookfold fr-p" data-look-fold="">
      <button type="button" className="fr-ib" aria-haspopup="true" aria-expanded={open} aria-label={name} title={name} onClick={() => setOpen((on) => !on)}>
        <Icon name="layers" size={20} />
      </button>
      {open ? (
        <span className="fr-lookmenu" role="group" aria-label={name}>
          <label className="fr-lookrow" data-look-fold-look="">
            <span>{t('settings:experimental.look.label')}</span>
            <span className="fr-v">{t(NAME[value as keyof typeof NAME] || NAME.standard)}</span>
            <select aria-label={t('settings:experimental.look.label')} value={value} onChange={(event) => { setOpen(false); onPick(event.target.value as Skin); }}>
              {CHOICES.map((choice) => <option key={choice} value={choice}>{t(NAME[choice])}</option>)}
            </select>
          </label>
          <button type="button" className="fr-lookrow" aria-pressed={dark} data-look-fold-theme="" onClick={onDark}>
            <span>{t('settings:theme.title')}</span>
            <span className="fr-v">{dark ? t('settings:theme.mode.dark') : t('settings:theme.mode.light')}</span>
          </button>
        </span>
      ) : null}
    </span>
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
