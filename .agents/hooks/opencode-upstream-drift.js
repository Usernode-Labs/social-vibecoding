import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Advisory, so unlike the promotion guard this never throws: a checkout it
// cannot read simply gets no freshness notice. See upstream-drift.js.
export const UsernodeUpstreamDrift = async (context) => {
  const candidate = context?.worktree || context?.directory;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return {};
  try {
    const checkoutRoot = fs.realpathSync(candidate);
    const driftPath = path.join(checkoutRoot, '.agents', 'hooks', 'upstream-drift.js');
    return require(driftPath).createOpenCodeUpstreamDrift({ worktree: checkoutRoot });
  } catch {
    return {};
  }
};
