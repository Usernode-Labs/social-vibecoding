/**
 * Artifacts (docs/plans/artifacts.md): the one policy every page the bot
 * writes is drawn under, in the browser. The text is
 * src/services/artifact-policy.json, the SAME file the server reads
 * (src/services/artifact-policy.js, where the three modes and the rule are
 * written down); tests/artifact-policy.test.js holds this module and that
 * one to the same strings.
 *
 * It is JSON so both sides can read it: the server is CommonJS and this
 * bundle is not (the admin console's country table is shared the same way).
 */

import policy from '../../../../src/services/artifact-policy.json';

/**
 * How a page is drawn: its own scripts running (`run`), nothing running
 * (`static`), or nothing of its own running and Homeroom's helper alone,
 * let run by this frame's nonce (`helper`).
 */
export type FrameMode = 'run' | 'static' | 'helper';

type Directive = readonly string[];
const MODES = policy.modes as unknown as Record<FrameMode, { sandbox: string; directives: readonly Directive[] }>;

/** Pure: the sandbox attribute of a frame in `mode`. */
export function sandboxFor(mode: FrameMode): string {
  return MODES[mode].sandbox;
}

/**
 * Pure: the content security policy text of a page drawn in `mode`. `site`:
 * this site's origin when the page draws with its stylesheets, pictures and
 * fonts, else null and the page names no origin. `nonce`: the helper mode's
 * one script, by this frame's nonce; without it, nothing runs.
 */
export function cspFor(mode: FrameMode, { site = null, nonce = null }: { site?: string | null; nonce?: string | null } = {}): string {
  const origin = site ? String(site).replace(/["';,\s]/g, '') : '';
  const kept = nonce ? String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, '') : '';
  return MODES[mode].directives.map(([name, ...values]) => {
    const said = values
      .map((value) => (value === '{site}' ? origin : value))
      .map((value) => (value.includes('{nonce}') ? (kept ? value.replace('{nonce}', kept) : '') : value))
      .filter(Boolean);
    return `${name} ${said.length ? said.join(' ') : "'none'"}`;
  }).join('; ');
}
