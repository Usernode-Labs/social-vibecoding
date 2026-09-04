/**
 * Trim a user-entered URL and supply HTTPS only when it has no explicit URI
 * scheme. Keeping explicit schemes intact lets each caller's validator decide
 * which protocols are allowed.
 */
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function normalizeSchemeLessUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || URI_SCHEME.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
