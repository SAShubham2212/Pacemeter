// PaceMeter MV3 Service Worker
const DEFAULT_SETTINGS = {
  "minWpm": 115,
  "targetMaxWpm": 152,
  "highSpeedWpm": 168,
  "sustainSeconds": 3,
  "engine": "hybrid",
  "chimeEnabled": true,
  "chimeVolume": 0.35,
  "sensitivity": 1,
  "overlayCorner": "top-right",
  "overlayStyle": "standard",
  "autoLaunchOnMeet": true,
  "showBadgeWpm": true
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['paceSettings'], (res) => {
    if (!res.paceSettings) {
      chrome.storage.local.set({ paceSettings: DEFAULT_SETTINGS });
    }
  });
});

function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
    return false;
  }
  return true;
}

function openStandaloneMeterWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('meter.html'),
    type: 'popup',
    width: 300,
    height: 250,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'PACE_UPDATE') {
    const tabId = sender.tab && sender.tab.id ? sender.tab.id : undefined;
    chrome.storage.local.get(['paceSettings'], (res) => {
      const settings = res.paceSettings || DEFAULT_SETTINGS;
      const target = tabId ? { tabId } : {};
      if (!settings.showBadgeWpm) {
        chrome.action.setBadgeText({ text: '', ...target }).catch(() => {});
        return;
      }
      const wpm = Math.round(msg.wpm || 0);
      const text = msg.active ? (msg.highAlert ? 'FAST' : String(wpm)) : '';
      const color = msg.highAlert
        ? '#DC2626'
        : msg.zone === 'caution'
          ? '#D97706'
          : msg.zone === 'optimal'
            ? '#16A34A'
            : '#0284C7';
      chrome.action.setBadgeText({ text, ...target }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color, ...target }).catch(() => {});
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-pacemeter') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !isInjectableUrl(tab.url)) {
      // Restricted browser page (e.g. chrome://extensions, New Tab) -> open standalone meter window
      openStandaloneMeterWindow();
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HUD' });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_HUD' }).catch(() => {});
      }, 150);
    }
  } catch {
    openStandaloneMeterWindow();
  }
});
