/**
 * Tidying and checking a display name before it is saved (#7281).
 *
 * A display name is how someone appears everywhere they appear, so the forms
 * that edit it clean up the two things people most often leave on: spaces at
 * either end, and a full stop at the end ("iqiyi." means "iqiyi"). The server
 * already trims spaces; this applies the same rule before the value leaves
 * the page, so the field can show exactly what will be stored.
 *
 * Pure and importless on purpose: tests load it on its own, and the form
 * modules that use it stub ./profile.js only.
 */

/** Spaces at either end and full stops at the end are removed. */
export function cleanDisplayName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\.+$/, '').trim();
}

export type DisplayNameProblem = 'lineBreaks' | 'tooLong';

/** What stops `cleaned` being saved, or null when nothing does. */
export function displayNameProblem(cleaned: string, max: number): DisplayNameProblem | null {
  if (/[\r\n]/.test(cleaned)) return 'lineBreaks';
  if (cleaned.length > max) return 'tooLong';
  return null;
}
