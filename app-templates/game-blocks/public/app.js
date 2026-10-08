// The block world's screen: the world drawn in 3D with three.js (vendored
// in public/vendor, never from a CDN), the palette and the build/erase
// switch, and who is building now. The game room (public/game/room.js)
// sends the whole world when the page opens and then each block as anyone
// places or removes it; where each builder is pointing comes in frames.
// Every block goes to the server, whose rules (game/rules.js) check it.
//
// Controls: tap (or click) the ground or a block to build on it; in Erase,
// tap a block to take it away (on a computer, right-click does too). Drag
// to look around; pinch or scroll to zoom.
//
// The world is a scene of its own, the same sky in both looks (CLAUDE.md
// "## Design" says so); the page around it is the design kit. Rendering
// builds elements and sets textContent, never innerHTML with people's words.

import * as THREE from './vendor/three.module.min.js';

const el = {
  connection: document.getElementById('connection'),
  loading: document.getElementById('loading'),
  error: document.getElementById('error'),
  game: document.getElementById('game'),
  mode: document.getElementById('mode'),
  palette: document.getElementById('palette'),
  world: document.getElementById('world'),
  canvas: document.getElementById('world-canvas'),
  labels: document.getElementById('labels'),
  no3d: document.getElementById('no-3d'),
  count: document.getElementById('count'),
  builders: document.getElementById('builders'),
  empty: document.getElementById('empty'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text'),
};

// The palette, by the index the server stores. Its names are what a
// screen reader says for each swatch.
const PALETTE = [
  ['#5a9e4b', 'Leaf green'], ['#8d939b', 'Stone grey'], ['#a0703f', 'Wood brown'], ['#b5493a', 'Brick red'],
  ['#e3cf8d', 'Sand'], ['#7fc4e8', 'Glass blue'], ['#f4f4f0', 'White'], ['#2e3138', 'Charcoal'],
  ['#f2c230', 'Sunflower yellow'], ['#8a5cc8', 'Violet'],
];
const SKY = '#bfe1f6';
const GROUND = '#7fb069';
const MAX_BLOCKS = 20000;

let view = null;
let size = { x: 32, y: 16, z: 32 };
const blocks = new Map(); // "x,y,z" -> colour
let colour = 2;
let mode = 'build';
let others = []; // [id, username, x, y, z, c, erase]
let hidden = false;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message) {
  el.toastText.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

const keyOf = (x, y, z) => `${x},${y},${z}`;

// ── The scene ────────────────────────────────────────────────────────────

// Can this browser draw in 3D at all? Asked on a spare canvas, so a "no"
// is a message on the page, not an error in the console.
function canDraw() {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

let renderer = null;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 500);
const world = new THREE.Group(); // cell (0,0,0) at a corner; the world is centred on the origin
scene.add(world);
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(18, 40, 12);
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: GROUND }));
ground.rotation.x = -Math.PI / 2;
world.add(ground);
let grid = null;

const cube = new THREE.BoxGeometry(1, 1, 1);
const mesh = new THREE.InstancedMesh(cube, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_BLOCKS);
mesh.count = 0;
world.add(mesh);
let cells = []; // instance index -> [x, y, z]

const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)), new THREE.LineBasicMaterial({ color: 0x111111 }));
ghost.visible = false;
world.add(ghost);
const cursorBoxes = new Map(); // builder id -> { box, label }

function setSize(s) {
  size = s;
  world.position.set(-size.x / 2, 0, -size.z / 2);
  ground.scale.set(size.x, size.z, 1);
  ground.position.set(size.x / 2, 0, size.z / 2);
  if (grid) world.remove(grid);
  grid = new THREE.GridHelper(size.x, size.x, 0x4a7a3c, 0x5f8f50);
  grid.position.set(size.x / 2, 0.01, size.z / 2);
  world.add(grid);
}

function rebuild() {
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  cells = [];
  let i = 0;
  for (const [k, col] of blocks) {
    if (i >= MAX_BLOCKS) break;
    const [x, y, z] = k.split(',').map(Number);
    m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(PALETTE[col] ? PALETTE[col][0] : PALETTE[0][0]));
    cells.push([x, y, z]);
    i += 1;
  }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  el.count.textContent = blocks.size + (blocks.size === 1 ? ' block' : ' blocks');
  draw();
}

// ── Looking around: drag to orbit, pinch or scroll to zoom ───────────────

const orbit = { theta: 0.8, phi: 0.95, radius: 36 };
function placeCamera() {
  const target = new THREE.Vector3(0, 3, 0);
  camera.position.set(
    target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    target.y + orbit.radius * Math.cos(orbit.phi),
    target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
  );
  camera.lookAt(target);
}

let needsDraw = true;
function draw() { needsDraw = true; }

function resize() {
  if (!renderer) return;
  const rect = el.canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const hgt = Math.max(1, Math.round(rect.height));
  const c = renderer.getSize(new THREE.Vector2());
  if (c.x !== w || c.y !== hgt) {
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    draw();
  }
}

function loop() {
  requestAnimationFrame(loop);
  if (!renderer || hidden) return;
  resize();
  if (!needsDraw) return;
  needsDraw = false;
  placeCamera();
  renderer.render(scene, camera);
  placeLabels();
}

// ── Pointing: where a tap would build or erase ───────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// The cell a tap at (clientX, clientY) acts on: { place: [x,y,z] } to build,
// { remove: [x,y,z] } to erase, or null.
function target(clientX, clientY, erase) {
  const rect = el.canvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  placeCamera();
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([mesh, ground], false);
  if (!hits.length) return null;
  const hit = hits[0];
  if (hit.object === mesh && hit.instanceId != null) {
    const cell = cells[hit.instanceId];
    if (erase) return { remove: cell };
    const n = hit.face.normal;
    return { place: [cell[0] + Math.round(n.x), cell[1] + Math.round(n.y), cell[2] + Math.round(n.z)] };
  }
  if (erase) return null;
  const local = world.worldToLocal(hit.point.clone());
  return { place: [Math.floor(local.x), 0, Math.floor(local.z)] };
}

function inWorld(c) {
  return c && c[0] >= 0 && c[0] < size.x && c[1] >= 0 && c[1] < size.y && c[2] >= 0 && c[2] < size.z;
}

function showGhost(t) {
  const cell = t && (t.place || t.remove);
  ghost.visible = !!(cell && inWorld(cell));
  if (ghost.visible) {
    ghost.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
    ghost.material.color.set(t.remove ? '#d62828' : '#111111');
  }
  draw();
}

function apply(t) {
  if (!t) return;
  if (t.place && inWorld(t.place)) {
    const [x, y, z] = t.place;
    if (blocks.has(keyOf(x, y, z))) return;
    // Shown at once; the server's answer (an event, or an error) settles it.
    blocks.set(keyOf(x, y, z), colour);
    rebuild();
    room.act({ type: 'place', x, y, z, c: colour });
  } else if (t.remove) {
    const [x, y, z] = t.remove;
    blocks.delete(keyOf(x, y, z));
    rebuild();
    room.act({ type: 'remove', x, y, z });
  }
}

const pointers = new Map();
let gesture = null; // { x, y, at, moved, pinch }

el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
el.canvas.addEventListener('pointerdown', (e) => {
  el.canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) gesture = { x: e.clientX, y: e.clientY, at: performance.now(), moved: false, button: e.button };
  else if (gesture) gesture.moved = true; // a second finger: a pinch, never a tap
});
el.canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) {
    if (e.pointerType === 'mouse' && renderer) {
      const t = target(e.clientX, e.clientY, mode === 'erase');
      showGhost(t);
      pointAt(t);
    }
    return;
  }
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX;
    p.y = e.clientY;
    const [a2, b2] = [...pointers.values()];
    const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
    if (before > 0) orbit.radius = Math.max(12, Math.min(90, orbit.radius * before / after));
    draw();
    return;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (gesture && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 6) gesture.moved = true;
  if (gesture && gesture.moved) {
    orbit.theta -= dx * 0.008;
    orbit.phi = Math.max(0.25, Math.min(1.45, orbit.phi - dy * 0.006));
    showGhost(null);
    draw();
  }
});
function release(e) {
  pointers.delete(e.pointerId);
  if (!gesture || pointers.size) return;
  const tap = !gesture.moved && performance.now() - gesture.at < 600;
  const erase = mode === 'erase' || gesture.button === 2 || e.shiftKey;
  gesture = null;
  if (tap && renderer) {
    if (!view || !view.you) return toast('Make an account to build.');
    apply(target(e.clientX, e.clientY, erase));
  }
}
el.canvas.addEventListener('pointerup', release);
el.canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; });
el.canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { showGhost(null); pointAt(null); } });
el.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.radius = Math.max(12, Math.min(90, orbit.radius * (e.deltaY > 0 ? 1.08 : 0.92)));
  draw();
}, { passive: false });

// Where you point, for everyone else's screen.
let pointed = null;
function pointAt(t) {
  const cell = t && (t.place || t.remove);
  const next = cell && inWorld(cell) ? { x: cell[0], y: cell[1], z: cell[2], c: colour, erase: !!t.remove } : null;
  if (JSON.stringify(next) === JSON.stringify(pointed)) return;
  pointed = next;
  if (view && view.you) room.input(next);
}

// ── Other builders ───────────────────────────────────────────────────────

function drawOthers() {
  const seen = new Set();
  for (const [id, username, x, y, z, c, erase] of others) {
    if (view && view.you && view.you.id === id) continue;
    seen.add(id);
    let entry = cursorBoxes.get(id);
    if (!entry) {
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.06, 1.06, 1.06)), new THREE.LineBasicMaterial({ color: 0xffffff }));
      world.add(box);
      const label = h('span', 'absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white');
      el.labels.appendChild(label);
      entry = { box, label };
      cursorBoxes.set(id, entry);
    }
    entry.box.position.set(x + 0.5, y + 0.5, z + 0.5);
    entry.box.material.color.set(erase ? '#d62828' : (PALETTE[c] ? PALETTE[c][0] : '#ffffff'));
    entry.label.textContent = '@' + username;
  }
  for (const [id, entry] of cursorBoxes) {
    if (seen.has(id)) continue;
    world.remove(entry.box);
    entry.label.remove();
    cursorBoxes.delete(id);
  }
  draw();
}

function placeLabels() {
  const rect = el.canvas.getBoundingClientRect();
  const v = new THREE.Vector3();
  for (const [, entry] of cursorBoxes) {
    entry.box.getWorldPosition(v);
    v.y += 0.8;
    v.project(camera);
    const behind = v.z > 1;
    entry.label.hidden = behind;
    entry.label.style.left = ((v.x + 1) / 2) * rect.width + 'px';
    entry.label.style.top = ((1 - v.y) / 2) * rect.height + 'px';
  }
}

// ── The page around it ───────────────────────────────────────────────────

function drawPalette() {
  el.palette.textContent = '';
  PALETTE.forEach(([hex, name], i) => {
    const b = h('button', i === colour
      ? 'h-9 w-9 rounded-full border-2 border-fg ring-2 ring-surface'
      : 'h-9 w-9 rounded-full border border-line');
    b.type = 'button';
    b.style.backgroundColor = hex;
    b.setAttribute('data-colour', String(i));
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', i === colour ? 'true' : 'false');
    b.setAttribute('aria-label', name);
    b.title = name;
    b.addEventListener('click', () => { colour = i; setMode('build'); drawPalette(); });
    el.palette.appendChild(b);
  });
}

function setMode(next) {
  mode = next;
  for (const b of el.mode.querySelectorAll('[data-mode]')) {
    const on = b.getAttribute('data-mode') === mode;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.className = on
      ? 'min-h-9 rounded-md bg-accent px-3 text-small font-medium text-on-accent'
      : 'min-h-9 rounded-md px-3 text-small font-medium text-muted hover:bg-raised';
  }
  showGhost(null);
}

function drawBuilders() {
  const here = view.watching.concat(view.players);
  el.builders.textContent = '';
  here.forEach((p) => {
    const li = h('li', 'list-row py-2');
    li.setAttribute('data-builder', String(p.id));
    li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', view.you && view.you.id === p.id ? 'You' : '@' + p.username));
    el.builders.appendChild(li);
  });
  const othersHere = here.filter((p) => !(view.you && view.you.id === p.id));
  el.empty.hidden = !!othersHere.length;
  el.builders.hidden = !here.length;
}

function render(next) {
  const first = !view;
  view = next;
  el.loading.hidden = true;
  el.error.hidden = true;
  el.game.hidden = false;
  if (view.game) {
    if (first || view.game.size.x !== size.x) setSize(view.game.size);
    blocks.clear();
    for (const [x, y, z, c] of view.game.blocks) blocks.set(keyOf(x, y, z), c);
    rebuild();
  }
  drawBuilders();
}

function onEvent(event) {
  if (event.type === 'place') blocks.set(keyOf(event.x, event.y, event.z), event.c);
  else if (event.type === 'remove') blocks.delete(keyOf(event.x, event.y, event.z));
  rebuild();
}

const room = window.GameRoom.connect({
  onView: render,
  onEvent,
  onFrame: (f) => { others = f.cursors || []; drawOthers(); },
  // A refused block: put the world back the way the server has it.
  onError: (message) => {
    toast(message);
    window.GameRoom.api('GET', '/api/room').then(render, () => {});
  },
  onStatus: (status) => {
    el.connection.hidden = status !== 'offline';
    el.connection.textContent = 'Reconnecting…';
  },
  onHidden: (isHidden) => { hidden = isHidden; if (!isHidden) draw(); },
  onFailed: () => {
    if (view) return;
    el.loading.hidden = true;
    el.error.hidden = false;
  },
});

for (const b of el.mode.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.getAttribute('data-mode')));
document.getElementById('retry').addEventListener('click', () => window.location.reload());
drawPalette();
setMode('build');

if (canDraw()) {
  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
} else {
  el.no3d.hidden = false;
}
window.addEventListener('resize', draw);
requestAnimationFrame(loop);
