/**
 * Content Script Loader for Chrome Extension Manifest V3
 * Loads content.js as an ES Module to support import.meta and WebAssembly.
 */
(async () => {
  try {
    const src = chrome.runtime.getURL('content.js');
    await import(src);
  } catch (err) {
    console.error('[Anime FrameGen] Failed to load content script module:', err);
  }
})();
