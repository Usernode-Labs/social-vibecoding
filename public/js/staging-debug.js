// ── TEMPORARY staging-only on-screen diagnostics ────────────────────────
//
// Investigation aid for "the Members & visibility drawer row closes the
// drawer but no panel appears" — reported on the staging preview after
// three code fixes, with no devtools available in the mobile WebView.
//
// Everything here is gated on the PLATFORM's own USERNODE_ENV === 'staging'
// (read from GET /api/version's `env` field). In production `active` stays
// false and EVERY method is an inert no-op — the StagingDebug.log()/snapshot()
// calls peppered through app.js / app-view.js / settings.js cost nothing and
// render nothing. The overlay is created lazily on the first log() (i.e. on a
// tap), sits at the maximum z-index so it's visible above the drawer and any
// modal, and reports each step of the open path plus the modal's computed
// style + bounding rect right after reveal.
//
// REMOVE THIS FILE, its <script> include in index.html, and the
// StagingDebug.* call sites once the root cause is identified.
const StagingDebug = {
  active: false,
  _el: null,
  _lines: [],

  // Resolve the platform env. Cheap extra GET on load; in prod it just
  // confirms active=false and we never touch the DOM again.
  async init() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = await r.json();
      StagingDebug.active = !!j && j.env === 'staging';
    } catch {
      StagingDebug.active = false;
    }
    if (StagingDebug.active) StagingDebug.log('StagingDebug armed (env=staging)');
  },

  _panel() {
    if (StagingDebug._el) return StagingDebug._el;
    const el = document.createElement('div');
    el.id = 'staging-debug-overlay';
    el.style.cssText = [
      'position:fixed', 'left:4px', 'right:4px', 'bottom:4px',
      'z-index:2147483647', 'max-height:45vh', 'overflow:auto',
      'background:rgba(8,8,18,0.96)', 'color:#7CFC9A',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:8px 10px', 'border:1px solid #3b3b5a', 'border-radius:8px',
      'white-space:pre-wrap', 'word-break:break-word',
      'box-shadow:0 4px 24px rgba(0,0,0,.55)', 'pointer-events:auto',
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-bottom:4px';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'copy';
    copyBtn.style.cssText = 'color:#9cf;background:none;border:1px solid #555;border-radius:4px;padding:0 6px;cursor:pointer';
    copyBtn.onclick = () => {
      try { navigator.clipboard.writeText(StagingDebug._lines.join('\n')); copyBtn.textContent = 'copied'; }
      catch { copyBtn.textContent = 'n/a'; }
    };
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'dismiss';
    clearBtn.style.cssText = 'color:#ff8;background:none;border:1px solid #555;border-radius:4px;padding:0 6px;cursor:pointer';
    clearBtn.onclick = () => { StagingDebug._lines = []; el.remove(); StagingDebug._el = null; };
    bar.appendChild(copyBtn);
    bar.appendChild(clearBtn);
    el.appendChild(bar);

    const body = document.createElement('div');
    body.id = 'staging-debug-body';
    el.appendChild(body);
    document.body.appendChild(el);
    StagingDebug._el = el;
    return el;
  },

  _render() {
    if (!StagingDebug._el) return;
    const body = StagingDebug._el.querySelector('#staging-debug-body');
    if (body) body.textContent = StagingDebug._lines.join('\n');
  },

  log(msg) {
    if (!StagingDebug.active) return;
    let t = '';
    try { t = new Date().toISOString().slice(11, 23) + '  '; } catch {}
    StagingDebug._lines.push(t + String(msg));
    if (StagingDebug._lines.length > 120) StagingDebug._lines.shift();
    StagingDebug._panel();
    StagingDebug._render();
  },

  // Snapshot an element's reveal-relevant computed style + bounding rect.
  snapshot(el, label) {
    if (!StagingDebug.active) return;
    if (!el) { StagingDebug.log(label + ': <element MISSING>'); return; }
    let cs = {};
    try { cs = getComputedStyle(el); } catch {}
    let r = { width: '?', height: '?', x: '?', y: '?' };
    try {
      const b = el.getBoundingClientRect();
      r = { width: Math.round(b.width), height: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
    } catch {}
    StagingDebug.log(
      label + ': hidden=' + el.classList.contains('hidden')
      + ' display=' + cs.display + ' visibility=' + cs.visibility
      + ' opacity=' + cs.opacity + ' z=' + cs.zIndex
      + ' pointer-events=' + cs.pointerEvents
      + ' rect=' + r.width + 'x' + r.height + '@' + r.x + ',' + r.y
    );
  },
};

window.StagingDebug = StagingDebug;
// Arm immediately (don't wait for DOMContentLoaded — fetch works now, and
// the overlay is only built lazily on the first log()).
StagingDebug.init();
