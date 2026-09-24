import { SectionHeading } from '@/components/ui/field';
import { DeleteAccount } from '../delete-account';

export function DeleteAccountSection() {
  // The Settings router owns only this static wrapper's visibility. The
  // confirmation form beneath it is entirely React-owned.
  return (
    <div data-settings-section="delete-account" className="hidden">
      <SectionHeading title="Delete account">
        Permanently remove your account and sign-in access. Shared messages and attachments remain as Deleted user.
      </SectionHeading>
      <DeleteAccount />
    </div>
  );
}
