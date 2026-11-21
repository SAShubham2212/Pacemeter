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
let running = false;
let audioCtx = null;
let stream = null;
let analyser = null;
let recognition = null;
let rafId = null;
let tickId = null;

const syllables = [];
const words = [];
const wordMap = new Map();
let noiseFloor = 0.015;
let prevRms = 0;
let lastPeak = 0;
let lastVoice = 0;
let currentRms = 0;
let smoothed = 0;
let highStreak = 0;
let lastChimeAt = 0;
let startedAt = 0;

const btn = document.getElementById('toggle-btn');
const wpmEl = document.getElementById('wpm');
const limitEl = document.getElementById('limit');
const stateEl = document.getElementById('state');
const fillEl = document.getElementById('fill');
const lvlEl = document.getElementById('lvl');
const engEl = document.getElementById('eng');
const errEl = document.getElementById('err');

chrome.storage.local.get(['paceSettings'], (res) => {
  if (res.paceSettings) settings = { ...DEFAULT_SETTINGS, ...res.paceSettings };
  limitEl.textContent = 'Alert ' + settings.highSpeedWpm;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.paceSettings && changes.paceSettings.newValue) {
    settings = { ...DEFAULT_SETTINGS, ...changes.paceSettings.newValue };
    limitEl.textContent = 'Alert ' + settings.highSpeedWpm;
  }
});

function playChime() {
  if (!settings.chimeEnabled) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = audioCtx || new Ctx();
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
    osc.connect(g); g.connect(ctx.destination);
    osc.start(now + delay); osc.stop(now + delay + dur + 0.02);
  };
  note(659.25, 0, 0.22);
  note(523.25, 0.16, 0.3);
}

function stopMeter() {
  running = false;
  btn.textContent = 'Start Mic';
  btn.classList.remove('stop');
  document.body.classList.remove('alert');
  if (rafId) cancelAnimationFrame(rafId);
  if (tickId) clearInterval(tickId);
  if (recognition) { try { recognition.onend = null; recognition.stop(); } catch {} recognition = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  wpmEl.textContent = '0';
  fillEl.style.width = '0%';
  stateEl.className = 'state';
  stateEl.textContent = 'Standby — click Start Mic';
  chrome.runtime.sendMessage({ type: 'PACE_UPDATE', active: false, wpm: 0, zone: 'standby', highAlert: false }).catch(() => {});
}

async function startMeter() {
  errEl.style.display = 'none';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    const src = audioCtx.createMediaStreamSource(stream);
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1150; bp.Q.value = 0.75;
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
    src.connect(bp); bp.connect(analyser);

    running = true;
    startedAt = Date.now();
    smoothed = 0; highStreak = 0;
    syllables.length = 0; words.length = 0; wordMap.clear();
    btn.textContent = 'Stop';
    btn.classList.add('stop');

    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      if (!running || !analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sq = 0;
      for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
      const rms = Math.sqrt(sq / buf.length);
      const now = Date.now();
      noiseFloor = rms < noiseFloor * 1.4 ? noiseFloor * 0.985 + rms * 0.015 : noiseFloor * 0.998 + rms * 0.002;
      noiseFloor = Math.max(0.005, Math.min(0.06, noiseFloor));
      const th = Math.max(0.022, noiseFloor * 2.5);
      if (rms > th * 0.9) lastVoice = now;
      if (rms > th && rms > prevRms * 1.12 && now - lastPeak >= 120) {
        syllables.push(now); lastPeak = now;
      }
      prevRms = rms;
      currentRms = Math.min(1, rms * 7.5);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && settings.engine !== 'acoustic') {
      try {
        recognition = new SR();
        recognition.continuous = true; recognition.interimResults = true; recognition.lang = 'en-US';
        recognition.onresult = (e) => {
          const now = Date.now();
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const txt = (e.results[i][0]?.transcript || '').trim();
            const cnt = txt ? txt.split(/\s+/).filter(Boolean).length : 0;
            const prev = wordMap.get(i) || 0;
            if (cnt > prev) {
              for (let k = 0; k < cnt - prev; k++) words.push(now);
              wordMap.set(i, cnt); lastVoice = now;
            }
          }
        };
        recognition.onend = () => { if (running && recognition) { wordMap.clear(); try { recognition.start(); } catch {} } };
        recognition.start();
        engEl.textContent = 'Hybrid DSP';
      } catch { engEl.textContent = 'Local DSP'; }
    } else {
      engEl.textContent = 'Local DSP';
    }

    tickId = setInterval(() => {
      if (!running) return;
      const now = Date.now();
      const cut = now - 10000;
      while (syllables.length && syllables[0] < cut) syllables.shift();
      while (words.length && words[0] < cut) words.shift();
      const span = Math.min(10, Math.max(2.5, (now - startedAt) / 1000));
      const aWpm = ((syllables.length / span) * 60 / 1.55) * (settings.sensitivity || 1);
      const sWpm = words.length > 0 ? (words.length / span) * 60 : 0;
      let target = settings.engine === 'acoustic'
        ? aWpm
        : sWpm > 20 && aWpm > 20 ? sWpm * 0.65 + aWpm * 0.35 : (sWpm > 20 ? sWpm : aWpm);
      if (now - lastVoice > 2400) { target = smoothed * 0.68; if (target < 10) target = 0; }
      smoothed = smoothed === 0 && target > 0 ? target : smoothed * 0.62 + target * 0.38;
      const wpm = Math.min(260, Math.max(0, Math.round(smoothed)));

      let zone = 'standby';
      if (wpm >= settings.highSpeedWpm) zone = 'high';
      else if (wpm > settings.targetMaxWpm) zone = 'caution';
      else if (wpm >= settings.minWpm) zone = 'optimal';
      else if (wpm >= 15) zone = 'slow';

      if (zone === 'high') highStreak++; else highStreak = 0;
      const highAlert = highStreak >= (settings.sustainSeconds || 3);
      if (highAlert && now - lastChimeAt >= 9000) { playChime(); lastChimeAt = now; }

      wpmEl.textContent = String(wpm);
      lvlEl.textContent = 'Input: ' + Math.round(currentRms * 100) + '%';
      fillEl.style.width = Math.min(100, Math.round((wpm / 220) * 100)) + '%';
      fillEl.style.backgroundColor = zone === 'high' ? '#EF4444' : zone === 'caution' ? '#F59E0B' : zone === 'optimal' ? '#10B981' : '#38BDF8';
      document.body.classList.toggle('alert', highAlert);
      stateEl.className = 'state ' + zone;
      stateEl.textContent = highAlert
        ? '▲ Too Fast — Slow Down'
        : zone === 'high' ? '▲ High Speed'
        : zone === 'caution' ? '◆ Slightly Fast'
        : zone === 'optimal' ? '● Optimal Lecture Pace'
        : zone === 'slow' ? '▼ Slow — Pick Up'
        : 'Listening...';

      chrome.runtime.sendMessage({ type: 'PACE_UPDATE', active: true, wpm, zone, highAlert }).catch(() => {});
    }, 1000);
  } catch {
    errEl.style.display = 'block';
    errEl.textContent = 'Microphone access was blocked. Allow microphone permission for this extension.';
  }
}

btn.addEventListener('click', () => (running ? stopMeter() : startMeter()));
window.addEventListener('beforeunload', () => stopMeter());
