// Background music for the App view.
//
// When a dapp is opened (AppView.open) we start a short, generative
// ambient track so each open feels a little different. There are no
// audio files shipped — the tracks are synthesised on the fly with the
// Web Audio API, so they're royalty-free by construction and weigh
// nothing. A small set of distinct "presets" (different scales, tempos
// and timbres) is rotated/picked-at-random on each open.
//
// A tiny floating control (mute toggle + volume slider) lets the user
// turn it down or off; the choice is persisted in localStorage and
// respected on subsequent opens. Browser autoplay policies are honoured:
// if the AudioContext can't start without a gesture we resume it on the
// first user interaction.
const AppMusic = {
  _VOL_KEY: 'appmusic-volume-v1',
  _MUTED_KEY: 'appmusic-muted-v1',
  _LAST_PRESET_KEY: 'appmusic-last-preset-v1',

  // Lowered default so it sits under the app, never over it.
  _DEFAULT_VOLUME: 0.25,

  ctx: null,
  masterGain: null,
  volume: 0.25,
  muted: false,
  playing: false,
  _schedulerTimer: null,
  _nextNoteTime: 0,
  _step: 0,
  _preset: null,
  _activeNodes: [],
  _gestureBound: false,
  _ui: null,

  // ---- Generative presets -------------------------------------------------
  // Each preset is a small scale (semitone offsets from a root), a tempo
  // (seconds per step), a base octave and an oscillator timbre. The
  // sequencer walks the scale with a gentle random walk to keep things
  // melodic but non-repeating. A soft low pad underpins each one.
  PRESETS: [
    { name: 'Aurora',  scale: [0, 2, 4, 7, 9],        root: 57, step: 0.42, lead: 'sine',     pad: 'sine',     padOffset: -12 },
    { name: 'Tide',    scale: [0, 3, 5, 7, 10],       root: 55, step: 0.55, lead: 'triangle', pad: 'sine',     padOffset: -12 },
    { name: 'Lumen',   scale: [0, 2, 4, 6, 7, 9, 11], root: 60, step: 0.36, lead: 'sine',     pad: 'triangle', padOffset: -24 },
    { name: 'Drift',   scale: [0, 2, 3, 5, 7, 8, 10], root: 53, step: 0.5,  lead: 'triangle', pad: 'sine',     padOffset: -12 },
    { name: 'Glimmer', scale: [0, 4, 7, 9, 11],       root: 62, step: 0.3,  lead: 'sine',     pad: 'sine',     padOffset: -24 },
  ],

  _midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  },

  _readPersisted() {
    try {
      const v = parseFloat(localStorage.getItem(AppMusic._VOL_KEY) || '');
      if (Number.isFinite(v)) AppMusic.volume = Math.min(1, Math.max(0, v));
      else AppMusic.volume = AppMusic._DEFAULT_VOLUME;
    } catch { AppMusic.volume = AppMusic._DEFAULT_VOLUME; }
    try {
      AppMusic.muted = localStorage.getItem(AppMusic._MUTED_KEY) === '1';
    } catch { AppMusic.muted = false; }
  },

  _persist() {
    try { localStorage.setItem(AppMusic._VOL_KEY, String(AppMusic.volume)); } catch {}
    try { localStorage.setItem(AppMusic._MUTED_KEY, AppMusic.muted ? '1' : '0'); } catch {}
  },

  // Effective gain applied to the master bus (0 when muted).
  _effectiveGain() {
    return AppMusic.muted ? 0 : AppMusic.volume;
  },

  _applyGain() {
    if (!AppMusic.masterGain || !AppMusic.ctx) return;
    const now = AppMusic.ctx.currentTime;
    const g = AppMusic.masterGain.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      // Short ramp so toggles/slider moves don't click.
      g.linearRampToValueAtTime(AppMusic._effectiveGain(), now + 0.08);
    } catch {
      g.value = AppMusic._effectiveGain();
    }
  },

  _pickPreset() {
    let lastIdx = -1;
    try { lastIdx = parseInt(localStorage.getItem(AppMusic._LAST_PRESET_KEY) || '-1', 10); } catch {}
    let idx = Math.floor(Math.random() * AppMusic.PRESETS.length);
    // Avoid repeating the immediately-previous preset when we have a choice
    // so consecutive opens feel distinct.
    if (AppMusic.PRESETS.length > 1 && idx === lastIdx) {
      idx = (idx + 1) % AppMusic.PRESETS.length;
    }
    try { localStorage.setItem(AppMusic._LAST_PRESET_KEY, String(idx)); } catch {}
    return AppMusic.PRESETS[idx];
  },

  // ---- Lifecycle ----------------------------------------------------------
  // Called by AppView.open(). Safe to call repeatedly; restarts with a
  // freshly-picked preset each time so each open sounds different.
  start() {
    AppMusic._readPersisted();
    AppMusic._ensureUI();
    AppMusic._showUI();

    // Tear down any previous run first.
    AppMusic._teardownAudio();

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // No Web Audio — silently skip.
      AppMusic.ctx = new AC();
      AppMusic.masterGain = AppMusic.ctx.createGain();
      AppMusic.masterGain.gain.value = 0;
      AppMusic.masterGain.connect(AppMusic.ctx.destination);
    } catch {
      return;
    }

    AppMusic._preset = AppMusic._pickPreset();
    AppMusic._step = 0;
    AppMusic._curDegree = null;
    AppMusic._nextNoteTime = AppMusic.ctx.currentTime + 0.1;
    AppMusic.playing = true;

    AppMusic._applyGain();
    AppMusic._startPad();
    AppMusic._scheduler();

    // Autoplay policy: the context may start suspended. Try to resume,
    // and if that's blocked, resume on the first user gesture.
    AppMusic._tryResume();
    AppMusic._updateUI();
  },

  // Called by AppView.close().
  stop() {
    AppMusic.playing = false;
    AppMusic._teardownAudio();
    AppMusic._hideUI();
  },

  _teardownAudio() {
    if (AppMusic._schedulerTimer) {
      clearTimeout(AppMusic._schedulerTimer);
      AppMusic._schedulerTimer = null;
    }
    AppMusic._activeNodes.forEach((n) => { try { n.stop(); } catch {} try { n.disconnect(); } catch {} });
    AppMusic._activeNodes = [];
    if (AppMusic.ctx) {
      try { AppMusic.ctx.close(); } catch {}
    }
    AppMusic.ctx = null;
    AppMusic.masterGain = null;
  },

  _tryResume() {
    if (!AppMusic.ctx) return;
    if (AppMusic.ctx.state === 'suspended') {
      AppMusic.ctx.resume().catch(() => {});
    }
    if (!AppMusic._gestureBound) {
      AppMusic._gestureBound = true;
      const resume = () => {
        if (AppMusic.ctx && AppMusic.ctx.state === 'suspended') {
          AppMusic.ctx.resume().catch(() => {});
        }
        AppMusic._updateUI();
      };
      ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
        window.addEventListener(ev, resume, { passive: true }));
    }
  },

  // ---- Synthesis ----------------------------------------------------------
  // A slow, evolving low pad that holds under the melody.
  _startPad() {
    const p = AppMusic._preset;
    const ctx = AppMusic.ctx;
    if (!ctx) return;
    const padFreq = AppMusic._midiToFreq(p.root + p.padOffset);
    const osc = ctx.createOscillator();
    osc.type = p.pad;
    osc.frequency.value = padFreq;
    // Slow detune wobble for movement.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 3;
    lfo.connect(lfoGain).connect(osc.detune);

    const padGain = ctx.createGain();
    padGain.gain.value = 0.18;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;

    osc.connect(filter).connect(padGain).connect(AppMusic.masterGain);
    osc.start();
    lfo.start();
    AppMusic._activeNodes.push(osc, lfo);
  },

  // Look-ahead sequencer: schedule any notes due in the next 0.2s, then
  // re-arm. Keeps timing tight without a tight loop.
  _scheduler() {
    if (!AppMusic.playing || !AppMusic.ctx) return;
    const ctx = AppMusic.ctx;
    const p = AppMusic._preset;
    while (AppMusic._nextNoteTime < ctx.currentTime + 0.2) {
      AppMusic._scheduleNote(AppMusic._nextNoteTime);
      AppMusic._nextNoteTime += p.step;
    }
    AppMusic._schedulerTimer = setTimeout(() => AppMusic._scheduler(), 60);
  },

  _scheduleNote(time) {
    const p = AppMusic._preset;
    const ctx = AppMusic.ctx;
    AppMusic._step++;

    // Random walk over the scale degrees, occasionally resting for space.
    if (Math.random() < 0.22) return; // rest

    if (AppMusic._curDegree == null) AppMusic._curDegree = Math.floor(p.scale.length / 2);
    AppMusic._curDegree += [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)];
    // Wrap across two octaves of the scale.
    const span = p.scale.length * 2;
    if (AppMusic._curDegree < 0) AppMusic._curDegree += span;
    if (AppMusic._curDegree >= span) AppMusic._curDegree -= span;

    const octave = AppMusic._curDegree >= p.scale.length ? 12 : 0;
    const degree = AppMusic._curDegree % p.scale.length;
    const midi = p.root + p.scale[degree] + octave;
    const freq = AppMusic._midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = p.lead;
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const peak = 0.16;
    const dur = p.step * (1.4 + Math.random() * 0.8);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

    osc.connect(gain).connect(AppMusic.masterGain);
    osc.start(time);
    osc.stop(time + dur + 0.05);

    // Occasional soft harmony a fifth above.
    if (Math.random() < 0.3) {
      const h = ctx.createOscillator();
      h.type = p.lead;
      h.frequency.value = AppMusic._midiToFreq(midi + 7);
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0, time);
      hg.gain.linearRampToValueAtTime(peak * 0.5, time + 0.05);
      hg.gain.exponentialRampToValueAtTime(0.001, time + dur);
      h.connect(hg).connect(AppMusic.masterGain);
      h.start(time);
      h.stop(time + dur + 0.05);
    }
  },

  // ---- Controls (called by UI) -------------------------------------------
  toggleMute() {
    AppMusic.muted = !AppMusic.muted;
    AppMusic._persist();
    AppMusic._applyGain();
    AppMusic._tryResume();
    AppMusic._updateUI();
  },

  setVolume(v) {
    AppMusic.volume = Math.min(1, Math.max(0, v));
    // Dragging the slider up off zero implies "unmute".
    if (AppMusic.volume > 0 && AppMusic.muted) AppMusic.muted = false;
    AppMusic._persist();
    AppMusic._applyGain();
    AppMusic._tryResume();
    AppMusic._updateUI();
  },

  // ---- Floating UI --------------------------------------------------------
  _ensureUI() {
    if (AppMusic._ui) return;
    const wrap = document.createElement('div');
    wrap.id = 'app-music-control';
    wrap.className = 'hidden';
    wrap.setAttribute('aria-label', 'Background music');
    wrap.innerHTML = `
      <button id="app-music-toggle" type="button" title="Mute/unmute background music"
              class="amc-btn" aria-label="Mute or unmute background music">
        <span class="amc-icon"></span>
      </button>
      <input id="app-music-volume" type="range" min="0" max="1" step="0.01"
             class="amc-range" title="Background music volume"
             aria-label="Background music volume" />
    `;
    document.body.appendChild(wrap);

    // Scoped styles. Kept inline so the module is fully self-contained.
    const style = document.createElement('style');
    style.id = 'app-music-control-style';
    style.textContent = `
      #app-music-control {
        position: fixed; bottom: 14px; right: 14px; z-index: 40;
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px 6px 6px; border-radius: 9999px;
        background: rgba(24,24,27,0.82); backdrop-filter: blur(6px);
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        border: 1px solid rgba(255,255,255,0.08);
        opacity: 0.55; transition: opacity .15s ease;
      }
      #app-music-control:hover { opacity: 1; }
      #app-music-control.amc-muted { opacity: 0.45; }
      .amc-btn {
        width: 28px; height: 28px; border-radius: 9999px;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: 0; cursor: pointer; color: #e4e4e7;
      }
      .amc-btn:hover { background: rgba(255,255,255,0.1); }
      .amc-icon { font-size: 15px; line-height: 1; }
      .amc-range {
        width: 0; opacity: 0; transition: width .18s ease, opacity .18s ease;
        accent-color: #8b5cf6; height: 4px; cursor: pointer;
      }
      #app-music-control:hover .amc-range,
      #app-music-control:focus-within .amc-range { width: 84px; opacity: 1; }
    `;
    document.head.appendChild(style);

    wrap.querySelector('#app-music-toggle').addEventListener('click', () => AppMusic.toggleMute());
    const range = wrap.querySelector('#app-music-volume');
    range.addEventListener('input', (e) => AppMusic.setVolume(parseFloat(e.target.value)));

    AppMusic._ui = wrap;
  },

  _showUI() { if (AppMusic._ui) AppMusic._ui.classList.remove('hidden'); AppMusic._updateUI(); },
  _hideUI() { if (AppMusic._ui) AppMusic._ui.classList.add('hidden'); },

  _updateUI() {
    const ui = AppMusic._ui;
    if (!ui) return;
    const icon = ui.querySelector('.amc-icon');
    const range = ui.querySelector('#app-music-volume');
    const suspended = AppMusic.ctx && AppMusic.ctx.state === 'suspended';
    if (icon) {
      icon.textContent = (AppMusic.muted || AppMusic.volume === 0) ? '🔇'
        : suspended ? '🔈' : '🔊';
    }
    if (range && document.activeElement !== range) {
      range.value = String(AppMusic.muted ? 0 : AppMusic.volume);
    }
    ui.classList.toggle('amc-muted', AppMusic.muted || AppMusic.volume === 0);
    const title = suspended
      ? 'Background music — click anywhere to start'
      : (AppMusic.muted ? 'Background music muted' : 'Background music');
    ui.setAttribute('title', title);
  },
};

window.AppMusic = AppMusic;
