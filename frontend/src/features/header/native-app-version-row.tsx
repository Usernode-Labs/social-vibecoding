/**
 * The "Mobile app version" row — the Improve panel's reference footer (#improve-footer), which is where #1443 put the version rows back.
 * See ./native-app-version-store.ts for what the seam carries.
 *
 * It was the hamburger drawer's footer until the Streamlined Concept board
 * took that footer away; the installed Flutter build is a fact about the
 * PLATFORM, not about whichever app the drawer is scoped to, which is why
 * Settings is where it landed rather than the app's own page. Renamed with
 * the move (`drawer-row-native-app-version` → `about-row-native-app-version`)
 * — see tests/shell-id-inventory.test.js.
 *
 * It still renders from the header feature rather than inline in
 * ../settings/index.tsx: the screen should not grow a native-bridge concern,
 * and a version landing should not re-render the whole of Settings.
 *
 * Named `-row` rather than matching its module: `./native-app-version.js` sits
 * beside it, and an extensionless import of the shared stem resolves to the
 * `.js` first — which fails the build with "not exported by", one directory
 * away from where it reads.
 */

import { type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { nativeAppVersionStore } from './native-app-version-store';

/** The two class runs, as complete literals — Tailwind's extractor is a regex. */
const ROW = {
  hidden: 'hidden drawer-ver-row flex items-center gap-2',
  shown: 'drawer-ver-row flex items-center gap-2',
} as const;

export function NativeAppVersionRow(): ReactNode {
  const { value } = useStoreState(nativeAppVersionStore);
  return (
    <div id="drawer-row-native-app-version" className={value ? ROW.shown : ROW.hidden}>
      <span className="drawer-ver-label">
        Mobile app version
      </span>
      {/* A text child, never `dangerouslySetInnerHTML`: this string comes from
          the native runtime, and the module it replaces used `textContent` for
          exactly that reason. React escapes text children. */}
      <span
        id="native-app-version-slot"
        className="drawer-ver drawer-ver-value ml-auto min-w-0 justify-end"
      >{value}</span>
    </div>
  );
}
