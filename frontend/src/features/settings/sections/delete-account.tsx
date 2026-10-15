import { SectionHeading } from '@/components/ui/field';
import { DeleteAccount } from '../delete-account';
import { useMessages } from '../../../lib/i18n/react';

export function DeleteAccountSection() {
  const t = useMessages('settings');
  // The Settings router owns only this static wrapper's visibility. The
  // confirmation form beneath it is entirely React-owned.
  return (
    <div data-settings-section="delete-account" className="hidden">
      <SectionHeading title={t('settings:deleteAccount.title')}>
        {t('settings:deleteAccount.intro')}
      </SectionHeading>
      <DeleteAccount />
    </div>
  );
}
