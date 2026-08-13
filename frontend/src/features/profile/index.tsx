// The profile screen (#profile) as a React island — #1083 chunk F step 2,
// converted end to end by #1191 slice 6.
//
// #profile-root used to be an unmanaged host: React owned the container and
// ./profile.js built everything below it with createElement and textContent.
// Slice 6 finished the job. The subtree is React's now — ./profile-view.tsx
// renders it from the view ./profile-store.js derives, and ./profile.js kept
// only the fetches, the load-token discipline and the writes. That is what the
// island rule asks for before a region may hold state: no public/js/** module,
// and no module in this bundle either, writes a node inside #profile-root.
//
// #profile-edit-sheet (#982) is part of this tree now, and that is deliberate
// rather than incidental. It is NOT one of the nine dialogs that go through
// frontend/src/lib/static-modal.ts — there is no static root whose card gets
// lifted — so it is rendered here, inside #profile-root, and handed to the
// native kit by lib/kit-surface.ts. Its no-kit fallback was already "leave the
// panel at the top of #profile-root", which is exactly where React puts it.
//
// Visibility comes from the store; `false` is the shipped state. See
// browse-screen.tsx for why it has to be useVisibilityHiddenClass and not
// useVisibility.

import { useRef } from 'react';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { ProfileRoot } from './profile-view';
import './mount';

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
        <ProfileRoot />
      </div>
    </main>
  );
}
