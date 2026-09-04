/**
 * Canonicalise the optional "something you've made" link before it reaches
 * native form validation or the waitlist API.
 *
 * A scheme that was explicitly supplied is left alone so the server can
 * reject unsupported protocols through its existing validation path. Only a
 * genuinely scheme-less value gets the helpful HTTPS default.
 */
import { normalizeSchemeLessUrl } from '../../lib/url';

export function normalizeMadeUrl(value: string): string {
  return normalizeSchemeLessUrl(value);
}
