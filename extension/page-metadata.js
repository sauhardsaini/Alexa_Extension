(() => {
  'use strict';
  const EVENT = 'echo-library:media-state-v1';
  if (window.__echoLibraryMediaProbeV1) return;
  window.__echoLibraryMediaProbeV1 = true;
  const clean = value => typeof value === 'string' && value.length <= 250 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ? value.replace(/\s+/gu, ' ').trim() : '';
  function currentMedia() {
    const hostname = globalThis.location?.hostname;
    const selector = hostname === 'music.youtube.com' ? 'ytmusic-player audio, ytmusic-player video, #movie_player audio, #movie_player video'
      : hostname === 'open.spotify.com' ? '[data-testid="now-playing-bar"] audio, [data-testid="now-playing-bar"] video'
      : hostname === 'music.apple.com' ? 'amp-player audio, amp-player video, .web-chrome audio, .web-chrome video' : '';
    const scoped = selector ? [...new Set(document.querySelectorAll(selector))] : [];
    const all = scoped.length ? scoped : [...document.querySelectorAll('audio, video')];
    const loaded = all.filter(item => item.isConnected !== false && item.readyState >= 1);
    // A known player's active element can coexist with a preloaded queue item.
    // Without that scope, several media elements are ambiguous: do not borrow
    // an unrelated preview's clock or playback state for the current song.
    if (scoped.length) {
      const playing = loaded.filter(item => !item.paused && !item.ended);
      if (playing.length === 1) return playing[0];
    }
    return loaded.length === 1 ? loaded[0] : null;
  }
  function publish() {
    try {
      const session = navigator.mediaSession;
      const metadata = session?.metadata;
      const media = currentMedia();
      const state = media ? media.paused || media.ended ? 'paused' : 'playing'
        : session?.playbackState === 'playing' || session?.playbackState === 'paused' ? session.playbackState : 'unknown';
      const payload = { title: clean(metadata?.title), artist: clean(metadata?.artist), album: clean(metadata?.album), state, nativeState: !!media };
      if (media && Number.isFinite(media.currentTime) && media.currentTime >= 0 && media.currentTime <= 86400) payload.positionMs = Math.round(media.currentTime * 1000);
      if (media && Number.isFinite(media.duration) && media.duration > 0 && media.duration <= 86400) payload.durationMs = Math.round(media.duration * 1000);
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(payload) }));
    } catch (_) {}
  }
  setInterval(publish, 1000);
  // Native media events also cover source changes while background timers slow down.
  for (const event of ['play', 'pause', 'ended', 'playing', 'loadedmetadata', 'durationchange', 'seeked', 'emptied']) document.addEventListener(event, publish, true);
  document.addEventListener('visibilitychange', publish);
  publish();
})();
