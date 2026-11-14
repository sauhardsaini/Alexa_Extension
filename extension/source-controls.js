(() => {
  'use strict';
  const sources = new Set(['youtube-music', 'spotify', 'apple-music']);
  const cleanKey = value => typeof value === 'string' && value.length <= 250 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim() : '';
  const identity = track => track ? [track.source, cleanKey(track.title), cleanKey(track.artist)].join('\u001f') : '';
  const recordingKey = track => track ? [identity(track), track.trackId || ''].join('\u001f') : '';
  const stableKey = track => track ? [recordingKey(track), track.state, track.confidence, track.isAd === true].join('\u001f') : '';
  const complete = track => !!track?.title && !!track.artist && track.confidence === 'high' && !track.isAd;
  const missingArtist = track => typeof track?.artist === 'string' && track.artist.length <= 250 && !/[\u0000-\u001f\u007f-\u009f]/u.test(track.artist) && !track.artist.trim();
  const reliableId = track => typeof track?.trackId === 'string' && (track.source === 'youtube-music' ? /^[\w-]{11}$/u.test(track.trackId) : track.source === 'spotify' ? /^[a-zA-Z0-9]{22}$/u.test(track.trackId) : track.source === 'apple-music' ? /^\d{1,24}$/u.test(track.trackId) : false);
  const validExpected = track => !!track && typeof track === 'object' && !Array.isArray(track) && sources.has(track.source) && !!cleanKey(track.title) && (!!cleanKey(track.artist) || missingArtist(track) && reliableId(track)) && (track.trackId === undefined || typeof track.trackId === 'string' && track.trackId.length <= 180 && !/[\u0000-\u001f\u007f-\u009f]/u.test(track.trackId));
  const matches = (track, expected) => !!track && !!expected && track.source === expected.source && cleanKey(track.title) === cleanKey(expected.title) && (!expected.trackId || track.trackId === expected.trackId) && (missingArtist(expected) ? reliableId(expected) : cleanKey(track.artist) === cleanKey(expected.artist));
  const stale = () => ({ ok: false, stale: true, message: 'The music website selected a different song. No playback change was sent to that newer selection.' });
  async function run(action, { read, control, expectedTrack, hold = false, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 10000, settleMs = 800 } = {}) {
    if (!['play', 'pause', 'next'].includes(action)) return { ok: false, message: 'Choose Play, Pause or Next.' };
    if (typeof read !== 'function' || typeof control !== 'function') return { ok: false, message: 'The browser playback control is unavailable.' };
    if (expectedTrack !== undefined && !validExpected(expectedTrack)) return { ok: false, message: 'Refresh the expected song details before changing browser playback.' };
    const before = read();
    if (!before?.title) return { ok: false, message: 'Choose a song in the music website before using these controls.' };
    if (expectedTrack && !matches(before, expectedTrack)) return stale();
    const started = now(), beforeIdentity = identity(before);
    // Reread immediately before each native click. An older Echo handoff must
    // never pause or resume a song the user selected while it was in flight.
    const invoke = (command, expected) => {
      const current = read();
      if (!matches(current, expected)) return stale();
      return control(command, current.state, expected);
    };
    const command = invoke(action, expectedTrack || before);
    if (!command?.ok) return command || { ok: false, message: 'The browser playback control is unavailable.' };
    let candidateKey = '', candidateAt = started, resumedNext = false, heldRecording = null;
    while (now() - started <= timeoutMs) {
      const track = read();
      const sameSource = track?.source === before.source;
      if (action !== 'next' && !matches(track, expectedTrack || before)) return stale();
      if (heldRecording && !matches(track, heldRecording)) return stale();
      const changed = sameSource && identity(track) !== beforeIdentity;
      if (action === 'next' && hold === true && changed && complete(track) && track.state === 'playing' && !heldRecording) {
        const paused = invoke('pause', track);
        if (!paused?.ok) return paused || { ok: false, message: 'The website advanced, but the new song could not be paused while your Echo starts.' };
        heldRecording = { ...track }; candidateKey = '';
      } else {
        const desired = action === 'play' ? 'playing' : 'paused';
        const suitable = action === 'next'
          ? changed && complete(track) && (hold === true ? track.state === 'paused' : ['playing', 'paused'].includes(track.state))
          : sameSource && track.state === desired;
        if (suitable) {
          const key = stableKey(track);
          if (key !== candidateKey) { candidateKey = key; candidateAt = now(); }
          if (now() - candidateAt >= settleMs) {
            if (action === 'next' && hold !== true && track.state === 'paused') {
              if (!resumedNext) {
                const resumed = invoke('play', track);
                if (!resumed?.ok) return resumed || { ok: false, message: 'The website advanced, but the new song could not be started. Play it in the music tab.' };
                resumedNext = true; candidateKey = '';
              }
            } else return { ok: true, track };
          }
        } else candidateKey = '';
      }
      await wait(150);
    }
    return { ok: false, message: action === 'next' ? 'The browser’s next song could not be confirmed. Check the music tab before trying again.' : 'The browser did not confirm the playback change. Check the music tab before trying again.' };
  }
  globalThis.EchoSourceControls = Object.freeze({ run });
})();
