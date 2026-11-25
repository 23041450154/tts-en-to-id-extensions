(() => {
  if (window.__YT_INDOSUB_BRIDGE_LOADED__) return;
  window.__YT_INDOSUB_BRIDGE_LOADED__ = true;

  const BRIDGE_SRC = 'YT_INDOSUB_BRIDGE';
  const CONTENT_SRC = 'YT_INDOSUB_CONTENT';

  const capturedByVideo = new Map();
  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

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

  function parseTimedTextMeta(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      if (!u.pathname.includes('/api/timedtext')) return null;
      return {
        url: u.toString(),
        videoId: u.searchParams.get('v') || getCurrentVideoId(),
        lang: u.searchParams.get('lang') || '',
        tlang: u.searchParams.get('tlang') || '',
        kind: u.searchParams.get('kind') || '',
        fmt: u.searchParams.get('fmt') || ''
      };
    } catch {
      return null;
    }
  }

  function emitCaptured(meta, body) {
    if (!meta || !meta.videoId || !body || body.trim().length < 20) return;

    const payload = {
      videoId: meta.videoId,
      lang: meta.lang || 'en',
      tlang: meta.tlang || '',
      kind: meta.kind || '',
      fmt: meta.fmt || '',
      url: meta.url,
      body
    };

    const existing = capturedByVideo.get(meta.videoId);
    const isEnglish = payload.lang.toLowerCase().startsWith('en');
    const existingIsEnglish = existing && existing.lang.toLowerCase().startsWith('en') && !existing.tlang;
    if (!existing || (isEnglish && !payload.tlang) || (!existingIsEnglish && !payload.tlang)) {
      capturedByVideo.set(meta.videoId, payload);
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

  // Intercept window.fetch for /api/timedtext
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
    }

    return promise;
  };

  // Intercept XMLHttpRequest for /api/timedtext
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytIndoSubMeta = typeof url === 'string' ? parseTimedTextMeta(url) : null;
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytIndoSubMeta) {
      const meta = this.__ytIndoSubMeta;
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string') {
            emitCaptured(meta, this.responseText);
          }
        } catch {
          // ignore non-text response types
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

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
        if (!name.includes('/api/timedtext')) continue;
        const meta = parseTimedTextMeta(name);
        if (meta && meta.videoId === videoId) {
          candidates.push(meta);
        }
      }

      // Prefer English non-translated first, otherwise most recent matching videoId
      candidates.sort((a, b) => {
        const score = (m) =>
          (m.lang.toLowerCase().startsWith('en') ? 4 : 0) + (!m.tlang ? 2 : 0) + (m.fmt === 'json3' ? 1 : 0);
        return score(b) - score(a);
      });

      for (const meta of candidates) {
        try {
          const res = await origFetch.call(window, meta.url, { credentials: 'include' });
          if (!res.ok) continue;
          const body = await res.text();
          if (body && body.trim().length > 20) {
            emitCaptured(meta, body);
            return true;
          }
        } catch {
          // try next candidate
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
      if (!body || body.trim().length < 20) return false;

      emitCaptured(
        {
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
        // CC was already ON before our request; wait briefly then toggle OFF -> ON to force fresh POT fetch
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

  async function handleRequestCaptions(videoId, forceReload = false) {
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

    // Fast path: check if YouTube already requested timedtext with a valid POT token
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

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== CONTENT_SRC) return;
    if (event.data.type === 'REQUEST_CAPTIONS') {
      handleRequestCaptions(event.data.videoId, Boolean(event.data.forceReload));
    }
  });
})();
