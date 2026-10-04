import { useTranslation } from 'react-i18next';
import { i18n } from './runtime';

/** Subscribe only the React owner rendering text; Shell itself stays static. */
export function useMessages(namespace = 'core') {
  return useTranslation(namespace, { i18n }).t;
}

export function Message({ id, values }: { id: string; values?: Record<string, string | number> }) {
  const t = useMessages(id.includes(':') ? id.split(':')[0] : 'core');
  return <>{t(id, values)}</>;
}
