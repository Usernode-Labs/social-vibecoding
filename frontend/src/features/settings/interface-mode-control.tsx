import { useCallback, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../lib/legacy-dom';
import { INTERFACE_MODE_KEY, readInterfaceMode, saveInterfaceMode, type InterfaceMode } from './interface-mode';

/** This subtree is owned entirely by React; settings.js never binds inside it. */
export function InterfaceModeControl() {
  const t = useMessages('settings');
  const [mode, setMode] = useState<InterfaceMode>('advanced');
  const [failed, setFailed] = useState(false);
  const sync = useCallback(() => {
    setMode(readInterfaceMode());
    setFailed(false);
  }, []);
  useIsomorphicLayoutEffect(sync, [sync]);
  useWindowEvent('storage', (event) => {
    if (event.key === INTERFACE_MODE_KEY || event.key === null) sync();
  });
  useWindowEvent('usernode:settings-section', sync);

  return (
    <div data-interface-mode={mode} className="mb-6 pb-6 border-b border-zinc-200 dark:border-zinc-800">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          checked={mode === 'advanced'}
          onChange={(event) => {
            const next = event.currentTarget.checked ? 'advanced' : 'basic';
            const saved = saveInterfaceMode(next);
            setFailed(!saved);
            if (saved) setMode(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:experimental.interfaceMode.label')}
        </span>
      </label>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed" aria-live="polite">
        {mode === 'advanced'
          ? t('settings:experimental.interfaceMode.advanced')
          : t('settings:experimental.interfaceMode.basic')}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:experimental.interfaceMode.device')}
      </p>
      {failed && <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-2">
        {t('settings:experimental.interfaceMode.saveFailed')}
      </p>}
    </div>
  );
}
