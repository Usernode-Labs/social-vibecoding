// The way into one private request (#5048) from elsewhere: a private request
// has no page or address, so a door (the bell's private platform request
// row, through UsernodeReact.devBoard.showPrivateRequest) names the one to
// open, then opens Homeroom's Workshop, whose Private requests section
// (private-requests.tsx) expands it and scrolls to it.
// The section may mount after the door is used, so the id waits here until
// the section takes it.

export const PRIVATE_REQUEST_OPEN = 'usernode:private-request-open';

let pending: { slug: string; id: number } | null = null;

export function openPrivateRequest(slug: string, id: number): void {
  if (!slug || !Number.isInteger(id) || id <= 0) return;
  pending = { slug, id };
  window.dispatchEvent(new CustomEvent(PRIVATE_REQUEST_OPEN, { detail: { slug, id } }));
}

/**
 * The id a door asked for on this project's Workshop and nobody has taken
 * yet; taking it clears it. Another project's section leaves it waiting.
 */
export function takePendingPrivateRequest(slug: string): number | null {
  if (!pending || pending.slug !== slug) return null;
  const { id } = pending;
  pending = null;
  return id;
}
