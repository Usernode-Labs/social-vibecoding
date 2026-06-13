// Theme module — Light / Dark / System mode selector.
// Storage contract (byte-compatible with inline no-flash guards):
//   'light'  → light mode
//   'dark'   → dark mode
//   key absent → system (follows OS preference)
// System removes the key; Light and Dark store the value explicitly.
window.Theme = (function () {
  const KEY = 'theme';
  const _listeners = [];

  function get() {
    try {
      const val = window.localStorage.getItem(KEY);
      if (val === 'light' || val === 'dark') return val;
      return 'system';
    } catch {
      return 'system';
    }
  }

  function apply() {
    const mode = get();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const wantDark = mode === 'dark' || (mode === 'system' && prefersDark);
    if (wantDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  function set(mode) {
    try {
      if (mode === 'light' || mode === 'dark') {
        window.localStorage.setItem(KEY, mode);
      } else {
        window.localStorage.removeItem(KEY);
      }
    } catch {}
    apply();
    _listeners.forEach(function (fn) { try { fn(mode); } catch {} });
  }

  function onChange(fn) {
    _listeners.push(fn);
  }

  // Re-apply when OS preference changes (only meaningful in system mode).
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (get() === 'system') {
      apply();
      _listeners.forEach(function (fn) { try { fn('system'); } catch {} });
    }
  });

  // Sync across tabs when another tab writes localStorage.theme.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) {
      apply();
      _listeners.forEach(function (fn) { try { fn(get()); } catch {} });
    }
  });

  // Apply on load (harmless re-run after the inline no-flash guard).
  apply();

  return { get, set, apply, onChange };
}());
