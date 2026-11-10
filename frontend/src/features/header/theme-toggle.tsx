import { useEffect, useState } from 'react';
import { SunIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';

/** A shortcut to the same persisted choice Settings → Theme owns. */
export function HeaderThemeToggle() {
  const t = useMessages('core');
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let mounted = true;
    const sync = () => { if (mounted) setDark(document.documentElement.classList.contains('dark')); };
    sync();
    window.Theme?.onChange?.(sync);
    return () => { mounted = false; };
  }, []);
  return (
    <button
      type="button" data-header-theme="" aria-label={t('core:header.darkMode')} aria-pressed={dark}
      title={dark ? t('core:header.themeLight') : t('core:header.themeDark')}
      className="relative w-7 h-7 flex items-center justify-center rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)] transition-colors hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)]"
      onClick={() => window.Theme?.set?.(document.documentElement.classList.contains('dark') ? 'light' : 'dark')}
    >
      <SunIcon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}
