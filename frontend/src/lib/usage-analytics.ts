/**
 * "Share usage analytics" (#5097, Settings > Privacy) on the client: whether
 * this page may send the usage analytics that are not the UI telemetry
 * module's own (an app opened from the App tab, the made screen's moments,
 * watching Live). public/js/ui-telemetry.js reads the same answer itself.
 *
 * Only the server's explicit TRUE says yes: `uiTelemetryEligible` on the
 * /api/auth/me user, which is false until the person switches the setting on
 * (and for platform service accounts and people who asked not to be
 * recorded). Signed out, or before the answer arrives, nothing is sent. The
 * server drops these events for an opted-out account in any case
 * (src/services/usage-analytics.js); this only saves the request.
 */

type AnalyticsHost = { App?: { user?: { uiTelemetryEligible?: unknown } | null } };

export function sharesUsageAnalytics(host: unknown = globalThis): boolean {
  try {
    return (host as AnalyticsHost | null)?.App?.user?.uiTelemetryEligible === true;
  } catch {
    return false;
  }
}
