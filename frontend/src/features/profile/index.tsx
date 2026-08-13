// The profile screen (#profile) as a React island — #1083 chunk F step 2.
//
// The smallest of the four regions: the shell only ever held the <main> and
// one host div, because ./profile.js builds the whole card — identity, rank,
// token allocation, points breakdown, completed challenges — into
// #profile-root with createElement and textContent. So this island is the
// frame and nothing more, and #profile-root stays an unmanaged host: React
// owns the container, the module owns everything below it.
//
// #profile-edit-sheet (#982) is NOT part of this markup, and that is
// deliberate rather than an omission. profile.js creates the sheet on demand
// and presents it through PlatformUI, and it is not one of the nine dialogs
// that go through frontend/src/lib/static-modal.ts — there is no static root
// whose card gets lifted, so there is nothing here for a re-render to fight.
//
// Visibility comes from the store; `false` is the shipped state. See
// browse-screen.tsx for why it has to be useVisibilityHiddenClass and not
// useVisibility.

import { useRef } from 'react';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import './profile.js';

export function ProfileScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'profile-screen', false);

  return (
    <main
      ref={screenRef}
      id="profile-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
    >
      <div id="profile-root" className="max-w-3xl mx-auto p-4">
      </div>
    </main>
  );
}
