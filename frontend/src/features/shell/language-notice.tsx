import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import {
  dismissNotice, getNotice, i18n, subscribeNotice, switchToEnglish,
} from '../../lib/i18n/runtime';

type ShellUI = { toastClearance?: () => number };

/**
 * `#language-notice` — "Showing Homeroom in Español · Switch to English".
 *
 * Shown once per device, the first time the language was picked from the
 * device rather than chosen (lib/i18n/core.ts decides when). It is the way
 * back for a person the automatic choice was wrong for, so there is no
 * language picker on the sign-in screen.
 *
 * The sentence is in the language now showing. The button is always English:
 * someone who cannot read the picked language still has to find it.
 *
 * It rests where a toast does, fixed above the tab bar (app.css), and stays
 * until it is answered. PlatformUI.toastClearance() is the measurement a toast
 * uses for a composer pinned above the bar; it is taken again when the screen
 * or the window changes.
 *
 * A wholly React-owned island that renders nothing until there is a notice,
 * which is also what the prerendered document and the hydrating render hold.
 * While only English ships there never is one.
 */
export function LanguageNotice() {
  const notice = useSyncExternalStore(subscribeNotice, getNotice, () => null);
  const t = useMessages();
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!notice) return undefined;
    const measure = () => {
      const ui = (window as unknown as { PlatformUI?: ShellUI }).PlatformUI;
      setInset(ui?.toastClearance?.() || 0);
    };
    measure();
    window.addEventListener('hashchange', measure);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('hashchange', measure);
      window.removeEventListener('resize', measure);
    };
  }, [notice]);

  if (!notice) return null;

  return (
    <div
      id="language-notice"
      role="status"
      style={inset > 0 ? { '--language-notice-inset': `${inset}px` } as CSSProperties : undefined}
      className="flex items-center gap-2 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 py-1.5 pl-4 pr-1.5 text-xs text-zinc-700 dark:text-zinc-300 shadow-lg"
    >
      <span className="min-w-0">{t('language.notice.showing', { language: notice.name })}</span>
      <Button
        id="language-notice-english"
        type="button"
        lang="en"
        layout="shrink"
        variant="default"
        size="xsText"
        ink="solid"
        className="inline-flex items-center h-7 un-touch-target"
        // A failed save leaves the language and this notice as they were.
        onClick={() => { void switchToEnglish().catch(() => {}); }}
      >
        {i18n.getFixedT('en', 'core')('language.notice.switchToEnglish')}
      </Button>
      <button
        id="language-notice-dismiss"
        type="button"
        onClick={dismissNotice}
        aria-label={t('language.notice.dismiss')}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
      >
        <XIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
