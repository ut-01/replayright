// ui-bundle.js
//
// Node-side half of the recording overlay: reads the plain files under src/ui/ and
// concatenates them into the one script string handed to
// `context.addInitScript({ content })`.
//
// Why `{ content }` and not `addInitScript(fn, arg)`: the old inpage.js was a single
// function serialized by Playwright and called with a config argument in the page.
// Splitting it into separate HTML/CSS/JS files on disk means there is no longer one
// function to serialize - the files have to be read and joined into raw source text
// instead. `{ content }` runs that raw text directly, but (unlike `addInitScript(fn,
// arg)`) it has no way to pass a second argument into the page, so the config that
// used to arrive as installOverlay's parameter is baked into the string here as a
// `const __CFG__ = <JSON>` literal, alongside the HTML/CSS the overlay mounts.
//
// Concatenation order: the plain JS files first (selectors.js's pure functions, then
// overlay.js, which calls them and defines installOverlay), then the baked
// config/markup/style constants those files reference, then a bootstrap call that
// invokes installOverlay now that everything it needs is in scope - all wrapped in one
// IIFE so nothing leaks into the page as a global except window.__playright itself.
const fs = require('fs');
const path = require('path');

const UI_DIR = path.join(__dirname, 'ui');

// Cached after the first read: record.js may call buildOverlayScript() once per
// navigation across a whole recording session, and re-reading four files off disk that
// often would be wasted work for content that never changes mid-run.
let cachedSources = null;

function readSources() {
  return {
    selectorsJs: fs.readFileSync(path.join(UI_DIR, 'selectors.js'), 'utf8'),
    overlayJs: fs.readFileSync(path.join(UI_DIR, 'overlay.js'), 'utf8'),
    html: fs.readFileSync(path.join(UI_DIR, 'overlay.html'), 'utf8'),
    css: fs.readFileSync(path.join(UI_DIR, 'overlay.css'), 'utf8'),
  };
}

function buildOverlayScript(config) {
  if (!cachedSources) cachedSources = readSources();
  const { selectorsJs, overlayJs, html, css } = cachedSources;

  return [
    '(function () {',
    selectorsJs,
    overlayJs,
    `const __CFG__ = ${JSON.stringify(config)};`,
    `const __HTML__ = ${JSON.stringify(html)};`,
    `const __CSS__ = ${JSON.stringify(css)};`,
    'installOverlay(__CFG__, __HTML__, __CSS__);',
    '})();',
  ].join('\n');
}

module.exports = { buildOverlayScript };
