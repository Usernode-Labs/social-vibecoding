'use strict';

// Drag-to-select screenshot capture for the feedback modal (#683).
//
// Capture is ALWAYS real screen pixels via the Screen Capture API
// (getDisplayMedia) — never a DOM rasterization — so the cross-origin app
// iframe's content is included. Two mapping branches, chosen by the
// surface the browser actually granted:
//
//   - 'browser' (tab self-capture; Chromium desktop): the frame IS the
//     tab viewport at device resolution, so the selection rect maps by a
//     measured per-axis scale with zero offset.
//   - 'window' / 'monitor' (all Firefox and desktop Safari can offer):
//     the frame contains browser chrome / other windows at an unknown
//     offset+scale. Four QR-finder-style fiducial markers rendered in
//     the viewport corners are located in a registration frame and an
//     axis-aligned scale+offset mapping is solved from them; a second,
//     clean frame (overlay hidden) is then cropped with that mapping.
//     Any detection/validation failure FAILS CLOSED — a coded error, no
//     degraded capture.
//
// Where getDisplayMedia is absent, the feedback controller can instead use
// this module's native-payload decoder or PNG/JPEG file preparation helpers.
//
// The geometry/detection/solve functions are PURE and exported for Node
// tests (tests/screenshot-select.test.js) via the module.exports branch
// at the bottom — same convention as public/sw.js's classifyRequest.

(function () {
  // ── Marker geometry (CSS px) ──────────────────────────────────────
  // A QR finder pattern: 7-module core (dark 7x7 border, light 5x5 ring,
  // dark 3x3 center) inside a 2-module white quiet zone. MODULE is the
  // CSS pixel size of one module; the physical size in the captured
  // frame is measured, never assumed, so DPR and browser zoom are
  // absorbed by the solve.
  const MARKER = {
    MODULE: 6,           // CSS px per module
    CORE_MODULES: 7,     // finder core is 7x7 modules
    QUIET_MODULES: 2,    // white quiet zone on every side
    CORNER_INSET: 8,     // px from each viewport edge to the quiet zone
  };
  MARKER.CORE = MARKER.MODULE * MARKER.CORE_MODULES;             // 42
  MARKER.QUIET = MARKER.MODULE * MARKER.QUIET_MODULES;           // 12
  MARKER.TOTAL = MARKER.CORE + 2 * MARKER.QUIET;                 // 66
  MARKER.CENTER = MARKER.CORNER_INSET + MARKER.TOTAL / 2;        // 41

  // Expected CSS centers of the four corner markers for a viewport.
  // Order: tl, tr, bl, br — the same keys classifyCorners returns.
  function markerCssCenters(viewportW, viewportH) {
    const c = MARKER.CENTER;
    return {
      tl: { x: c, y: c },
      tr: { x: viewportW - c, y: c },
      bl: { x: c, y: viewportH - c },
      br: { x: viewportW - c, y: viewportH - c },
    };
  }

  // ── Mapping (pure) ────────────────────────────────────────────────
  // Direct viewport→frame mapping for a tab self-capture: the frame is
  // exactly the viewport, so scale is measured from the real dimensions
  // (robust to DPR rounding and browser zoom) and offset is zero.
  function directMapping(viewportW, viewportH, frameW, frameH) {
    if (!(viewportW > 0) || !(viewportH > 0) || !(frameW > 0) || !(frameH > 0)) return null;
    return { scaleX: frameW / viewportW, scaleY: frameH / viewportH, offsetX: 0, offsetY: 0 };
  }

  // Apply an axis-aligned mapping to a viewport-CSS rect, clamping to the
  // frame. Returns an integer source crop { sx, sy, sw, sh } or null when
  // the clamped region is degenerate.
  function applyMapping(rect, mapping, frameW, frameH) {
    if (!rect || !mapping) return null;
    const x0 = rect.x * mapping.scaleX + mapping.offsetX;
    const y0 = rect.y * mapping.scaleY + mapping.offsetY;
    const x1 = (rect.x + rect.w) * mapping.scaleX + mapping.offsetX;
    const y1 = (rect.y + rect.h) * mapping.scaleY + mapping.offsetY;
    const sx = Math.max(0, Math.min(frameW, Math.round(Math.min(x0, x1))));
    const sy = Math.max(0, Math.min(frameH, Math.round(Math.min(y0, y1))));
    const ex = Math.max(0, Math.min(frameW, Math.round(Math.max(x0, x1))));
    const ey = Math.max(0, Math.min(frameH, Math.round(Math.max(y0, y1))));
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw < 1 || sh < 1) return null;
    return { sx, sy, sw, sh };
  }

  // ── Marker detection (pure) ───────────────────────────────────────
  // Input is an ImageData-like { data, width, height } (RGBA bytes).
  // Structural detection, never exact-color: binarize by luminance
  // midpoint, then hunt the finder pattern's 1:1:3:1:1 run-length
  // signature along rows, confirming candidates vertically and
  // diagonally through the center. Survives the lossy capture codec and
  // moderate blur.

  function toLuminance(frame) {
    const { data, width, height } = frame;
    const lum = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
      lum[p] = ((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000) | 0;
    }
    return lum;
  }

  // Binarize around the luminance midpoint. A near-flat frame (all-black
  // minimized window, frozen fill) has no usable contrast → null.
  function binarize(lum) {
    let min = 255;
    let max = 0;
    for (let i = 0; i < lum.length; i++) {
      const v = lum[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < 32) return null;
    const threshold = (min + max) / 2;
    const bin = new Uint8Array(lum.length);
    for (let i = 0; i < lum.length; i++) bin[i] = lum[i] < threshold ? 1 : 0; // 1 = dark
    return bin;
  }

  // 1:1:3:1:1 ratio check over five consecutive run lengths (dark, light,
  // dark, light, dark). Generous per-segment tolerance for codec noise.
  function isFinderRatio(a, b, c, d, e) {
    const total = a + b + c + d + e;
    if (total < 7) return false;
    const unit = total / 7;
    const tol = unit * 0.55;
    return Math.abs(a - unit) <= tol
      && Math.abs(b - unit) <= tol
      && Math.abs(c - 3 * unit) <= 3 * tol
      && Math.abs(d - unit) <= tol
      && Math.abs(e - unit) <= tol;
  }

  // Walk from (cx,cy) along (dx,dy) and its inverse, measuring the center
  // dark run and the light ring / dark border beyond it on both sides.
  // Confirms the finder cross-section and returns the refined center
  // offset along the axis, or null. Hitting the frame edge mid-pattern
  // fails (an occluded / clipped marker must not survive).
  function probeAxis(bin, w, h, cx, cy, dx, dy, unit) {
    const runs = (sx, sy, sdx, sdy) => {
      // [center-dark, light-ring, dark-border] extents from (but not
      // counting) the start pixel, walking one pixel at a time.
      const out = [0, 0, 0];
      let x = sx;
      let y = sy;
      let stage = 0;
      const limit = Math.ceil(unit * 4) + 2;
      for (let step = 0; step < limit * 3; step++) {
        x += sdx; y += sdy;
        if (x < 0 || y < 0 || x >= w || y >= h) return null;
        const dark = bin[y * w + x] === 1;
        if (stage === 0) {
          if (dark) { out[0]++; if (out[0] > limit) return null; } else stage = 1;
        }
        if (stage === 1) {
          if (!dark) { out[1]++; if (out[1] > limit) return null; } else stage = 2;
        }
        if (stage === 2) {
          if (dark) { out[2]++; if (out[2] > limit) return null; } else return out;
        }
      }
      return null;
    };
    if (cx < 0 || cy < 0 || cx >= w || cy >= h || bin[cy * w + cx] !== 1) return null;
    const fwd = runs(cx, cy, dx, dy);
    const bwd = runs(cx, cy, -dx, -dy);
    if (!fwd || !bwd) return null;
    // Diagonal walks cover sqrt(2) distance per step — normalise the
    // module unit accordingly so the ratio checks stay meaningful.
    const stepLen = Math.sqrt(dx * dx + dy * dy);
    const u = unit / stepLen;
    const centerDark = fwd[0] + bwd[0] + 1;
    const ok = (v, expected, slack) => Math.abs(v - expected) <= expected * slack + 1.5;
    if (!ok(centerDark, 3 * u, 0.55)) return null;
    if (!ok(fwd[1], u, 0.7) || !ok(bwd[1], u, 0.7)) return null;
    if (fwd[2] < Math.max(1, u * 0.3) || bwd[2] < Math.max(1, u * 0.3)) return null;
    // Refined center offset along this axis (in steps).
    return (fwd[0] - bwd[0]) / 2;
  }

  // Full detection: returns an array of marker centers
  // [{ x, y, unit, hits }] in frame pixels. Empty array on a flat frame.
  function detectMarkers(frame) {
    const { width: w, height: h } = frame;
    if (!w || !h) return [];
    const lum = toLuminance(frame);
    const bin = binarize(lum);
    if (!bin) return [];

    const clusters = [];
    const ROW_STEP = 2;
    for (let y = 0; y < h; y += ROW_STEP) {
      // Run-length encode this row.
      const row = y * w;
      let runStart = 0;
      let runVal = bin[row];
      const runs = []; // { start, len, dark }
      for (let x = 1; x <= w; x++) {
        const v = x < w ? bin[row + x] : -1;
        if (v !== runVal) {
          runs.push({ start: runStart, len: x - runStart, dark: runVal === 1 });
          runStart = x;
          runVal = v;
        }
      }
      for (let i = 0; i + 4 < runs.length; i++) {
        if (!runs[i].dark) continue;
        const [a, b, c, d, e] = [runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len];
        if (!isFinderRatio(a, b, c, d, e)) continue;
        const unit = (a + b + c + d + e) / 7;
        const cx = Math.round(runs[i + 2].start + c / 2);
        // Confirm the cross-section vertically and diagonally through
        // the candidate center; both refine the center as they go.
        const dyOff = probeAxis(bin, w, h, cx, y, 0, 1, unit);
        if (dyOff === null) continue;
        const cy = Math.round(y + dyOff);
        if (probeAxis(bin, w, h, cx, cy, 1, 1, unit) === null) continue;
        if (probeAxis(bin, w, h, cx, cy, 1, -1, unit) === null) continue;
        // Cluster with earlier hits.
        let placed = false;
        for (const cl of clusters) {
          if (Math.abs(cl.x / cl.hits - cx) <= unit * 3 && Math.abs(cl.y / cl.hits - cy) <= unit * 3) {
            cl.x += cx; cl.y += cy; cl.unit += unit; cl.hits++;
            placed = true;
            break;
          }
        }
        if (!placed) clusters.push({ x: cx, y: cy, unit, hits: 1 });
      }
    }
    return clusters
      .filter((cl) => cl.hits >= 2)
      .map((cl) => ({ x: cl.x / cl.hits, y: cl.y / cl.hits, unit: cl.unit / cl.hits, hits: cl.hits }));
  }

  // ── Corner classification + registration solve (pure) ────────────
  // Assign four detected points to viewport corners by relative position.
  // Returns { tl, tr, bl, br } or null when the assignment is ambiguous.
  function classifyCorners(points) {
    if (!Array.isArray(points) || points.length !== 4) return null;
    const by = (score) => points.slice().sort((p, q) => score(p) - score(q));
    const tl = by((p) => p.x + p.y)[0];
    const br = by((p) => p.x + p.y)[3];
    const bl = by((p) => p.x - p.y)[0];
    const tr = by((p) => p.x - p.y)[3];
    const picked = new Set([tl, tr, bl, br]);
    if (picked.size !== 4) return null;
    return { tl, tr, bl, br };
  }

  function solveAxis(pairs) {
    const n = pairs.length;
    let mc = 0;
    let mf = 0;
    for (const p of pairs) { mc += p.css; mf += p.frame; }
    mc /= n; mf /= n;
    let num = 0;
    let den = 0;
    for (const p of pairs) {
      num += (p.css - mc) * (p.frame - mf);
      den += (p.css - mc) * (p.css - mc);
    }
    if (den === 0) return null;
    const scale = num / den;
    return { scale, offset: mf - scale * mc };
  }

  // Solve the axis-aligned scale+offset mapping from detected markers to
  // the known CSS marker centers. Fails closed: exactly four markers,
  // unambiguous corner assignment, tight reprojection residuals, and
  // near-square pixel scales are all required.
  function solveRegistration(detected, cssCenters, frameW, frameH) {
    if (!Array.isArray(detected) || detected.length !== 4) {
      return { ok: false, reason: `expected 4 markers, found ${Array.isArray(detected) ? detected.length : 0}` };
    }
    const corners = classifyCorners(detected);
    if (!corners) return { ok: false, reason: 'ambiguous corner assignment' };
    const keys = ['tl', 'tr', 'bl', 'br'];
    const xPairs = keys.map((k) => ({ css: cssCenters[k].x, frame: corners[k].x }));
    const yPairs = keys.map((k) => ({ css: cssCenters[k].y, frame: corners[k].y }));
    const sx = solveAxis(xPairs);
    const sy = solveAxis(yPairs);
    if (!sx || !sy) return { ok: false, reason: 'degenerate marker layout' };
    if (!(sx.scale > 0) || !(sy.scale > 0)) return { ok: false, reason: 'non-positive scale' };
    // Screen pixels are square — a real capture never skews the axes.
    const ratio = sx.scale / sy.scale;
    if (ratio < 0.9 || ratio > 1.1) return { ok: false, reason: 'skewed axis scales' };
    const tol = Math.max(4, frameW * 0.01);
    for (const k of keys) {
      const px = sx.scale * cssCenters[k].x + sx.offset;
      const py = sy.scale * cssCenters[k].y + sy.offset;
      const err = Math.hypot(px - corners[k].x, py - corners[k].y);
      if (err > tol) return { ok: false, reason: `residual ${err.toFixed(1)}px on ${k}` };
    }
    void frameH;
    return {
      ok: true,
      mapping: { scaleX: sx.scale, scaleY: sy.scale, offsetX: sx.offset, offsetY: sy.offset },
    };
  }

  const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // mirrors the server cap
  const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];

  function isSupportedImageType(contentType) {
    return SUPPORTED_IMAGE_TYPES.includes(String(contentType || '').toLowerCase());
  }

  function isSupportedPickedFile(file) {
    if (!file) return false;
    if (isSupportedImageType(file.type)) return true;
    const genericType = !file.type || file.type === 'application/octet-stream';
    return genericType && /\.(png|jpe?g)$/i.test(String(file.name || ''));
  }

  // Validate the native bridge shape before decoding an attacker-controlled
  // string into a browser allocation. Returns a short reason or null.
  function validateNativeCapturePayload(payload) {
    if (!payload || typeof payload !== 'object') return 'invalid';
    if (!isSupportedImageType(payload.contentType)) return 'invalid-type';
    const encoded = payload.base64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0) return 'invalid';
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return 'invalid';
    const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
    const decodedBytes = (encoded.length / 4) * 3 - padding;
    if (decodedBytes > MAX_UPLOAD_BYTES) return 'too-large';
    return null;
  }

  const pure = {
    MARKER,
    MAX_UPLOAD_BYTES,
    markerCssCenters,
    directMapping,
    applyMapping,
    detectMarkers,
    classifyCorners,
    solveRegistration,
    validateNativeCapturePayload,
  };

  // Node test import — no browser globals touched beyond this point at
  // require time.
  if (typeof module === 'object' && module.exports) {
    module.exports = pure;
  }
  if (typeof window === 'undefined') return;

  // ── Browser orchestration ─────────────────────────────────────────

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  // Coded failure so app.js can pick the right user message.
  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  // Wait ~two rendered frames of the capture stream so the compositor
  // reflects the DOM change we just made (overlay hidden/shown) before we
  // grab. rVFC where available; a timeout belt-and-braces elsewhere.
  function waitFrames(video, n) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        let left = n;
        const tick = () => {
          if (--left <= 0) resolve();
          else video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
        // Some browsers stall rVFC on occluded tabs — never hang forever.
        setTimeout(resolve, 700);
      } else {
        setTimeout(resolve, 150);
      }
    });
  }

  function grabFrame(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    return { canvas, ctx, width: w, height: h };
  }

  // PNG first; over the cap re-encode as JPEG, then downscale until it
  // fits (bounded loop — never spins).
  async function exportBlob(canvas) {
    const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
    let blob = await toBlob(canvas, 'image/png');
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    blob = await toBlob(canvas, 'image/jpeg', 0.85);
    let current = canvas;
    for (let i = 0; blob && blob.size > MAX_UPLOAD_BYTES && i < 4; i++) {
      const next = document.createElement('canvas');
      next.width = Math.max(1, Math.round(current.width * 0.7));
      next.height = Math.max(1, Math.round(current.height * 0.7));
      next.getContext('2d').drawImage(current, 0, 0, next.width, next.height);
      current = next;
      blob = await toBlob(current, 'image/jpeg', 0.85);
    }
    if (!blob || blob.size > MAX_UPLOAD_BYTES) throw fail('capture_failed', 'Screenshot too large');
    return blob;
  }

  function blobFromNativeCapture(payload) {
    const invalid = validateNativeCapturePayload(payload);
    if (invalid === 'too-large') throw fail('too-large', 'Screenshot is larger than 4 MB');
    if (invalid) throw fail('capture_failed', 'Native screenshot data is invalid');
    try {
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: payload.contentType.toLowerCase() });
      if (!blob.size || blob.size > MAX_UPLOAD_BYTES) throw fail('too-large');
      return blob;
    } catch (err) {
      if (err && err.code) throw err;
      throw fail('capture_failed', 'Native screenshot data could not be decoded');
    }
  }

  async function loadPickedImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        return {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      } catch { /* fall through to the broadly-supported image element */ }
    }

    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Image decode failed'));
      });
      return {
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        cleanup: () => URL.revokeObjectURL(url),
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  // The native Android file selector and WKWebView's iOS picker both feed
  // this path. Small JPEG/PNG files stay byte-for-byte intact; larger photos
  // reuse the screenshot encoder so phone-camera images still fit the 4 MB
  // upload contract instead of failing after the user has selected one.
  async function prepareFile(file) {
    if (!isSupportedPickedFile(file)) {
      throw fail('invalid-type', 'Choose a PNG or JPEG image');
    }
    if (file.size > 0 && file.size <= MAX_UPLOAD_BYTES) return file;

    let source;
    try {
      source = await loadPickedImage(file);
      if (!(source.width > 0) || !(source.height > 0)) throw new Error('Empty image');
      const maxEdge = 2560;
      const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      canvas.getContext('2d').drawImage(source.image, 0, 0, canvas.width, canvas.height);
      return await exportBlob(canvas);
    } catch (err) {
      if (err && err.code) throw err;
      throw fail('capture_failed', 'Could not prepare the selected image');
    } finally {
      if (source) source.cleanup();
    }
  }

  // One nested-squares finder pattern as DOM (crisper than a scaled
  // canvas): white quiet zone → dark 7x7 → light 5x5 → dark 3x3.
  function buildMarkerEl(corner) {
    const { MODULE: m, CORE, QUIET, TOTAL, CORNER_INSET } = MARKER;
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;width:${TOTAL}px;height:${TOTAL}px;background:#fff;z-index:2147483647;pointer-events:none;`;
    if (corner.includes('t')) el.style.top = `${CORNER_INSET}px`; else el.style.bottom = `${CORNER_INSET}px`;
    if (corner.includes('l')) el.style.left = `${CORNER_INSET}px`; else el.style.right = `${CORNER_INSET}px`;
    const dark = document.createElement('div');
    dark.style.cssText = `position:absolute;left:${QUIET}px;top:${QUIET}px;width:${CORE}px;height:${CORE}px;background:#000;`;
    const light = document.createElement('div');
    light.style.cssText = `position:absolute;left:${m}px;top:${m}px;width:${m * 5}px;height:${m * 5}px;background:#fff;`;
    const center = document.createElement('div');
    center.style.cssText = `position:absolute;left:${m}px;top:${m}px;width:${m * 3}px;height:${m * 3}px;background:#000;`;
    light.appendChild(center);
    dark.appendChild(light);
    el.appendChild(dark);
    return el;
  }

  // Full selection + capture flow. opts.onCaptureStart fires once the
  // stream is granted (app.js hides the feedback modal there). Resolves
  // { blob, contentType } or rejects with a coded Error:
  //   'unsupported' | 'denied' | 'cancelled' | 'register_failed' |
  //   'capture_failed'
  async function start(opts = {}) {
    if (!isSupported()) throw fail('unsupported');

    // Synchronous-enough with the click: getDisplayMedia is the first
    // await, preserving the transient user activation.
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
          // Chromium hints — safely ignored elsewhere.
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
          monitorTypeSurfaces: 'exclude',
        },
        audio: false,
      });
    } catch (err) {
      void err;
      throw fail('denied', 'Screen capture was declined');
    }

    const track = stream.getVideoTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    // Only a tab self-capture is trusted for direct mapping; anything
    // else (or an unreported surface) goes through marker registration,
    // which fails closed if the page isn't actually visible in the share.
    const tabMode = settings.displaySurface === 'browser';

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    const cleanupBits = [];
    const cleanup = () => {
      while (cleanupBits.length) {
        try { cleanupBits.pop()(); } catch { /* best effort */ }
      }
    };
    cleanupBits.push(() => video.remove());
    cleanupBits.push(() => stream.getTracks().forEach((t) => t.stop()));

    try {
      await video.play();
      if (!video.videoWidth) {
        await new Promise((resolve) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          setTimeout(resolve, 1500);
        });
      }

      if (typeof opts.onCaptureStart === 'function') opts.onCaptureStart();

      // ── Overlay ──
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;touch-action:none;overflow:hidden;';
      const veil = document.createElement('div');
      // With no selection yet the veil dims everything; once a selection
      // exists the selection div's giant box-shadow takes over the
      // dimming and the veil goes transparent.
      veil.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.6);';
      overlay.appendChild(veil);
      const selection = document.createElement('div');
      selection.style.cssText = 'position:absolute;display:none;border:1px solid rgba(255,255,255,0.9);box-shadow:0 0 0 100vmax rgba(0,0,0,0.6);';
      overlay.appendChild(selection);
      const hint = document.createElement('div');
      hint.textContent = 'Drag to select the area to capture — Esc to cancel';
      hint.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(24,24,27,0.92);color:#fff;font:500 13px system-ui,sans-serif;padding:8px 14px;border-radius:9999px;pointer-events:none;max-width:90vw;text-align:center;';
      overlay.appendChild(hint);

      const controls = document.createElement('div');
      controls.style.cssText = 'position:absolute;display:none;gap:8px;z-index:2;';
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.textContent = '✓';
      confirmBtn.setAttribute('aria-label', 'Attach selected area');
      confirmBtn.style.cssText = 'width:36px;height:36px;border-radius:9999px;border:none;background:#0a7cff;color:#fff;font-size:18px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.5);';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '✕';
      cancelBtn.setAttribute('aria-label', 'Cancel screenshot');
      cancelBtn.style.cssText = 'width:36px;height:36px;border-radius:9999px;border:none;background:#3f3f46;color:#fff;font-size:16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.5);';
      controls.appendChild(confirmBtn);
      controls.appendChild(cancelBtn);
      controls.style.display = 'none';
      overlay.appendChild(controls);

      const markerEls = [];
      if (!tabMode) {
        for (const corner of ['tl', 'tr', 'bl', 'br']) {
          const el = buildMarkerEl(corner);
          overlay.appendChild(el);
          markerEls.push(el);
        }
      }

      document.body.appendChild(overlay);
      cleanupBits.push(() => overlay.remove());
      const prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      cleanupBits.push(() => { document.documentElement.style.overflow = prevOverflow; });

      // ── Drag selection ──
      let rect = null; // viewport CSS px { x, y, w, h }
      let dragFrom = null;

      const positionControls = () => {
        if (!rect) { controls.style.display = 'none'; return; }
        controls.style.display = 'flex';
        const belowY = rect.y + rect.h + 10;
        const y = belowY + 46 < window.innerHeight ? belowY : Math.max(8, rect.y - 46);
        const x = Math.max(8, Math.min(window.innerWidth - 96, rect.x + rect.w - 88));
        controls.style.left = `${x}px`;
        controls.style.top = `${y}px`;
      };
      const renderSelection = () => {
        if (!rect) {
          selection.style.display = 'none';
          veil.style.background = 'rgba(0,0,0,0.6)';
          return;
        }
        veil.style.background = 'transparent';
        selection.style.display = 'block';
        selection.style.left = `${rect.x}px`;
        selection.style.top = `${rect.y}px`;
        selection.style.width = `${rect.w}px`;
        selection.style.height = `${rect.h}px`;
      };

      const selectionDone = new Promise((resolve, reject) => {
        const finish = (fn) => { try { fn(); } finally { /* listeners removed via cleanup */ } };
        const cancel = () => finish(() => reject(fail('cancelled')));

        overlay.addEventListener('pointerdown', (e) => {
          if (e.target === confirmBtn || e.target === cancelBtn) return;
          e.preventDefault();
          dragFrom = { x: e.clientX, y: e.clientY };
          rect = null;
          renderSelection();
          controls.style.display = 'none';
          overlay.setPointerCapture(e.pointerId);
        });
        overlay.addEventListener('pointermove', (e) => {
          if (!dragFrom) return;
          const x = Math.max(0, Math.min(window.innerWidth, e.clientX));
          const y = Math.max(0, Math.min(window.innerHeight, e.clientY));
          rect = {
            x: Math.min(dragFrom.x, x),
            y: Math.min(dragFrom.y, y),
            w: Math.abs(x - dragFrom.x),
            h: Math.abs(y - dragFrom.y),
          };
          renderSelection();
        });
        overlay.addEventListener('pointerup', () => {
          if (!dragFrom) return;
          dragFrom = null;
          // Sub-threshold drags are ignored, not treated as cancel.
          if (!rect || rect.w < 10 || rect.h < 10) {
            rect = null;
            renderSelection();
            controls.style.display = 'none';
            return;
          }
          positionControls();
        });
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        };
        document.addEventListener('keydown', onKey);
        cleanupBits.push(() => document.removeEventListener('keydown', onKey));
        cancelBtn.addEventListener('click', cancel);
        confirmBtn.addEventListener('click', () => {
          if (!rect) { cancel(); return; }
          finish(() => resolve(rect));
        });
        // The user can end the share from the browser's own UI at any
        // point — treat it as a cancel, not an error.
        if (track) track.addEventListener('ended', cancel);
      });

      const chosen = await selectionDone;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      let mapping;
      let regFrameW = null;
      let regFrameH = null;
      if (!tabMode) {
        // Registration frame: markers + veil still visible.
        await waitFrames(video, 2);
        const reg = grabFrame(video);
        if (!reg) throw fail('capture_failed', 'No video frame available');
        regFrameW = reg.width;
        regFrameH = reg.height;
        const detected = detectMarkers(reg.ctx.getImageData(0, 0, reg.width, reg.height));
        const solved = solveRegistration(detected, markerCssCenters(viewportW, viewportH), reg.width, reg.height);
        if (!solved.ok) throw fail('register_failed', solved.reason);
        mapping = solved.mapping;
      }

      // Clean frame: nothing of ours visible.
      overlay.style.display = 'none';
      await waitFrames(video, 2);
      const clean = grabFrame(video);
      if (!clean) throw fail('capture_failed', 'No video frame available');
      if (tabMode) {
        mapping = directMapping(viewportW, viewportH, clean.width, clean.height);
      } else if (clean.width !== regFrameW || clean.height !== regFrameH) {
        // The window was resized between the two grabs — the solved
        // mapping no longer applies. Fail closed.
        throw fail('register_failed', 'window changed during capture');
      }
      stream.getTracks().forEach((t) => t.stop());

      const crop = mapping && applyMapping(chosen, mapping, clean.width, clean.height);
      if (!crop) throw fail('capture_failed', 'Selected area is outside the captured frame');

      const out = document.createElement('canvas');
      out.width = crop.sw;
      out.height = crop.sh;
      out.getContext('2d').drawImage(clean.canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
      const blob = await exportBlob(out);
      return { blob, contentType: blob.type };
    } finally {
      cleanup();
    }
  }

  // ── Moved into the React bundle by #1078 chunk I ────────────────
  //
  // This file was public/js/screenshot-select.js, a classic <script> tag
  // loaded just before app.js so the feedback modal could gate its attach
  // button on isSupported(). It is a MOVE: the IIFE above is unchanged, and
  // the publication stays, because the feedback dialog still reads
  // `window.ScreenshotSelect` by name.
  //
  // The `typeof window` guard is for the SSG prerender pass, which evaluates
  // this module in Node (FeedbackDialog imports it). Nothing else in here
  // touches a browser global at module scope.
  if (typeof window !== 'undefined') {
    window.ScreenshotSelect = Object.assign({
      isSupported,
      start,
      blobFromNativeCapture,
      prepareFile,
    }, pure);
  }
})();
