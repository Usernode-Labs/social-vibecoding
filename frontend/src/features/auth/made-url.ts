/**
 * Canonicalise the optional "something you've made" link before it reaches
 * native form validation or the waitlist API.
 *
 * A scheme that was explicitly supplied is left alone so the server can
 * reject unsupported protocols through its existing validation path. Only a
 * genuinely scheme-less value gets the helpful HTTPS default.
 */
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function normalizeMadeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || URI_SCHEME.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
