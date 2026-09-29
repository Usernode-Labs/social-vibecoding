/**
 * Copy text for the ⋯ menu's Copy text / Copy link (#2387), and say so.
 *
 * The async Clipboard API where the page may use it, else a hidden textarea
 * and `execCommand('copy')` — the one path that still works inside the
 * native shell's WebView on older Android, where `navigator.clipboard` is
 * present but refuses. The toast is the kit's (`PlatformUI.toast`), so the
 * confirmation looks like every other one in the shell.
 */
export async function copyToClipboard(text: string, done = 'Copied'): Promise<boolean> {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) ok = legacyCopy(text);
  toast(ok ? done : 'Couldn’t copy. Your browser blocked the clipboard.');
  return ok;
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function toast(text: string): void {
  const kit = (window as unknown as { PlatformUI?: { toast?: (message: string) => void } }).PlatformUI;
  kit?.toast?.(text);
}

/**
 * An absolute link to a place in this app: the shell's own origin and path,
 * with the hash route. The query string is dropped — it carries the staging
 * token and the demo flag, neither of which belongs in a link someone pastes.
 */
export function absoluteLink(hash: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${hash.startsWith('#') ? hash : `#${hash}`}`;
}
