import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';

/**
 * A shortcut to the same persisted choice Settings → Theme owns. The glyph
 * is where a press goes, as the look picker's switch draws it: the moon
 * while the screen is light, the sun while it is dark, whoever changed it.
 * It stops listening to window.Theme when it unmounts.
 */
export function HeaderThemeToggle() {
  const t = useMessages('core');
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains('dark'));
    sync();
    const stop = window.Theme?.onChange?.(sync);
    return () => { if (typeof stop === 'function') stop(); };
  }, []);
  return (
    <button
      type="button" data-header-theme="" aria-label={t('core:header.darkMode')} aria-pressed={dark}
      title={dark ? t('core:header.themeLight') : t('core:header.themeDark')}
      className="relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)] transition-colors hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)]"
      onClick={() => window.Theme?.set?.(document.documentElement.classList.contains('dark') ? 'light' : 'dark')}
    >
      {dark ? <SunIcon className="w-5 h-5" aria-hidden="true" /> : <MoonIcon className="w-5 h-5" aria-hidden="true" />}
    </button>
  );
}
