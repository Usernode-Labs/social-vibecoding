/**
 * `#app-iframe` and its launch cover, as a React island (#1085 chunk H, step 2).
 *
 * Read ./app-frame-store.js first: this file exists to satisfy a single
 * invariant, and every line of it is shaped by that invariant.
 *
 *   **The `<iframe>` element must be created exactly once per app and never
 *   again.** It hosts someone else's application. Re-creating it reloads their
 *   document and throws away whatever the user had in it.
 *
 * React re-creates a DOM node when its element type changes, its `key` changes,
 * or its position among its siblings changes. So:
 *
 * - `AppFrame` is keyed by `slug` and by nothing else, by its only caller below.
 *   A different app IS a different frame; nothing else is.
 * - The `.app-launch-host` wrapper is rendered UNCONDITIONALLY, outside
 *   `AppFrame`, so the frame's parent is the same node for the lifetime of the
 *   document. (It also supplies the `position: relative` that
 *   `#app-iframe { position: absolute; inset: 0 }` resolves against — the same
 *   role `#app-content { position: relative }` played for the old hand-built
 *   markup, so the frame's rect is unchanged.)
 * - The iframe is the FIRST child, always, and the cover — which comes and goes
 *   — is the second. Removing a trailing sibling cannot move the one before it.
 * - There is no `src` prop. `src` is assigned through the registered ref by
 *   `appFrameBridge.setSrc` and nowhere else; re-applying a `src` prop is a
 *   document reload even when the value has not changed.
 * - Parking (Dev tab) hides the HOST, it does not unmount this component.
 *
 * `opacity` is a rendered prop rather than an imperative write because React
 * owns it end to end: `#app-iframe` had `style="opacity:0"` in the launch
 * markup and `_revealLaunch` set it to '1'. A style-prop change updates the
 * existing node's style; it never re-creates it.
 */

import { memo, useRef, type ReactNode } from 'react';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { appFrameRefs, appFrameStore } from './app-frame-store.js';

/**
 * The one place the sandboxed-iframe attribute contract is written on the React
 * side. Must stay identical to `AppView._appIframeHtml` in
 * public/js/app-view.js, which is still the DOM adapter's copy.
 */
const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock';
const ALLOW = 'clipboard-write; pointer-lock; geolocation';

function LaunchCover({
  iconKind,
  iconHtml,
  aura,
  name,
  note,
  spinner,
  out,
}: {
  iconKind: string;
  iconHtml: string;
  aura: string;
  name: string;
  note: string;
  spinner: boolean;
  out: boolean;
}): ReactNode {
  return (
    <div
      id="app-launch-cover"
      className={out ? 'app-launch-cover app-launch-cover--out' : 'app-launch-cover'}
      aria-hidden="true"
    >
      {/*
          The icon tile's inner markup comes from `Home.iconTileFor` — the same
          helper that paints every icon tile on the platform — so it arrives as
          HTML. The name and the note are raw text: React escapes them, where
          the legacy template called escapeHtml itself.
      */}
      <div
        className="app-icon-tile app-launch-cover-icon"
        data-icon={iconKind}
        data-aura={aura || undefined}
        dangerouslySetInnerHTML={{ __html: iconHtml }}
      >
      </div>
      <p className="app-launch-cover-name">{name}</p>
      <p className="app-launch-cover-note" id="app-launch-cover-note">{note}</p>
      <div
        className={
          spinner
            ? 'dc-status-spinner-arc app-launch-cover-spinner'
            : 'dc-status-spinner-arc app-launch-cover-spinner hidden'
        }
        id="app-launch-cover-spinner"
      >
      </div>
    </div>
  );
}

/**
 * `memo` is not what protects the frame's identity — the key and the position
 * do. It is here because this component subscribes to the store for `faded` and
 * `cover`, and `slug` is the only prop it takes: memoising keeps a parent
 * re-render from doing any work at all.
 */
const AppFrame = memo(function AppFrame(_props: { slug: string }): ReactNode {
  const state = useStoreState(appFrameStore);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Register the element for the bridge, and only for as long as React owns it.
  useIsomorphicLayoutEffect(() => {
    appFrameRefs.iframe = iframeRef.current;
    return () => {
      if (appFrameRefs.iframe === iframeRef.current) appFrameRefs.iframe = null;
    };
  }, []);

  const cover = state.cover;
  return (
    <>
      <iframe
        id="app-iframe"
        ref={iframeRef}
        className="w-full h-full border-0"
        style={{ opacity: state.faded ? 0 : 1 }}
        sandbox={SANDBOX}
        allow={ALLOW}
      >
      </iframe>
      {cover ? (
        <LaunchCover
          iconKind={cover.iconKind}
          iconHtml={cover.iconHtml}
          aura={cover.aura}
          name={cover.name}
          note={cover.note}
          spinner={cover.spinner}
          out={cover.out}
        />
      ) : null}
    </>
  );
});

/**
 * `#app-frame-host` — the React-owned half of `#app-view`.
 *
 * A sibling of `#app-content` rather than a child of it, and that split is the
 * whole architecture of step 2: `#app-content` stays exactly what it was, an
 * empty host that `public/js/**` fills with `innerHTML` (Dev mode and all its
 * sub-views, the status placeholders, the `?shot=app-launching` cover), and the
 * app frame moves out from under it into a region React owns end to end. That
 * is what the migration rule demands — "a region may become stateful only when
 * its entire subtree is React-owned" — and it is also what lets the frame
 * survive a tab switch, because a Dev render no longer writes over it.
 *
 * Exactly one of the two is visible. Both carry `flex-1` + `min-height: 0` +
 * `overflow: hidden` inside `#app-view`'s column flex, and a hidden sibling is
 * `display: none` and out of the layout, so the visible one gets the same box
 * `#app-content` had when it was the only child.
 */
export function AppFrameHost(): ReactNode {
  const state = useStoreState(appFrameStore);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Written on the ref, not rendered, so `className` stays a constant string —
  // #app-view's own `hidden` is toggled by app.js's visibility seam and the same
  // discipline applies all the way down this subtree.
  useHiddenClass(hostRef, !state.active);

  return (
    <div
      id="app-frame-host"
      ref={hostRef}
      className="hidden flex-1"
      style={{ minHeight: '0', overflow: 'hidden' }}
    >
      <div className="app-launch-host w-full h-full">
        {state.slug ? <AppFrame key={state.slug} slug={state.slug} /> : null}
      </div>
    </div>
  );
}
