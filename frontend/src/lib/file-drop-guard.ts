/**
 * A file dropped where nothing takes it must not open in place of the app
 * (#4065).
 *
 * A browser's default for a file dropped on a page is to navigate to it, and
 * that takes whatever was typed with it: a draft beside an agent session's
 * box, a reply under a page header. Every composer claims its own drop (see
 * features/attachments/file-drag.tsx); this is the floor under all of them.
 *
 * The listeners are on the window, so they run after any element's own: a
 * drop a composer already took (`defaultPrevented`) is left alone, and only
 * an unclaimed FILE drag is refused. Text and link drags keep the browser's
 * behaviour. Apps run in their own frames, which are other documents, so
 * nothing here reaches them.
 */

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

export function onUnclaimedFileDrag(event: DragEvent): void {
  if (event.defaultPrevented || !carriesFiles(event)) return;
  event.preventDefault();
  if (event.type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
}

let installed = false;

export function installFileDropGuard(target: Pick<Window, 'addEventListener'> | null = typeof window !== 'undefined' ? window : null): void {
  if (installed || !target) return;
  installed = true;
  target.addEventListener('dragover', onUnclaimedFileDrag as EventListener);
  target.addEventListener('drop', onUnclaimedFileDrag as EventListener);
}

installFileDropGuard();
