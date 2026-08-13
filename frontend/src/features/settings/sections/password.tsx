import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Change password (issue #282). Default form calls POST /api/me/password
 * (current password required). In the Usernode native app with a linked
 * wallet, a "Use your wallet instead" link switches to wallet mode
 * (cp-wallet-mode shown, current password hidden) which signs a wallet-check
 * challenge and calls POST /api/me/wallet-change-password — the way back for a
 * logged-in user who's forgotten the password they'd need to type. settings.js
 * wires the mode switch and both submit paths.
 */
export function PasswordSection() {
  return (
    <div data-settings-section="password" className="hidden">
      <div id="change-password-section">
        <SectionHeading title="Change password">
          Set a new password for web login. If an admin gave you a temporary password, enter it as your current password here.
        </SectionHeading>
        <div className="space-y-2">
          <div id="cp-current-row">
            <Input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
            />
          </div>
          <Input
            id="cp-new"
            type="password"
            autoComplete="new-password"
            placeholder="New password (at least 8 characters)"
          />
          <Input
            id="cp-confirm"
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
          />
        </div>
        {/* Default (password) submit */}
        <Button id="cp-save" layout="stacked">
          Change password
        </Button>
        {/* Wallet (signature) submit — shown only in wallet mode */}
        <Button id="cp-wallet-save" layout="hiddenStacked">
          Sign &amp; change password
        </Button>
        {/*
            Mode switches. cp-wallet-mode is itself hidden unless the user
            is in the native app with a linked wallet (settings.js).
        */}
        <p id="cp-wallet-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-wallet" href="#" className="text-violet-500 hover:text-violet-400">
            Forgot it? Use your wallet instead
          </a>
        </p>
        <p id="cp-password-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-password" href="#" className="text-violet-500 hover:text-violet-400">
            Use current password instead
          </a>
        </p>
        <StatusLine id="cp-status" />
      </div>
    </div>
  );
}
