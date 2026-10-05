'use strict';

// Screenshot annotation editor for the feedback modal (request: "annotate the
// auto-captured screenshot").
//
// Tapping an attached screenshot's thumbnail in the feedback dialog opens
// this: a full-screen overlay showing the image with exactly two tools —
// Crop (drag a rectangle to keep only that part) and Red marker (draw over
// the image in a bright red pen of one fixed width). Done composites the
// drawing (and the crop) back into a single image and hands it to the
// controller through the SAME encoder the capture path uses
// (window.ScreenshotSelect.exportBlob), so an edited screenshot obeys the
// same 4 MB upload contract a fresh capture does. Cancel resolves without
// touching the attachment.
//
// It is built in the screenshot-select.js pattern — runtime-built DOM
// appended to body, no static shell markup, no <script> tag (it rides the
// frontend bundle through the controller's side-effect import, and the
// controller reads window.ScreenshotAnnotate by name, as it reads
// window.ScreenshotSelect). The geometry helpers below are PURE and exported
// for Node tests (tests/screenshot-annotate.test.js) via the module.exports
// branch, same convention as screenshot-select.js.

(function () {
  // The pen. Bright red on purpose — it has to read over screenshots of both
  // platform looks and over arbitrary app content. One width, scaled to the
  // image so the stroke reads at any resolution: ~1/160th of the image's
  // width, never thinner than 3 image px.
  const MARKER_COLOR = '#ef4444';
  const MIN_MARKER_WIDTH = 3;
  const MARKER_WIDTH_DIVISOR = 160;

  // A drag smaller than this is a tap, not a crop: ignore it rather than
  // crop to a sliver. Image px, so it means the same at any resolution.
  const MIN_CROP_SIZE = 24;

  // Normalise two drag endpoints into an { x, y, w, h } rect with the top
  // left corner first — a drag in any direction yields the same rectangle.
  // Pure (exported for tests).
  function normalizeRect(ax, ay, bx, by) {
    const x = Math.min(ax, bx);
    const y = Math.min(ay, by);
    return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  // Clamp a drag rect into the image and drop it when it degenerated below
  // the minimum crop. Coordinates may arrive outside the image (a drag that
  // left the picture); the kept region is the intersection. Returns the
  // clamped { x, y, w, h } in image px, or null when there is no usable crop.
  // Pure (exported for tests).
  function clampRectToImage(rect, imageW, imageH, minSize) {
    const min = minSize == null ? MIN_CROP_SIZE : minSize;
    if (!rect || !(imageW > 0) || !(imageH > 0)) return null;
    const x0 = Math.max(0, Math.min(imageW, rect.x));
    const y0 = Math.max(0, Math.min(imageH, rect.y));
    const x1 = Math.max(0, Math.min(imageW, rect.x + rect.w));
    const y1 = Math.max(0, Math.min(imageH, rect.y + rect.h));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < min || h < min) return null;
    return { x: x0, y: y0, w, h };
  }

  // The crop rect as an integer source rectangle for drawImage — rounded
  // inward so the kept region never reads outside what was drawn.
  // Pure (exported for tests).
  function cropRectToSource(rect, imageW, imageH) {
    if (!rect || !(imageW > 0) || !(imageH > 0)) return null;
    const sx = Math.max(0, Math.min(imageW, Math.round(rect.x)));
    const sy = Math.max(0, Math.min(imageH, Math.round(rect.y)));
    const ex = Math.max(sx, Math.min(imageW, Math.round(rect.x + rect.w)));
    const ey = Math.max(sy, Math.min(imageH, Math.round(rect.y + rect.h)));
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw < 1 || sh < 1) return null;
    return { sx, sy, sw, sh };
  }

  // The pen's width for an image of `imageW` px. Pure (exported for tests).
  function markerLineWidth(imageW) {
    if (!(imageW > 0)) return MIN_MARKER_WIDTH;
    return Math.max(MIN_MARKER_WIDTH, Math.round(imageW / MARKER_WIDTH_DIVISOR));
  }

  // Keep a stroke point inside the image — a pointer that left the picture
  // (a finger dragged off the edge) must not draw outside it, because the
  // crop below could then land on a region the stroke escapes.
  // Pure (exported for tests).
  function clampPoint(point, imageW, imageH) {
    if (!point) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(imageW, point.x)),
      y: Math.max(0, Math.min(imageH, point.y)),
    };
  }

  const pure = {
    MARKER_COLOR,
    MIN_MARKER_WIDTH,
    MARKER_WIDTH_DIVISOR,
    MIN_CROP_SIZE,
    normalizeRect,
    clampRectToImage,
    cropRectToSource,
    markerLineWidth,
    clampPoint,
  };

  // Node test import — no browser globals touched beyond this point at
  // require time.
  if (typeof module === 'object' && module.exports) {
    module.exports = pure;
  }
  if (typeof window === 'undefined') return;

  // ── Browser orchestration ─────────────────────────────────────────

  // The editor is a full-screen surface over the page, built the same way
  // screenshot-select.js builds its selection overlay. It looks like the
  // platform: zinc surfaces and hairlines, the violet accent on the one
  // applied action (Done), and the dialog's own Cancel / Done word pair.
  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  function open(opts = {}) {
    const tools = window.ScreenshotSelect;
    if (!tools || typeof tools.loadPickedImage !== 'function'
        || typeof tools.exportBlob !== 'function') {
      return Promise.reject(fail('unsupported', 'Screenshot tools are not available'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let source = null;      // loadPickedImage's { image, width, height, cleanup }
      const cleanupBits = [];
      const cleanup = () => {
        while (cleanupBits.length) {
          try { cleanupBits.pop()(); } catch { /* best effort */ }
        }
        if (source) { try { source.cleanup(); } catch { /* already closed */ } source = null; }
      };
      const settle = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (typeof opts.onDone === 'function') {
          try { opts.onDone(result); } catch { /* the promise still settles */ }
        }
        resolve(result);
      };
      const failOut = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const applyDone = async () => {
        if (settled || !source) return;
        try {
          const out = document.createElement('canvas');
          const r = cropRect
            ? cropRectToSource(cropRect, source.width, source.height)
            : { sx: 0, sy: 0, sw: source.width, sh: source.height };
          out.width = r.sw;
          out.height = r.sh;
          const ctx = out.getContext('2d');
          ctx.drawImage(source.image, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
          ctx.drawImage(strokeCanvas, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
          // The shared encoder: PNG → JPEG 0.85 → ×0.7 downscale ladder,
          // bounded, so the edited attachment fits MAX_UPLOAD_BYTES exactly
          // as a fresh capture does.
          const blob = await tools.exportBlob(out);
          settle({ ok: true, blob });
        } catch (err) {
          failOut(err && err.code ? err : fail('too-large', 'Could not save the edited screenshot'));
        }
      };

      // ── Overlay ──
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;'
        + 'background:rgba(9,9,11,0.97);color:#fafafa;font:400 14px system-ui,sans-serif;';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Edit screenshot');
      overlay.tabIndex = -1;

      const header = document.createElement('div');
      header.style.cssText = 'flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;'
        + 'border-bottom:1px solid rgba(255,255,255,0.08);';
      const title = document.createElement('span');
      title.textContent = 'Edit screenshot';
      title.style.cssText = 'font-weight:600;font-size:15px;flex:1;min-width:0;overflow:hidden;'
        + 'text-overflow:ellipsis;white-space:nowrap;';
      header.appendChild(title);

      const hint = document.createElement('div');
      hint.style.cssText = 'flex:none;padding:8px 12px;font-size:12px;color:#a1a1aa;'
        + 'border-bottom:1px solid rgba(255,255,255,0.08);';

      const stage = document.createElement('div');
      stage.style.cssText = 'flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px;overflow:hidden;';

      const frame = document.createElement('div');
      frame.style.cssText = 'position:relative;max-width:100%;max-height:100%;touch-action:none;user-select:none;-webkit-user-select:none;';
      const img = document.createElement('img');
      img.alt = '';
      img.style.cssText = 'display:block;max-width:100%;max-height:100%;';
      const strokeCanvas = document.createElement('canvas');
      strokeCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
      const cropEl = document.createElement('div');
      // The same cut-out the desktop drag-to-select shows: the kept region
      // outlined, everything outside it dimmed.
      cropEl.style.cssText = 'position:absolute;display:none;border:1px solid rgba(255,255,255,0.9);'
        + 'box-shadow:0 0 0 100vmax rgba(0,0,0,0.55);pointer-events:none;';
      frame.appendChild(img);
      frame.appendChild(strokeCanvas);
      frame.appendChild(cropEl);
      stage.appendChild(frame);

      const footer = document.createElement('div');
      footer.style.cssText = 'flex:none;display:flex;gap:12px;padding:12px;border-top:1px solid rgba(255,255,255,0.08);';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'flex:1;min-height:44px;border-radius:10px;border:none;background:#27272a;'
        + 'color:#fafafa;font-size:14px;font-weight:500;cursor:pointer;';
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.textContent = 'Done';
      doneBtn.style.cssText = 'flex:1;min-height:44px;border-radius:10px;border:none;background:#7c3aed;'
        + 'color:#fff;font-size:14px;font-weight:500;cursor:pointer;';
      footer.appendChild(cancelBtn);
      footer.appendChild(doneBtn);

      overlay.appendChild(header);
      overlay.appendChild(hint);
      overlay.appendChild(stage);
      overlay.appendChild(footer);

      const toolRow = document.createElement('div');
      toolRow.style.cssText = 'display:flex;gap:8px;';
      const toolBtns = {};
      for (const [tool, label, hintLine] of [
        ['crop', 'Crop', 'Drag on the image to crop it.'],
        ['marker', 'Red marker', 'Draw on the image to point at what is wrong.'],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.style.cssText = 'min-height:36px;padding:0 14px;border-radius:9999px;border:1px solid rgba(255,255,255,0.15);'
          + 'background:transparent;color:#fafafa;font-size:13px;font-weight:500;cursor:pointer;';
        toolBtns[tool] = btn;
        toolRow.appendChild(btn);
        btn.addEventListener('click', () => setTool(tool));
        btn.dataset.toolHint = hintLine;
      }
      header.appendChild(toolRow);

      // ── State ──
      let tool = 'crop';
      let strokes = [];        // array of arrays of { x, y } in image px
      let cropRect = null;     // { x, y, w, h } in image px
      let dragging = null;     // { kind: 'crop'|'marker', start } while a pointer is down
      let dispScaleX = 1;      // image px per displayed px
      let dispScaleY = 1;

      const setTool = (next) => {
        tool = next;
        for (const [name, btn] of Object.entries(toolBtns)) {
          const active = name === tool;
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          btn.style.background = active ? '#7c3aed' : 'transparent';
          btn.style.borderColor = active ? '#7c3aed' : 'rgba(255,255,255,0.15)';
          btn.style.color = '#fafafa';
        }
        hint.textContent = toolBtns[tool].dataset.toolHint;
        // A crop that is being replaced is the tool's own "re-drag replaces
        // it" rule; a tool switch keeps what each tool made.
        if (tool === 'crop') renderCrop();
      };

      const renderCrop = () => {
        if (!cropRect) {
          cropEl.style.display = 'none';
          return;
        }
        cropEl.style.display = 'block';
        cropEl.style.left = `${cropRect.x / dispScaleX}px`;
        cropEl.style.top = `${cropRect.y / dispScaleY}px`;
        cropEl.style.width = `${cropRect.w / dispScaleX}px`;
        cropEl.style.height = `${cropRect.h / dispScaleY}px`;
      };

      const drawStrokeSegment = (stroke, from) => {
        const ctx = strokeCanvas.getContext('2d');
        ctx.strokeStyle = MARKER_COLOR;
        ctx.lineWidth = markerLineWidth(source.width);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const fromPt = stroke[Math.max(0, stroke.length - (from ? 2 : 1))];
        const toPt = stroke[stroke.length - 1];
        ctx.beginPath();
        if (from && stroke.length > 1) {
          ctx.moveTo(fromPt.x, fromPt.y);
        } else {
          // A dot, not an invisible zero-length line: a tap of the marker
          // still leaves its mark.
          ctx.moveTo(toPt.x, toPt.y);
          ctx.lineTo(toPt.x + 0.01, toPt.y);
        }
        ctx.lineTo(toPt.x, toPt.y);
        ctx.stroke();
      };

      const toImagePx = (e) => {
        const rect = frame.getBoundingClientRect();
        return clampPoint({
          x: (e.clientX - rect.left) * dispScaleX,
          y: (e.clientY - rect.top) * dispScaleY,
        }, source.width, source.height);
      };

      frame.addEventListener('pointerdown', (e) => {
        if (!source) return;
        e.preventDefault();
        try { frame.setPointerCapture(e.pointerId); } catch { /* the moves still land */ }
        const p = toImagePx(e);
        if (tool === 'crop') {
          dragging = { kind: 'crop', start: p };
          cropRect = null;
          renderCrop();
        } else {
          dragging = { kind: 'marker', start: p };
          strokes.push([p]);
          drawStrokeSegment(strokes[strokes.length - 1], false);
        }
      });
      frame.addEventListener('pointermove', (e) => {
        if (!dragging || !source) return;
        const p = toImagePx(e);
        if (dragging.kind === 'crop') {
          cropRect = clampRectToImage(
            normalizeRect(dragging.start.x, dragging.start.y, p.x, p.y),
            source.width, source.height, 1,
          );
          if (cropRect) renderCrop();
        } else {
          const stroke = strokes[strokes.length - 1];
          stroke.push(p);
          drawStrokeSegment(stroke, true);
        }
      });
      const endDrag = () => {
        if (!dragging) return;
        if (dragging.kind === 'crop') {
          // A tap or a sliver is no crop: the whole image stays.
          cropRect = cropRect && clampRectToImage(cropRect, source.width, source.height, MIN_CROP_SIZE);
          renderCrop();
        }
        dragging = null;
      };
      frame.addEventListener('pointerup', endDrag);
      frame.addEventListener('pointercancel', endDrag);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          settle({ ok: false, cancelled: true });
        }
      };
      document.addEventListener('keydown', onKey);
      cleanupBits.push(() => document.removeEventListener('keydown', onKey));

      cancelBtn.addEventListener('click', () => settle({ ok: false, cancelled: true }));
      doneBtn.addEventListener('click', () => { void applyDone(); });

      cleanupBits.push(() => overlay.remove());
      // On screen from the start: the decode is async, and the stage is only
      // measurable once the overlay is in the document.
      document.body.appendChild(overlay);

      (async () => {
        try {
          source = await tools.loadPickedImage(opts.blob);
          if (!(source.width > 0) || !(source.height > 0)) throw new Error('Empty image');
          if (settled) return;
          const objectUrl = URL.createObjectURL(opts.blob);
          cleanupBits.push(() => { try { URL.revokeObjectURL(objectUrl); } catch { /* gone */ } });
          await new Promise((r) => requestAnimationFrame(r));
          if (settled) return;
          const stageRect = stage.getBoundingClientRect();
          const availW = Math.max(1, stageRect.width - 24);
          const availH = Math.max(1, stageRect.height - 24);
          const scale = Math.min(availW / source.width, availH / source.height, 1);
          const dispW = Math.max(1, Math.round(source.width * scale));
          const dispH = Math.max(1, Math.round(source.height * scale));
          img.src = objectUrl;
          img.style.width = `${dispW}px`;
          img.style.height = `${dispH}px`;
          frame.style.width = `${dispW}px`;
          frame.style.height = `${dispH}px`;
          strokeCanvas.width = source.width;
          strokeCanvas.height = source.height;
          strokeCanvas.style.width = `${dispW}px`;
          strokeCanvas.style.height = `${dispH}px`;
          dispScaleX = source.width / dispW;
          dispScaleY = source.height / dispH;
          setTool('crop');
          overlay.focus();
        } catch (err) {
          failOut(err && err.code ? err : fail('capture_failed', 'Could not open the image for editing'));
        }
      })();
    });
  }

  if (typeof window !== 'undefined') {
    window.ScreenshotAnnotate = Object.assign({ open }, pure);
  }
})();
