(() => {
  if (window.__YT_INDOSUB_CONTENT_LOADED__) return;
  window.__YT_INDOSUB_CONTENT_LOADED__ = true;

  const BRIDGE_SRC = 'YT_INDOSUB_BRIDGE';
  const CONTENT_SRC = 'YT_INDOSUB_CONTENT';

  const DEFAULT_SETTINGS = {
    enabled: true,
    showOriginal: true,
    ttsEnabled: true,
    autoTtsSpeed: true,
    ttsEngine: 'google', // 'google' | 'browser'
    ttsRate: 1.1,
    ttsVolume: 1.0,
    duckVolume: 0.15,
    fontSize: 22
  };

  let settings = { ...DEFAULT_SETTINGS };

  const state = {
    videoId: '',
    sourceLang: 'en',
    cues: [], // { id, start, end, en, idText, translating }
    activeCueIndex: -1,
    status: 'idle', // idle | loading | ready | no_captions | error
    statusDetail: 'Menunggu video YouTube...',
    translatedCount: 0,
    runToken: 0,
    domFallbackObserver: null,
    domFallbackActive: false,
    lastDomText: '',
    lastDomSpokenAt: 0
  };

  let overlayEl = null;
  let enLineEl = null;
  let idLineEl = null;
  let toastEl = null;
  let toastTimer = null;
  let subBtnEl = null;
  let ttsBtnEl = null;
  let videoEl = null;

  // Audio ducking state
  let savedVideoVolume = null;
  let isDucking = false;

  // =========================
  // Settings & Persistence
  // =========================

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
        settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
        resolve(settings);
      });
    });
  }

  function saveSettingsPatch(patch) {
    settings = { ...settings, ...patch };
    chrome.storage.sync.set(patch);
    applySettingsUI();
  }

  // =========================
  // Helpers & Status
  // =========================

  function getCurrentVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = url.pathname.match(/^\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];
    } catch {
      // ignore
    }
    return '';
  }

  function decodeHtmlEntities(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
  }

  function cleanCaptionText(raw) {
    return decodeHtmlEntities(String(raw || ''))
      .replace(/\r?\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function showToast(text, duration = 2400) {
    ensureOverlay();
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('visible');
    }, duration);
  }

  function setStatus(status, detail) {
    state.status = status;
    state.statusDetail = detail;
  }

  // =========================
  // Cue Parsing & Merging
  // =========================

  function parseTimedText(body) {
    const trimmed = (body || '').trim();
    if (!trimmed) return [];

    let rawCues = [];

    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        const events = Array.isArray(json.events) ? json.events : [];
        for (const ev of events) {
          if (!Array.isArray(ev.segs)) continue;
          const text = cleanCaptionText(ev.segs.map((s) => s.utf8 || '').join(''));
          if (!text) continue;
          const start = (Number(ev.tStartMs) || 0) / 1000;
          const dur = (Number(ev.dDurationMs) || 2500) / 1000;
          rawCues.push({ start, end: start + Math.max(0.4, dur), en: text });
        }
      } catch {
        return [];
      }
    } else if (trimmed.startsWith('<')) {
      try {
        const doc = new DOMParser().parseFromString(trimmed, 'text/xml');
        const textNodes = doc.querySelectorAll('text');
        if (textNodes.length > 0) {
          textNodes.forEach((node) => {
            const text = cleanCaptionText(node.textContent || '');
            if (!text) return;
            const start = parseFloat(node.getAttribute('start') || '0');
            const dur = parseFloat(node.getAttribute('dur') || '2.5');
            rawCues.push({ start, end: start + Math.max(0.4, dur), en: text });
          });
        } else {
          const pNodes = doc.querySelectorAll('p');
          pNodes.forEach((node) => {
            const text = cleanCaptionText(node.textContent || '');
            if (!text) return;
            const start = (parseFloat(node.getAttribute('t') || '0') || 0) / 1000;
            const dur = (parseFloat(node.getAttribute('d') || '2500') || 2500) / 1000;
            rawCues.push({ start, end: start + Math.max(0.4, dur), en: text });
          });
        }
      } catch {
        return [];
      }
    }

    if (rawCues.length === 0) return [];

    rawCues.sort((a, b) => a.start - b.start);
    const deduped = [];
    for (const cue of rawCues) {
      const prev = deduped[deduped.length - 1];
      if (prev) {
        if (prev.en === cue.en && Math.abs(cue.start - prev.start) < 1.5) {
          prev.end = Math.max(prev.end, cue.end);
          continue;
        }
        if (prev.end > cue.start) {
          prev.end = Math.max(prev.start + 0.35, cue.start);
        }
      }
      deduped.push({ ...cue });
    }

    return mergeShortCues(deduped);
  }

  function mergeShortCues(cues) {
    const merged = [];
    let current = null;

    for (const cue of cues) {
      if (!current) {
        current = {
          id: 0,
          start: cue.start,
          end: cue.end,
          en: cue.en,
          idText: '',
          translating: false
        };
        continue;
      }

      const gap = cue.start - current.end;
      const combinedLen = current.en.length + 1 + cue.en.length;
      const combinedDur = cue.end - current.start;
      const endsSentence = /[.?!]["')\]]?$/.test(current.en);

      // Keep cues compact (~95 chars / ~4.4s) so TTS fits in a single chunk and syncs tightly
      if (!endsSentence && gap <= 0.6 && combinedLen <= 95 && combinedDur <= 4.4) {
        current.en = `${current.en} ${cue.en}`;
        current.end = cue.end;
      } else {
        merged.push(current);
        current = {
          id: merged.length,
          start: cue.start,
          end: cue.end,
          en: cue.en,
          idText: '',
          translating: false
        };
      }
    }

    if (current) merged.push(current);
    return merged;
  }

  // =========================
  // Translation Pipeline
  // =========================

  function translateBatchBg(texts, sourceLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts,
          sourceLang: sourceLang || 'en',
          targetLang: 'id'
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            resolve(null);
            return;
          }
          resolve(resp.translations || null);
        }
      );
    });
  }

  async function translateRange(startIdx, count, token) {
    if (token !== state.runToken || state.cues.length === 0) return;

    const batchIndices = [];
    const batchTexts = [];
    const endIdx = Math.min(state.cues.length, startIdx + count);

    for (let i = Math.max(0, startIdx); i < endIdx; i++) {
      const cue = state.cues[i];
      if (!cue || cue.idText || cue.translating) continue;
      cue.translating = true;
      batchIndices.push(i);
      batchTexts.push(cue.en);
    }

    if (batchIndices.length === 0) return;

    const translations = await translateBatchBg(batchTexts, state.sourceLang);
    if (token !== state.runToken) return;

    for (let j = 0; j < batchIndices.length; j++) {
      const cue = state.cues[batchIndices[j]];
      if (!cue) continue;
      cue.translating = false;
      if (translations && translations[j]) {
        cue.idText = translations[j];
        state.translatedCount++;
      }
    }

    if (state.status === 'loading' || state.status === 'ready') {
      setStatus('ready', `${state.translatedCount}/${state.cues.length} baris diterjemahkan`);
    }

    updateActiveCue(true);
  }

  async function runProgressiveTranslation(token) {
    if (token !== state.runToken || state.cues.length === 0) return;

    const currentTime = videoEl ? videoEl.currentTime : 0;
    const pivotIdx = Math.max(0, findCueIndexAtTime(currentTime));

    await translateRange(pivotIdx, 14, token);
    if (token !== state.runToken) return;

    for (let i = pivotIdx + 14; i < state.cues.length; i += 20) {
      if (token !== state.runToken) return;
      await translateRange(i, 20, token);
      await new Promise((r) => setTimeout(r, 120));
    }

    for (let i = 0; i < pivotIdx; i += 20) {
      if (token !== state.runToken) return;
      await translateRange(i, Math.min(20, pivotIdx - i), token);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  function findCueIndexAtTime(timeSec) {
    const cues = state.cues;
    if (cues.length === 0) return -1;

    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = cues[mid];
      if (timeSec < cue.start) {
        hi = mid - 1;
      } else if (timeSec > cue.end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  }

  // =========================
  // Audio Ducking
  // =========================

  function applyAudioDucking() {
    if (!videoEl) return;
    const shouldDuck = settings.enabled && settings.ttsEnabled && !videoEl.paused;

    if (shouldDuck) {
      if (!isDucking) {
        savedVideoVolume = videoEl.volume;
        isDucking = true;
      }
      const targetVol = Math.max(0, Math.min(1, Number(settings.duckVolume)));
      if (Math.abs(videoEl.volume - targetVol) > 0.01) {
        videoEl.volume = targetVol;
      }
    } else if (isDucking) {
      isDucking = false;
      if (savedVideoVolume !== null) {
        videoEl.volume = savedVideoVolume;
        savedVideoVolume = null;
      }
    }
  }

  // =========================
  // Adaptive Dual-Engine Indonesian TTS
  // =========================

  class IndonesianTTSEngine {
    constructor() {
      this.audioEl = new Audio();
      this.audioEl.preload = 'auto';
      this.enablePitchPreservation(this.audioEl);
      this.prefetchCache = new Map();
      this.inflightFetches = new Map();
      this.playToken = 0;
      this.lastSpokenKey = '';
      this.autoplayNoticeShown = false;

      // Adaptive speed detection state
      this.paceEma = 1.1; // rolling detected pace multiplier
      this.lastAppliedRate = 1.1;
      this.lastPaceLabel = 'Normal';
      this.isPlayingAudio = false;
      this.graceTimer = null;
    }

    enablePitchPreservation(audio) {
      try {
        audio.preservesPitch = true;
        audio.mozPreservesPitch = true;
        audio.webkitPreservesPitch = true;
      } catch {
        // ignore
      }
    }

    getRemainingAudioSec() {
      if (!this.isPlayingAudio || this.audioEl.paused) return 0;
      const dur = this.audioEl.duration;
      if (!dur || !Number.isFinite(dur)) return 0;
      const rate = this.audioEl.playbackRate || 1;
      return Math.max(0, (dur - this.audioEl.currentTime) / rate);
    }

    getStatusSummary() {
      return {
        autoTtsSpeed: Boolean(settings.autoTtsSpeed),
        currentRate: Number(this.lastAppliedRate.toFixed(2)),
        paceLabel: this.lastPaceLabel
      };
    }

    classifyPace(rate) {
      if (rate >= 1.75) return 'Sangat Cepat';
      if (rate >= 1.38) return 'Cepat';
      if (rate <= 0.98) return 'Santai';
      return 'Normal';
    }

    computeAdaptiveRate(audioDurationSec, remainingWallSec, textLength) {
      const baseRate = Math.max(0.8, Math.min(1.8, Number(settings.ttsRate) || 1.1));
      const videoSpeed = videoEl ? Math.max(0.5, Math.min(2.0, videoEl.playbackRate || 1)) : 1;
      const manualRate = Math.max(0.75, Math.min(2.2, baseRate * videoSpeed));

      if (!settings.autoTtsSpeed) {
        this.lastAppliedRate = manualRate;
        this.lastPaceLabel = 'Manual';
        return manualRate;
      }

      const safeRemaining = Math.max(0.45, remainingWallSec);

      // Estimate duration if exact audio duration isn't available (e.g., Browser TTS)
      const effectiveDur =
        audioDurationSec && Number.isFinite(audioDurationSec) && audioDurationSec > 0.1
          ? audioDurationSec
          : Math.max(0.6, (textLength || 20) / 13.5);

      // Required rate with 6% safety margin so speech ends right before next subtitle
      const exactNeeded = (effectiveDur / safeRemaining) * 1.06;

      // Update rolling speaker pace EMA so transitions between cues stay smooth
      const clampedObserved = Math.max(0.95, Math.min(2.35, exactNeeded));
      this.paceEma = this.paceEma * 0.65 + clampedObserved * 0.35;

      // Never fall behind exactNeeded when fast; when slow, relax gently toward baseRate & EMA
      let chosenRate;
      if (exactNeeded > manualRate) {
        chosenRate = Math.max(exactNeeded, this.paceEma * 0.95);
      } else {
        // Gentle blend between user base rate and speaker pace so slow cues don't sound jarring
        chosenRate = Math.max(manualRate * 0.92, Math.min(manualRate * 1.1, (manualRate + this.paceEma) * 0.5));
      }

      // Hard natural intelligibility bounds (pitch-preserved up to 2.35x)
      chosenRate = Math.max(0.85, Math.min(2.35, chosenRate));

      this.lastAppliedRate = chosenRate;
      this.lastPaceLabel = this.classifyPace(chosenRate);
      updatePlayerButtonStates();
      return chosenRate;
    }

    stop() {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.playToken++;
      this.isPlayingAudio = false;
      try {
        this.audioEl.pause();
        this.audioEl.removeAttribute('src');
        this.audioEl.load();
      } catch {
        // ignore
      }
      try {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      } catch {
        // ignore
      }
      if (idLineEl) idLineEl.classList.remove('yt-indosub-speaking');
    }

    resetForVideo() {
      this.stop();
      this.lastSpokenKey = '';
      this.paceEma = Math.max(0.9, Math.min(1.6, Number(settings.ttsRate) || 1.1));
      this.lastAppliedRate = this.paceEma;
      this.lastPaceLabel = 'Normal';
      this.prefetchCache.clear();
      this.inflightFetches.clear();
    }

    fetchGoogleAudio(text) {
      const clean = (text || '').trim();
      if (!clean) return Promise.resolve([]);
      if (this.prefetchCache.has(clean)) {
        return Promise.resolve(this.prefetchCache.get(clean));
      }
      if (this.inflightFetches.has(clean)) {
        return this.inflightFetches.get(clean);
      }

      const promise = new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_TTS_AUDIO', text: clean, lang: 'id' },
          (resp) => {
            this.inflightFetches.delete(clean);
            if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.audioUrls)) {
              resolve([]);
              return;
            }
            if (this.prefetchCache.size > 80) {
              const oldest = this.prefetchCache.keys().next().value;
              this.prefetchCache.delete(oldest);
            }
            this.prefetchCache.set(clean, resp.audioUrls);
            resolve(resp.audioUrls);
          }
        );
      });

      this.inflightFetches.set(clean, promise);
      return promise;
    }

    prefetchAhead(currentIdx) {
      if (settings.ttsEngine !== 'google' || !settings.ttsEnabled) return;
      for (let offset = 1; offset <= 3; offset++) {
        const nextCue = state.cues[currentIdx + offset];
        if (nextCue && nextCue.idText) {
          this.fetchGoogleAudio(nextCue.idText);
        }
      }
    }

    /**
     * Speak text with real-time deadline awareness.
     * windowEndVideoSec: video timestamp when next cue starts (null for DOM fallback).
     * fallbackWallSec: fallback speaking window if windowEndVideoSec is null.
     */
    async speak(text, cueKey, windowEndVideoSec = null, fallbackWallSec = 3.5) {
      const clean = (text || '').trim();
      if (!clean) return;
      if (this.lastSpokenKey === cueKey) return;

      // Gentle anti-cutoff grace: if previous line has <= 0.35s left, let its last syllable finish
      const prevLeft = this.getRemainingAudioSec();
      if (settings.autoTtsSpeed && prevLeft > 0.04 && prevLeft <= 0.35 && settings.ttsEngine === 'google') {
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (!settings.enabled || !settings.ttsEnabled || (videoEl && videoEl.paused)) return;
          this.startSpeakingNow(clean, cueKey, windowEndVideoSec, fallbackWallSec);
        }, Math.round(prevLeft * 1000) + 15);
        return;
      }

      this.startSpeakingNow(clean, cueKey, windowEndVideoSec, fallbackWallSec);
    }

    getRemainingWallSec(windowEndVideoSec, fallbackWallSec) {
      if (windowEndVideoSec !== null && videoEl) {
        const videoSpeed = Math.max(0.5, Math.min(2.0, videoEl.playbackRate || 1));
        const diff = (windowEndVideoSec - videoEl.currentTime) / videoSpeed;
        return Math.max(0.45, diff);
      }
      return Math.max(0.6, fallbackWallSec || 3.5);
    }

    async startSpeakingNow(clean, cueKey, windowEndVideoSec, fallbackWallSec) {
      if (this.lastSpokenKey === cueKey) return;
      this.lastSpokenKey = cueKey;

      this.stop();
      const token = this.playToken;

      if (settings.ttsEngine === 'browser') {
        const remSec = this.getRemainingWallSec(windowEndVideoSec, fallbackWallSec);
        this.speakWithBrowser(clean, token, remSec);
        return;
      }

      const audioUrls = await this.fetchGoogleAudio(clean);
      if (token !== this.playToken || !settings.enabled || !settings.ttsEnabled) return;
      if (videoEl && videoEl.paused) return;

      if (!audioUrls || audioUrls.length === 0) {
        const remSec = this.getRemainingWallSec(windowEndVideoSec, fallbackWallSec);
        this.speakWithBrowser(clean, token, remSec);
        return;
      }

      if (idLineEl) idLineEl.classList.add('yt-indosub-speaking');
      this.isPlayingAudio = true;

      for (let i = 0; i < audioUrls.length; i++) {
        if (token !== this.playToken) break;
        const chunksLeft = audioUrls.length - i;
        const remWall = this.getRemainingWallSec(windowEndVideoSec, fallbackWallSec);
        const chunkBudget = remWall / chunksLeft;
        const played = await this.playAudioUrl(
          audioUrls[i],
          token,
          chunkBudget,
          Math.ceil(clean.length / audioUrls.length)
        );
        if (!played) break;
      }

      if (token === this.playToken) {
        this.isPlayingAudio = false;
        if (idLineEl) idLineEl.classList.remove('yt-indosub-speaking');
      }
    }

    playAudioUrl(dataUrl, token, chunkTargetSec, chunkChars) {
      return new Promise((resolve) => {
        const audio = this.audioEl;
        this.enablePitchPreservation(audio);

        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          audio.onended = null;
          audio.onerror = null;
          audio.onloadedmetadata = null;
          resolve(ok);
        };

        audio.onloadedmetadata = () => {
          if (token !== this.playToken) {
            finish(false);
            return;
          }
          const rate = this.computeAdaptiveRate(audio.duration, chunkTargetSec, chunkChars);
          audio.playbackRate = rate;
        };

        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);

        audio.src = dataUrl;
        audio.volume = Math.max(0.05, Math.min(1, Number(settings.ttsVolume) || 1));
        audio.playbackRate = this.computeAdaptiveRate(null, chunkTargetSec, chunkChars);

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            if (err && err.name === 'NotAllowedError' && !this.autoplayNoticeShown) {
              this.autoplayNoticeShown = true;
              showToast('Klik video sekali untuk mengaktifkan suara TTS', 3500);
            }
            finish(false);
          });
        }
      });
    }

    speakWithBrowser(text, token, remainingWallSec) {
      if (!('speechSynthesis' in window)) return;
      try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'id-ID';
        utter.rate = Math.min(2.2, this.computeAdaptiveRate(null, remainingWallSec, text.length));
        utter.volume = Math.max(0.1, Math.min(1, Number(settings.ttsVolume) || 1));

        const voices = window.speechSynthesis.getVoices() || [];
        const idVoice =
          voices.find((v) => v.lang && v.lang.toLowerCase() === 'id-id') ||
          voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('id'));
        if (idVoice) utter.voice = idVoice;

        utter.onstart = () => {
          if (token === this.playToken && idLineEl) {
            idLineEl.classList.add('yt-indosub-speaking');
          }
        };
        utter.onend = utter.onerror = () => {
          if (token === this.playToken && idLineEl) {
            idLineEl.classList.remove('yt-indosub-speaking');
          }
        };

        window.speechSynthesis.speak(utter);
      } catch {
        // ignore
      }
    }
  }

  const ttsEngine = new IndonesianTTSEngine();

  // =========================
  // Overlay & Player Buttons
  // =========================

  function ensureOverlay() {
    const player = document.querySelector('#movie_player');
    if (!player) return false;

    if (!overlayEl || !player.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'yt-indosub-overlay';
      overlayEl.className = 'yt-indosub-hidden';

      enLineEl = document.createElement('div');
      enLineEl.className = 'yt-indosub-line yt-indosub-line-en';

      idLineEl = document.createElement('div');
      idLineEl.className = 'yt-indosub-line yt-indosub-line-id';

      overlayEl.appendChild(enLineEl);
      overlayEl.appendChild(idLineEl);
      player.appendChild(overlayEl);
    }

    if (!toastEl || !player.contains(toastEl)) {
      toastEl = document.createElement('div');
      toastEl.id = 'yt-indosub-toast';
      player.appendChild(toastEl);
    }

    applySettingsUI();
    return true;
  }

  function ensurePlayerButtons() {
    const rightControls = document.querySelector('#movie_player .ytp-right-controls');
    if (!rightControls) return;

    if (!subBtnEl || !rightControls.contains(subBtnEl)) {
      subBtnEl = document.createElement('button');
      subBtnEl.type = 'button';
      subBtnEl.className = 'ytp-button yt-indosub-player-btn';
      subBtnEl.title = 'Toggle Subtitle Indonesia (YT IndoSub)';
      subBtnEl.innerHTML = '<span class="yt-indosub-pill">ID</span>';
      subBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !settings.enabled;
        saveSettingsPatch({ enabled: next });
        showToast(next ? 'Subtitle Indonesia: AKTIF' : 'Subtitle Indonesia: NONAKTIF');
        if (!next) {
          ttsEngine.stop();
          applyAudioDucking();
        } else {
          updateActiveCue(true);
        }
      });
      rightControls.prepend(subBtnEl);
    }

    if (!ttsBtnEl || !rightControls.contains(ttsBtnEl)) {
      ttsBtnEl = document.createElement('button');
      ttsBtnEl.type = 'button';
      ttsBtnEl.className = 'ytp-button yt-indosub-player-btn';
      ttsBtnEl.title = 'Toggle Suara Dubbing Indonesia (TTS)';
      ttsBtnEl.innerHTML = '<span class="yt-indosub-pill">TTS</span>';
      ttsBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !settings.ttsEnabled;
        saveSettingsPatch({ ttsEnabled: next, enabled: next ? true : settings.enabled });
        showToast(next ? 'Dubbing Suara Indonesia: AKTIF' : 'Dubbing Suara Indonesia: NONAKTIF');
        if (!next) {
          ttsEngine.stop();
        } else {
          ttsEngine.lastSpokenKey = '';
          updateActiveCue(true);
        }
        applyAudioDucking();
      });
      rightControls.prepend(ttsBtnEl);
    }

    updatePlayerButtonStates();
  }

  function updatePlayerButtonStates() {
    if (subBtnEl) {
      subBtnEl.classList.toggle('active-sub', Boolean(settings.enabled));
    }
    if (ttsBtnEl) {
      const active = Boolean(settings.enabled && settings.ttsEnabled);
      ttsBtnEl.classList.toggle('active-tts', active);
      if (active && settings.autoTtsSpeed) {
        const info = ttsEngine.getStatusSummary();
        ttsBtnEl.title = `Dubbing ID: AKTIF (Auto ${info.currentRate.toFixed(2)}x • ${info.paceLabel})`;
      } else {
        ttsBtnEl.title = active ? 'Dubbing ID: AKTIF (Manual)' : 'Toggle Suara Dubbing Indonesia (TTS)';
      }
    }
  }

  function applySettingsUI() {
    const player = document.querySelector('#movie_player');
    if (player) {
      const hideNative = Boolean(settings.enabled && (state.cues.length > 0 || state.domFallbackActive));
      player.classList.toggle('yt-indosub-hide-native', hideNative);
    }

    if (overlayEl) {
      overlayEl.style.fontSize = `${Math.max(14, Math.min(36, Number(settings.fontSize) || 22))}px`;
      if (!settings.enabled) {
        overlayEl.classList.add('yt-indosub-hidden');
      }
    }

    if (enLineEl) {
      enLineEl.style.display = settings.showOriginal ? 'inline-block' : 'none';
    }

    updatePlayerButtonStates();
    applyAudioDucking();
  }

  function renderSubtitleText(enText, idText) {
    ensureOverlay();
    if (!overlayEl || !enLineEl || !idLineEl) return;

    if (!settings.enabled || (!enText && !idText)) {
      overlayEl.classList.add('yt-indosub-hidden');
      return;
    }

    if (settings.showOriginal && enText) {
      enLineEl.textContent = enText;
      enLineEl.style.display = 'inline-block';
    } else {
      enLineEl.textContent = '';
      enLineEl.style.display = 'none';
    }

    idLineEl.textContent = idText || (enText ? '...' : '');
    idLineEl.style.display = idLineEl.textContent ? 'inline-block' : 'none';
    overlayEl.classList.remove('yt-indosub-hidden');
  }

  // =========================
  // Playback Sync
  // =========================

  function updateActiveCue(force = false) {
    if (!videoEl) return;

    if (!settings.enabled) {
      if (overlayEl) overlayEl.classList.add('yt-indosub-hidden');
      return;
    }

    if (state.cues.length === 0) return;

    const now = videoEl.currentTime;
    const idx = findCueIndexAtTime(now);

    if (idx === -1) {
      if (state.activeCueIndex !== -1 || force) {
        state.activeCueIndex = -1;
        renderSubtitleText('', '');
      }
      return;
    }

    const cue = state.cues[idx];
    const changed = idx !== state.activeCueIndex;
    state.activeCueIndex = idx;

    if (!cue.idText && !cue.translating) {
      translateRange(idx, 12, state.runToken);
    }

    if (changed || force) {
      renderSubtitleText(cue.en, cue.idText);
    }

    if (settings.ttsEnabled && !videoEl.paused && cue.idText) {
      const nextCue = state.cues[idx + 1];
      // Allow TTS to naturally use any silent gap before next cue, but finish cleanly before next cue starts
      const windowEndVideoSec = nextCue ? Math.max(cue.end, nextCue.start - 0.06) : cue.end + 0.8;
      ttsEngine.speak(cue.idText, `${state.videoId}:${idx}`, windowEndVideoSec, Math.max(0.8, cue.end - now));
      ttsEngine.prefetchAhead(idx);
    }
  }

  function bindVideoElement() {
    const found = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    if (!found || found === videoEl) return;

    videoEl = found;

    videoEl.addEventListener('timeupdate', () => updateActiveCue(false));
    videoEl.addEventListener('seeking', () => {
      ttsEngine.stop();
      ttsEngine.lastSpokenKey = '';
    });
    videoEl.addEventListener('seeked', () => {
      updateActiveCue(true);
    });
    videoEl.addEventListener('pause', () => {
      ttsEngine.stop();
      applyAudioDucking();
    });
    videoEl.addEventListener('play', () => {
      applyAudioDucking();
      ttsEngine.lastSpokenKey = '';
      updateActiveCue(true);
    });
    videoEl.addEventListener('volumechange', () => {
      if (!isDucking && videoEl) {
        savedVideoVolume = videoEl.volume;
      }
    });
  }

  // =========================
  // Live DOM Fallback (for streams / edge cases)
  // =========================

  function stopDomFallback() {
    if (state.domFallbackObserver) {
      state.domFallbackObserver.disconnect();
      state.domFallbackObserver = null;
    }
    state.domFallbackActive = false;
    state.lastDomText = '';
    state.lastDomSpokenAt = 0;
  }

  function startDomFallback(token) {
    stopDomFallback();
    const container = document.querySelector('#movie_player .ytp-caption-window-container');
    if (!container) return;

    state.domFallbackActive = true;
    applySettingsUI();

    let debounceTimer = null;
    state.domFallbackObserver = new MutationObserver(() => {
      if (token !== state.runToken || state.cues.length > 0 || !settings.enabled) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const segments = Array.from(container.querySelectorAll('.ytp-caption-segment'));
        const text = cleanCaptionText(segments.map((s) => s.textContent || '').join(' '));
        if (!text || text === state.lastDomText) return;

        const nowMs = Date.now();
        const elapsedSec = state.lastDomSpokenAt ? Math.max(0.7, Math.min(5.0, (nowMs - state.lastDomSpokenAt) / 1000)) : 2.8;
        state.lastDomText = text;
        state.lastDomSpokenAt = nowMs;

        setStatus('ready', 'Mode live caption aktif');
        applySettingsUI();

        const res = await translateBatchBg([text], 'auto');
        if (token !== state.runToken) return;
        const translated = res && res[0] ? res[0] : text;
        renderSubtitleText(text, translated);
        if (settings.ttsEnabled && videoEl && !videoEl.paused) {
          ttsEngine.speak(translated, `dom:${nowMs}:${translated}`, null, elapsedSec);
        }
      }, 420);
    });

    state.domFallbackObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // =========================
  // Video Lifecycle & Bridge
  // =========================

  function requestCaptionsForVideo(videoId, forceReload = false) {
    if (!videoId) return;

    state.runToken++;
    const token = state.runToken;
    state.videoId = videoId;
    state.cues = [];
    state.activeCueIndex = -1;
    state.translatedCount = 0;

    stopDomFallback();
    ttsEngine.resetForVideo();
    renderSubtitleText('', '');
    applySettingsUI();

    setStatus('loading', 'Mencari subtitle video...');

    window.postMessage(
      {
        source: CONTENT_SRC,
        type: 'REQUEST_CAPTIONS',
        videoId,
        forceReload
      },
      '*'
    );

    // Fallback to live DOM observer if timedtext hasn't arrived after 4s
    setTimeout(() => {
      if (token === state.runToken && state.cues.length === 0 && state.status !== 'no_captions') {
        startDomFallback(token);
      }
    }, 4000);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== BRIDGE_SRC) return;

    const { type, payload, videoId, track } = event.data;

    if (type === 'TRACK_FOUND' && videoId === state.videoId) {
      state.sourceLang = track?.languageCode || 'en';
      setStatus('loading', `Subtitle ditemukan (${track?.name || state.sourceLang}), memuat...`);
      return;
    }

    if (type === 'NO_CAPTIONS' && videoId === state.videoId) {
      setStatus('no_captions', 'Video ini tidak memiliki subtitle/caption di YouTube');
      applySettingsUI();
      return;
    }

    if (type === 'TIMEDTEXT_CAPTURED' && payload) {
      const currentId = getCurrentVideoId();
      if (!currentId || payload.videoId !== currentId) return;

      if (state.videoId === currentId && state.cues.length > 0 && payload.tlang) return;

      const parsed = parseTimedText(payload.body);
      if (parsed.length === 0) return;

      stopDomFallback();
      state.videoId = currentId;
      state.sourceLang = (payload.lang || 'en').split('-')[0] || 'en';
      state.cues = parsed;
      state.activeCueIndex = -1;
      state.translatedCount = 0;

      if (payload.tlang === 'id' || state.sourceLang === 'id') {
        for (const cue of state.cues) {
          cue.idText = cue.en;
        }
        state.translatedCount = state.cues.length;
        setStatus('ready', `${state.cues.length} baris subtitle Indonesia siap`);
        applySettingsUI();
        updateActiveCue(true);
        return;
      }

      setStatus('loading', `Menerjemahkan ${state.cues.length} baris ke Indonesia...`);
      applySettingsUI();
      runProgressiveTranslation(state.runToken);
    }
  });

  // Listen to popup messages & storage updates
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'GET_STATUS') {
      sendResponse({
        videoId: state.videoId,
        status: state.status,
        statusDetail: state.statusDetail,
        cueCount: state.cues.length,
        translatedCount: state.translatedCount,
        ttsInfo: ttsEngine.getStatusSummary(),
        settings
      });
      return false;
    }

    if (msg.type === 'RELOAD_CAPTIONS') {
      const vid = getCurrentVideoId();
      if (vid) {
        requestCaptionsForVideo(vid, true);
        showToast('Memuat ulang subtitle...');
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const prevTts = settings.ttsEnabled;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
    applySettingsUI();
    if (!settings.enabled || !settings.ttsEnabled) {
      ttsEngine.stop();
    } else if (!prevTts && settings.ttsEnabled) {
      ttsEngine.lastSpokenKey = '';
      updateActiveCue(true);
    } else {
      updateActiveCue(true);
    }
  });

  // =========================
  // Navigation & Init Loop
  // =========================

  function checkPageState() {
    ensureOverlay();
    ensurePlayerButtons();
    bindVideoElement();

    const vid = getCurrentVideoId();
    if (!vid) {
      if (state.videoId) {
        state.videoId = '';
        state.cues = [];
        stopDomFallback();
        ttsEngine.resetForVideo();
        applyAudioDucking();
        setStatus('idle', 'Buka video YouTube untuk mulai menerjemahkan');
      }
      return;
    }

    if (vid !== state.videoId) {
      requestCaptionsForVideo(vid, false);
    }
  }

  async function init() {
    await loadSettings();
    checkPageState();

    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(checkPageState, 250);
    });
    window.addEventListener('yt-page-data-updated', () => {
      setTimeout(checkPageState, 250);
    });

    setInterval(checkPageState, 1200);
  }

  init();
})();
