'use strict';

/* PIXORA app shell.
 *
 * Everything a page is built from lives here as small string-returning
 * components: Sidebar, PageHeader, Card, Button and the tool placeholder.
 * The TOOLS registry below drives the sidebar, the routes and the pages,
 * so adding a tool later means adding one entry (plus its real UI inside
 * `renderTool` when it exists), nothing else.
 *
 * Routing is hash-based (`#/creative`, `#/upscale`, ...) so every page is
 * deep-linkable from the single static document this app ships as.
 */

/* Lucide icons (ISC licence), inline so the page loads with no external
 * assets. Each entry is the inner markup of a 24-unit, 2px-stroke icon. */
const PX_ICONS = {
  sparkles:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>'
    + '<path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  'maximize-2':
    '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  eraser:
    '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/>'
    + '<path d="m5.082 11.09 8.828 8.828"/>',
  tags:
    '<path d="M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z"/>'
    + '<path d="M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193"/>'
    + '<circle cx="10.5" cy="6.5" r=".5" fill="currentColor"/>',
  'wand-2':
    '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/>'
    + '<path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/>'
    + '<path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/** One Lucide icon at `size` px, stroked with the current text colour. */
function pxIcon(name, size) {
  const s = size || 20;
  return (
    '<span class="pixora-icon" aria-hidden="true">'
    + `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" `
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round">'
    + (PX_ICONS[name] || '')
    + '</svg></span>'
  );
}

/* ── The tool registry ─────────────────────────────────────────────────── */

const PX_TOOLS = [
  {
    id: 'creative',
    name: 'Creative',
    icon: 'sparkles',
    description: 'Generate and edit images from a text prompt.',
    placeholder:
      'The creative canvas will live here. Describe an image, generate '
      + 'variations and refine the result without leaving the page.',
  },
  {
    id: 'upscale',
    name: 'Upscale Image',
    icon: 'maximize-2',
    description: 'Increase the resolution of an image while keeping details sharp.',
    placeholder:
      'The upscaler will live here. Drop in an image, choose a target size '
      + 'and compare the result against the original.',
  },
  {
    id: 'remove-background',
    name: 'Remove Background',
    icon: 'eraser',
    description: 'Cut the subject out of a photo with a transparent background.',
    placeholder:
      'The background remover will live here. Upload a photo, preview the '
      + 'cut-out and download it as a transparent PNG.',
  },
  {
    id: 'metadata',
    name: 'Metadata AI',
    icon: 'tags',
    description: 'Read, write and clean up the metadata of your image files.',
    placeholder:
      'The metadata editor will live here. Inspect a file, edit its titles, '
      + 'descriptions and keywords, and clear what should not ship.',
  },
  {
    id: 'prompt',
    name: 'Prompt Generator',
    icon: 'wand-2',
    description: 'Turn a rough idea into a detailed, reusable prompt.',
    placeholder:
      'The prompt builder will live here. Start from a rough idea and shape '
      + 'it into a prompt you can reuse in any AI tool.',
  },
];

const PX_DEFAULT_ROUTE = 'creative';

/* ── Components ────────────────────────────────────────────────────────── */

/** Sidebar navigation. The same element is the off-canvas drawer on mobile. */
function pxSidebar(tools, activeId) {
  const items = tools.map((tool) => {
    const current = tool.id === activeId;
    return (
      `<a class="pixora-nav-item" href="#/${tool.id}"`
      + (current ? ' aria-current="page"' : '')
      + `>${pxIcon(tool.icon, 18)}<span>${tool.name}</span></a>`
    );
  }).join('');
  return (
    `<aside class="pixora-sidebar" id="pixora-sidebar">`
    + `<button class="pixora-icon-btn pixora-sidebar-close" type="button"`
    + ` data-px-close aria-label="Close menu" aria-controls="pixora-sidebar">`
    + `${pxIcon('x', 20)}</button>`
    + `<div class="pixora-brand"><span class="pixora-brand-name">PIXORA</span>`
    + `<span class="pixora-brand-sub">AI Creative Tools</span></div>`
    + `<nav class="pixora-nav" aria-label="Tools">`
    + `<div class="pixora-nav-label">Tools</div>${items}</nav>`
    + `<div class="pixora-sidebar-foot">5 tools</div>`
    + `</aside>`
  );
}

/** The title and one-line description every tool page opens with. */
function pxPageHeader(tool) {
  return (
    `<header class="pixora-page-head"><h1 class="pixora-page-title">`
    + `${tool.name}</h1><p class="pixora-page-desc">${tool.description}</p>`
    + `</header>`
  );
}

/** A rounded surface with a hairline border. Everything on a page sits in one. */
function pxCard(inner) {
  return `<div class="pixora-card">${inner}</div>`;
}

/** Primary and secondary actions. Tool pages adopt these as their UIs land. */
function pxButton(label, variant) {
  const cls = variant === 'secondary' ? 'pixora-btn pixora-btn-secondary'
    : 'pixora-btn pixora-btn-primary';
  return `<button type="button" class="${cls}">${label}</button>`;
}

/** The empty state a tool page shows until its real UI ships. */
function pxPlaceholder(tool) {
  return pxCard(
    `<div class="pixora-placeholder">`
    + `<div class="pixora-placeholder-icon">${pxIcon(tool.icon, 26)}</div>`
    + `<h2 class="pixora-placeholder-title">The ${tool.name} workspace will live here</h2>`
    + `<p class="pixora-placeholder-text">${tool.placeholder}</p>`
    + `</div>`
  );
}

/* ── Router ────────────────────────────────────────────────────────────── */

function pxCurrentRoute() {
  const id = String(window.location.hash || '')
    .replace(/^#\/?/, '').split('/')[0];
  return PX_TOOLS.some((tool) => tool.id === id) ? id : PX_DEFAULT_ROUTE;
}

function pxRender() {
  const activeId = pxCurrentRoute();
  const tool = PX_TOOLS.find((t) => t.id === activeId);
  const app = document.getElementById('pixora-app');
  app.innerHTML =
    pxSidebar(PX_TOOLS, activeId)
    + `<div class="pixora-body">`
    + `<header class="pixora-topbar">`
    + `<button class="pixora-icon-btn" type="button" id="pixora-menu-btn"`
    + ` aria-label="Open menu" aria-controls="pixora-sidebar"`
    + ` aria-expanded="false">${pxIcon('menu', 20)}</button>`
    + `<span class="pixora-topbar-title">PIXORA</span>`
    + `</header>`
    + `<main class="pixora-main"><div class="pixora-content">`
    + pxPageHeader(tool)
    + pxPlaceholder(tool)
    + `</div></main></div>`;

  document.title = `${tool.name} · PIXORA`;

  const sidebar = app.querySelector('#pixora-sidebar');
  const backdrop = document.createElement('div');
  backdrop.className = 'pixora-backdrop';
  app.appendChild(backdrop);

  const setOpen = (open) => {
    sidebar.classList.toggle('pixora-open', open);
    backdrop.classList.toggle('pixora-open', open);
    app.querySelector('#pixora-menu-btn').setAttribute('aria-expanded', String(open));
    if (open) sidebar.querySelector('[data-px-close]').focus();
  };

  app.querySelector('#pixora-menu-btn').addEventListener('click', () => setOpen(true));
  sidebar.querySelector('[data-px-close]').addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('pixora-open')) {
      setOpen(false);
      app.querySelector('#pixora-menu-btn').focus();
    }
  });
}

window.addEventListener('hashchange', pxRender);
pxRender();
