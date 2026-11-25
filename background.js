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

async function fetchGoogleTTSChunk(chunk, lang = 'id') {
  const cacheKey = `google:${lang}:${chunk}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    ie: 'UTF-8',
    tl: lang,
    client: 'tw-ob',
    q: chunk
  });

  const res = await fetch(`https://translate.google.com/translate_tts?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Google TTS HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  if (!buffer || buffer.byteLength < 100) {
    throw new Error('Google TTS returned empty audio');
  }

  const dataUrl = `data:audio/mpeg;base64,${arrayBufferToBase64(buffer)}`;
  setBounded(ttsCache, cacheKey, dataUrl, TTS_CACHE_LIMIT);
  return dataUrl;
}

async function fetchTikTokTTSChunk(chunk, voiceId) {
  const cacheKey = `tiktok:${voiceId}:${chunk}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const res = await fetch('https://ottsy.weilbyte.dev/api/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: chunk, voice: voiceId })
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
}

async function fetchSingleTTSChunk(chunk, voice = 'google:id', lang = 'id') {
  if (voice && voice.startsWith('tiktok:')) {
    const voiceId = voice.slice('tiktok:'.length);
    try {
      return await fetchTikTokTTSChunk(chunk, voiceId);
    } catch {
      // Automatic fallback to Google TTS if upstream hiccups
      return await fetchGoogleTTSChunk(chunk, lang);
    }
  }
  return await fetchGoogleTTSChunk(chunk, lang);
}

async function handleFetchTTS(text, voice = 'google:id', lang = 'id') {
  const chunks = splitTextForTTS(text);
  if (chunks.length === 0) return [];
  const audioDataUrls = [];
  for (const chunk of chunks) {
    const dataUrl = await fetchSingleTTSChunk(chunk, voice, lang);
    audioDataUrls.push(dataUrl);
  }
  return audioDataUrls;
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
    handleFetchTTS(message.text || '', message.voice || 'google:id', message.lang || 'id')
      .then((audioUrls) => sendResponse({ ok: true, audioUrls }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
