import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { SectionHeading } from '@/components/ui/field';
import { DeleteAccount } from '../delete-account';

export function DeleteAccountSection() {
  // The Settings router owns only this static wrapper's visibility. The
  // confirmation form beneath it is entirely React-owned.
  return (
    <div data-settings-section="delete-account" className="hidden">
      <Localized element={<SectionHeading title={catalogText("settings:delete_account_a2e20a33")}><Message id="settings:anonymise_your_account_and_remove_your_sign_in_a_7f60f499" /></SectionHeading>} messages={{"title":"settings:delete_account_a2e20a33"}} />
      <DeleteAccount />
    </div>
  );
}
