// The block world's screen: the world in 3D with three.js (vendored in
// public/vendor, never from a CDN), seen in first person, filling the
// screen. The title screen floats over it while the camera circles the
// world; "Enter the world" puts you in it.
//
// The game room (public/game/room.js) sends the whole world when the page
// opens, then each block as anyone places or removes it, and where everyone
// is (frames). Every block goes to the server, whose rules (game/rules.js)
// check it.
//
// Controls, on a computer: click to take the mouse (pointer lock), move the
// mouse to look, WASD or the arrows to walk, Space and Shift to fly up and
// down. Click to build where the crosshair points, right-click to take that
// block away, 1 to 9, 0, - and = (or the scroll wheel) to choose a block.
// Esc lets the mouse go. Where the browser will not lend the mouse, drag to
// look and click to build. On a touch screen: drag to look, the stick to
// walk, and buttons to fly, build and take away.
//
// The world is a scene of its own, the same daylight in both looks
// (CLAUDE.md "## Design"). Rendering builds elements and sets textContent,
// never innerHTML with people's words in it.

import * as THREE from './vendor/three.module.min.js';

const $ = (id) => document.getElementById(id);
const el = {
  world: $('world'),
  canvas: $('world-canvas'),
  labels: $('labels'),
  no3d: $('no-3d'),
  title: $('title'),
  loading: $('loading'),
  error: $('error'),
  ready: $('ready'),
  count: $('count'),
  builders: $('builders'),
  empty: $('empty'),
  enter: $('enter'),
  keys: $('keys'),
  stage: $('stage'),
  toTitle: $('to-title'),
  here: $('here'),
  handName: $('hand-name'),
  hotbar: $('hotbar'),
  touch: $('touch'),
  stick: $('stick'),
  knob: $('knob'),
  flyUp: $('fly-up'),
  flyDown: $('fly-down'),
  place: $('place'),
  remove: $('remove'),
  paused: $('paused'),
  pausedTitle: $('paused-title'),
  connection: $('connection'),
  toast: $('toast'),
  toastText: $('toast-text'),
};

// The blocks, by the index the server stores (game/rules.js BLOCKS). The
// names are what the hotbar and a screen reader say.
const BLOCKS = [
  { name: 'Grass', colour: '#6dbb45' },
  { name: 'Dirt', colour: '#8b5a2b' },
  { name: 'Stone', colour: '#8f9399' },
  { name: 'Wood', colour: '#7a4f2a' },
  { name: 'Planks', colour: '#c8995a' },
  { name: 'Leaves', colour: '#3f8f3a' },
  { name: 'Sand', colour: '#e3cf8d' },
  { name: 'Brick', colour: '#b0503d' },
  { name: 'Glass', colour: '#bfe6f5', glass: true },
  { name: 'Snow', colour: '#f3f6f8' },
  { name: 'Red', colour: '#d64541' },
  { name: 'Blue', colour: '#3d6fd6' },
];
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
// Each builder's colour, by their id.
const BUILDER_COLOURS = ['#e0457b', '#2f6fdf', '#f08a24', '#8b5cf6', '#14a3b8', '#2ea05a', '#d4a017', '#7c4dff'];
// The scene's own colours, the same as public/scene.css names.
const HORIZON = '#dcefff';
const GROUND = '#78b552';
const PLOT = '#86c263';
const MAX_BLOCKS = 20000;
const MAX_GLASS = 4000;
const REACH = 8; // how far away you can build, in blocks
const SPEED = 8; // blocks a second
const LOOK = 0.0024; // radians per pixel of mouse
const TOUCH_LOOK = 0.0055;
const COARSE = window.matchMedia('(pointer: coarse)').matches;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let view = null;
let size = { x: 40, y: 20, z: 40 };
const blocks = new Map(); // "x,y,z" -> block
let dirty = true;
let hand = 7;
let screen = 'title';
let hidden = false;
const others = new Map(); // id -> { username, target, pos, yaw, c, avatar, label }

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
const inWorld = (x, y, z) => x >= 0 && x < size.x && y >= 0 && y < size.y && z >= 0 && z < size.z;
const colourOf = (id) => BUILDER_COLOURS[Math.abs(id) % BUILDER_COLOURS.length];

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
scene.fog = new THREE.Fog(HORIZON, 34, 120);
const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 400);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x6b5a44, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
sun.position.set(24, 50, 36);
scene.add(sun);

// A block's face: pixels of slightly different light, darker at the edge,
// in grey, so each block's own colour tints it.
function faceTexture(edge, inner, alpha) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const border = x === 0 || y === 0 || x === 15 || y === 15;
      const v = border ? edge : inner - Math.floor(Math.random() * 22);
      g.fillStyle = `rgba(${v},${v},${v},${border ? 1 : alpha})`;
      g.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const cube = new THREE.BoxGeometry(1, 1, 1);
const solid = new THREE.InstancedMesh(cube, new THREE.MeshLambertMaterial({ map: faceTexture(178, 255, 1) }), MAX_BLOCKS);
const glass = new THREE.InstancedMesh(cube, new THREE.MeshLambertMaterial({ map: faceTexture(255, 255, 0.25), transparent: true, opacity: 0.6, depthWrite: false }), MAX_GLASS);
solid.count = 0;
glass.count = 0;
scene.add(solid, glass);

// The ground: grass reaching into the haze, the world's plot a little
// lighter, with a faint grid to build on.
function groundTexture(base) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 32, 32);
  for (let i = 0; i < 140; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)';
    g.fillRect(Math.floor(Math.random() * 32), Math.floor(Math.random() * 32), 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const farTex = groundTexture(GROUND);
farTex.repeat.set(140, 140);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(280, 280), new THREE.MeshLambertMaterial({ map: farTex }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
scene.add(ground);
const plotTex = groundTexture(PLOT);
const plot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ map: plotTex }));
plot.rotation.x = -Math.PI / 2;
scene.add(plot);
let grid = null;

// Where you are pointing: an outline round the block you would take away,
// and a ghost of the block you would build.
const outline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.75 }),
);
outline.visible = false;
scene.add(outline);
const ghost = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }));
ghost.visible = false;
scene.add(ghost);

function setSize(s) {
  size = s;
  plot.scale.set(size.x, size.z, 1);
  plot.position.set(size.x / 2, 0, size.z / 2);
  plotTex.repeat.set(size.x / 2, size.z / 2);
  if (grid) scene.remove(grid);
  grid = new THREE.GridHelper(size.x, size.x, 0x4f8a35, 0x4f8a35);
  grid.material.transparent = true;
  grid.material.opacity = 0.22;
  grid.position.set(size.x / 2, 0.003, size.z / 2);
  scene.add(grid);
}
setSize(size);

function rebuild() {
  dirty = false;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  let s = 0;
  let g = 0;
  for (const [k, b] of blocks) {
    const [x, y, z] = k.split(',').map(Number);
    const kind = BLOCKS[b] || BLOCKS[0];
    m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
    c.set(kind.colour);
    if (kind.glass) {
      if (g >= MAX_GLASS) continue;
      glass.setMatrixAt(g, m);
      glass.setColorAt(g, c);
      g += 1;
    } else {
      if (s >= MAX_BLOCKS) continue;
      solid.setMatrixAt(s, m);
      solid.setColorAt(s, c);
      s += 1;
    }
  }
  for (const [mesh, n] of [[solid, s], [glass, g]]) {
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
}

// ── Everyone else: a blocky figure with their name ───────────────────────

function avatar(id) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.8, 0.34), new THREE.MeshLambertMaterial({ color: new THREE.Color(colourOf(id)) }));
  body.position.y = -0.85;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0xf1d3b3 }));
  const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x1b1b1b }));
  eyes.position.set(0, 0.04, -0.26);
  const held = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  held.position.set(0.42, -0.85, -0.25);
  group.add(body, head, eyes, held);
  group.userData.held = held;
  scene.add(group);
  return group;
}

function setOthers(list) {
  const seen = new Set();
  for (const [id, username, x, y, z, yaw, c] of list || []) {
    if (view && view.you && view.you.id === id) continue;
    seen.add(id);
    let o = others.get(id);
    if (!o) {
      o = { username, pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(), yaw, c, avatar: avatar(id), label: h('span', 'label', '@' + username) };
      el.labels.appendChild(o.label);
      others.set(id, o);
    }
    o.target.set(x, y, z);
    o.yaw = yaw;
    o.c = c;
    o.avatar.userData.held.material.color.set((BLOCKS[c] || BLOCKS[0]).colour);
  }
  for (const [id, o] of others) {
    if (seen.has(id)) continue;
    scene.remove(o.avatar);
    o.label.remove();
    others.delete(id);
  }
}

const projected = new THREE.Vector3();
function moveOthers(dt) {
  const k = 1 - Math.exp(-dt * 10);
  for (const o of others.values()) {
    o.pos.lerp(o.target, k);
    o.avatar.position.copy(o.pos);
    o.avatar.rotation.y = o.yaw;
    projected.copy(o.pos);
    projected.y += 0.55;
    projected.project(camera);
    const show = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
    o.label.hidden = !show;
    if (show) {
      const w = el.world.clientWidth;
      const hh = el.world.clientHeight;
      o.label.style.transform = `translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * hh}px) translate(-50%, -100%)`;
    }
  }
}

// ── You: where you are, which way you look ───────────────────────────────

const me = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
const move = { f: 0, b: 0, l: 0, r: 0, up: 0, down: 0 };
const stick = { id: null, x: 0, y: 0, dx: 0, dy: 0 };
let locked = false;
let everLocked = false;
let lockFailed = false;
let wantLock = false;
let lookDrag = null; // a drag to look: { id, x, y, moved, button, touch }

// Everyone starts at the near edge of the world, a little apart.
function spawn() {
  const id = view && view.you ? view.you.id : 0;
  me.pos.set(size.x / 2 + ((Math.abs(id) % 7) - 3) * 1.5, 5, size.z + 7);
  me.yaw = 0;
  me.pitch = -0.18;
}

function look(dx, dy, speed) {
  me.yaw -= dx * speed;
  me.pitch = Math.max(-1.5, Math.min(1.5, me.pitch - dy * speed));
}

function stopMoving() {
  for (const k in move) move[k] = 0;
}

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const step = new THREE.Vector3();
function fly(dt) {
  fwd.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
  right.set(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
  step.set(0, 0, 0);
  step.addScaledVector(fwd, move.f - move.b - stick.dy);
  step.addScaledVector(right, move.r - move.l + stick.dx);
  if (step.lengthSq() > 1) step.normalize();
  me.pos.addScaledVector(step, SPEED * dt);
  me.pos.y += (move.up - move.down) * SPEED * dt;
  me.pos.x = Math.max(-10, Math.min(size.x + 10, me.pos.x));
  me.pos.z = Math.max(-10, Math.min(size.z + 10, me.pos.z));
  me.pos.y = Math.max(0.8, Math.min(size.y + 10, me.pos.y));
}

// Which block the crosshair is on, and the empty cell in front of it: a
// walk through the grid from your eye (a voxel ray cast), up to REACH.
const dir = new THREE.Vector3();
function aim() {
  dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const o = camera.position;
  let x = Math.floor(o.x);
  let y = Math.floor(o.y);
  let z = Math.floor(o.z);
  const sx = Math.sign(dir.x);
  const sy = Math.sign(dir.y);
  const sz = Math.sign(dir.z);
  const tdx = sx ? Math.abs(1 / dir.x) : Infinity;
  const tdy = sy ? Math.abs(1 / dir.y) : Infinity;
  const tdz = sz ? Math.abs(1 / dir.z) : Infinity;
  let tx = sx ? (sx > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
  let ty = sy ? (sy > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
  let tz = sz ? (sz > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
  let prev = null;
  let t = 0;
  while (t <= REACH) {
    if (y < 0) {
      // Down through the ground: build on it, inside the plot.
      return prev && prev[1] === 0 && inWorld(prev[0], 0, prev[2]) ? { hit: null, place: prev } : null;
    }
    if (blocks.has(keyOf(x, y, z))) {
      const free = prev && inWorld(prev[0], prev[1], prev[2]) && !blocks.has(keyOf(prev[0], prev[1], prev[2]));
      return { hit: [x, y, z], place: free ? prev : null };
    }
    prev = [x, y, z];
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; }
    else { z += sz; t = tz; tz += tdz; }
  }
  return null;
}

let target = null;
function showAim() {
  target = screen === 'stage' ? aim() : null;
  outline.visible = !!(target && target.hit);
  if (outline.visible) outline.position.set(target.hit[0] + 0.5, target.hit[1] + 0.5, target.hit[2] + 0.5);
  ghost.visible = !!(target && target.place);
  if (ghost.visible) {
    ghost.position.set(target.place[0] + 0.5, target.place[1] + 0.5, target.place[2] + 0.5);
    ghost.material.color.set(BLOCKS[hand].colour);
  }
}

// Build or take away at once on this screen; the server's answer (an event
// for everyone) agrees, or a refusal asks for the world again.
function build() {
  if (!target || !target.place) return;
  const [x, y, z] = target.place;
  blocks.set(keyOf(x, y, z), hand);
  dirty = true;
  room.act({ type: 'place', x, y, z, c: hand });
}

function takeAway() {
  if (!target || !target.hit) return;
  const [x, y, z] = target.hit;
  blocks.delete(keyOf(x, y, z));
  dirty = true;
  room.act({ type: 'remove', x, y, z });
}

// ── The hotbar ───────────────────────────────────────────────────────────

const slots = BLOCKS.map((b, i) => {
  const slot = h('button', b.glass ? 'slot slot-glass' : 'slot', KEYS[i]);
  slot.type = 'button';
  slot.setAttribute('data-block', String(i));
  slot.setAttribute('role', 'radio');
  slot.setAttribute('aria-label', b.name);
  slot.style.backgroundColor = b.colour;
  slot.addEventListener('click', () => choose(i));
  el.hotbar.appendChild(slot);
  return slot;
});

let nameTimer = null;
function choose(i) {
  hand = (i + BLOCKS.length) % BLOCKS.length;
  slots.forEach((s, j) => {
    s.classList.toggle('slot-on', j === hand);
    s.setAttribute('aria-checked', j === hand ? 'true' : 'false');
  });
  el.handName.textContent = BLOCKS[hand].name;
  el.handName.hidden = false;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => { el.handName.hidden = true; }, 1600);
}
choose(hand);
el.handName.hidden = true;

// ── Screens ──────────────────────────────────────────────────────────────

function show(next) {
  screen = next;
  el.title.hidden = screen !== 'title';
  el.stage.hidden = screen !== 'stage';
  el.touch.hidden = !COARSE;
  el.paused.hidden = true;
  stopMoving();
  if (screen === 'title' && document.pointerLockElement) document.exitPointerLock();
  if (view) drawTitle();
}

let entered = false;
function enter() {
  if (!entered) spawn();
  entered = true;
  show('stage');
  if (!COARSE) takeMouse();
}

// Ask the browser to lend the mouse. If it never will (some frames and
// browsers refuse), dragging looks around instead; if it would before but
// not just now (straight after Esc), the pause stays up for another click.
function lockRefused() {
  if (!wantLock) return;
  wantLock = false;
  if (!everLocked) lockFailed = true;
  else if (screen === 'stage') el.paused.hidden = false;
}

function takeMouse() {
  if (COARSE || lockFailed || !el.canvas.requestPointerLock) {
    lockFailed = true;
    return;
  }
  wantLock = true;
  try {
    const p = el.canvas.requestPointerLock();
    if (p && p.catch) p.catch(lockRefused);
  } catch (e) {
    lockRefused();
    return;
  }
  setTimeout(() => { if (!locked) lockRefused(); }, 600);
}

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === el.canvas;
  if (locked) {
    everLocked = true;
    wantLock = false;
    el.paused.hidden = true;
  } else if (screen === 'stage' && !lockFailed) {
    // Esc let the mouse go: pause until a click takes it back.
    stopMoving();
    el.paused.hidden = false;
  }
});
document.addEventListener('pointerlockerror', lockRefused);

// ── Input ────────────────────────────────────────────────────────────────

const MOVE_KEYS = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
  Space: 'up', ShiftLeft: 'down', ShiftRight: 'down',
};
window.addEventListener('keydown', (e) => {
  if (screen !== 'stage') return;
  const m = MOVE_KEYS[e.code];
  if (m) {
    move[m] = 1;
    e.preventDefault();
    return;
  }
  const i = KEYS.indexOf(e.key);
  if (i !== -1) choose(i);
});
window.addEventListener('keyup', (e) => {
  const m = MOVE_KEYS[e.code];
  if (m) move[m] = 0;
});
window.addEventListener('blur', stopMoving);

el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
el.canvas.addEventListener('mousemove', (e) => {
  if (locked) look(e.movementX, e.movementY, LOOK);
});
el.canvas.addEventListener('wheel', (e) => {
  if (screen !== 'stage') return;
  e.preventDefault();
  choose(hand + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

el.canvas.addEventListener('pointerdown', (e) => {
  if (screen !== 'stage') return;
  if (locked) {
    if (e.button === 0) build();
    else if (e.button === 2) takeAway();
    return;
  }
  if (e.pointerType === 'mouse' && !lockFailed) {
    takeMouse();
    return;
  }
  lookDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, button: e.button, touch: e.pointerType !== 'mouse' };
  el.canvas.setPointerCapture(e.pointerId);
});
el.canvas.addEventListener('pointermove', (e) => {
  if (!lookDrag || e.pointerId !== lookDrag.id) return;
  const dx = e.clientX - lookDrag.x;
  const dy = e.clientY - lookDrag.y;
  lookDrag.moved += Math.abs(dx) + Math.abs(dy);
  lookDrag.x = e.clientX;
  lookDrag.y = e.clientY;
  look(dx, dy, lookDrag.touch ? TOUCH_LOOK : LOOK * 1.6);
});
function endLook(e) {
  if (!lookDrag || e.pointerId !== lookDrag.id) return;
  // A click that did not drag builds (or, with the right button, takes away).
  if (!lookDrag.touch && lookDrag.moved < 6) {
    if (lookDrag.button === 2) takeAway();
    else build();
  }
  lookDrag = null;
}
el.canvas.addEventListener('pointerup', endLook);
el.canvas.addEventListener('pointercancel', endLook);

// The stick: how far the knob is from the middle is how fast you walk.
el.stick.addEventListener('pointerdown', (e) => {
  stick.id = e.pointerId;
  const r = el.stick.getBoundingClientRect();
  stick.x = r.left + r.width / 2;
  stick.y = r.top + r.height / 2;
  el.stick.setPointerCapture(e.pointerId);
  moveStick(e);
});
function moveStick(e) {
  if (stick.id !== e.pointerId) return;
  const max = el.stick.clientWidth / 2;
  let dx = (e.clientX - stick.x) / max;
  let dy = (e.clientY - stick.y) / max;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  stick.dx = dx;
  stick.dy = dy;
  el.knob.style.transform = `translate(${dx * max * 0.7}px, ${dy * max * 0.7}px)`;
}
function endStick(e) {
  if (stick.id !== e.pointerId) return;
  stick.id = null;
  stick.dx = 0;
  stick.dy = 0;
  el.knob.style.transform = '';
}
el.stick.addEventListener('pointermove', moveStick);
el.stick.addEventListener('pointerup', endStick);
el.stick.addEventListener('pointercancel', endStick);

function hold(button, key) {
  button.addEventListener('pointerdown', (e) => { e.preventDefault(); move[key] = 1; });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(ev, () => { move[key] = 0; });
}
hold(el.flyUp, 'up');
hold(el.flyDown, 'down');
el.place.addEventListener('click', build);
el.remove.addEventListener('click', takeAway);

// ── The title screen ─────────────────────────────────────────────────────

function drawTitle() {
  const list = (view.game && view.game.builders) || [];
  const here = new Map();
  for (const b of list) here.set(b[0], b[1]);
  if (view.you && screen === 'stage') here.set(view.you.id, view.you.username);
  el.builders.textContent = '';
  for (const [id, username] of here) {
    const li = h('li', 'builder');
    li.setAttribute('data-builder', String(id));
    const face = h('span', 'builder-face');
    face.style.backgroundColor = colourOf(id);
    li.appendChild(face);
    li.appendChild(h('span', 'builder-name', view.you && view.you.id === id ? 'You' : '@' + username));
    el.builders.appendChild(li);
  }
  el.builders.hidden = !here.size;
  el.empty.hidden = !!here.size;
  const n = view.game ? view.game.count : 0;
  el.count.textContent = n.toLocaleString('en-US') + (n === 1 ? ' block' : ' blocks');
  const count = [...here.keys()].filter((id) => !(view.you && view.you.id === id)).length;
  el.here.textContent = count ? count + (count === 1 ? ' other builder here' : ' other builders here') : 'Just you here';
  el.keys.hidden = COARSE;
}

// ── The loop ─────────────────────────────────────────────────────────────

function resize() {
  if (!renderer) return;
  const w = el.world.clientWidth;
  const hh = el.world.clientHeight;
  renderer.setSize(w, hh, false);
  camera.aspect = w / Math.max(1, hh);
  camera.updateProjectionMatrix();
}

let last = 0;
let lastSent = 0;
let sentAt = '';
function frame(t) {
  requestAnimationFrame(frame);
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
  last = t;
  if (hidden || !renderer) return;
  if (screen === 'stage') {
    fly(dt);
    camera.position.copy(me.pos);
    camera.rotation.set(me.pitch, me.yaw, 0);
    // Where you are, for everyone else: when it changes, and now and then.
    const where = [me.pos.x, me.pos.y, me.pos.z, me.yaw].map((v) => v.toFixed(1)).join() + ':' + hand;
    if (where !== sentAt || t - lastSent > 4000) {
      sentAt = where;
      lastSent = t;
      room.input({ x: me.pos.x, y: me.pos.y, z: me.pos.z, yaw: me.yaw, c: hand });
    }
  } else {
    // The title screen: the camera circles the world slowly.
    const a = REDUCED ? 0.6 : t / 26000;
    const cx = size.x / 2;
    const cz = size.z / 2;
    camera.position.set(cx + Math.cos(a) * size.x * 0.8, size.y * 0.7, cz + Math.sin(a) * size.z * 0.8);
    camera.lookAt(cx, 2, cz);
  }
  showAim();
  moveOthers(dt);
  if (dirty) rebuild();
  renderer.render(scene, camera);
}

// ── The room ─────────────────────────────────────────────────────────────

function render(next) {
  view = next;
  el.loading.hidden = true;
  el.error.hidden = true;
  el.ready.hidden = false;
  const g = view.game;
  if (g) {
    if (g.size && (g.size.x !== size.x || g.size.z !== size.z)) {
      setSize(g.size);
      if (screen === 'title') spawn();
    }
    blocks.clear();
    for (const [x, y, z, c] of g.blocks) blocks.set(keyOf(x, y, z), c);
    dirty = true;
    setOthers(g.builders);
  }
  drawTitle();
}

const room = window.GameRoom.connect({
  onView: render,
  onFrame: (f) => {
    setOthers(f.builders);
    if (view && view.game) {
      view.game.builders = f.builders;
      drawTitle();
    }
  },
  onEvent: (e) => {
    if (e.type === 'place') blocks.set(keyOf(e.x, e.y, e.z), e.c);
    else if (e.type === 'remove') blocks.delete(keyOf(e.x, e.y, e.z));
    else return;
    if (view && view.game) view.game.count = blocks.size;
    dirty = true;
    drawTitle();
  },
  onError: (message) => {
    toast(message);
    // A block this page showed early was refused: ask for the world again.
    window.GameRoom.api('GET', '/api/room').then(render, () => {});
  },
  onHidden: (away) => {
    hidden = away;
    if (away) stopMoving();
  },
  onStatus: (status) => {
    el.connection.hidden = status !== 'offline';
    el.connection.textContent = 'Reconnecting…';
  },
  onFailed: () => {
    if (view) return;
    el.loading.hidden = true;
    el.error.hidden = false;
  },
});

if (canDraw()) {
  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  resize();
  window.addEventListener('resize', resize);
} else {
  el.no3d.hidden = false;
  el.enter.disabled = true;
}
spawn();
show('title');
requestAnimationFrame(frame);

el.enter.addEventListener('click', enter);
// A click anywhere on the pause (bar its own way out) carries on.
el.paused.addEventListener('click', (e) => {
  if (e.target.closest('#paused-title')) return;
  el.paused.hidden = true;
  takeMouse();
});
el.pausedTitle.addEventListener('click', () => show('title'));
el.toTitle.addEventListener('click', () => show('title'));
$('retry').addEventListener('click', () => window.location.reload());
