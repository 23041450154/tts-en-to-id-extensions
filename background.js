const TRANSLATION_CACHE_LIMIT = 2500;
const TTS_CACHE_LIMIT = 100;

const translationCache = new Map();
const ttsCache = new Map();

function setBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

async function translateViaClients5(texts, sourceLang, targetLang) {
  const sl = sourceLang || 'auto';
  const params = new URLSearchParams();
  params.set('client', 'dict-chrome-ex');
  params.set('sl', sl);
  params.set('tl', targetLang);
  for (const text of texts) {
    params.append('q', text);
  }

  const url = `https://clients5.google.com/translate_a/t?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`clients5 HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('clients5 returned HTML block page');
  }
  const data = await res.json();

  // Single string or array of strings or array of [translated, detectedLang]
  if (typeof data === 'string') {
    return [data];
  }
  if (!Array.isArray(data)) {
    throw new Error('clients5 unexpected format');
  }

  // When texts.length === 1 and sl === 'auto', response may be [["Halo", "en"]] or ["Halo", "en"]
  if (texts.length === 1) {
    if (Array.isArray(data[0])) {
      return [String(data[0][0] ?? '')];
    }
    if (typeof data[0] === 'string') {
      return [data[0]];
    }
  }

  const out = data.map((item) => {
    if (typeof item === 'string') return item;
    if (Array.isArray(item) && typeof item[0] === 'string') return item[0];
    return '';
  });

  if (out.length !== texts.length) {
    throw new Error(`clients5 count mismatch: ${out.length} vs ${texts.length}`);
  }
  return out;
}

async function translateSingleViaGoogleApis(text, sourceLang, targetLang) {
  const sl = sourceLang || 'auto';
  const params = new URLSearchParams({
    client: 'gtx',
    sl,
    tl: targetLang,
    dt: 't',
    q: text
  });
  const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
  if (!res.ok) throw new Error(`googleapis HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) throw new Error('googleapis blocked');
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('googleapis unexpected format');
  }
  return data[0].map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
}

async function translateSingleViaMyMemory(text, sourceLang, targetLang) {
  const sl = sourceLang && sourceLang !== 'auto' ? sourceLang : 'en';
  const params = new URLSearchParams({
    q: text,
    langpair: `${sl}|${targetLang}`
  });
  const res = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`);
  if (!res.ok) throw new Error(`mymemory HTTP ${res.status}`);
  const data = await res.json();
  if (data?.responseData?.translatedText) {
    return data.responseData.translatedText;
  }
  throw new Error('mymemory empty');
}

async function translateChunk(texts, sourceLang, targetLang) {
  try {
    return await translateViaClients5(texts, sourceLang, targetLang);
  } catch (err) {
    // Fallback per item
    const results = [];
    for (const text of texts) {
      let translated = '';
      try {
        translated = await translateSingleViaGoogleApis(text, sourceLang, targetLang);
      } catch {
        try {
          translated = await translateSingleViaMyMemory(text, sourceLang, targetLang);
        } catch {
          translated = text;
        }
      }
      results.push(translated);
    }
    return results;
  }
}

async function handleTranslateBatch(texts, sourceLang = 'en', targetLang = 'id') {
  const results = new Array(texts.length);
  const uncachedIndices = [];
  const uncachedTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const raw = (texts[i] || '').trim();
    if (!raw) {
      results[i] = '';
      continue;
    }
    const cacheKey = `${sourceLang}:${targetLang}:${raw}`;
    if (translationCache.has(cacheKey)) {
      results[i] = translationCache.get(cacheKey);
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(raw);
    }
  }

  if (uncachedTexts.length === 0) {
    return results;
  }

  // Group into URL-safe chunks (max ~1400 chars encoded or 12 items)
  let offset = 0;
  while (offset < uncachedTexts.length) {
    const chunkTexts = [];
    const chunkIndices = [];
    let charBudget = 0;

    while (offset < uncachedTexts.length && chunkTexts.length < 12) {
      const nextText = uncachedTexts[offset];
      const nextCost = encodeURIComponent(nextText).length + 6;
      if (chunkTexts.length > 0 && charBudget + nextCost > 1500) {
        break;
      }
      chunkTexts.push(nextText);
      chunkIndices.push(uncachedIndices[offset]);
      charBudget += nextCost;
      offset++;
    }

    const translatedChunk = await translateChunk(chunkTexts, sourceLang, targetLang);
    for (let j = 0; j < chunkTexts.length; j++) {
      const idx = chunkIndices[j];
      const translated = (translatedChunk[j] || chunkTexts[j]).trim();
      results[idx] = translated;
      const cacheKey = `${sourceLang}:${targetLang}:${chunkTexts[j]}`;
      setBounded(translationCache, cacheKey, translated, TRANSLATION_CACHE_LIMIT);
    }
  }

  return results;
}

function splitTextForTTS(text, maxLen = 175) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks = [];
  let remaining = clean;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    // Prefer splitting at sentence end, then comma/semicolon, then space
    let splitAt = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! ')
    );
    if (splitAt > 40) {
      splitAt += 1;
    } else {
      splitAt = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '));
      if (splitAt > 40) {
        splitAt += 1;
      } else {
        splitAt = slice.lastIndexOf(' ');
        if (splitAt <= 0) splitAt = maxLen;
      }
    }

    const part = remaining.slice(0, splitAt).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchGoogleTTSFromEndpoint(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Google TTS HTTP ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new Error('Google TTS diblokir sementara (HTML)');
    }
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength < 100) {
      throw new Error('Google TTS returned empty audio');
    }
    return `data:audio/mpeg;base64,${arrayBufferToBase64(buffer)}`;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleTTSChunk(chunk, lang = 'id') {
  const cacheKey = `google:${lang}:${chunk}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const p1 = new URLSearchParams({ ie: 'UTF-8', tl: lang, client: 'tw-ob', q: chunk });
  const p2 = new URLSearchParams({ ie: 'UTF-8', tl: lang, client: 'gtx', q: chunk });
  const urls = [
    `https://translate.google.com/translate_tts?${p1.toString()}`,
    `https://translate.googleapis.com/translate_tts?${p2.toString()}`
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const dataUrl = await fetchGoogleTTSFromEndpoint(url, 6000);
      setBounded(ttsCache, cacheKey, dataUrl, TTS_CACHE_LIMIT);
      return dataUrl;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Google TTS gagal');
}

async function fetchTikTokTTSChunk(chunk, voiceId, timeoutMs = 7000) {
  const cacheKey = `tiktok:${voiceId}:${chunk}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://ottsy.weilbyte.dev/api/generation', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, voice: voiceId }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`TikTok TTS HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json || !json.success || !json.data) {
      throw new Error(json?.error || 'TikTok TTS empty response');
    }

    const dataUrl = `data:audio/mpeg;base64,${json.data}`;
    setBounded(ttsCache, cacheKey, dataUrl, TTS_CACHE_LIMIT);
    return dataUrl;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSingleTTSChunk(chunk, voice = 'google:id', lang = 'id', options = {}) {
  const { isPrefetch = false, isTest = false } = options;
  if (voice && voice.startsWith('tiktok:')) {
    const voiceId = voice.slice('tiktok:'.length);
    const timeoutMs = isTest ? 9500 : isPrefetch ? 7500 : 3200;
    try {
      return await fetchTikTokTTSChunk(chunk, voiceId, timeoutMs);
    } catch (err) {
      if (isPrefetch) throw err;
      return await fetchGoogleTTSChunk(chunk, lang);
    }
  }
  return await fetchGoogleTTSChunk(chunk, lang);
}

async function handleFetchTTS(text, voice = 'google:id', lang = 'id', options = {}) {
  const chunks = splitTextForTTS(text);
  if (chunks.length === 0) return [];
  const audioDataUrls = [];
  for (const chunk of chunks) {
    const dataUrl = await fetchSingleTTSChunk(chunk, voice, lang, options);
    audioDataUrls.push(dataUrl);
  }
  return audioDataUrls;
}

async function handleFetchSubtitleUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('URL subtitle tidak valid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Subtitle HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text || text.trim().length < 10) {
      throw new Error('Isi subtitle kosong');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function updateActionBadge(masterEnabled) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  if (masterEnabled === false) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

if (chrome.storage && chrome.storage.sync) {
  chrome.storage.sync.get({ masterEnabled: true }, (stored) => {
    updateActionBadge(stored?.masterEnabled !== false);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.masterEnabled) {
      updateActionBadge(changes.masterEnabled.newValue !== false);
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'TRANSLATE_BATCH') {
    handleTranslateBatch(message.texts || [], message.sourceLang || 'en', message.targetLang || 'id')
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'FETCH_TTS_AUDIO') {
    handleFetchTTS(message.text || '', message.voice || 'google:id', message.lang || 'id', {
      isPrefetch: Boolean(message.isPrefetch),
      isTest: Boolean(message.isTest)
    })
      .then((audioUrls) => sendResponse({ ok: true, audioUrls }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'FETCH_SUBTITLE_URL') {
    handleFetchSubtitleUrl(message.url || '')
      .then((body) => sendResponse({ ok: true, body }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
