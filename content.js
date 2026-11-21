// PaceMeter Floating Lecture Overlay (Shadow DOM + 100% Local Audio Analysis)
(() => {
  if (window.__PACEMETER_INJECTED__) {
    return;
  }
  window.__PACEMETER_INJECTED__ = true;

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
  let settings = { ...DEFAULT_SETTINGS };
  let isRunning = false;
  let isVisible = false;
  let audioCtx = null;
  let stream = null;
  let analyser = null;
  let recognition = null;
  let rafId = null;
  let tickId = null;

  const syllableTimestamps = [];
  const wordTimestamps = [];
  const wordCountsByResult = new Map();
  let noiseFloor = 0.015;
  let prevRms = 0;
  let lastPeakTime = 0;
  let lastVoiceTime = 0;
  let currentRms = 0;
  let smoothedWpm = 0;
  let consecutiveHigh = 0;
  let lastChimeAt = 0;
  let startedAt = 0;

  // Create Shadow DOM container so host lecture page styles never leak
  const host = document.createElement('div');
  host.id = 'pacemeter-extension-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;display:none;user-select:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const applyCornerPosition = (corner) => {
    host.style.top = '';
    host.style.right = '';
    host.style.bottom = '';
    host.style.left = '';
    if (corner === 'top-left') { host.style.top = '18px'; host.style.left = '18px'; }
    else if (corner === 'bottom-left') { host.style.bottom = '18px'; host.style.left = '18px'; }
    else if (corner === 'bottom-right') { host.style.bottom = '18px'; host.style.right = '18px'; }
    else { host.style.top = '18px'; host.style.right = '18px'; }
  };

  shadow.innerHTML = `
    <style>
      :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .hud {
        width: 224px;
        background: rgba(15, 23, 42, 0.94);
        color: #F8FAFC;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 12px;
        padding: 12px 14px;
        box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
        backdrop-filter: blur(8px);
        transition: border-color 180ms ease, background-color 180ms ease;
      }
      .hud.alert {
        border-color: #EF4444;
        background: rgba(69, 10, 10, 0.95);
      }
      .hud.compact { width: 176px; padding: 9px 12px; }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: grab;
        margin-bottom: 8px;
      }
      .brand { font-size: 11px; font-weight: 600; color: #94A3B8; letter-spacing: 0.02em; }
      .actions { display: flex; gap: 6px; }
      .icon-btn {
        background: rgba(255,255,255,0.08);
        color: #E2E8F0;
        border: none;
        border-radius: 6px;
        padding: 3px 7px;
        font-size: 11px;
        cursor: pointer;
      }
      .icon-btn:hover { background: rgba(255,255,255,0.18); }
      .readout {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .wpm {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-variant-numeric: tabular-nums;
        font-size: 30px;
        font-weight: 700;
        line-height: 1;
      }
      .unit { font-size: 11px; color: #94A3B8; margin-left: 4px; font-family: ui-monospace, monospace; }
      .state {
        font-size: 12px;
        font-weight: 600;
        margin-top: 6px;
      }
      .state.optimal { color: #34D399; }
      .state.caution { color: #FBBF24; }
      .state.high { color: #FCA5A5; }
      .state.slow { color: #38BDF8; }
      .state.standby { color: #94A3B8; }
      .track {
        height: 6px;
        background: rgba(148, 163, 184, 0.22);
        border-radius: 3px;
        margin-top: 9px;
        overflow: hidden;
        position: relative;
      }
      .fill {
        height: 100%;
        width: 0%;
        background: #38BDF8;
        transition: width 180ms ease, background-color 180ms ease;
      }
      .meta {
        margin-top: 7px;
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: #94A3B8;
        font-family: ui-monospace, monospace;
      }
      .hud.compact .meta { display: none; }
      .err {
        margin-top: 6px;
        font-size: 11px;
        color: #FCA5A5;
        line-height: 1.35;
      }
    </style>
    <div class="hud" id="hud">
      <div class="bar" id="drag-bar">
        <span class="brand">PaceMeter</span>
        <div class="actions">
          <button class="icon-btn" id="toggle-mic">Start</button>
          <button class="icon-btn" id="close-hud" title="Hide">×</button>
        </div>
      </div>
      <div class="readout">
        <div><span class="wpm" id="wpm-val">0</span><span class="unit">WPM</span></div>
        <span class="unit" id="target-label">Max 168</span>
      </div>
      <div class="state standby" id="pace-state">Standby — click Start</div>
      <div class="track"><div class="fill" id="pace-fill"></div></div>
      <div class="meta">
        <span id="mic-level">Level: 0%</span>
        <span id="engine-tag">Local DSP</span>
      </div>
      <div class="err" id="err-box" style="display:none;"></div>
    </div>
  `;

  const hudEl = shadow.getElementById('hud');
  const dragBar = shadow.getElementById('drag-bar');
  const wpmEl = shadow.getElementById('wpm-val');
  const stateEl = shadow.getElementById('pace-state');
  const fillEl = shadow.getElementById('pace-fill');
  const targetEl = shadow.getElementById('target-label');
  const levelEl = shadow.getElementById('mic-level');
  const engineEl = shadow.getElementById('engine-tag');
  const errEl = shadow.getElementById('err-box');
  const toggleBtn = shadow.getElementById('toggle-mic');
  const closeBtn = shadow.getElementById('close-hud');

  // Draggable HUD positioning
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  dragBar.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    const rect = host.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    host.style.right = '';
    host.style.bottom = '';
    host.style.left = rect.left + 'px';
    host.style.top = rect.top + 'px';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    host.style.left = Math.max(8, Math.min(window.innerWidth - 232, e.clientX - offsetX)) + 'px';
    host.style.top = Math.max(8, Math.min(window.innerHeight - 130, e.clientY - offsetY)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  const playSlowDownChime = () => {
    if (!settings.chimeEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = audioCtx || new AudioCtx();
    const now = ctx.currentTime;
    const vol = Math.max(0.03, Math.min(0.45, (settings.chimeVolume || 0.35) * 0.4));
    const note = (freq, delay, dur) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(vol, now + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.02);
    };
    note(659.25, 0, 0.22);
    note(523.25, 0.16, 0.3);
  };

  const updateSettingsUI = () => {
    targetEl.textContent = 'Alert ' + settings.highSpeedWpm;
    hudEl.classList.toggle('compact', settings.overlayStyle === 'compact');
  };

  const stopMeter = () => {
    isRunning = false;
    toggleBtn.textContent = 'Start';
    if (rafId) cancelAnimationFrame(rafId);
    if (tickId) clearInterval(tickId);
    if (recognition) { try { recognition.onend = null; recognition.stop(); } catch {} recognition = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    hudEl.classList.remove('alert');
    wpmEl.textContent = '0';
    fillEl.style.width = '0%';
    stateEl.className = 'state standby';
    stateEl.textContent = 'Standby — click Start';
    chrome.runtime.sendMessage({ type: 'PACE_UPDATE', active: false, wpm: 0, zone: 'standby', highAlert: false }).catch(() => {});
  };

  const startMeter = async () => {
    errEl.style.display = 'none';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();
      const src = audioCtx.createMediaStreamSource(stream);
      const bandpass = audioCtx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1150;
      bandpass.Q.value = 0.75;
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(bandpass);
      bandpass.connect(analyser);

      isRunning = true;
      startedAt = Date.now();
      smoothedWpm = 0;
      consecutiveHigh = 0;
      syllableTimestamps.length = 0;
      wordTimestamps.length = 0;
      toggleBtn.textContent = 'Stop';

      const buf = new Float32Array(analyser.fftSize);
      const loop = () => {
        if (!isRunning || !analyser) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        noiseFloor = rms < noiseFloor * 1.4 ? noiseFloor * 0.985 + rms * 0.015 : noiseFloor * 0.998 + rms * 0.002;
        noiseFloor = Math.max(0.005, Math.min(0.06, noiseFloor));
        const thresh = Math.max(0.022, noiseFloor * 2.5);
        if (rms > thresh * 0.9) lastVoiceTime = now;
        if (rms > thresh && rms > prevRms * 1.12 && now - lastPeakTime >= 120) {
          syllableTimestamps.push(now);
          lastPeakTime = now;
        }
        prevRms = rms;
        currentRms = Math.min(1, rms * 7.5);
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);

      const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechCtor && settings.engine !== 'acoustic') {
        try {
          recognition = new SpeechCtor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          recognition.onresult = (e) => {
            const now = Date.now();
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const text = (e.results[i][0]?.transcript || '').trim();
              const count = text ? text.split(/\s+/).filter(Boolean).length : 0;
              const prev = wordCountsByResult.get(i) || 0;
              if (count > prev) {
                for (let k = 0; k < count - prev; k++) wordTimestamps.push(now);
                wordCountsByResult.set(i, count);
                lastVoiceTime = now;
              }
            }
          };
          recognition.onend = () => {
            if (isRunning && recognition) {
              wordCountsByResult.clear();
              try { recognition.start(); } catch {}
            }
          };
          recognition.start();
          engineEl.textContent = 'Hybrid DSP';
        } catch {
          engineEl.textContent = 'Local DSP';
        }
      } else {
        engineEl.textContent = 'Local DSP';
      }

      tickId = setInterval(() => {
        if (!isRunning) return;
        const now = Date.now();
        const cutoff = now - 10000;
        while (syllableTimestamps.length && syllableTimestamps[0] < cutoff) syllableTimestamps.shift();
        while (wordTimestamps.length && wordTimestamps[0] < cutoff) wordTimestamps.shift();

        const spanSec = Math.min(10, Math.max(2.5, (now - startedAt) / 1000));
        const acousticWpm = ((syllableTimestamps.length / spanSec) * 60 / 1.55) * (settings.sensitivity || 1);
        const speechWpm = wordTimestamps.length > 0 ? (wordTimestamps.length / spanSec) * 60 : 0;

        let targetWpm = settings.engine === 'acoustic'
          ? acousticWpm
          : speechWpm > 20 && acousticWpm > 20
            ? speechWpm * 0.65 + acousticWpm * 0.35
            : speechWpm > 20 ? speechWpm : acousticWpm;

        if (now - lastVoiceTime > 2400) {
          targetWpm = smoothedWpm * 0.68;
          if (targetWpm < 10) targetWpm = 0;
        }

        smoothedWpm = smoothedWpm === 0 && targetWpm > 0 ? targetWpm : smoothedWpm * 0.62 + targetWpm * 0.38;
        const wpm = Math.min(260, Math.max(0, Math.round(smoothedWpm)));

        let zone = 'standby';
        if (wpm >= settings.highSpeedWpm) zone = 'high';
        else if (wpm > settings.targetMaxWpm) zone = 'caution';
        else if (wpm >= settings.minWpm) zone = 'optimal';
        else if (wpm >= 15) zone = 'slow';

        if (zone === 'high') consecutiveHigh++;
        else consecutiveHigh = 0;

        const highAlert = consecutiveHigh >= (settings.sustainSeconds || 3);
        if (highAlert && now - lastChimeAt >= 9000) {
          playSlowDownChime();
          lastChimeAt = now;
        }

        wpmEl.textContent = String(wpm);
        levelEl.textContent = 'Level: ' + Math.round(currentRms * 100) + '%';
        fillEl.style.width = Math.min(100, Math.round((wpm / 220) * 100)) + '%';
        fillEl.style.backgroundColor =
          zone === 'high' ? '#EF4444' : zone === 'caution' ? '#F59E0B' : zone === 'optimal' ? '#10B981' : '#38BDF8';
        hudEl.classList.toggle('alert', highAlert);
        stateEl.className = 'state ' + zone;
        stateEl.textContent = highAlert
          ? '▲ Too Fast — Slow Down'
          : zone === 'high'
            ? '▲ High Speed'
            : zone === 'caution'
              ? '◆ Slightly Fast'
              : zone === 'optimal'
                ? '● Optimal Lecture Pace'
                : zone === 'slow'
                  ? '▼ Slow — Pick Up'
                  : 'Listening...';

        chrome.runtime.sendMessage({ type: 'PACE_UPDATE', active: true, wpm, zone, highAlert }).catch(() => {});
      }, 1000);
    } catch {
      errEl.textContent = 'Mic blocked on this site. Allow microphone permission for this tab and click Start.';
      errEl.style.display = 'block';
    }
  };

  toggleBtn.addEventListener('click', () => {
    if (isRunning) stopMeter();
    else startMeter();
  });

  closeBtn.addEventListener('click', () => {
    stopMeter();
    isVisible = false;
    host.style.display = 'none';
  });

  const showHud = () => {
    isVisible = true;
    host.style.display = 'block';
  };

  chrome.storage.local.get(['paceSettings'], (res) => {
    if (res.paceSettings) settings = { ...DEFAULT_SETTINGS, ...res.paceSettings };
    applyCornerPosition(settings.overlayCorner);
    updateSettingsUI();
    if (settings.autoLaunchOnMeet) {
      showHud();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.paceSettings && changes.paceSettings.newValue) {
      settings = { ...DEFAULT_SETTINGS, ...changes.paceSettings.newValue };
      updateSettingsUI();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SHOW_HUD') {
      showHud();
      sendResponse({ ok: true, visible: true, running: isRunning });
    } else if (msg.type === 'TOGGLE_HUD') {
      if (isVisible) {
        stopMeter();
        isVisible = false;
        host.style.display = 'none';
      } else {
        showHud();
      }
      sendResponse({ ok: true, visible: isVisible, running: isRunning });
    } else if (msg.type === 'START_HUD') {
      showHud();
      if (!isRunning) startMeter();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_HUD') {
      stopMeter();
      sendResponse({ ok: true });
    }
  });
})();
