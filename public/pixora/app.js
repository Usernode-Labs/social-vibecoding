'use strict';

/* PIXORA: the AI creative toolkit for microstock creators.
 *
 * Everything a page is built from lives here as small string-returning
 * components: Sidebar, PageHeader, FeatureCard, Card, Button, form fields,
 * the upload dropzone, the before/after comparison and the status note.
 * The TOOLS registry drives the sidebar, the routes, the dashboard cards
 * and the pages, so adding a tool later means adding one entry and one
 * page renderer, nothing else.
 *
 * Nothing here calls an external API. Uploads are read locally with the
 * File API purely to drive the preview, and every processing button states
 * plainly that its engine connects in a later update. That boundary is the
 * architecture: a tool's real work lands inside its page renderer.
 *
 * Routing is path-based under /pixora: the dashboard is /pixora/ and each
 * tool owns its own route (/pixora/creative, ...). server.js serves this
 * same static document for all of them, and the router below reads
 * location.pathname, so every page is deep-linkable.
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
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>'
    + '<circle cx="12" cy="12" r="3"/>',
  'cloud-upload':
    '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/>'
    + '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  copy:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'
    + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'rotate-ccw':
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
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

const PX_BASE = '/pixora';

/* ── The tool registry ─────────────────────────────────────────────────── */
/* `description` is the dashboard card line AND the page's own description,
 * so the two surfaces never disagree about what a tool is for. */

const PX_TOOLS = [
  {
    id: 'creative',
    name: 'Creative',
    icon: 'sparkles',
    description: 'Generate commercial stock-ready visual concepts and assets.',
  },
  {
    id: 'upscale',
    name: 'Upscale Image',
    icon: 'maximize-2',
    description: 'Increase image resolution and improve detail before submission.',
  },
  {
    id: 'remove-background',
    name: 'Remove Background',
    icon: 'eraser',
    description: 'Create clean isolated assets with transparent backgrounds.',
  },
  {
    id: 'metadata',
    name: 'Metadata AI',
    icon: 'tags',
    description: 'Generate titles, descriptions, keywords and categories for stock assets.',
  },
  {
    id: 'prompt-generator',
    name: 'Prompt Generator',
    icon: 'wand-2',
    description: 'Create optimized prompts for generating commercially useful stock content.',
  },
];

/* ── Shared components ─────────────────────────────────────────────────── */

/** A rounded surface with a hairline border. Everything on a page sits in one. */
function pxCard(inner) {
  return `<div class="pixora-card">${inner}</div>`;
}

/** The title and one-line description a page opens with. */
function pxPageHeader(title, description) {
  return (
    `<header class="pixora-page-head"><h1 class="pixora-page-title">`
    + `${title}</h1><p class="pixora-page-desc">${description}</p></header>`
  );
}

/** Primary and secondary actions. `action` names the handler wired per page. */
function pxButton(label, opts) {
  const o = opts || {};
  const cls = o.secondary ? 'pixora-btn pixora-btn-secondary' : 'pixora-btn pixora-btn-primary';
  return (
    `<button type="button" class="${cls}"${o.action ? ` data-px-action="${o.action}"` : ''}>`
    + (o.icon ? pxIcon(o.icon, 16) : '') + `<span>${label}</span></button>`
  );
}

/** An inline status line a page reveals instead of pretending work happened. */
function pxStatus(text) {
  return `<p class="pixora-status" data-px-status${text ? '' : ' hidden'}>`
    + `${text || ''}</p>`;
}

function pxShowStatus(root, message) {
  const el = root.querySelector('[data-px-status]');
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
}

/** A labelled form field. `control` is a select/input/textarea's markup. */
function pxField(label, control, hint) {
  return (
    `<div class="pixora-field"><label class="pixora-label">${label}</label>`
    + `${control}${hint ? `<span class="pixora-hint">${hint}</span>` : ''}</div>`
  );
}

function pxSelect(name, options, selected) {
  const opts = options.map((opt) => {
    const value = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    const isSel = value === selected;
    return `<option value="${value}"${isSel ? ' selected' : ''}>${label}</option>`;
  }).join('');
  return `<select class="pixora-input" name="${name}">${opts}</select>`;
}

function pxTextarea(name, placeholder, rows, value) {
  return (
    `<textarea class="pixora-input" name="${name}" rows="${rows || 3}"`
    + ` placeholder="${placeholder || ''}">${value || ''}</textarea>`
  );
}

function pxInput(name, placeholder, value) {
  return (
    `<input class="pixora-input" type="text" name="${name}"`
    + `${placeholder ? ` placeholder="${placeholder}"` : ''} value="${value || ''}">`
  );
}

/** The upload dropzone. Wired by pxWireUpload, which owns the preview. */
function pxUpload(hint) {
  return (
    `<div class="pixora-drop" data-px-drop tabindex="0" role="button"`
    + ` aria-label="Upload an image">`
    + `<span class="pixora-drop-icon">${pxIcon('cloud-upload', 26)}</span>`
    + `<span class="pixora-drop-title">Drop an image here or browse</span>`
    + `<span class="pixora-drop-hint">${hint || 'PNG, JPEG or WebP'}</span>`
    + `<input type="file" accept="image/png,image/jpeg,image/webp"`
    + ` class="pixora-drop-input" data-px-file>`
    + `</div>`
    + `<div class="pixora-preview" data-px-preview hidden>`
    + `<img alt="Uploaded image preview" data-px-preview-img>`
    + `</div>`
  );
}

/** Drag, drop, browse and preview one image, entirely in the browser.
 * `onImage(file, url, width, height)` runs once the dimensions are known. */
function pxWireUpload(root, onImage) {
  const drop = root.querySelector('[data-px-drop]');
  const input = root.querySelector('[data-px-file]');
  const preview = root.querySelector('[data-px-preview]');
  const img = root.querySelector('[data-px-preview-img]');
  if (!drop || !input) return;

  let lastUrl = null;
  const accept = (file) => {
    if (!file || !/^image\//.test(file.type)) return;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(file);
    img.onload = () => {
      preview.hidden = false;
      if (onImage) onImage(file, lastUrl, img.naturalWidth, img.naturalHeight);
    };
    img.src = lastUrl;
  };

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('pixora-drop-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('pixora-drop-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('pixora-drop-over');
    accept(event.dataTransfer.files && event.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => accept(input.files && input.files[0]));
}

/** A two-pane before/after comparison. `transparent` gives the right pane a
 * checkerboard so a future transparent PNG reads correctly. */
function pxCompare(leftTitle, rightTitle, transparent) {
  const pane = (side, title, body) =>
    `<div class="pixora-compare-pane">`
    + `<div class="pixora-compare-label">${title}</div>`
    + `<div class="pixora-compare-body${transparent && side === 'right' ? ' pixora-checker' : ''}"`
    + ` data-px-${side}-body>${body}</div></div>`;
  const empty = (text) =>
    `<div class="pixora-compare-empty">${pxIcon('image', 22)}<span>${text}</span></div>`;
  return (
    `<div class="pixora-compare">`
    + pane('left', leftTitle, empty('Nothing loaded yet'))
    + pane('right', rightTitle, empty('The result appears here'))
    + `</div>`
  );
}

function pxCompareFill(root, side, url) {
  const body = root.querySelector(`[data-px-${side}-body]`);
  if (!body) return;
  body.innerHTML = `<img src="${url}" alt="">`;
}

/* ── Sidebar ───────────────────────────────────────────────────────────── */

/** Dark sidebar. The brand returns to the dashboard, the five tools are the
 * only nav items, and Settings sits at the bottom as its own entry. */
function pxSidebar(activeId) {
  const items = PX_TOOLS.map((tool) => {
    const current = tool.id === activeId;
    return (
      `<a class="pixora-nav-item" href="${PX_BASE}/${tool.id}"`
      + (current ? ' aria-current="page"' : '')
      + `>${pxIcon(tool.icon, 18)}<span>${tool.name}</span></a>`
    );
  }).join('');
  return (
    `<aside class="pixora-sidebar" id="pixora-sidebar">`
    + `<button class="pixora-icon-btn pixora-sidebar-close" type="button"`
    + ` data-px-close aria-label="Close menu" aria-controls="pixora-sidebar">`
    + `${pxIcon('x', 20)}</button>`
    + `<a class="pixora-brand" href="${PX_BASE}/" aria-label="PIXORA dashboard">`
    + `<span class="pixora-brand-name">PIXORA</span></a>`
    + `<nav class="pixora-nav" aria-label="Tools">`
    + `<div class="pixora-nav-label">Tools</div>${items}</nav>`
    + `<div class="pixora-sidebar-foot">`
    + `<a class="pixora-nav-item" href="${PX_BASE}/settings"`
    + (activeId === 'settings' ? ' aria-current="page"' : '')
    + `>${pxIcon('settings', 18)}<span>Settings</span></a>`
    + `</div></aside>`
  );
}

/* ── Dashboard ─────────────────────────────────────────────────────────── */

function pxDashboard() {
  const cards = PX_TOOLS.map((tool) =>
    `<a class="pixora-feature" href="${PX_BASE}/${tool.id}">`
    + `<span class="pixora-feature-icon">${pxIcon(tool.icon, 22)}</span>`
    + `<span class="pixora-feature-name">${tool.name}</span>`
    + `<span class="pixora-feature-desc">${tool.description}</span>`
    + `</a>`).join('');
  return (
    pxPageHeader('AI Creative Toolkit for Microstock',
      'Create, enhance and prepare commercial-ready visual assets for stock marketplaces.')
    + `<div class="pixora-feature-grid">${cards}</div>`
  );
}

/* ── Page renderers ────────────────────────────────────────────────────── */
/* Each returns the page's markup. Wiring happens in pxWire below, keyed by
 * the same route id. When a tool's real engine arrives, its API call goes
 * exactly where the preview status note is shown today. */

const STOCK_CATEGORIES = [
  'Business', 'Food and Drink', 'Nature', 'People', 'Technology',
  'Health and Wellness', 'Travel', 'Backgrounds and Textures', 'Animals', 'Objects',
];

function pxPageCreative() {
  return (
    pxPageHeader('Creative', PX_TOOLS[0].description)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Generation</div>`
      + pxField('Prompt', pxTextarea('prompt',
        'Describe the stock image you want, e.g. a flat lay of fresh berries '
        + 'on a marble surface with copy space on the left.', 3),
        'One clear scene works best: subject, setting, light and mood.')
      + pxField('Negative Prompt', pxTextarea('negative',
        'What to avoid: logos, brand names, text, watermarks, distorted hands.', 2))
      + `<div class="pixora-field-row">`
      + pxField('Style', pxSelect('style', [
        'Photorealistic', 'Illustration', 'Flat vector', 'Watercolor',
        '3D render', 'Line art']))
      + pxField('Aspect Ratio', pxSelect('aspect',
        ['1:1', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16']))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Number of Images', pxSelect('count', ['1', '2', '4', '6', '8']))
      + pxField('Model', pxSelect('model', [
        'Pixora Standard', 'Pixora Quality', 'Pixora Batch']))
      + `</div>`
      + pxStatus()
      + `<div class="pixora-actions">`
      + pxButton('Generate Images', { action: 'generate' })
      + `<span class="pixora-hint">The generation engine connects in a later update.</span>`
      + `</div></div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Batch queue</div>`
      + `<p class="pixora-card-text">Queue many stock concepts at once: paste one prompt per line and Creative will generate a variation for each when batch generation connects.</p>`
      + pxTextarea('batch', 'One prompt per line, each a distinct stock concept.', 4)
      + `<div class="pixora-batch-foot"><span data-px-batch-count>0 prompts queued</span></div>`
      + `</div>`)
  );
}

function pxPageUpscale() {
  return (
    pxPageHeader('Upscale Image', PX_TOOLS[1].description)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Upload</div>`
      + pxUpload('PNG, JPEG or WebP, processed in the browser for this preview')
      + `<div class="pixora-meta-row"><span>Original resolution</span>`
      + `<strong data-px-orig>Not loaded yet</strong></div>`
      + `<div class="pixora-meta-row"><span>Output resolution</span>`
      + `<strong data-px-out>Not loaded yet</strong></div>`
      + `<div class="pixora-field"><span class="pixora-label">Scale</span>`
      + `<div class="pixora-seg" role="group" aria-label="Scale">`
      + `<button type="button" class="pixora-seg-btn" data-px-scale="2" aria-pressed="true">2x</button>`
      + `<button type="button" class="pixora-seg-btn" data-px-scale="4" aria-pressed="false">4x</button>`
      + `</div></div>`
      + pxStatus()
      + `<div class="pixora-actions">`
      + pxButton('Upscale Image', { action: 'upscale' })
      + `<span class="pixora-hint">The upscaling engine connects in a later update.</span>`
      + `</div></div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Before and after</div>`
      + pxCompare('Original', 'Upscaled result')
      + `</div>`)
  );
}

function pxPageRemoveBackground() {
  return (
    pxPageHeader('Remove Background', PX_TOOLS[2].description)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Upload</div>`
      + pxUpload('A clear subject on any background works best')
      + pxStatus()
      + `<div class="pixora-actions">`
      + pxButton('Remove Background', { action: 'removebg' })
      + `<span class="pixora-hint">The cut-out engine connects in a later update.</span>`
      + `</div></div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Before and after</div>`
      + pxCompare('Original image', 'Processed result', true)
      + `<p class="pixora-card-text">The processed result previews over a checkerboard, the way a transparent PNG will read once the cut-out engine connects. Ideal for isolated objects, products and icons.</p>`
      + `</div>`)
  );
}

const PX_EXAMPLE_METADATA = {
  title: 'Fresh pineapple slices on a white marble kitchen counter',
  description:
    'Sliced pineapple arranged on bright white marble with soft natural '
    + 'window light. Clean, minimal food photography with generous copy '
    + 'space, ready for food blogs, packaging and healthy eating campaigns.',
  primary: ['pineapple', 'tropical fruit', 'fruit slices'],
  secondary: [
    'healthy eating', 'food photography', 'white marble', 'fresh fruit',
    'summer', 'juicy', 'organic', 'vitamin', 'copy space', 'minimal',
    'bright', 'raw food', 'vegan', 'diet',
  ],
  category: 'Food and Drink',
};

function pxPageMetadata() {
  const ex = PX_EXAMPLE_METADATA;
  const chip = (word, primary) =>
    `<span class="pixora-chip${primary ? ' pixora-chip-primary' : ''}">${word}</span>`;
  const keywords =
    ex.primary.map((w) => chip(w, true)).join('')
    + ex.secondary.map((w) => chip(w, false)).join('');
  return (
    pxPageHeader('Metadata AI', PX_TOOLS[3].description)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Upload</div>`
      + pxUpload('The image stays in your browser for this preview')
      + `</div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Metadata</div>`
      + `<p class="pixora-card-text">Example metadata for a stock food shot, shown until you upload an image. The generated set will include a stock-friendly title, a natural description, primary and secondary keywords, and a suggested category.</p>`
      + pxField('Title', pxInput('title', '', ex.title))
      + pxField('Description', pxTextarea('description', '', 3, ex.description))
      + pxField('Keywords', `<div class="pixora-chips">${keywords}</div>`,
        'The first group is primary keywords; the rest are secondary search terms.')
      + pxField('Category', pxSelect('category', STOCK_CATEGORIES, ex.category))
      + pxStatus()
      + `<div class="pixora-actions">`
      + pxButton('Generate Metadata', { action: 'metadata' })
      + `<span class="pixora-hint">The metadata model connects in a later update.</span>`
      + `</div></div>`)
  );
}

/* Prompt templates the generator cycles through. Each keeps the commercial
 * guardrails in the request: no logos, brands, trademarks, famous
 * characters or celebrity likenesses. */
const PX_PROMPT_TEMPLATES = [
  (s) => `Professional ${s.type.toLowerCase()} of ${s.subject}, ${s.style} style, `
    + `${s.composition.toLowerCase()}, ${s.lighting.toLowerCase()}, `
    + `${s.background}, ${s.mood}, ${s.lens}, natural and authentic, generous `
    + `copy space for headlines, no logos or brand names, no trademarks, no `
    + `famous characters or celebrity likenesses, commercially usable, clean `
    + `and uncluttered, high resolution${s.aspect === '1:1' ? '' : `, ${s.aspect} aspect ratio`}`,
  (s) => `A ${s.style.toLowerCase()} ${s.type.toLowerCase()} for stock marketplaces: `
    + `${s.subject}, composed as a ${s.composition.toLowerCase()} with `
    + `${s.lighting.toLowerCase()}, set against ${s.background}. Color and mood: `
    + `${s.mood}. Camera: ${s.lens.toLowerCase()}. Suitable for commercial `
    + `licensing, free of logos, brand names, trademarks and recognizable people, `
    + `rendered in high resolution${s.aspect === '1:1' ? '' : ` at ${s.aspect}`}`,
  (s) => `${s.aspect === '1:1' ? 'Square' : `${s.aspect}`} ${s.type.toLowerCase()}: `
    + `${s.subject}. ${s.composition}, ${s.lighting}, ${s.background}. `
    + `${s.mood}, ${s.lens}. Original and generic enough for commercial stock: `
    + `no logos, no brand names, no trademarks, no famous characters, no `
    + `celebrity likenesses, sharp detail, professional finish`,
];

function pxPagePromptGenerator() {
  return (
    pxPageHeader('Prompt Generator', PX_TOOLS[4].description)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Brief</div>`
      + `<div class="pixora-field-row pixora-field-row-wide">`
      + pxField('Subject', pxInput('subject',
        'e.g. a modern home office desk with a laptop and a coffee cup'))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Content Type', pxSelect('type', [
        'Stock photo', 'Illustration', 'Flat vector', '3D render',
        'Background or texture']))
      + pxField('Style', pxSelect('style', [
        'Bright and airy', 'Minimal', 'Warm and natural', 'Corporate clean',
        'Vibrant', 'Monochrome']))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Composition', pxSelect('composition', [
        'Wide shot with copy space', 'Close-up detail', 'Top-down flat lay',
        'Centered subject', 'Rule of thirds']))
      + pxField('Lighting', pxSelect('lighting', [
        'Soft natural window light', 'Golden hour', 'Studio softbox',
        'Bright and even', 'Dramatic side light']))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Camera / Lens', pxSelect('lens', [
        '85mm f/1.8 look', '50mm standard look', '100mm macro look',
        '24mm wide look', 'Not camera specific']))
      + pxField('Aspect Ratio', pxSelect('aspect',
        ['1:1', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16']))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Background', pxInput('background',
        'e.g. a clean white studio background'))
      + pxField('Color / Mood', pxInput('mood',
        'e.g. a soft neutral palette, calm and productive'))
      + `</div>`
      + `</div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Optional</div>`
      + `<div class="pixora-field-row">`
      + pxField('Commercial Use', pxSelect('commercial', [
        { value: 'strict', label: 'Strict: avoid logos, brands, trademarks and likenesses' },
        { value: 'standard', label: 'Standard: avoid trademarks and famous characters' }]))
      + pxField('Target Stock Category', pxSelect('category', STOCK_CATEGORIES))
      + `</div>`
      + `<div class="pixora-field-row">`
      + pxField('Number of Variations', pxSelect('variations', ['1', '2', '3', '4']))
      + `</div>`
      + `</div>`)
    + pxCard(
      `<div class="pixora-form">`
      + `<div class="pixora-card-title">Generated Prompt</div>`
      + `<p class="pixora-prompt" data-px-prompt></p>`
      + pxStatus()
      + `<div class="pixora-actions">`
      + pxButton('Copy Prompt', { secondary: true, icon: 'copy', action: 'copy' })
      + pxButton('Regenerate', { secondary: true, icon: 'rotate-ccw', action: 'regen' })
      + `<span class="pixora-hint">Built from your brief in the browser until the generator connects.</span>`
      + `</div></div>`)
  );
}

function pxPageSettings() {
  const rows = [
    ['Marketplace accounts', 'Connect the stock marketplaces you sell on'],
    ['Default export size', 'The resolution new exports are prepared at'],
    ['Watermark presets', 'How drafts are marked before submission'],
  ].map(([name, hint]) =>
    `<div class="pixora-setting"><div class="pixora-setting-name">${name}</div>`
    + `<div class="pixora-setting-hint">${hint}</div>`
    + `<span class="pixora-setting-state">Later update</span></div>`).join('');
  return (
    pxPageHeader('Settings', 'Workspace preferences and marketplace connections.')
    + pxCard(`<div class="pixora-settings">${rows}</div>`)
  );
}

const PX_PAGES = {
  creative: pxPageCreative,
  upscale: pxPageUpscale,
  'remove-background': pxPageRemoveBackground,
  metadata: pxPageMetadata,
  'prompt-generator': pxPagePromptGenerator,
  settings: pxPageSettings,
};

/* ── Router ────────────────────────────────────────────────────────────── */

function pxCurrentRoute() {
  const path = window.location.pathname;
  const rest = path.startsWith(PX_BASE)
    ? path.slice(PX_BASE.length).replace(/\/+$/, '')
    : '';
  if (rest === '' || rest === '/index.html') return null; // dashboard
  const id = rest.slice(1);
  return PX_PAGES[id] ? id : null;
}

function pxRender() {
  const activeId = pxCurrentRoute();
  const app = document.getElementById('pixora-app');
  app.innerHTML =
    pxSidebar(activeId)
    + `<div class="pixora-body">`
    + `<header class="pixora-topbar">`
    + `<button class="pixora-icon-btn" type="button" id="pixora-menu-btn"`
    + ` aria-label="Open menu" aria-controls="pixora-sidebar"`
    + ` aria-expanded="false">${pxIcon('menu', 20)}</button>`
    + `<a class="pixora-topbar-title" href="${PX_BASE}/">PIXORA</a>`
    + `</header>`
    + `<main class="pixora-main"><div class="pixora-content">`
    + (activeId ? PX_PAGES[activeId]() : pxDashboard())
    + `</div></main></div>`
    + `<div class="pixora-backdrop" data-px-backdrop></div>`;

  document.title = activeId
    ? `${PX_TOOLS.find((t) => t.id === activeId)?.name || 'Settings'} · PIXORA`
    : 'PIXORA · AI Creative Toolkit for Microstock';

  const sidebar = app.querySelector('#pixora-sidebar');
  const backdrop = app.querySelector('[data-px-backdrop]');

  const setOpen = (open) => {
    sidebar.classList.toggle('pixora-open', open);
    backdrop.classList.toggle('pixora-open', open);
    app.querySelector('#pixora-menu-btn').setAttribute('aria-expanded', String(open));
    if (open) sidebar.querySelector('[data-px-close]').focus();
  };

  app.querySelector('#pixora-menu-btn').addEventListener('click', () => setOpen(true));
  sidebar.querySelector('[data-px-close]').addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));

  if (activeId) pxWire(activeId, app);
}

/* Per-page wiring. Each handler is the seam where the real engine call
 * lands; today they all state plainly that the engine is not connected. */
function pxWire(route, root) {
  if (route === 'creative') {
    const batch = root.querySelector('[name="batch"]');
    const count = root.querySelector('[data-px-batch-count]');
    if (batch && count) {
      const update = () => {
        const n = batch.value.split('\n').filter((l) => l.trim()).length;
        count.textContent = `${n} prompt${n === 1 ? '' : 's'} queued`;
      };
      batch.addEventListener('input', update);
      update();
    }
  }

  if (route === 'upscale' || route === 'remove-background') {
    const state = { width: 0, height: 0, scale: 2 };
    const orig = root.querySelector('[data-px-orig]');
    const out = root.querySelector('[data-px-out]');
    const showRes = () => {
      if (!state.width || !orig || !out) return;
      orig.textContent = `${state.width} × ${state.height} px`;
      out.textContent = `${state.width * state.scale} × ${state.height * state.scale} px`;
    };
    pxWireUpload(root, (_file, url, w, h) => {
      state.width = w;
      state.height = h;
      showRes();
      pxCompareFill(root, 'left', url);
    });
    if (route === 'upscale') {
      root.querySelectorAll('[data-px-scale]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.scale = Number(btn.dataset.pxScale);
          root.querySelectorAll('[data-px-scale]').forEach((b) =>
            b.setAttribute('aria-pressed', String(b === btn)));
          showRes();
        });
      });
    }
  } else if (route === 'metadata') {
    // The upload only drives the preview here; the metadata card below is
    // where a generated set will land.
    pxWireUpload(root);
  }

  const action = (name) => root.querySelector(`[data-px-action="${name}"]`);
  const on = (name, fn) => {
    const btn = action(name);
    if (btn) btn.addEventListener('click', fn);
  };
  const notConnected = (what) =>
    pxShowStatus(root, `Preview only: ${what} is not connected yet in this build.`);

  on('generate', () => notConnected('image generation'));
  on('upscale', () => notConnected('upscaling'));
  on('removebg', () => notConnected('background removal'));
  on('metadata', () => notConnected('metadata generation'));

  if (route === 'prompt-generator') {
    let cycle = 0;
    const read = () => ({
      subject: (root.querySelector('[name="subject"]').value || '').trim()
        || 'a modern home office desk with a laptop and a coffee cup',
      type: root.querySelector('[name="type"]').value,
      style: root.querySelector('[name="style"]').value,
      composition: root.querySelector('[name="composition"]').value,
      lighting: root.querySelector('[name="lighting"]').value,
      lens: root.querySelector('[name="lens"]').value,
      background: (root.querySelector('[name="background"]').value || '').trim()
        || 'a clean uncluttered background',
      mood: (root.querySelector('[name="mood"]').value || '').trim()
        || 'a calm, natural color palette',
      aspect: root.querySelector('[name="aspect"]').value,
    });
    const out = root.querySelector('[data-px-prompt]');
    const renderPrompt = () => {
      out.textContent = PX_PROMPT_TEMPLATES[cycle % PX_PROMPT_TEMPLATES.length](read());
    };
    renderPrompt();
    // The prompt follows the brief as it is typed or changed.
    root.querySelectorAll('input[name], textarea[name], select[name]')
      .forEach((el) => {
        el.addEventListener('input', renderPrompt);
        el.addEventListener('change', renderPrompt);
      });
    on('regen', () => {
      cycle += 1;
      renderPrompt();
    });
    on('copy', async () => {
      try {
        await navigator.clipboard.writeText(out.textContent);
        pxShowStatus(root, 'Prompt copied to your clipboard.');
      } catch {
        pxShowStatus(root, 'Copying was blocked by the browser. Select the prompt and copy it by hand.');
      }
    });
  }
}

/* In-app links swap the page in place; every PIXORA link is a real href, so
 * the routes also work as plain deep links before this script runs. */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest(`a[href^="${PX_BASE}"]`);
  if (!link) return;
  event.preventDefault();
  if (link.getAttribute('href') !== window.location.pathname) {
    history.pushState({}, '', link.getAttribute('href'));
  }
  pxRender();
});

window.addEventListener('popstate', pxRender);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const sidebar = document.querySelector('#pixora-sidebar.pixora-open');
  if (!sidebar) return;
  sidebar.classList.remove('pixora-open');
  const backdrop = document.querySelector('[data-px-backdrop].pixora-open');
  if (backdrop) backdrop.classList.remove('pixora-open');
  const menuBtn = document.getElementById('pixora-menu-btn');
  if (menuBtn) {
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus();
  }
});

pxRender();



