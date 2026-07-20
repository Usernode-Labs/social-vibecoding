// Shared Light / Dark / System theme control for the standalone pages
// (#576). The main app (index.html) has its own copy of this control
// baked into the header drawer and wired in app.js; this module is for
// every OTHER page — login, register, dashboard, admin, admin-features,
// debug, status — which loads /js/theme.js (and the inline no-flash
// guard) but has no in-page affordance to CHANGE the theme.
//
// It reuses window.Theme entirely (one storage contract, one apply
// path), so a choice made here is byte-identical to one made in the
// drawer and syncs across tabs / pages on the same device.
//
// Renders into an element with id="theme-toggle" if present; otherwise
// it creates a fixed top-right container so a page can opt in just by
// loading the script. Classes mirror the drawer control in index.html
// (px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800 …) — those exact
// strings already ship in the HTML, so the CDN Tailwind JIT has seen
// them and this dynamically-inserted markup styles correctly.
(function () {
  // No Theme module → nothing to drive. Guard like app.js does; the
  // page still renders, it just has no live toggle (theme.js may not
  // have loaded, or this ran before it).
  if (!window.Theme) return;

  var MODES = [
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
    { mode: 'system', label: 'System' },
  ];

  function build() {
    var host = document.getElementById('theme-toggle');
    if (!host) {
      // Opt-in fallback: no explicit container on the page, so float one
      // in the top-right corner (auth pages use this shape).
      host = document.createElement('div');
      host.id = 'theme-toggle';
      host.className = 'fixed top-4 right-4 z-50';
      document.body.appendChild(host);
    }

    // Inner segmented group — compact, matches the drawer's right-side
    // cluster. Non-destructive: leaves any host classes (positioning)
    // intact and only owns its own children.
    var group = document.createElement('div');
    group.className = 'flex items-center gap-1 text-xs';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Theme');

    var buttons = [];
    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.themeMode = m.mode;
      b.textContent = m.label;
      b.className = 'px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800 whitespace-nowrap shrink-0';
      b.addEventListener('click', function () {
        Theme.set(m.mode);
        render();
      });
      buttons.push(b);
      group.appendChild(b);
    });

    host.appendChild(group);

    // Sync the active highlight from Theme.get(); mirrors
    // App.HeaderMenu._renderThemeButtons() in app.js.
    function render() {
      var current = Theme.get();
      buttons.forEach(function (b) {
        var active = b.dataset.themeMode === current;
        b.classList.toggle('bg-violet-600', active);
        b.classList.toggle('text-white', active);
        b.classList.toggle('bg-zinc-200', !active);
        b.classList.toggle('dark:bg-zinc-800', !active);
      });
    }

    // Storage/OS-driven changes (other tab, OS sunset switch) re-highlight.
    Theme.onChange(render);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
}());
