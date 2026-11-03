// What to SHOW for a server's error answer: its `error_message` when it came
// with one, the person's language, otherwise its `error`. '' when it has
// neither, so a site keeps its own fallback: `errorText(data) || t(...)`.
//
// For showing only. `error` is the contract, in English whatever the language,
// and anything that compares, stores or passes an answer on reads `error`.
// src/middleware/error-language.js adds the field. This is the only client code
// that reads it, and tests/error-language.test.js holds it there.
export function errorText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const { error_message: translated, error } = body as Record<string, unknown>;
  if (typeof translated === 'string' && translated) return translated;
  return typeof error === 'string' ? error : '';
}
