const DEFAULT_SETTINGS = {
  masterEnabled: true,
  enabled: true,
  showOriginal: true,
  ttsEnabled: true,
  autoTtsSpeed: true,
  vocalRemoveEnabled: false,
  ttsVoice: 'google:id',
  ttsRate: 1.1,
  ttsVolume: 1.0,
  duckVolume: 0.15,
  fontSize: 22
};

const els = {
  appRoot: document.getElementById('appRoot'),
  btnMasterToggle: document.getElementById('btnMasterToggle'),
  masterToggleText: document.getElementById('masterToggleText'),
  enabled: document.getElementById('enabled'),
  showOriginal: document.getElementById('showOriginal'),
  ttsEnabled: document.getElementById('ttsEnabled'),
  autoTtsSpeed: document.getElementById('autoTtsSpeed'),
  vocalRemoveEnabled: document.getElementById('vocalRemoveEnabled'),
  ttsVoice: document.getElementById('ttsVoice'),
  browserVoicesGroup: document.getElementById('browserVoicesGroup'),
  ttsRate: document.getElementById('ttsRate'),
  ttsRateLabel: document.getElementById('ttsRateLabel'),
  ttsRateVal: document.getElementById('ttsRateVal'),
  ttsVolume: document.getElementById('ttsVolume'),
  ttsVolumeVal: document.getElementById('ttsVolumeVal'),
  duckVolume: document.getElementById('duckVolume'),
  duckVolumeVal: document.getElementById('duckVolumeVal'),
  fontSize: document.getElementById('fontSize'),
  fontSizeVal: document.getElementById('fontSizeVal'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  autoSpeedBadge: document.getElementById('autoSpeedBadge'),
  btnTestTts: document.getElementById('btnTestTts'),
  btnReload: document.getElementById('btnReload')
};

let currentSettings = { ...DEFAULT_SETTINGS };
let testAudio = null;
let statusHoldUntil = 0;
let autoInjectAttempted = false;

function populateBrowserVoices() {
  if (!('speechSynthesis' in window) || !els.browserVoicesGroup) return;
  const voices = window.speechSynthesis.getVoices() || [];
  if (voices.length === 0) return;

  // Keep default auto option, then list Indonesian voices first followed by others
  els.browserVoicesGroup.innerHTML = '<option value="browser:auto">Browser TTS (Otomatis)</option>';

  const idVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('id'));
  const otherVoices = voices.filter((v) => !v.lang || !v.lang.toLowerCase().startsWith('id')).slice(0, 12);
  const ordered = [...idVoices, ...otherVoices];

  for (const v of ordered) {
    const opt = document.createElement('option');
    opt.value = `browser:${v.name}`;
    opt.textContent = `${v.name} (${v.lang || 'OS'})`;
    els.browserVoicesGroup.appendChild(opt);
  }

  if (currentSettings.ttsVoice) {
    els.ttsVoice.value = currentSettings.ttsVoice;
  }
}

function renderSettings(s) {
  const isMasterOn = s.masterEnabled !== false;
  els.appRoot.classList.toggle('is-off', !isMasterOn);
  els.btnMasterToggle.classList.toggle('on', isMasterOn);
  els.btnMasterToggle.classList.toggle('off', !isMasterOn);
  els.masterToggleText.textContent = isMasterOn ? 'ON' : 'OFF';

  els.enabled.checked = Boolean(s.enabled);
  els.showOriginal.checked = Boolean(s.showOriginal);
  els.ttsEnabled.checked = Boolean(s.ttsEnabled);
  els.autoTtsSpeed.checked = Boolean(s.autoTtsSpeed);
  els.vocalRemoveEnabled.checked = Boolean(s.vocalRemoveEnabled);
  els.ttsVoice.value = s.ttsVoice || 'google:id';
  if (!els.ttsVoice.value) {
    els.ttsVoice.value = 'google:id';
  }

  els.ttsRateLabel.textContent = s.autoTtsSpeed ? 'Kecepatan Dasar (Auto)' : 'Kecepatan Suara (Manual)';
  els.ttsRate.value = s.ttsRate;
  els.ttsRateVal.textContent = `${Number(s.ttsRate).toFixed(2)}x`;

  els.ttsVolume.value = s.ttsVolume;
  els.ttsVolumeVal.textContent = `${Math.round(Number(s.ttsVolume) * 100)}%`;

  els.duckVolume.value = s.duckVolume;
  els.duckVolumeVal.textContent = `${Math.round(Number(s.duckVolume) * 100)}%`;

  els.fontSize.value = s.fontSize;
  els.fontSizeVal.textContent = `${Math.round(Number(s.fontSize))}px`;
}

function savePatch(patch) {
  currentSettings = { ...currentSettings, ...patch };
  chrome.storage.sync.set(patch);
  renderSettings(currentSettings);
}

function setStatusUI(state, text, ttsInfo = null) {
  els.statusDot.className = `status-dot ${state}`;
  els.statusText.textContent = text;

  if (ttsInfo && ttsInfo.autoTtsSpeed && currentSettings.ttsEnabled && state === 'ready') {
    els.autoSpeedBadge.textContent = `Auto ${Number(ttsInfo.currentRate).toFixed(2)}x`;
    els.autoSpeedBadge.title = `Tempo terdeteksi: ${ttsInfo.paceLabel}`;
    els.autoSpeedBadge.classList.remove('hidden');
  } else {
    els.autoSpeedBadge.classList.add('hidden');
  }
}

function queryActiveVideoTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      callback(null);
      return;
    }
    callback(tab);
  });
}

async function tryAutoInjectTab(tabId) {
  if (!chrome.scripting) return false;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['page-bridge.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    });
    return true;
  } catch {
    return false;
  }
}

function refreshTabStatus() {
  if (Date.now() < statusHoldUntil) return;
  if (currentSettings.masterEnabled === false) {
    setStatusUI('idle', 'Ekstensi sedang dinonaktifkan');
    return;
  }
  queryActiveVideoTab((tab) => {
    if (!tab) {
      setStatusUI('idle', 'Buka video (YouTube, Udemy, dll.) untuk mulai');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, async (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (!autoInjectAttempted) {
          autoInjectAttempted = true;
          setStatusUI('loading', 'Menghubungkan ke halaman video...');
          const injected = await tryAutoInjectTab(tab.id);
          if (injected) {
            setTimeout(refreshTabStatus, 700);
            return;
          }
        }
        setStatusUI('loading', 'Refresh halaman ini (F5 / Ctrl+R) agar ekstensi terhubung');
        return;
      }

      if (resp.status === 'ready') {
        setStatusUI('ready', resp.statusDetail || 'Subtitle Indonesia aktif', resp.ttsInfo);
      } else if (resp.status === 'loading') {
        setStatusUI('loading', resp.statusDetail || 'Memuat subtitle...');
      } else if (resp.status === 'no_captions') {
        setStatusUI('error', resp.statusDetail || 'Video tidak punya caption');
      } else {
        setStatusUI('idle', resp.statusDetail || 'Siap menerjemahkan video');
      }
    });
  });
}

async function runVoiceTest() {
  const sample = 'Halo! Ini adalah tes suara dubbing bahasa Indonesia otomatis untuk YouTube.';
  const voice = currentSettings.ttsVoice || 'google:id';
  els.btnTestTts.textContent = 'Memuat...';
  els.btnTestTts.disabled = true;

  const restoreBtn = () => {
    els.btnTestTts.textContent = 'Tes Suara';
    els.btnTestTts.disabled = false;
  };

  const showTempError = (msg) => {
    statusHoldUntil = Date.now() + 4500;
    setStatusUI('error', msg);
    restoreBtn();
  };

  if (testAudio) {
    try {
      testAudio.onended = null;
      testAudio.onerror = null;
      testAudio.pause();
    } catch {
      // ignore
    }
    testAudio = null;
  }

  if (voice.startsWith('browser:')) {
    if (!('speechSynthesis' in window)) {
      showTempError('Browser TTS tidak tersedia');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(sample);
    utter.lang = 'id-ID';
    utter.rate = Number(currentSettings.ttsRate) || 1.1;
    utter.volume = Number(currentSettings.ttsVolume) || 1.0;

    const selectedName = voice.slice('browser:'.length);
    const voices = window.speechSynthesis.getVoices() || [];
    const picked =
      (selectedName && selectedName !== 'auto'
        ? voices.find((v) => v.name === selectedName || v.voiceURI === selectedName)
        : null) ||
      voices.find((v) => v.lang && v.lang.toLowerCase() === 'id-id') ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('id'));
    if (picked) utter.voice = picked;

    els.btnTestTts.textContent = 'Memutar...';
    utter.onend = restoreBtn;
    utter.onerror = () => showTempError('Browser TTS gagal memutar suara');
    window.speechSynthesis.speak(utter);
    return;
  }

  chrome.runtime.sendMessage({ type: 'FETCH_TTS_AUDIO', text: sample, voice, lang: 'id', isTest: true }, (resp) => {
    const runtimeErr = chrome.runtime.lastError?.message;
    if (runtimeErr || !resp || !resp.ok || !resp.audioUrls || resp.audioUrls.length === 0) {
      const detail = runtimeErr || resp?.error || 'Koneksi ke server TTS gagal';
      showTempError(`Gagal memuat suara (${detail})`);
      return;
    }

    els.btnTestTts.textContent = 'Memutar...';
    testAudio = new Audio(resp.audioUrls[0]);
    testAudio.preservesPitch = true;
    testAudio.volume = Math.max(0.1, Math.min(1, Number(currentSettings.ttsVolume) || 1));
    testAudio.playbackRate = Math.max(0.8, Math.min(1.8, Number(currentSettings.ttsRate) || 1.1));
    testAudio.onended = restoreBtn;
    testAudio.onerror = () => showTempError('Audio gagal didekode browser');
    testAudio.play().catch((err) => showTempError(`Gagal putar audio: ${err?.message || 'blocked'}`));
  });
}

// Bind controls
els.btnMasterToggle.addEventListener('click', () => {
  const next = currentSettings.masterEnabled === false;
  savePatch({ masterEnabled: next });
  if (!next) {
    setStatusUI('idle', 'Ekstensi sedang dinonaktifkan');
  } else {
    setStatusUI('loading', 'Mengaktifkan ekstensi...');
    setTimeout(refreshTabStatus, 400);
  }
});

els.enabled.addEventListener('change', () => savePatch({ enabled: els.enabled.checked }));
els.showOriginal.addEventListener('change', () => savePatch({ showOriginal: els.showOriginal.checked }));
els.ttsEnabled.addEventListener('change', () => savePatch({ ttsEnabled: els.ttsEnabled.checked }));
els.autoTtsSpeed.addEventListener('change', () => savePatch({ autoTtsSpeed: els.autoTtsSpeed.checked }));
els.vocalRemoveEnabled.addEventListener('change', () => savePatch({ vocalRemoveEnabled: els.vocalRemoveEnabled.checked }));
els.ttsVoice.addEventListener('change', () => savePatch({ ttsVoice: els.ttsVoice.value }));

els.ttsRate.addEventListener('input', () => savePatch({ ttsRate: parseFloat(els.ttsRate.value) }));
els.ttsVolume.addEventListener('input', () => savePatch({ ttsVolume: parseFloat(els.ttsVolume.value) }));
els.duckVolume.addEventListener('input', () => savePatch({ duckVolume: parseFloat(els.duckVolume.value) }));
els.fontSize.addEventListener('input', () => savePatch({ fontSize: parseInt(els.fontSize.value, 10) }));

els.btnTestTts.addEventListener('click', runVoiceTest);

els.btnReload.addEventListener('click', () => {
  queryActiveVideoTab((tab) => {
    if (!tab) {
      setStatusUI('idle', 'Buka halaman video terlebih dahulu');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_CAPTIONS' }, async () => {
      if (chrome.runtime.lastError) {
        setStatusUI('loading', 'Menghubungkan ulang ke tab video...');
        const ok = await tryAutoInjectTab(tab.id);
        if (ok) {
          setTimeout(refreshTabStatus, 800);
        } else {
          setStatusUI('error', 'Refresh tab video (F5) lalu coba lagi');
        }
        return;
      }
      setStatusUI('loading', 'Memuat ulang subtitle...');
      setTimeout(refreshTabStatus, 1500);
    });
  });
});

if ('speechSynthesis' in window) {
  window.speechSynthesis.addEventListener('voiceschanged', populateBrowserVoices);
}

// Init + live poll while popup is open
chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  populateBrowserVoices();
  renderSettings(currentSettings);
  refreshTabStatus();
  setInterval(refreshTabStatus, 1000);
});
