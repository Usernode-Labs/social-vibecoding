// The models a person may pick for a question or a build: the server's
// allowlist (GET /api/models, src/services/models.js), with a seeded copy
// for the first paint.
//
// It was a map on the dev chat's module until that chat was retired. The
// Workshop's ask box reads it (AppView._workshopModels,
// frontend/src/features/dev-board/card/model.ts).
//
// The seeded map DUPLICATES the `changeSize` copy in src/services/models.js
// (it exists only for the paint before /api/models resolves), so the two are
// edited together; tests/model-selector-ui.test.js fails if they diverge.
// No prices and no measured figures here: spend is shown by the allowance.
//
// A side-effect module with no imports or exports: the browser entry imports
// it (frontend/src/main.tsx) and classic scripts read `window.PlatformModels`;
// suites evaluate this file as a classic script.
const PlatformModels = {
  MODELS: {
    'claude-sonnet-5-5': {
      label: 'Sonnet 5.5',
      changeSize: {
        short: 'simple, small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
    },
    'claude-opus-5-5': {
      label: 'Opus 5.5',
      changeSize: {
        short: 'general coding work',
        long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
      },
    },
    'claude-fable-5-1': {
      label: 'Fable 5.1',
      changeSize: {
        short: 'design, taste, and difficult coding',
        long: 'Design and taste (how a screen looks, reads, and feels) plus the most difficult coding work.',
      },
    },
  },

  // Overwritten by GET /api/models with the server's own default.
  defaultModel: 'claude-opus-5-5',

  // Replace the seeded map with the server's allowlist, so a model added or
  // removed there reaches the picker without a client release. On any
  // failure the map stays as it was.
  async load() {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.models) && data.models.length) {
        const next = {};
        for (const m of data.models) {
          if (m && typeof m.id === 'string') {
            const label = (typeof m.label === 'string' && m.label) ? m.label : m.id;
            const changeSize = (m.changeSize && typeof m.changeSize === 'object') ? m.changeSize : null;
            next[m.id] = { label, changeSize };
          }
        }
        PlatformModels.MODELS = next;
      }
      if (data && typeof data.default === 'string' && data.default) {
        PlatformModels.defaultModel = data.default;
      }
    } catch { /* the seeded map stays */ }
  },
};

if (typeof window !== 'undefined') {
  window.PlatformModels = PlatformModels;
  // Only for a viewer the endpoint answers: this runs at module load on
  // every document, the signed-out landing and the waiting room included,
  // where /api/models is a guaranteed 401 or 403 and a red console line.
  // Otherwise it waits for the authed boot's once-per-document `sv:authed`,
  // the same test as frontend/src/lib/platform-viewer.ts (not imported: the
  // suites evaluate this file as a classic script).
  const hasPlatformViewer = () => !!(window.App && window.App.user
    && window.App.user.hasPlatformAccess !== false);
  if (hasPlatformViewer()) PlatformModels.load();
  else if (typeof document !== 'undefined') {
    document.addEventListener('sv:authed', () => {
      if (hasPlatformViewer()) PlatformModels.load();
    }, { once: true });
  }
}
