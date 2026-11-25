/**
 * The look picker in the frame's bar: an admin's way to switch the device's
 * look from under a look (./frame-app.tsx), so a look can always be left the
 * way it was entered. Under the standard header, Settings > Experimental >
 * Look is where a look is chosen.
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
 * dark, whoever changed it.
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
import { LOOK_CHOICES, useLiveSkin, type Skin } from '../../lib/skin';

// Whole literals, so the catalog inventory can see each id asked for.
const NAME_OF: Record<string, string> = {
  standard: 'settings:experimental.look.standard',
  brand: 'settings:experimental.look.brand',
};

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
  /** 'frame': in the kit's bar, under a look. */
  variant: 'frame';
  skin: Skin;
  onPick: (next: Skin) => void;
  /** The screen is dark now; with `onDark`, the toggle beside the look. */
  dark?: boolean;
  onDark?: () => void;
}) {
  const t = useMessages('settings');
  const label = t('settings:experimental.look.label');
  const darkName = t('settings:theme.mode.dark');
  // A look this menu does not offer reads as Standard here.
  const value: Skin = LOOK_CHOICES.includes(skin) ? skin : 'standard';
  const pick = (choice: string) => {
    onPick((LOOK_CHOICES as readonly string[]).includes(choice) ? choice as Skin : 'standard');
  };
  // Under a look, a phone's bar has room for one such disc beside the
  // title (the two left it about 85px): the pair is the desktop's, and a
  // phone gets one button whose small menu holds both (fr-d and fr-p are
  // the kit's own "desktop only" and "phone only").
  const fold = !!onDark;
  return (
    <>
    <label className={fold ? 'fr-ib fr-look fr-d' : 'fr-ib fr-look'} title={label} data-look-picker={variant}>
      <Icon name="layers" size={20} />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => pick(event.target.value)}
      >
        {LOOK_CHOICES.map((choice) => <option key={choice} value={choice}>{t(NAME_OF[choice])}</option>)}
      </select>
    </label>
    {onDark ? (
      <button type="button" className="fr-ib fr-d" aria-pressed={!!dark} aria-label={darkName} title={darkName} data-look-theme={variant} onClick={onDark}>
        <Icon name={dark ? 'sun' : 'moon'} size={20} />
      </button>
    ) : null}
    {fold ? <LookFold value={value} onPick={pick} dark={!!dark} onDark={onDark!} /> : null}
    </>
  );
}

/** A phone's one control for both: a disc, and under it a small menu with Look and Theme. */
function LookFold({ value, onPick, dark, onDark }: { value: Skin; onPick: (choice: string) => void; dark: boolean; onDark: () => void }) {
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
            <span className="fr-v">{t(NAME_OF[value] || NAME_OF.standard)}</span>
            <select aria-label={t('settings:experimental.look.label')} value={value} onChange={(event) => { setOpen(false); onPick(event.target.value); }}>
              {LOOK_CHOICES.map((choice) => <option key={choice} value={choice}>{t(NAME_OF[choice])}</option>)}
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

export function LookPicker({ variant }: { variant: 'frame' }) {
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
      onDark={() => { window.Theme?.set?.(dark ? 'light' : 'dark'); }}
    />
  );
}
