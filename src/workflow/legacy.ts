// The platform's CommonJS modules, reached from the workflow's ESM. Paths
// are relative to src/ ('services/github'). Loaded on first use, through
// the shared require cache, so tests that stub a module by require.cache
// stub it here too, and import cycles with the routes never bite.

import { createRequire } from 'node:module';

const load = createRequire(new URL('../', import.meta.url));

export function legacy(path: string): any {
  return load(`./${path}`);
}
