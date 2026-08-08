import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn class-name helper: conditional joining (clsx) plus
 * last-one-wins conflict resolution (tailwind-merge).
 *
 * Note for the platform shell: `twMerge` is configured for stock Tailwind
 * scales, and this repo overrides only the *values* of the `zinc` and
 * `violet` palettes in tailwind.config.js — not the utility names — so
 * merge behaviour is unaffected.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
