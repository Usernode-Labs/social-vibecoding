// The build this process runs, as the release machine names it: its commit
// (GIT_SHA), or on a dev build one name per boot, so two dev processes are
// two releases. The runtime claims work that must run this build's code by
// it (WorkHandler.ownRelease), and a clock that only the newest build runs
// hands it to its targets (clock/services.ts newestOnly).

import { randomUUID } from 'node:crypto';

const BOOT = randomUUID();

export function bootRelease(): string {
  const sha = String(process.env.GIT_SHA || '').trim().slice(0, 40);
  return sha && sha !== 'dev' ? sha : `dev:${BOOT}`;
}
