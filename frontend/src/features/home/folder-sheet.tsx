/**
 * The folder sheet's body — what tapping a folder tile on My apps opens.
 *
 * home.js owns the sheet itself (`Home.openFolder` builds the panel, presents
 * it with `PlatformUI.sheet` and mounts THIS into it, the same seam the
 * Wallet sheet uses). This component reads the grid store the launcher
 * renders from, so a membership change that lands while the sheet is up —
 * "Take out of folder" from one of its own tiles, a WS app event — repaints
 * it live, and it renders nothing once the folder no longer exists.
 *
 * Its tiles are the same `.app-card` / `.app-icon-tile` / `.app-card-title`
 * markup My apps draws, with `data-slug` and `data-in-folder` and WITHOUT
 * `data-yours`: the kit's drag recognizer selects on `data-yours`, so these
 * are not draggable. The long-press menu is home.js's own
 * `_wireCardLongPressMenu`, which routes through `Home.openCardMenu` — the
 * `data-in-folder` attribute is what makes that menu carry "Take out of
 * folder".
 */

import type { ReactNode } from 'react';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { useStoreState } from '../../lib/use-store-state';
import { gridStore, type HomeAppView, type IconView } from './grid-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

function SheetIcon({ icon }: { icon: IconView }): ReactNode {
  if (icon.kind === 'image') {
    // Same note as AppGrid's AppIcon: the image fills the content box so it
    // stays flush inside the hairline ring.
    return <img src={icon.src} alt="" draggable={false} className="w-full h-full object-cover" />;
  }
  if (icon.kind === 'emoji') return <span className="text-3xl leading-none">{icon.emoji}</span>;
  return <>{icon.letter}</>;
}

function SheetTile({ app, open, wire }: {
  app: HomeAppView; open: (slug: string) => void; wire: (el: HTMLDivElement | null) => void;
}): ReactNode {
  return (
    <div
      ref={wire}
      className="app-card relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 cursor-pointer"
      data-slug={app.slug}
      data-in-folder="true"
      tabIndex={0}
      role="button"
      aria-label={app.name}
      title={`${app.name}. Hold or right-click for app actions`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          controller()?.openCardMenu?.(app.slug, e.currentTarget);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(app.slug);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        controller()?.openCardMenu?.(app.slug, e.currentTarget);
      }}
      onClick={(e) => {
        const N = controller();
        // A long-press that opened the menu ends with the pointer still on
        // the tile; eat the click the browser fires after it.
        if (N?._suppressClick) { N._suppressClick = false; return; }
        open(app.slug);
      }}
    >
      <div className="relative w-14 h-14 shrink-0">
        <div
          className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
          data-icon={app.icon.kind}
        >
          <SheetIcon icon={app.icon} />
        </div>
      </div>
      <div className="w-full min-w-0">
        <div className="app-card-title" title={app.name}>{app.name}</div>
      </div>
    </div>
  );
}

export function FolderSheet({ folderId, dismiss }: {
  folderId: number; dismiss: () => void;
}): ReactNode {
  const state = useStoreState(gridStore);
  const item = state.items.find((it) => (
    it.kind === 'folder' && String(it.folder.id) === String(folderId)
  ));
  // The folder is gone (emptied, removed, or hidden members only): draw
  // nothing. home.js dismisses the sheet on the same paths.
  if (!item) return null;
  const open = (slug: string) => {
    (window as any).App?.navigateToApp?.(slug);
    dismiss();
  };
  const wire = (el: HTMLDivElement | null) => {
    if (!el) return;
    controller()?._wireCardLongPressMenu?.(el);
  };
  return (
    <>
      <div className="text-lg font-bold py-3">{item.folder.name}</div>
      <div className="grid grid-cols-4 gap-1.5">
        {item.folder.apps.map((app) => (
          <SheetTile key={app.slug} app={app} open={open} wire={wire} />
        ))}
      </div>
    </>
  );
}

/** home.js presents the sheet and hands its body host here. */
export function mountFolderSheet(
  host: Element | null,
  opts: { folderId: number; dismiss: () => void },
): void {
  mountLegacyPortal(host, <FolderSheet folderId={opts.folderId} dismiss={opts.dismiss} />);
}

export function unmountFolderSheet(host: Element | null): void {
  unmountLegacyPortal(host);
}