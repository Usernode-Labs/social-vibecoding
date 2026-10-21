// #5687: an attached picture or clip opens full size before the request is
// posted. This suite pins the seams that are easy to lose and cannot be seen
// from a screenshot: the preview is a portal beside the dialog root (so its
// backdrop is its own), Escape closes the preview alone (the kit modal's own
// listener stands aside for it), Back is claimed, and every id it asks for
// exists.
//
// The thumbnail taps themselves are behavioural, in
// tests/feedback-multi-screenshot-ui.test.js, against the real controller.
//
// Run with: node --test tests/feedback-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PREVIEW = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-preview.tsx'),
  'utf8'
);
const DIALOG = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback.tsx'),
  'utf8'
);
const NATIVE = fs.readFileSync(
  path.join(ROOT, 'public', 'usernode-native', 'v1', 'native.js'),
  'utf8'
);
const CATALOG = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'frontend', 'locales', 'en', 'dialogs.json'), 'utf8')
);

test('the preview is portalled to the body, outside the kit modal card', () => {
  assert.match(PREVIEW, /createPortal\(/, 'it renders through a portal');
  assert.match(PREVIEW, /,\s*\n\s*document\.body,\s*\n\s*\);/, 'the portal target is document.body');
});

// The kit's own Escape listener is registered on `window` capture by
// native.js, loaded before the shell bundle, so it runs first; it stands
// aside for an open `[data-owns-escape]` element (pinned below). What is
// pinned here is that the preview takes the press, stops it travelling
// further, and closes itself.
test('Escape is caught in the capture phase and closes the preview', () => {
  assert.match(PREVIEW, /window\.addEventListener\('keydown', onKey, true\)/, 'capture phase');
  const onKey = PREVIEW.slice(PREVIEW.indexOf('const onKey'), PREVIEW.indexOf('window.addEventListener'));
  assert.match(onKey, /event\.preventDefault\(\)/);
  assert.match(onKey, /event\.stopPropagation\(\)/, 'nothing else in the page treats it as its own');
  assert.match(onKey, /onCloseRef\.current\(\)/);
  assert.match(PREVIEW, /window\.removeEventListener\('keydown', onKey, true\)/);
});

test('the preview root claims Escape from the kit modal behind it', () => {
  const root = PREVIEW.slice(PREVIEW.indexOf('role="dialog"'), PREVIEW.indexOf('onClick={(event)'));
  assert.match(root, /data-feedback-preview=""/);
  assert.match(root, /data-owns-escape=""/, 'the root is the element the kit looks for');
  assert.doesNotMatch(PREVIEW, /KNOWN LIMIT/, 'Escape no longer closes the form too');
});

// The kit's modal-stack Escape listener, run for real: the section from
// `var modalStack` up to the next banner comment holds it.
function kitEscape({ owner }) {
  let onKeydown = null;
  const context = vm.createContext({
    document: { querySelector: (sel) => (sel === '[data-owns-escape]' ? owner : null) },
    window: {
      addEventListener(type, fn, capture) {
        if (type === 'keydown' && capture === true && !onKeydown) onKeydown = fn;
      },
    },
    activePopover: null,
    getComputedStyle: () => ({ opacity: '0' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
  });
  const at = NATIVE.indexOf('  var modalStack = []');
  vm.runInContext(`${NATIVE.slice(at, NATIVE.indexOf('\n  /* ', at))}\nthis.modalStack = modalStack;`, context);
  let dismissed = 0;
  context.modalStack.push({ dismissible: true, dismiss: () => { dismissed += 1; } });
  let prevented = false;
  onKeydown({ key: 'Escape', preventDefault() { prevented = true; } });
  return { dismissed, prevented };
}

test('the kit modal stands aside on Escape while a [data-owns-escape] element is open', () => {
  assert.deepEqual(kitEscape({ owner: { nodeType: 1 } }), { dismissed: 0, prevented: false },
    'the form behind the picture stays open');
  assert.deepEqual(kitEscape({ owner: null }), { dismissed: 1, prevented: true },
    'with nothing marked, Escape still closes the topmost modal');
});

test('Back closes the preview and is handed back when it closes any other way', () => {
  assert.match(PREVIEW, /pushDismissible\(/);
  assert.match(PREVIEW, /if \(!backed\) release\(\)/);
});

test('a tap on the dark around the picture closes it; a tap on the picture does not', () => {
  assert.match(PREVIEW, /event\.target === event\.currentTarget/);
  assert.match(PREVIEW, /event\.stopPropagation\(\)/, 'never reaches the dialog card');
});

test('closing the preview returns focus to the thumbnail it came from', () => {
  assert.match(PREVIEW, /before\?\.focus\?\.\(\{ preventScroll: true \}\)/);
});

test('the preview has no Download, unlike the chat picture viewer', () => {
  assert.doesNotMatch(PREVIEW, /DownloadIcon/);
  assert.doesNotMatch(PREVIEW, /saveImage|canSaveImage/);
  assert.doesNotMatch(PREVIEW, /data-image-viewer-download/);
});

test('a screenshot handed over from comment mode keeps its pins', () => {
  assert.match(PREVIEW, /\(item\.pins \|\| \[\]\)\.map\(/);
  assert.match(PREVIEW, /pin\.x \* 100/);
  assert.match(PREVIEW, /pin\.y \* 100/);
});

test('the island renders the preview beside the dialog root and clears it on close', () => {
  assert.match(DIALOG, /import \{ FeedbackPreview, type FeedbackPreviewItem \} from '\.\/feedback-preview'/);
  assert.match(DIALOG, /\{preview \? <FeedbackPreview item=\{preview\} onClose=\{\(\) => setPreview\(null\)\} \/> : null\}/);
  // Outside DialogRoot: the fragment opens before it and the preview follows
  // `</DialogRoot>`.
  const afterRoot = DIALOG.slice(DIALOG.indexOf('</DialogRoot>'));
  assert.ok(afterRoot.includes('<FeedbackPreview'), 'not inside the dialog root');
  assert.match(DIALOG, /onClose: \(\) => \{\s*\n\s*setPreview\(null\);/, 'a closed dialog never leaves a preview behind');
  assert.match(DIALOG, /Feedback\._preview = \(item\) => setPreview\(item\);/);
});

test('every message the preview asks for exists in the dialogs catalog', () => {
  const ids = [...PREVIEW.matchAll(/t\('dialogs:([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'it reads its words from the catalog');
  for (const id of ids) {
    assert.ok(CATALOG[id], `dialogs.json has ${id}`);
    assert.equal(typeof CATALOG[id].text, 'string');
    assert.equal(typeof CATALOG[id].description, 'string', `${id} carries a description`);
  }
});

test('the thumbnail labels the controller writes exist in the catalog', () => {
  const controller = fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'),
    'utf8'
  );
  for (const id of ['feedback.screenshot.view', 'feedback.video.view']) {
    assert.ok(controller.includes(`t('dialogs:${id}'`), `the controller asks for ${id}`);
    assert.ok(CATALOG[id], `dialogs.json has ${id}`);
  }
});
