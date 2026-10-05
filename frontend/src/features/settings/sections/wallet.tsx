import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';

/**
 * Homeroom Wallet linking.
 *
 * #wallet-section carries a `hidden` of its own, INSIDE the section wrapper's
 * routing `hidden`. That inner one is the CAPABILITY GATE: settings.js reveals
 * it only in the native app, and Settings._visibleSections() reads it back to
 * decide whether "Wallet" appears in the menu at all. The two must stay
 * separate — fold the gate into the wrapper and the section becomes
 * permanently invisible the moment the router hides it.
 */
export function WalletSection() {
  return (
    <div data-settings-section="wallet" className="hidden">
      {/* Wallet linking section */}
      <div id="wallet-section" className="hidden">
        <Localized element={<SectionHeading title={catalogText("settings:homeroom_wallet_6e5f658a")}><Message id="settings:link_your_on_chain_identity_scan_the_qr_code_wit_3d798ec2" /></SectionHeading>} messages={{"title":"settings:homeroom_wallet_6e5f658a"}} />
        {/* Unlinked: show link button */}
        <div id="wallet-unlinked" className="hidden">
          <Button id="wallet-link-btn" layout="full"><Message id="settings:link_homeroom_wallet_ad511b14" /></Button>
        </div>
        {/* Linking: show QR */}
        <div id="wallet-linking" className="hidden text-center">
          <div id="wallet-qr-canvas" className="inline-block rounded-lg bg-white p-2">
          </div>
          <p id="wallet-link-timer" className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          </p>
          <button
            id="wallet-link-cancel"
            className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-300 underline"
          ><Message id="settings:cancel_19766ed6" /></button>
        </div>
        {/* Linked: show pubkey + unlink */}
        <div id="wallet-linked" className="hidden">
          <div className="flex items-center gap-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2">
            <span className="text-xs text-emerald-700 font-bold dark:text-emerald-400">
              &#x2713;
            </span>
            <span
              id="wallet-pubkey-display"
              className="text-sm font-mono text-zinc-700 dark:text-zinc-300 truncate flex-1"
            >
            </span>
          </div>
          {/*
              Unlink intentionally hidden for now: unlinking only clears the
              server-side pubkey (no on-chain unlink), and wallet is the
              primary native sign-in path, so an accidental unlink is more
              footgun than feature. The DELETE /api/me/wallet-link endpoint
              and its (null-guarded) handler remain, so re-adding this button
              is all that's needed to restore the option.
          */}
        </div>
        <StatusLine id="wallet-status" />
      </div>
    </div>
  );
}
