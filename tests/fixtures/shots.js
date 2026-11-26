'use strict';

const { PNG } = require('pngjs');

function intent(overrides = {}) {
  return {
    version: 1,
    impact: 'ui',
    rationale: 'The invitation dialog now keeps matching users visible.',
    stories: [{
      id: 'invite-suggestions',
      claim: 'Typing a username shows suggestions beside the invite action.',
      persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: {
        startPath: '/lists/demo',
        steps: ['Open Members', 'Open Invite', 'Type ma'],
        checkpoint: 'Suggestions and the Invite button are visible together',
        focus: 'Invite member dialog',
        animation: 'steps',
      },
    }],
    ...overrides,
  };
}

// A declaration with one still change and one motion change, the case that
// needs clips as well as shots.
function motionIntent(overrides = {}) {
  const still = intent().stories[0];
  return intent({
    impact: 'motion',
    stories: [still, {
      id: 'saved-toast',
      claim: 'Saving slides a toast in from the bottom.',
      persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: {
        startPath: '/lists/demo',
        steps: ['Press Save'],
        checkpoint: 'The toast has slid in',
        focus: 'Saved toast',
        animation: 'motion',
      },
    }],
    ...overrides,
  });
}

// One complete PNG, as browser_take_screenshot saves it.
function png({ width = 4, height = 3, shade = 0 } = {}) {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = shade; image.data[i + 1] = 40; image.data[i + 2] = 90; image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

// A screen still taken at a declared screen size, as a browser resized to it
// saves one: the screen's own width and height at `scale` device pixels per
// CSS pixel (1 unless the run is taken at device density). A screen shot at
// another width is refused (shots-files checkScreenSize), so every fixture
// that saves one uses this; element shots and clips keep png()'s small size.
function screenPng(viewport = {}, options = {}) {
  // Called with no screen (the fixture intent's desktop one), or with a
  // screen size first; a first object without a width is the options.
  const byViewport = Number.isFinite(viewport.width);
  const screen = byViewport ? viewport : { width: 1280, height: 800 };
  const { shade = 0, height, scale = 1 } = byViewport ? options : viewport;
  return png({
    width: Math.round(screen.width * scale),
    height: Math.round((height ?? screen.height) * scale),
    shade,
  });
}

// Enough of a WebM for the platform's structural check: the EBML magic and a
// plausible size. The platform does not decode clips.
function webm(bytes = 2048, fill = 7) {
  const buffer = Buffer.alloc(bytes, fill);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(buffer, 0);
  return buffer;
}

module.exports = { intent, motionIntent, png, screenPng, webm };
