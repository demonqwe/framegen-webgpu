import { getDomainFromUrl } from '../config/defaults';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Anime FrameGen] Service Worker installed.');

  // Set default settings
  chrome.storage.local.get(['globalSettings', 'frameGenSettings'], (result) => {
    if (!result.globalSettings && !result.frameGenSettings) {
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

// Relay messages if needed between popup and active tab, or provide tab context for iframes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_CONTEXT') {
    const tabUrl = sender.tab?.url || '';
    const tabDomain = getDomainFromUrl(tabUrl);
    sendResponse({
      tabUrl,
      tabDomain,
      frameId: sender.frameId
    });
    return false; // Synchronous response
  }

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

