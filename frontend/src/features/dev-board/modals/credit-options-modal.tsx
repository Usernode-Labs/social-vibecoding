/**
 * `#credit-options-modal` — the out-of-credits popup on the
 * Generate-proposal path.
 *
 * Its BODY is `public/js/credit-options.js`'s `cardHtml`, the same card the
 * dev chat and the red banner draw, and `CreditOptions.wire` binds inside it
 * after the mount. So the card is a controller-host seam: React renders the
 * string the model carries and never looks below it. Reimplementing it here
 * would be the third copy of copy that exists once on purpose.
 *
 * What IS React's is the chrome the three modals shared — the centring
 * wrapper, the card and the footer — and the footer is where the reskin
 * lands: an outlined "Not now" becomes the language's filled neutral pill.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../../lib/use-store-state';
import { creditOptionsModalStore } from './modals-store';
import type { CreditOptionsModalView } from './model';

export function CreditOptionsCard({ view }: { view: CreditOptionsModalView }): ReactNode {
  return (
    <div className="dc-credits-modal-card w-full max-w-lg rounded-xl bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 shadow-xl p-4">
      <div dangerouslySetInnerHTML={{ __html: view.cardHtml }} />
      <div className="flex justify-end mt-3">
        {/* `data-credits-close` is app-view.js's: the scrim's delegated
            handler closes on it, and it also fires for a click on the
            backdrop, so the button carries no onClick of its own. */}
        <Button type="button" data-credits-close="" variant="neutral" ink="neutral" size="sm">
          Not now
        </Button>
      </div>
    </div>
  );
}

export function CreditOptionsModal(): ReactNode {
  const { view } = useStoreState<{ view: CreditOptionsModalView | null }>(creditOptionsModalStore);
  if (!view) return null;
  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <CreditOptionsCard view={view} />
    </div>
  );
}
