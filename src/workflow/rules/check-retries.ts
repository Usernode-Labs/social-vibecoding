// How long the checks' error lane re-runs an 'error' verdict on its own:
// the preview machine's errorTimer decides with it, and the surfaces that
// say whether a re-run is coming (staging-recovery.errorWithinAutoRetries:
// the connector, the merge gate, the vote route) read it. Pure: config.js
// and staging-recovery.js require it at load.

// #237: how many 'error' verdicts in a row the lane re-runs. storeChecks
// bumps consecutive_check_failures on every 'error' (and schedules
// check_next_retry_at, 2m → 4m → … → 30m); past this count the row is left
// 'error' until a new commit or a person re-runs it, unless the error is the
// platform's own (PLATFORM_FAULT_RETRY_MS below). Read once, here, from
// CHECK_MAX_AUTO_RETRIES.
const DEFAULT_CHECK_MAX_AUTO_RETRIES = 6;

export function checkMaxAutoRetries(env: Record<string, string | undefined> = process.env): number {
  const configured = Number.parseInt(env.CHECK_MAX_AUTO_RETRIES || String(DEFAULT_CHECK_MAX_AUTO_RETRIES), 10);
  return Number.isFinite(configured) ? configured : DEFAULT_CHECK_MAX_AUTO_RETRIES;
}

// A platform fault (chat_sessions.check_error_platform: the unit suite's Job
// refused or lost before any of the proposal's code ran) is not held to
// that cap. On 10 Oct 2026 every split unit suite failed to start for three
// hours (two shards' input Secrets took the same name, fixed by #4720); six
// approved proposals spent their six retries on it by 20:08 and waited for
// a person after the fix shipped. Nothing about the proposal decides when
// such a fault clears, so the lane keeps retrying it, 30 minutes apart once
// the backoff tops out, for this long after the streak's first failure.
export const PLATFORM_FAULT_RETRY_MS = 24 * 60 * 60 * 1000;

// Is an error with this streak still the lane's to run again? Under the cap,
// or a platform fault inside its day. `firstFailureAt` is the streak's first
// failure, as the machine keeps it (an ISO string) or the row stores it.
export function withinAutoRetries(
  { streak, platformFault, firstFailureAt }: { streak: number; platformFault: boolean; firstFailureAt: string | Date | null },
  cap: number, now: number,
): boolean {
  if (streak < cap) return true;
  if (!platformFault) return false;
  const first = firstFailureAt ? new Date(firstFailureAt).getTime() : NaN;
  return Number.isFinite(first) && now - first < PLATFORM_FAULT_RETRY_MS;
}
