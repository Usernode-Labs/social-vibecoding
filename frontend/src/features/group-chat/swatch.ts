/**
 * A stable colour per author, so the same person is the same swatch in every
 * row without the server having to store one. Same idea as `tintFor` for app
 * tiles, and deliberately not the accent ramp: an identity is not a state.
 *
 * Shared by the transcript's message rows and the proposal event rows
 * (./proposal-event.tsx), which draw the person who proposed a change with
 * the avatar their own messages wear — the same hash, so the same swatch.
 * features/messages/format.tsx carries a different hash for the Messages
 * screen; this is the group chat's, unchanged from when the row was an HTML
 * string.
 */
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];

export function swatchFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}
