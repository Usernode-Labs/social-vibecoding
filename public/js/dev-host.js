// Rewrite `http://localhost:<port>` URLs handed out by the server so they
// resolve from whatever hostname the browser is actually on. Same page
// served to a laptop (http://localhost:3000) and a phone on the LAN
// (http://192.168.1.x:3000) needs each to reach the child app/staging
// container at *its* own view of the host — not at the string "localhost".
//
// No-op for any URL that doesn't point at localhost / 127.0.0.1, so
// production URLs (https://<slug>.social-vibecoding.usernodelabs.org)
// are untouched.

(function () {
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

  function resolveDevHost(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      const u = new URL(url, window.location.origin);
      if (!LOCAL_HOSTS.has(u.hostname)) return url;
      if (LOCAL_HOSTS.has(window.location.hostname)) return url;
      u.hostname = window.location.hostname;
      return u.toString();
    } catch {
      return url;
    }
  }

  window.resolveDevHost = resolveDevHost;
})();
