/**
 * Artifacts (docs/plans/artifacts.md): the one policy every page the bot
 * writes is drawn under, in the browser. The text is
 * src/services/artifact-policy.json, the SAME file the server reads
 * (src/services/artifact-policy.js, where the two modes and the rule are
 * written down); tests/artifact-policy.test.js holds this module and that
 * one to the same strings.
 *
 * It is JSON so both sides can read it: the server is CommonJS and this
 * bundle is not (the admin console's country table is shared the same way).
 */

import policy from '../../../../src/services/artifact-policy.json';

/** How a page is drawn: its own scripts running, or nothing of its own running. */
export type FrameMode = 'run' | 'static';

type Directive = readonly string[];
const MODES = policy.modes as unknown as Record<FrameMode, { sandbox: string; directives: readonly Directive[] }>;

/** Pure: the sandbox attribute of a frame in `mode`; with `helper`, a static frame that runs Homeroom's own helper. */
export function sandboxFor(mode: FrameMode, { helper = false }: { helper?: boolean } = {}): string {
  return helper && mode === 'static' ? policy.helper.sandbox : MODES[mode].sandbox;
}

/**
 * Pure: the content security policy text of a page drawn in `mode`. `site`:
 * this site's origin when the page draws with its stylesheets, pictures and
 * fonts, else null and the page names no origin. `nonce`: a static page that
 * runs Homeroom's helper allows that one script by it.
 */
export function cspFor(mode: FrameMode, { site = null, nonce = null }: { site?: string | null; nonce?: string | null } = {}): string {
  const origin = site ? String(site).replace(/["';,\s]/g, '') : '';
  const helper = mode === 'static' && nonce ? String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, '') : '';
  return MODES[mode].directives.map(([name, ...values]) => {
    const kept = name === 'script-src' && helper
      ? [policy.helper['script-src'].replace('{nonce}', helper)]
      : values.map((value) => (value === '{site}' ? origin : value)).filter(Boolean);
    return `${name} ${kept.join(' ')}`;
  }).join('; ');
}
