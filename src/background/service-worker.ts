/**
 * Chrome Extension Background Service Worker (Manifest V3)
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Anime FrameGen] Service Worker installed.');

  // Set default settings
  chrome.storage.local.get(['frameGenSettings'], (result) => {
    if (!result.frameGenSettings) {
      chrome.storage.local.set({
        frameGenSettings: {
          enabled: true,
          targetFpsMode: '2x',
          resolutionProfile: 'auto',
          anime4kParams: {
            strength: 0.8,
            thinningThreshold: 0.05
          },
          showBadge: true
        }
      });
    }
  });
});

// Relay messages if needed between popup and active tab
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_ACTIVE_TAB_STATUS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ active: false, error: 'No video player found on current page.' });
          } else {
            sendResponse(response);
          }
        });
      } else {
        sendResponse({ active: false, error: 'No active tab found.' });
      }
    });
    return true; // async response
  }
});
