(() => {
  if (window.__YT_INDOSUB_CONTENT_LOADED__) return;
  window.__YT_INDOSUB_CONTENT_LOADED__ = true;

  const BRIDGE_SRC = 'YT_INDOSUB_BRIDGE';
  const CONTENT_SRC = 'YT_INDOSUB_CONTENT';
  const isYouTubeHost = /(^|\.)youtube\.com$/i.test(location.hostname);

  const DEFAULT_SETTINGS = {
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

  let settings = { ...DEFAULT_SETTINGS };

  const state = {
    siteName: isYouTubeHost ? 'YouTube' : location.hostname.replace(/^www\./, ''),
    mediaKey: '',
    videoId: '', // YouTube videoId when on YouTube
    sourceLang: 'en',
    cues: [], // { id, start, end, en, idText, translating }
    activeCueIndex: -1,
    status: 'idle', // idle | loading | ready | no_captions | error
    statusDetail: 'Menunggu video...',
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
  let floatingBarEl = null;
  let playerContainerEl = null;
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
  // Text Cleaning & Non-Speech Filtering
  // =========================

  const PAREN_SFX_RE =
    /\(\s*(?:music|musik|applause|tepuk tangan|laughter|laughing|laughs|tawa|tertawa|cheering|cheers|sorak|sighs?|groans?|gasps?|coughs?|coughing|panting|chuckles?|giggles?|snickers?|sobs?|crying|screaming|yelling|whispers?|whispering|inaudible|unintelligible|silence|silent|static|beep|bleep|sfx|sound(?:s| effect)?|background\s*(?:music|noise|audio)|upbeat\s*music|soft\s*music|dramatic\s*music|instrumental|singing|humming|clapping|footsteps|door\s*\w+|phone\s*\w+|bell\s*\w+|foreign(?:\s*language)?)\s*\)/gi;

  function decodeHtmlEntities(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
  }

  function stripNonSpeechAnnotations(raw) {
    return String(raw || '')
      // Strip WebVTT / HTML inline tags (<c>, <v Instructor>, <i>, <b>, <00:01:02.000>)
      .replace(/<[^>]+>/g, ' ')
      // Strip ALL square-bracket caption tags: [Music], [musik], [Applause], [Laughter], [♪], etc.
      .replace(/\[[^\]]{1,60}\]/g, ' ')
      // Strip parenthesized sound-effect descriptions: (music), (laughter), (applause), etc.
      .replace(PAREN_SFX_RE, ' ')
      // Strip musical note glyphs
      .replace(/[♪♫♬♩🎵🎶]+/g, ' ')
      // Strip speaker-change markers like >> or >>>
      .replace(/(?:^|\s)>>+\s*/g, ' ')
      // Normalize whitespace and punctuation spacing
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function cleanCaptionText(raw) {
    const decoded = decodeHtmlEntities(String(raw || ''));
    const cleaned = stripNonSpeechAnnotations(decoded);
    // Drop pure punctuation / dashes with no spoken alphanumeric content
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return '';
    return cleaned;
  }

  // =========================
  // Site / Video Detection
  // =========================

  function getCurrentYouTubeVideoId() {
    if (!isYouTubeHost) return '';
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

  function findPrimaryVideo() {
    if (isYouTubeHost) {
      return (
        document.querySelector('#movie_player video.html5-main-video') ||
        document.querySelector('#shorts-player video') ||
        document.querySelector('video')
      );
    }

    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    let best = null;
    let bestScore = -1;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      const visible = rect.width >= 180 && rect.height >= 100 && getComputedStyle(v).visibility !== 'hidden';
      const hasMedia = Boolean(v.currentSrc || v.src || v.readyState >= 1 || (v.textTracks && v.textTracks.length > 0));
      if (!visible && !hasMedia) continue;
      const score = area + (v.paused ? 0 : 1e7) + (v.textTracks && v.textTracks.length > 0 ? 5e6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function findPlayerContainer(video) {
    if (isYouTubeHost) {
      return document.querySelector('#movie_player') || document.querySelector('#shorts-player') || video?.parentElement || null;
    }

    if (!video) return null;

    if (document.fullscreenElement && document.fullscreenElement.contains(video)) {
      return document.fullscreenElement;
    }

    const vRect = video.getBoundingClientRect();
    let candidate = video.parentElement;
    let best = video.parentElement;

    for (let depth = 0; depth < 6 && candidate && candidate !== document.body && candidate !== document.documentElement; depth++) {
      const cRect = candidate.getBoundingClientRect();
      const pos = getComputedStyle(candidate).position;
      const similarSize =
        cRect.width >= vRect.width - 10 &&
        cRect.height >= vRect.height - 10 &&
        cRect.width <= vRect.width + 140 &&
        cRect.height <= vRect.height + 140;

      if (similarSize && (pos === 'relative' || pos === 'absolute' || pos === 'fixed')) {
        best = candidate;
      }
      candidate = candidate.parentElement;
    }

    if (best && getComputedStyle(best).position === 'static') {
      best.style.position = 'relative';
    }
    return best;
  }

  function computeMediaKey(video) {
    if (isYouTubeHost) {
      const vid = getCurrentYouTubeVideoId();
      return vid ? `yt:${vid}` : '';
    }
    if (!video) return '';
    const tracks = Array.from(video.querySelectorAll('track')).map((t) => t.src || '').join(',');
    const srcKey = video.currentSrc || video.src || '';
    return `web:${location.origin}${location.pathname}|${srcKey}|${tracks}`;
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
  // Universal Cue Parsing (JSON3, WebVTT, SRT, XML/TTML)
  // =========================

  function parseTimestampSec(str) {
    const clean = String(str || '').trim().replace(',', '.');
    if (!clean) return NaN;
    if (/^\d+(?:\.\d+)?s?$/i.test(clean)) {
      return parseFloat(clean);
    }
    const parts = clean.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function parseVttOrSrt(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const cues = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || /^WEBVTT\b/i.test(line) || /^NOTE\b/i.test(line) || /^STYLE\b/i.test(line) || /^REGION\b/i.test(line)) {
        // Skip header/metadata block until blank line
        if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
          while (i < lines.length && lines[i].trim() !== '') i++;
        }
        i++;
        continue;
      }

      let timeLine = line;
      if (!timeLine.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) {
        i++;
        timeLine = lines[i].trim();
      }

      const match = timeLine.match(
        /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3})/
      );
      if (!match) {
        i++;
        continue;
      }

      const start = parseTimestampSec(match[1]);
      const end = parseTimestampSec(match[2]);
      i++;

      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      const cleaned = cleanCaptionText(textLines.join(' '));
      if (cleaned && Number.isFinite(start) && Number.isFinite(end)) {
        cues.push({ start, end: Math.max(start + 0.4, end), en: cleaned });
      }
    }

    return cues;
  }

  function finalizeCues(rawCues) {
    if (!rawCues || rawCues.length === 0) return [];

    rawCues.sort((a, b) => a.start - b.start);
    const deduped = [];
    for (const cue of rawCues) {
      if (!cue.en) continue;
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

  function parseTimedText(body) {
    const trimmed = (body || '').trim();
    if (!trimmed) return [];

    let rawCues = [];

    if (trimmed.startsWith('{')) {
      // 1. YouTube JSON3
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
    } else if (/^WEBVTT\b/i.test(trimmed) || /\d{1,2}:\d{2}[.,]\d{2,3}\s*-->/.test(trimmed)) {
      // 2. WebVTT / SubRip SRT (Udemy, Coursera, Vimeo, edX, Pluralsight, HTML5)
      rawCues = parseVttOrSrt(trimmed);
    } else if (trimmed.startsWith('<')) {
      // 3. XML / SRV3 / TTML
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
            const beginAttr = node.getAttribute('begin');
            const endAttr = node.getAttribute('end');
            if (beginAttr) {
              const start = parseTimestampSec(beginAttr);
              const end = endAttr ? parseTimestampSec(endAttr) : start + 2.5;
              if (Number.isFinite(start)) {
                rawCues.push({ start, end: Math.max(start + 0.4, Number.isFinite(end) ? end : start + 2.5), en: text });
              }
            } else {
              const start = (parseFloat(node.getAttribute('t') || '0') || 0) / 1000;
              const dur = (parseFloat(node.getAttribute('d') || '2500') || 2500) / 1000;
              rawCues.push({ start, end: start + Math.max(0.4, dur), en: text });
            }
          });
        }
      } catch {
        return [];
      }
    }

    return finalizeCues(rawCues);
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
  // HTML5 TextTrack & <track> Extraction (Udemy, Coursera, Vimeo, etc.)
  // =========================

  function pickBestHtmlTrack(tracks) {
    const list = Array.from(tracks || []).filter(
      (t) => !t.kind || t.kind === 'subtitles' || t.kind === 'captions'
    );
    if (list.length === 0) return null;

    const isEn = (t) => {
      const lang = (t.language || t.srclang || '').toLowerCase();
      const label = (t.label || '').toLowerCase();
      return lang.startsWith('en') || label.includes('english') || label.includes('inggris');
    };

    return list.find((t) => isEn(t) && t.mode === 'showing') || list.find(isEn) || list.find((t) => t.mode === 'showing') || list[0];
  }

  function loadCuesIntoState(parsed, sourceLang = 'en', alreadyIndonesian = false) {
    if (!parsed || parsed.length === 0) return false;

    stopDomFallback();
    state.sourceLang = (sourceLang || 'en').split(/[-_]/)[0] || 'en';
    state.cues = parsed;
    state.activeCueIndex = -1;
    state.translatedCount = 0;

    if (alreadyIndonesian || state.sourceLang === 'id') {
      for (const cue of state.cues) {
        cue.idText = cue.en;
      }
      state.translatedCount = state.cues.length;
      setStatus('ready', `${state.cues.length} baris subtitle Indonesia siap`);
      applySettingsUI();
      updateActiveCue(true);
      return true;
    }

    setStatus('loading', `Menerjemahkan ${state.cues.length} baris ke Indonesia...`);
    applySettingsUI();
    runProgressiveTranslation(state.runToken);
    return true;
  }

  function fetchSubtitleUrlBg(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FETCH_SUBTITLE_URL', url }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.body) {
          resolve('');
          return;
        }
        resolve(resp.body);
      });
    });
  }

  async function tryExtractGenericVideoTracks(video, token) {
    if (!video || token !== state.runToken || state.cues.length > 0) return false;

    // 1. Check <track src="..."> DOM elements first (fetches full VTT via background.js, bypasses CORS)
    const trackEls = Array.from(video.querySelectorAll('track[src]'));
    if (trackEls.length > 0) {
      const bestEl = pickBestHtmlTrack(trackEls);
      if (bestEl && bestEl.src) {
        const body = await fetchSubtitleUrlBg(bestEl.src);
        if (token !== state.runToken || state.cues.length > 0) return true;
        const parsed = parseTimedText(body);
        if (parsed.length > 0) {
          return loadCuesIntoState(parsed, bestEl.srclang || 'en', false);
        }
      }
    }

    // 2. Check HTML5 video.textTracks API directly
    if (video.textTracks && video.textTracks.length > 0) {
      const bestTrack = pickBestHtmlTrack(video.textTracks);
      if (bestTrack) {
        const readCues = () => {
          if (token !== state.runToken || state.cues.length > 0) return false;
          const cueList = bestTrack.cues;
          if (!cueList || cueList.length === 0) return false;
          const raw = [];
          for (let i = 0; i < cueList.length; i++) {
            const c = cueList[i];
            const cleaned = cleanCaptionText(c.text || '');
            if (!cleaned) continue;
            raw.push({
              start: Number(c.startTime) || 0,
              end: Math.max((Number(c.startTime) || 0) + 0.4, Number(c.endTime) || 0),
              en: cleaned
            });
          }
          const parsed = finalizeCues(raw);
          if (parsed.length > 0) {
            return loadCuesIntoState(parsed, bestTrack.language || 'en', false);
          }
          return false;
        };

        if (bestTrack.mode === 'disabled') {
          try {
            bestTrack.mode = 'hidden';
          } catch {
            // ignore
          }
        }

        if (readCues()) return true;

        // Wait briefly for browser to load VTT cues into TextTrack
        await new Promise((r) => setTimeout(r, 800));
        if (readCues()) return true;
      }
    }

    return false;
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
        cue.idText = cleanCaptionText(translations[j]) || translations[j];
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
  // Real-Time Web Audio Vocal Remover (3-Band Mid/Side DSP)
  // =========================

  class VocalRemover {
    constructor() {
      this.attachedVideo = null;
      this.ctx = null;
      this.dryGain = null;
      this.wetGain = null;
      this.active = false;
      this.corsWarned = false;
    }

    isCorsSafe(video) {
      if (!video) return false;
      const src = video.currentSrc || video.src || '';
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) return true;
      if (video.crossOrigin) return true;
      try {
        return new URL(src, location.href).origin === location.origin;
      } catch {
        return false;
      }
    }

    ensureAttached(video) {
      if (!video) return false;
      if (this.attachedVideo === video && this.ctx) {
        return true;
      }

      if (video.__ytIndoSubVocalGraph) {
        const g = video.__ytIndoSubVocalGraph;
        this.attachedVideo = video;
        this.ctx = g.ctx;
        this.dryGain = g.dryGain;
        this.wetGain = g.wetGain;
        return true;
      }

      // Guard against muting direct cross-origin MP4 videos without CORS headers
      if (!this.isCorsSafe(video)) {
        if (!this.corsWarned) {
          this.corsWarned = true;
          showToast('Penghilang vokal tidak didukung oleh CORS video di situs ini', 3200);
        }
        return false;
      }

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return false;

        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(video);

        const dryGain = ctx.createGain();
        dryGain.gain.value = 1.0;

        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);

        const sideBus = ctx.createGain();
        const sideLGain = ctx.createGain();
        const sideRGain = ctx.createGain();
        sideLGain.gain.value = 0.5;
        sideRGain.gain.value = -0.5;
        splitter.connect(sideLGain, 0);
        splitter.connect(sideRGain, 1);
        sideLGain.connect(sideBus);
        sideRGain.connect(sideBus);

        const sidePosGain = ctx.createGain();
        const sideNegGain = ctx.createGain();
        sidePosGain.gain.value = 1.35;
        sideNegGain.gain.value = -1.35;
        sideBus.connect(sidePosGain);
        sideBus.connect(sideNegGain);
        sidePosGain.connect(merger, 0, 0);
        sideNegGain.connect(merger, 0, 1);

        const midBus = ctx.createGain();
        const midLGain = ctx.createGain();
        const midRGain = ctx.createGain();
        midLGain.gain.value = 0.5;
        midRGain.gain.value = 0.5;
        splitter.connect(midLGain, 0);
        splitter.connect(midRGain, 1);
        midLGain.connect(midBus);
        midRGain.connect(midBus);

        const lowPass = ctx.createBiquadFilter();
        lowPass.type = 'lowpass';
        lowPass.frequency.value = 155;
        lowPass.Q.value = 0.707;
        const lowGain = ctx.createGain();
        lowGain.gain.value = 0.78;
        midBus.connect(lowPass);
        lowPass.connect(lowGain);

        const highPass = ctx.createBiquadFilter();
        highPass.type = 'highpass';
        highPass.frequency.value = 6800;
        highPass.Q.value = 0.707;
        const highGain = ctx.createGain();
        highGain.gain.value = 0.25;
        midBus.connect(highPass);
        highPass.connect(highGain);

        lowGain.connect(merger, 0, 0);
        lowGain.connect(merger, 0, 1);
        highGain.connect(merger, 0, 0);
        highGain.connect(merger, 0, 1);

        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 12;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.005;
        limiter.release.value = 0.1;

        const wetGain = ctx.createGain();
        wetGain.gain.value = 0.0;

        source.connect(dryGain);
        dryGain.connect(ctx.destination);

        source.connect(splitter);
        merger.connect(limiter);
        limiter.connect(wetGain);
        wetGain.connect(ctx.destination);

        video.__ytIndoSubVocalGraph = { ctx, source, dryGain, wetGain };
        this.attachedVideo = video;
        this.ctx = ctx;
        this.dryGain = dryGain;
        this.wetGain = wetGain;
        return true;
      } catch {
        return false;
      }
    }

    resumeIfNeeded() {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    setEnabled(video, enable) {
      if (!video) return false;

      if (!enable && !this.ctx && !video.__ytIndoSubVocalGraph) {
        this.active = false;
        return false;
      }

      if (!this.ensureAttached(video)) {
        this.active = false;
        return false;
      }
      this.resumeIfNeeded();

      const now = this.ctx.currentTime;
      const targetDry = enable ? 0.0 : 1.0;
      const targetWet = enable ? 1.0 : 0.0;

      this.dryGain.gain.cancelScheduledValues(now);
      this.wetGain.gain.cancelScheduledValues(now);
      this.dryGain.gain.setTargetAtTime(targetDry, now, 0.05);
      this.wetGain.gain.setTargetAtTime(targetWet, now, 0.05);
      this.active = Boolean(enable);
      return this.active;
    }
  }

  const vocalRemover = new VocalRemover();

  // =========================
  // Audio Ducking
  // =========================

  function applyAudioDucking() {
    if (!videoEl) return;

    const wantVocalRemover = Boolean(settings.enabled && settings.vocalRemoveEnabled);
    const vocalActive = vocalRemover.setEnabled(videoEl, wantVocalRemover);

    const shouldDuck = Boolean(settings.enabled && settings.ttsEnabled && !videoEl.paused && !vocalActive);

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
      this.audioEl = null;
      this.prefetchCache = new Map();
      this.inflightFetches = new Map();
      this.playToken = 0;
      this.lastSpokenKey = '';
      this.pendingGraceKey = '';
      this.autoplayNoticeShown = false;

      this.paceEma = 1.1;
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
      if (!this.isPlayingAudio || !this.audioEl || this.audioEl.paused) return 0;
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
      const effectiveDur =
        audioDurationSec && Number.isFinite(audioDurationSec) && audioDurationSec > 0.1
          ? audioDurationSec
          : Math.max(0.6, (textLength || 20) / 13.5);

      const exactNeeded = (effectiveDur / safeRemaining) * 1.06;
      const clampedObserved = Math.max(0.95, Math.min(2.35, exactNeeded));
      this.paceEma = this.paceEma * 0.65 + clampedObserved * 0.35;

      let chosenRate;
      if (exactNeeded > manualRate) {
        chosenRate = Math.max(exactNeeded, this.paceEma * 0.95);
      } else {
        chosenRate = Math.max(manualRate * 0.92, Math.min(manualRate * 1.1, (manualRate + this.paceEma) * 0.5));
      }

      chosenRate = Math.max(0.85, Math.min(2.35, chosenRate));

      this.lastAppliedRate = chosenRate;
      this.lastPaceLabel = this.classifyPace(chosenRate);
      updatePlayerButtonStates();
      return chosenRate;
    }

    stop() {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.pendingGraceKey = '';
      this.playToken++;
      this.isPlayingAudio = false;
      if (this.audioEl) {
        try {
          this.audioEl.onended = null;
          this.audioEl.onerror = null;
          this.audioEl.onloadedmetadata = null;
          this.audioEl.pause();
        } catch {
          // ignore
        }
        this.audioEl = null;
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
      this.pendingGraceKey = '';
      this.paceEma = Math.max(0.9, Math.min(1.6, Number(settings.ttsRate) || 1.1));
      this.lastAppliedRate = this.paceEma;
      this.lastPaceLabel = 'Normal';
      this.prefetchCache.clear();
      this.inflightFetches.clear();
    }

    isBrowserVoice() {
      return (settings.ttsVoice || 'google:id').startsWith('browser:');
    }

    fetchOnlineAudio(text, isPrefetch = false) {
      const clean = cleanCaptionText(text);
      if (!clean) return Promise.resolve([]);
      const voice = settings.ttsVoice || 'google:id';
      const cacheKey = `${voice}:${clean}`;

      if (this.prefetchCache.has(cacheKey)) {
        return Promise.resolve(this.prefetchCache.get(cacheKey));
      }
      if (this.inflightFetches.has(cacheKey)) {
        const shared = this.inflightFetches.get(cacheKey);
        if (isPrefetch) return shared;
        return Promise.race([shared, new Promise((resolve) => setTimeout(() => resolve([]), 2200))]);
      }

      const promise = new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_TTS_AUDIO', text: clean, voice, lang: 'id', isPrefetch },
          (resp) => {
            this.inflightFetches.delete(cacheKey);
            if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.audioUrls) || resp.audioUrls.length === 0) {
              resolve([]);
              return;
            }
            if (this.prefetchCache.size > 120) {
              const oldest = this.prefetchCache.keys().next().value;
              this.prefetchCache.delete(oldest);
            }
            this.prefetchCache.set(cacheKey, resp.audioUrls);
            resolve(resp.audioUrls);
          }
        );
      });

      this.inflightFetches.set(cacheKey, promise);
      return promise;
    }

    prefetchAhead(currentIdx) {
      if (this.isBrowserVoice() || !settings.ttsEnabled) return;
      const voice = settings.ttsVoice || 'google:id';
      const lookahead = voice.startsWith('tiktok:') ? 7 : 4;
      for (let offset = 1; offset <= lookahead; offset++) {
        const nextCue = state.cues[currentIdx + offset];
        if (nextCue && nextCue.idText) {
          this.fetchOnlineAudio(nextCue.idText, true);
        }
      }
    }

    async speak(text, cueKey, windowEndVideoSec = null, fallbackWallSec = 3.5) {
      const clean = cleanCaptionText(text);
      if (!clean) return;
      if (this.lastSpokenKey === cueKey || this.pendingGraceKey === cueKey) return;

      const prevLeft = this.getRemainingAudioSec();
      if (settings.autoTtsSpeed && prevLeft > 0.04 && prevLeft <= 0.35 && !this.isBrowserVoice()) {
        clearTimeout(this.graceTimer);
        this.pendingGraceKey = cueKey;
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.pendingGraceKey !== cueKey) return;
          this.pendingGraceKey = '';
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

      if (this.isBrowserVoice()) {
        const remSec = this.getRemainingWallSec(windowEndVideoSec, fallbackWallSec);
        this.speakWithBrowser(clean, token, remSec);
        return;
      }

      let audioUrls = await this.fetchOnlineAudio(clean, false);
      if (token !== this.playToken || !settings.enabled || !settings.ttsEnabled) return;
      if (videoEl && videoEl.paused) return;

      if (!audioUrls || audioUrls.length === 0) {
        audioUrls = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'FETCH_TTS_AUDIO', text: clean, voice: 'google:id', lang: 'id', isPrefetch: false },
            (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.audioUrls)) {
                resolve([]);
              } else {
                resolve(resp.audioUrls);
              }
            }
          );
        });
        if (token !== this.playToken || !settings.enabled || !settings.ttsEnabled) return;
        if (videoEl && videoEl.paused) return;
      }

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
        const audio = new Audio();
        audio.preload = 'auto';
        this.enablePitchPreservation(audio);
        this.audioEl = audio;

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
        const selectedName = (settings.ttsVoice || '').startsWith('browser:')
          ? settings.ttsVoice.slice('browser:'.length)
          : 'auto';
        const pickedVoice =
          (selectedName && selectedName !== 'auto'
            ? voices.find((v) => v.name === selectedName || v.voiceURI === selectedName)
            : null) ||
          voices.find((v) => v.lang && v.lang.toLowerCase() === 'id-id') ||
          voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('id'));
        if (pickedVoice) utter.voice = pickedVoice;

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
    const container = findPlayerContainer(videoEl);
    if (!container) return false;

    if (playerContainerEl && playerContainerEl !== container) {
      playerContainerEl.classList.remove('yt-indosub-hide-native');
    }
    playerContainerEl = container;

    if (!overlayEl || !container.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'yt-indosub-overlay';
      overlayEl.className = 'yt-indosub-hidden';

      enLineEl = document.createElement('div');
      enLineEl.className = 'yt-indosub-line yt-indosub-line-en';

      idLineEl = document.createElement('div');
      idLineEl.className = 'yt-indosub-line yt-indosub-line-id';

      overlayEl.appendChild(enLineEl);
      overlayEl.appendChild(idLineEl);
      container.appendChild(overlayEl);
    }

    if (!toastEl || !container.contains(toastEl)) {
      toastEl = document.createElement('div');
      toastEl.id = 'yt-indosub-toast';
      container.appendChild(toastEl);
    }

    applySettingsUI();
    return true;
  }

  function makeToggleHandlers() {
    const onSubClick = (e) => {
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
    };

    const onTtsClick = (e) => {
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
    };

    return { onSubClick, onTtsClick };
  }

  function ensurePlayerButtons() {
    const { onSubClick, onTtsClick } = makeToggleHandlers();

    if (isYouTubeHost) {
      const rightControls = document.querySelector('#movie_player .ytp-right-controls');
      if (!rightControls) return;

      if (!subBtnEl || !rightControls.contains(subBtnEl)) {
        subBtnEl = document.createElement('button');
        subBtnEl.type = 'button';
        subBtnEl.className = 'ytp-button yt-indosub-player-btn';
        subBtnEl.title = 'Toggle Subtitle Indonesia (IndoSub)';
        subBtnEl.innerHTML = '<span class="yt-indosub-pill">ID</span>';
        subBtnEl.addEventListener('click', onSubClick);
        rightControls.prepend(subBtnEl);
      }

      if (!ttsBtnEl || !rightControls.contains(ttsBtnEl)) {
        ttsBtnEl = document.createElement('button');
        ttsBtnEl.type = 'button';
        ttsBtnEl.className = 'ytp-button yt-indosub-player-btn';
        ttsBtnEl.title = 'Toggle Suara Dubbing Indonesia (TTS)';
        ttsBtnEl.innerHTML = '<span class="yt-indosub-pill">TTS</span>';
        ttsBtnEl.addEventListener('click', onTtsClick);
        rightControls.prepend(ttsBtnEl);
      }
    } else if (playerContainerEl) {
      if (!floatingBarEl || !playerContainerEl.contains(floatingBarEl)) {
        floatingBarEl = document.createElement('div');
        floatingBarEl.id = 'yt-indosub-floating-controls';

        subBtnEl = document.createElement('button');
        subBtnEl.type = 'button';
        subBtnEl.className = 'yt-indosub-float-btn';
        subBtnEl.title = 'Toggle Subtitle Indonesia (IndoSub)';
        subBtnEl.innerHTML = '<span class="yt-indosub-pill">ID</span>';
        subBtnEl.addEventListener('click', onSubClick);

        ttsBtnEl = document.createElement('button');
        ttsBtnEl.type = 'button';
        ttsBtnEl.className = 'yt-indosub-float-btn';
        ttsBtnEl.title = 'Toggle Suara Dubbing Indonesia (TTS)';
        ttsBtnEl.innerHTML = '<span class="yt-indosub-pill">TTS</span>';
        ttsBtnEl.addEventListener('click', onTtsClick);

        floatingBarEl.appendChild(subBtnEl);
        floatingBarEl.appendChild(ttsBtnEl);
        playerContainerEl.appendChild(floatingBarEl);
      }
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
    if (playerContainerEl) {
      const hideNative = Boolean(settings.enabled && (state.cues.length > 0 || state.domFallbackActive));
      playerContainerEl.classList.toggle('yt-indosub-hide-native', hideNative);
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
      const windowEndVideoSec = nextCue ? Math.max(cue.end, nextCue.start - 0.06) : cue.end + 0.8;
      ttsEngine.speak(cue.idText, `${state.mediaKey}:${idx}`, windowEndVideoSec, Math.max(0.8, cue.end - now));
      ttsEngine.prefetchAhead(idx);
    }
  }

  function bindVideoElement(found) {
    if (!found || found === videoEl) return;

    videoEl = found;

    if (!videoEl.__ytIndoSubListenersBound) {
      videoEl.__ytIndoSubListenersBound = true;
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
        vocalRemover.resumeIfNeeded();
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
  }

  // =========================
  // Universal Live DOM Fallback (YouTube, Udemy, Coursera, Netflix, Video.js, etc.)
  // =========================

  const LIVE_CAPTION_SELECTORS = [
    '#movie_player .ytp-caption-segment',
    '[data-purpose="captions-cue-text"]',
    '.vjs-text-track-cue',
    '.player-timedtext-text-container',
    '.plyr__captions',
    '.jw-text-track-cue',
    '.shaka-text-container'
  ];

  const LIVE_CONTAINER_SELECTORS = [
    '#movie_player .ytp-caption-window-container',
    '[class*="captions-display--captions-container"]',
    '.vjs-text-track-display',
    '.player-timedtext',
    '.plyr__captions',
    '.jw-captions',
    '.shaka-text-container'
  ];

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
    const root = playerContainerEl || document;
    let container = null;
    for (const sel of LIVE_CONTAINER_SELECTORS) {
      container = root.querySelector(sel) || document.querySelector(sel);
      if (container) break;
    }
    if (!container) return;

    state.domFallbackActive = true;
    applySettingsUI();

    let debounceTimer = null;
    state.domFallbackObserver = new MutationObserver(() => {
      if (token !== state.runToken || state.cues.length > 0 || !settings.enabled) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        let rawText = '';
        for (const sel of LIVE_CAPTION_SELECTORS) {
          const nodes = container.querySelectorAll(sel);
          if (nodes.length > 0) {
            rawText = Array.from(nodes)
              .map((n) => n.textContent || '')
              .join(' ');
            break;
          }
        }
        if (!rawText) rawText = container.textContent || '';

        const text = cleanCaptionText(rawText);
        if (!text || text === state.lastDomText) return;

        const nowMs = Date.now();
        const elapsedSec = state.lastDomSpokenAt ? Math.max(0.7, Math.min(5.0, (nowMs - state.lastDomSpokenAt) / 1000)) : 2.8;
        state.lastDomText = text;
        state.lastDomSpokenAt = nowMs;

        setStatus('ready', `Mode live caption (${state.siteName})`);
        applySettingsUI();

        const res = await translateBatchBg([text], 'auto');
        if (token !== state.runToken) return;
        const translated = cleanCaptionText((res && res[0]) || text) || text;
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

  async function requestCaptionsForCurrentMedia(mediaKey, forceReload = false) {
    if (!mediaKey) return;

    state.runToken++;
    const token = state.runToken;
    state.mediaKey = mediaKey;
    state.videoId = isYouTubeHost ? getCurrentYouTubeVideoId() : '';
    state.cues = [];
    state.activeCueIndex = -1;
    state.translatedCount = 0;

    stopDomFallback();
    ttsEngine.resetForVideo();
    renderSubtitleText('', '');
    applySettingsUI();

    setStatus('loading', `Mencari subtitle (${state.siteName})...`);

    if (!isYouTubeHost && videoEl) {
      const okFromTrack = await tryExtractGenericVideoTracks(videoEl, token);
      if (okFromTrack || token !== state.runToken) return;
    }

    window.postMessage(
      {
        source: CONTENT_SRC,
        type: 'REQUEST_CAPTIONS',
        videoId: state.videoId,
        forceReload
      },
      '*'
    );

    setTimeout(async () => {
      if (token !== state.runToken || state.cues.length > 0 || state.status === 'no_captions') return;
      if (!isYouTubeHost && videoEl) {
        const retryOk = await tryExtractGenericVideoTracks(videoEl, token);
        if (retryOk) return;
      }
      startDomFallback(token);
      if (!isYouTubeHost && !state.domFallbackActive && state.cues.length === 0) {
        setStatus('no_captions', `Aktifkan CC di player ${state.siteName} lalu klik Muat Ulang`);
      }
    }, 3500);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== BRIDGE_SRC) return;

    const { type, payload, videoId, track, urls } = event.data;

    if (type === 'TRACK_FOUND' && isYouTubeHost && videoId === state.videoId) {
      state.sourceLang = track?.languageCode || 'en';
      setStatus('loading', `Subtitle ditemukan (${track?.name || state.sourceLang}), memuat...`);
      return;
    }

    if (type === 'NO_CAPTIONS' && isYouTubeHost && videoId === state.videoId) {
      setStatus('no_captions', 'Video ini tidak memiliki subtitle/caption di YouTube');
      applySettingsUI();
      return;
    }

    if (type === 'GENERIC_SUB_URLS' && !isYouTubeHost && Array.isArray(urls) && state.cues.length === 0) {
      const token = state.runToken;
      for (const item of urls) {
        const body = await fetchSubtitleUrlBg(item.url);
        if (token !== state.runToken || state.cues.length > 0) return;
        const parsed = parseTimedText(body);
        if (parsed.length > 0) {
          loadCuesIntoState(parsed, item.lang || 'en', false);
          return;
        }
      }
      return;
    }

    if (type === 'TIMEDTEXT_CAPTURED' && payload) {
      if (isYouTubeHost) {
        const currentId = getCurrentYouTubeVideoId();
        if (!currentId || payload.videoId !== currentId) return;
        if (state.videoId === currentId && state.cues.length > 0 && payload.tlang) return;

        const parsed = parseTimedText(payload.body);
        if (parsed.length === 0) return;
        state.videoId = currentId;
        loadCuesIntoState(parsed, payload.lang || 'en', payload.tlang === 'id');
      } else {
        if (!videoEl) {
          const found = findPrimaryVideo();
          if (found) bindVideoElement(found);
        }
        if (!videoEl) return;
        const parsed = parseTimedText(payload.body);
        if (parsed.length === 0) return;
        ensureOverlay();
        ensurePlayerButtons();
        loadCuesIntoState(parsed, payload.lang || 'auto', false);
      }
    }
  });

  // Listen to popup messages & storage updates
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    // On non-YouTube pages with multiple iframes, only respond from frames that actually have a video
    const hasVideo = Boolean(videoEl || findPrimaryVideo());
    if (!isYouTubeHost && !hasVideo) {
      return false;
    }

    if (msg.type === 'GET_STATUS') {
      sendResponse({
        siteName: state.siteName,
        videoId: state.videoId,
        mediaKey: state.mediaKey,
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
      const found = findPrimaryVideo();
      if (found) bindVideoElement(found);
      const key = computeMediaKey(videoEl);
      if (key) {
        requestCaptionsForCurrentMedia(key, true);
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
    const prevVoice = settings.ttsVoice;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
    applySettingsUI();
    if (!settings.enabled || !settings.ttsEnabled) {
      ttsEngine.stop();
    } else if ((!prevTts && settings.ttsEnabled) || prevVoice !== settings.ttsVoice) {
      ttsEngine.stop();
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
    const found = findPrimaryVideo();
    if (found) {
      bindVideoElement(found);
    }

    if (!isYouTubeHost && !videoEl) {
      return;
    }

    ensureOverlay();
    ensurePlayerButtons();

    const key = computeMediaKey(videoEl);
    if (!key) {
      if (state.mediaKey) {
        state.mediaKey = '';
        state.videoId = '';
        state.cues = [];
        stopDomFallback();
        ttsEngine.resetForVideo();
        applyAudioDucking();
        setStatus('idle', `Buka video di ${state.siteName} untuk mulai`);
      }
      return;
    }

    if (key !== state.mediaKey) {
      requestCaptionsForCurrentMedia(key, false);
    }
  }

  async function init() {
    await loadSettings();
    checkPageState();

    document.addEventListener('pointerdown', () => vocalRemover.resumeIfNeeded(), { passive: true });
    document.addEventListener('keydown', () => vocalRemover.resumeIfNeeded(), { passive: true });
    document.addEventListener('fullscreenchange', () => setTimeout(ensureOverlay, 120));

    if (isYouTubeHost) {
      window.addEventListener('yt-navigate-finish', () => setTimeout(checkPageState, 250));
      window.addEventListener('yt-page-data-updated', () => setTimeout(checkPageState, 250));
    } else {
      window.addEventListener('popstate', () => setTimeout(checkPageState, 300));
    }

    setInterval(checkPageState, isYouTubeHost ? 1200 : 1500);
  }

  init();
})();
