(() => {
  if (window.__YT_INDOSUB_BRIDGE_LOADED__) return;
  window.__YT_INDOSUB_BRIDGE_LOADED__ = true;

  const BRIDGE_SRC = 'YT_INDOSUB_BRIDGE';
  const CONTENT_SRC = 'YT_INDOSUB_CONTENT';

  const isYouTubeHost = /(^|\.)youtube\.com$/i.test(location.hostname);
  const capturedByVideo = new Map();
  let latestGenericSub = null;

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

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

  function guessLangFromUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      const qLang = u.searchParams.get('lang') || u.searchParams.get('locale') || u.searchParams.get('language');
      if (qLang) return qLang;
      const pathMatch = u.pathname.match(/(?:^|[/_.-])(en(?:[-_][a-z]{2})?|id(?:[-_][a-z]{2})?)(?:[/_.-]|\.(?:vtt|srt|ttml|xml)$)/i);
      if (pathMatch) return pathMatch[1];
    } catch {
      // ignore
    }
    return 'auto';
  }

  function parseTimedTextMeta(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      if (isYouTubeHost && u.pathname.includes('/api/timedtext')) {
        return {
          site: 'youtube',
          url: u.toString(),
          videoId: u.searchParams.get('v') || getCurrentYouTubeVideoId(),
          lang: u.searchParams.get('lang') || '',
          tlang: u.searchParams.get('tlang') || '',
          kind: u.searchParams.get('kind') || '',
          fmt: u.searchParams.get('fmt') || ''
        };
      }

      if (!isYouTubeHost) {
        const lower = (u.pathname + u.search).toLowerCase();
        // Never capture video seekbar thumbnail/storyboard sprite VTTs
        if (/(?:thumb|sprite|storyboard|trickplay|chapters?|preview[-_]?img)/i.test(lower)) {
          return null;
        }
        const looksLikeSub =
          /\.(vtt|srt|ttml|dfxp)(\?|$|&)/i.test(lower) ||
          /(\/vtt\/|\/subtitles?\/|\/captions?\/|timedtext|webvtt|vtt-c\.udemycdn\.com)/i.test(u.href);
        if (looksLikeSub && !/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|mp4|m4s|ts|m3u8|mpd)(\?|$)/i.test(u.pathname)) {
          return {
            site: 'generic',
            url: u.toString(),
            videoId: `${location.origin}${location.pathname}`,
            lang: guessLangFromUrl(u.toString()),
            tlang: '',
            kind: '',
            fmt: lower.includes('.srt') ? 'srt' : lower.includes('.ttml') || lower.includes('.xml') ? 'xml' : 'vtt'
          };
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  function looksLikeSubtitleBody(body) {
    const trimmed = (body || '').trim();
    if (trimmed.length < 18) return false;
    // Reject thumbnail/storyboard sprite VTTs (e.g. thumb-sprite.jpg#xywh=0,0,160,90)
    const sample = trimmed.slice(0, 1500);
    if (/#xywh=/i.test(sample) || /\.(?:jpg|jpeg|png|webp|gif)(?:#|\?|\s|$)/i.test(sample)) {
      return false;
    }
    if (/^WEBVTT\b/i.test(trimmed)) return true;
    if (/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}/.test(trimmed)) return true;
    if (trimmed.startsWith('{') && trimmed.includes('"events"')) return true;
    if (trimmed.startsWith('<') && (trimmed.includes('<text') || trimmed.includes('<p ') || trimmed.includes('<tt'))) return true;
    return false;
  }

  function emitCaptured(meta, body) {
    if (!meta || !body || !looksLikeSubtitleBody(body)) return;

    const payload = {
      site: meta.site || (isYouTubeHost ? 'youtube' : 'generic'),
      videoId: meta.videoId || '',
      lang: meta.lang || (isYouTubeHost ? 'en' : 'auto'),
      tlang: meta.tlang || '',
      kind: meta.kind || '',
      fmt: meta.fmt || '',
      url: meta.url,
      pageUrl: location.href,
      body
    };

    if (payload.site === 'youtube' && payload.videoId) {
      const existing = capturedByVideo.get(payload.videoId);
      const isEnglish = payload.lang.toLowerCase().startsWith('en');
      const existingIsEnglish = existing && existing.lang.toLowerCase().startsWith('en') && !existing.tlang;
      if (!existing || (isEnglish && !payload.tlang) || (!existingIsEnglish && !payload.tlang)) {
        capturedByVideo.set(payload.videoId, payload);
      }
    } else {
      latestGenericSub = payload;
    }

    window.postMessage(
      {
        source: BRIDGE_SRC,
        type: 'TIMEDTEXT_CAPTURED',
        payload
      },
      '*'
    );
  }

  // Intercept window.fetch for YouTube /api/timedtext and generic VTT/SRT/TTML
  window.fetch = function (...args) {
    const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const meta = reqUrl ? parseTimedTextMeta(reqUrl) : null;
    const promise = origFetch.apply(this, args);

    if (meta) {
      promise
        .then((response) => {
          if (!response || !response.ok) return;
          response
            .clone()
            .text()
            .then((text) => emitCaptured(meta, text))
            .catch(() => {});
        })
        .catch(() => {});
    } else if (!isYouTubeHost && reqUrl && /^https?:\/\//i.test(reqUrl)) {
      // Also detect subtitle responses served via text/vtt even without .vtt extension
      promise
        .then((response) => {
          if (!response || !response.ok) return;
          const ct = (response.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('text/vtt') || ct.includes('application/x-subrip') || ct.includes('ttml')) {
            response
              .clone()
              .text()
              .then((text) =>
                emitCaptured(
                  {
                    site: 'generic',
                    url: reqUrl,
                    videoId: `${location.origin}${location.pathname}`,
                    lang: guessLangFromUrl(reqUrl),
                    tlang: '',
                    kind: '',
                    fmt: ct.includes('subrip') ? 'srt' : ct.includes('ttml') ? 'xml' : 'vtt'
                  },
                  text
                )
              )
              .catch(() => {});
          }
        })
        .catch(() => {});
    }

    return promise;
  };

  // Intercept XMLHttpRequest
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytIndoSubMeta = typeof url === 'string' ? parseTimedTextMeta(url) : null;
    this.__ytIndoSubUrl = typeof url === 'string' ? url : '';
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__ytIndoSubMeta;
    const rawUrl = this.__ytIndoSubUrl;

    if (meta || (!isYouTubeHost && rawUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType && this.responseType !== 'text') return;
          const text = this.responseText;
          if (typeof text !== 'string' || text.length < 18) return;

          if (meta) {
            emitCaptured(meta, text);
          } else {
            const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
            if (ct.includes('text/vtt') || /^WEBVTT\b/i.test(text.trimStart())) {
              emitCaptured(
                {
                  site: 'generic',
                  url: rawUrl,
                  videoId: `${location.origin}${location.pathname}`,
                  lang: guessLangFromUrl(rawUrl),
                  tlang: '',
                  kind: '',
                  fmt: 'vtt'
                },
                text
              );
            }
          }
        } catch {
          // ignore non-text responses
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

  // =========================
  // YouTube-specific helpers
  // =========================

  function getPlayerResponse(videoId) {
    const player = document.querySelector('#movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const resp = player.getPlayerResponse();
        if (resp && (!videoId || resp?.videoDetails?.videoId === videoId)) {
          return resp;
        }
      } catch {
        // ignore
      }
    }

    const initial = window.ytInitialPlayerResponse;
    if (initial && (!videoId || initial?.videoDetails?.videoId === videoId)) {
      return initial;
    }

    return null;
  }

  function pickBestTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    return (
      tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find((t) => (t.languageCode || '').toLowerCase().startsWith('en') && t.kind !== 'asr') ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => (t.languageCode || '').toLowerCase().startsWith('en')) ||
      tracks[0]
    );
  }

  async function tryFetchFromPerformanceEntries(videoId) {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      const candidates = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i]?.name || '';
        const meta = parseTimedTextMeta(name);
        if (!meta) continue;
        if (isYouTubeHost) {
          if (meta.site === 'youtube' && meta.videoId === videoId) {
            candidates.push(meta);
          }
        } else {
          candidates.push(meta);
        }
      }

      candidates.sort((a, b) => {
        const score = (m) =>
          (m.lang.toLowerCase().startsWith('en') ? 4 : 0) + (!m.tlang ? 2 : 0) + (m.fmt === 'json3' || m.fmt === 'vtt' ? 1 : 0);
        return score(b) - score(a);
      });

      for (const meta of candidates.slice(0, 4)) {
        try {
          const res = await origFetch.call(window, meta.url, { credentials: isYouTubeHost ? 'include' : 'same-origin' });
          if (!res.ok) continue;
          const body = await res.text();
          if (looksLikeSubtitleBody(body)) {
            emitCaptured(meta, body);
            return true;
          }
        } catch {
          // try next or let content.js fetch via background.js
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  async function tryDirectFetchTrack(videoId, track) {
    if (!track || !track.baseUrl) return false;
    try {
      const u = new URL(track.baseUrl);
      u.searchParams.set('fmt', 'json3');
      const res = await origFetch.call(window, u.toString(), { credentials: 'include' });
      if (!res.ok) return false;
      const body = await res.text();
      if (!looksLikeSubtitleBody(body)) return false;

      emitCaptured(
        {
          site: 'youtube',
          url: u.toString(),
          videoId,
          lang: track.languageCode || 'en',
          tlang: '',
          kind: track.kind || '',
          fmt: 'json3'
        },
        body
      );
      return true;
    } catch {
      return false;
    }
  }

  function triggerNativeCaptionFetch(videoId, track) {
    const player = document.querySelector('#movie_player');
    if (!player) return;

    try {
      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }
    } catch {
      // ignore
    }

    const applyTrack = () => {
      if (capturedByVideo.has(videoId)) return;

      try {
        if (track && typeof player.setOption === 'function') {
          player.setOption('captions', 'track', {
            languageCode: track.languageCode,
            vssId: track.vssId
          });
        }
      } catch {
        // ignore
      }

      const ccBtn = document.querySelector('#movie_player .ytp-subtitles-button');
      if (!ccBtn) return;

      const pressed = ccBtn.getAttribute('aria-pressed');
      if (pressed === 'false') {
        ccBtn.click();
      } else if (pressed === 'true') {
        setTimeout(async () => {
          if (capturedByVideo.has(videoId)) return;
          const fromPerf = await tryFetchFromPerformanceEntries(videoId);
          if (fromPerf || capturedByVideo.has(videoId)) return;
          try {
            ccBtn.click();
            setTimeout(() => {
              if (!capturedByVideo.has(videoId)) {
                ccBtn.click();
              }
            }, 220);
          } catch {
            // ignore
          }
        }, 450);
      }
    };

    setTimeout(applyTrack, 220);
  }

  async function handleRequestYouTubeCaptions(videoId, forceReload = false) {
    if (!videoId) return;

    if (forceReload) {
      capturedByVideo.delete(videoId);
    } else if (capturedByVideo.has(videoId)) {
      window.postMessage(
        {
          source: BRIDGE_SRC,
          type: 'TIMEDTEXT_CAPTURED',
          payload: capturedByVideo.get(videoId)
        },
        '*'
      );
      return;
    }

    const perfOk = await tryFetchFromPerformanceEntries(videoId);
    if (perfOk) return;

    let resp = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      resp = getPlayerResponse(videoId);
      if (resp) break;
      await new Promise((r) => setTimeout(r, 320));
    }

    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (tracks.length === 0) {
      window.postMessage(
        {
          source: BRIDGE_SRC,
          type: 'NO_CAPTIONS',
          videoId
        },
        '*'
      );
      return;
    }

    const bestTrack = pickBestTrack(tracks);
    window.postMessage(
      {
        source: BRIDGE_SRC,
        type: 'TRACK_FOUND',
        videoId,
        track: {
          languageCode: bestTrack.languageCode || 'en',
          kind: bestTrack.kind || '',
          name: bestTrack.name?.simpleText || bestTrack.languageCode || 'en'
        }
      },
      '*'
    );

    const directOk = await tryDirectFetchTrack(videoId, bestTrack);
    if (!directOk) {
      triggerNativeCaptionFetch(videoId, bestTrack);
    }
  }

  async function handleRequestGenericCaptions(forceReload = false) {
    if (!forceReload && latestGenericSub && latestGenericSub.pageUrl === location.href) {
      window.postMessage(
        {
          source: BRIDGE_SRC,
          type: 'TIMEDTEXT_CAPTURED',
          payload: latestGenericSub
        },
        '*'
      );
      return;
    }
    if (forceReload) {
      latestGenericSub = null;
    }

    // Collect any subtitle URLs already present in performance entries for content.js fallback fetch
    const perfOk = await tryFetchFromPerformanceEntries('');
    if (!perfOk) {
      const urls = [];
      try {
        const entries = performance.getEntriesByType('resource') || [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const name = entries[i]?.name || '';
          const meta = parseTimedTextMeta(name);
          if (meta && meta.site === 'generic') {
            urls.push({ url: meta.url, lang: meta.lang });
          }
        }
      } catch {
        // ignore
      }
      if (urls.length > 0) {
        window.postMessage(
          {
            source: BRIDGE_SRC,
            type: 'GENERIC_SUB_URLS',
            urls: urls.slice(0, 5)
          },
          '*'
        );
      }
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== CONTENT_SRC) return;
    if (event.data.type === 'REQUEST_CAPTIONS') {
      if (isYouTubeHost) {
        handleRequestYouTubeCaptions(event.data.videoId, Boolean(event.data.forceReload));
      } else {
        handleRequestGenericCaptions(Boolean(event.data.forceReload));
      }
    }
  });
})();
