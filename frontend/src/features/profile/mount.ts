/**
 * The legacy → React seam for the Profile screen (#1191 slice 6, conversion 1).
 *
 * Same shape as ../app-frame/mount.ts, and for the same two reasons.
 *
 * `public/js/app.js` is a classic script that runs before this bundle, and it
 * reaches this screen by name: `App.navigateToProfile` calls `Profile.open()`
 * and `App._exitProfile` calls `Profile.close()`. Those keep working through
 * the `window.Profile` publication in ./profile.js — this file adds the
 * React-dependent halves that module may not import.
 *
 * `setFlush(flushSync)` because the legacy callers read the DOM on their next
 * line. `?shot=profile-edit` is the sharpest case: `Profile._maybeOpenShot()`
 * opens the edit sheet, and the declared dapp.json check asserts on
 * `#profile-edit-sheet #profile-edit-username[disabled]` — batched, the sheet
 * would not exist yet when the kit hand-off and the screenshot both look for it.
 */

import { flushSync } from 'react-dom';

import { Profile } from './profile.js';
import { profileStore } from './profile-store.js';

profileStore.setFlush(flushSync);

export { Profile, profileStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.profile = Profile;
}
