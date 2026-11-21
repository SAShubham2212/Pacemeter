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

const highSlider = document.getElementById('high-wpm');
const highVal = document.getElementById('high-wpm-val');
const minSlider = document.getElementById('min-wpm');
const minVal = document.getElementById('min-wpm-val');
const chimeToggle = document.getElementById('chime-toggle');
const compactToggle = document.getElementById('compact-toggle');
const noticeEl = document.getElementById('notice');

let current = { ...DEFAULT_SETTINGS };

const showNotice = (text, isOk = false) => {
  noticeEl.textContent = text;
  noticeEl.className = isOk ? 'notice ok' : 'notice';
  noticeEl.style.display = 'block';
};

const isInjectableUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
    return false;
  }
  return true;
};

const save = () => {
  chrome.storage.local.set({ paceSettings: current });
};

chrome.storage.local.get(['paceSettings'], (res) => {
  if (res.paceSettings) current = { ...DEFAULT_SETTINGS, ...res.paceSettings };
  highSlider.value = current.highSpeedWpm;
  highVal.textContent = current.highSpeedWpm + ' WPM';
  minSlider.value = current.minWpm;
  minVal.textContent = current.minWpm + ' WPM';
  chimeToggle.checked = Boolean(current.chimeEnabled);
  compactToggle.checked = current.overlayStyle === 'compact';
});

highSlider.addEventListener('input', () => {
  current.highSpeedWpm = Number(highSlider.value);
  current.targetMaxWpm = Math.max(current.minWpm + 10, current.highSpeedWpm - 14);
  highVal.textContent = current.highSpeedWpm + ' WPM';
  save();
});

minSlider.addEventListener('input', () => {
  current.minWpm = Number(minSlider.value);
  minVal.textContent = current.minWpm + ' WPM';
  save();
});

chimeToggle.addEventListener('change', () => {
  current.chimeEnabled = chimeToggle.checked;
  save();
});

compactToggle.addEventListener('change', () => {
  current.overlayStyle = compactToggle.checked ? 'compact' : 'standard';
  save();
});

function openStandaloneWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('meter.html'),
    type: 'popup',
    width: 300,
    height: 250,
  });
}

async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showNotice('No active browser tab found. Opening standalone meter window instead.');
      if (message.type === 'START_HUD') openStandaloneWindow();
      return;
    }

    if (!isInjectableUrl(tab.url)) {
      if (message.type === 'START_HUD') {
        showNotice('Browser system pages (chrome://, New Tab, Web Store) block overlays. Opening Standalone Meter Window instead.', true);
        openStandaloneWindow();
      } else {
        showNotice('Open a regular website (e.g. Google Meet, Zoom, Teams) or use Standalone Meter Window.');
      }
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, message);
      if (message.type === 'START_HUD') {
        showNotice('Overlay active on current lecture tab.', true);
      } else {
        showNotice('Monitoring stopped on current tab.', true);
      }
    } catch {
      if (message.type === 'STOP_HUD') {
        showNotice('Overlay is not active on this tab.');
        return;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }, 160);
        showNotice('Overlay launched on current tab.', true);
      } catch {
        showNotice('This page restricts script injection. Opening Standalone Meter Window instead.');
        openStandaloneWindow();
      }
    }
  } catch {
    showNotice('Could not reach active tab. Use Open Standalone Meter Window above.');
  }
}

document.getElementById('launch-btn').addEventListener('click', () => {
  sendToActiveTab({ type: 'START_HUD' });
});

document.getElementById('window-btn').addEventListener('click', () => {
  openStandaloneWindow();
});

document.getElementById('stop-btn').addEventListener('click', () => {
  sendToActiveTab({ type: 'STOP_HUD' });
});

document.getElementById('mic-help-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
});
