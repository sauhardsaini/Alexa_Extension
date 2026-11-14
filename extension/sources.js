(() => {
  'use strict';
  const hosts = Object.freeze({ 'music.youtube.com': 'youtube-music', 'open.spotify.com': 'spotify', 'music.apple.com': 'apple-music' });
  const clean = (value, max = 250) => {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return '';
    const result = value.replace(/\s+/gu, ' ').trim();
    return result.length <= max ? result : '';
  };
  const key = value => clean(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
  const same = (left, right) => !!key(left) && key(left) === key(right);
  // Media Session can spell an artist credit's '&' as 'and'. Keep the
  // conjunction significant, and leave title matching and displayed names alone.
  const artistKey = value => key(clean(value).replace(/&/gu, ' and '));
  const sameArtist = (left, right) => !!artistKey(left) && artistKey(left) === artistKey(right);
  function featuredTitle(value) {
    const title = clean(value);
    // Only a standalone trailing featured-credit annotation can be omitted by
    // Media Session. Never strip nested groups or recording/version details.
    const match = /^(.*?)\s*(?:\(\s*(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\s*\)|\[\s*(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\s*\])$/iu.exec(title);
    if (!match) return null;
    const base = clean(match[1]), credit = clean(match[2] || match[3]);
    if (!base || !credit || /[()[\]]/u.test(base)) return null;
    if (/\b(?:live|remix|mix|acoustic|edit|version|remaster(?:ed)?|instrumental|demo|cover|karaoke|slowed|reverb|sped|radio|extended|session|mono|stereo)\b/iu.test(credit)) return null;
    return { base, credit };
  }
  function featuredTitleAlias(left, right) {
    const leftFeatured = featuredTitle(left), rightFeatured = featuredTitle(right);
    if (!!leftFeatured === !!rightFeatured) return null;
    const featured = leftFeatured || rightFeatured, bareTitle = leftFeatured ? right : left;
    return same(featured.base, bareTitle) ? { title: bareTitle, credit: featured.credit } : null;
  }
  const query = (root, selectors) => {
    for (const selector of selectors) {
      try { const found = root?.querySelector(selector); if (found) return found; } catch (_) {}
    }
    return null;
  };
  const attr = (node, name) => { try { return node?.getAttribute(name) || ''; } catch (_) { return ''; } };
  const nodeText = node => { try { return clean(node?.textContent || ''); } catch (_) { return ''; } };
  const firstText = (root, selectors) => nodeText(query(root, selectors));
  const splitByline = value => clean(value.split(/\s+[•·]\s+|\s+[—–]\s+/u)[0]);
  const clockValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value) : null;
  const playbackState = value => value === 'playing' || value === 'paused' ? value : 'unknown';
  function cleanArtistNames(values) {
    const names = [], seen = new Set();
    for (const value of Array.isArray(values) ? values.slice(0, 12) : []) {
      const name = clean(value), identity = key(name);
      if (!name || !identity || seen.has(identity)) continue;
      seen.add(identity); names.push(name);
    }
    return names;
  }

  function mediaInfo(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try {
      return { title: clean(value.title), artist: clean(value.artist), album: clean(value.album), state: playbackState(value.state || value.playbackState), nativeState: value.nativeState === true, positionMs: clockValue(value.positionMs), durationMs: clockValue(value.durationMs) };
    } catch (_) { return {}; }
  }
  function safeUrl(value, base, source) {
    try {
      const url = new URL(value || base.href, base.href);
      if (url.protocol !== 'https:' || url.port || hosts[url.hostname] !== source || url.username || url.password || url.pathname.length > 1024) return '';
      const keep = source === 'youtube-music' ? ['v'] : source === 'apple-music' ? ['i'] : [];
      const params = new URLSearchParams();
      for (const name of keep) {
        const item = url.searchParams.get(name);
        if (name === 'v' ? /^[\w-]{11}$/u.test(item || '') : /^\d{1,24}$/u.test(item || '')) params.set(name, item);
      }
      url.search = params.toString(); url.hash = '';
      return url.href;
    } catch (_) { return ''; }
  }
  function idFromUrl(value, source) {
    try {
      const url = new URL(value);
      if (source === 'youtube-music') return /^[\w-]{11}$/u.test(url.searchParams.get('v') || '') ? url.searchParams.get('v') : '';
      if (source === 'spotify') return /^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]{22})(?:\/|$)/u.exec(url.pathname)?.[1] || '';
      if (source === 'apple-music') return /^\d{1,24}$/u.test(url.searchParams.get('i') || '') ? url.searchParams.get('i') : /\/song\/(?:[^/]+\/)?(\d{1,24})(?:\/|$)/u.exec(url.pathname)?.[1] || '';
    } catch (_) {}
    return '';
  }
  function stateFromButton(root, selectors) {
    const control = query(root, selectors);
    const nested = query(control, ['button[aria-label]', '[role="button"][aria-label]', 'button']);
    for (const value of [attr(nested, 'aria-label'), attr(control, 'aria-label'), attr(nested, 'title'), attr(control, 'title')]) {
      const label = clean(value, 300).toLocaleLowerCase('en');
      if (/^(?:pause|pause playback)(?:\b|$)/u.test(label)) return 'playing';
      if (/^(?:play|resume|resume playback)(?:\b|$)/u.test(label)) return 'paused';
    }
    return 'unknown';
  }
  function allNodes(root, selectors) {
    const seen = new Set(), nodes = [];
    try {
      for (const node of root?.querySelectorAll?.(selectors.join(', ')) || []) if (!seen.has(node)) { seen.add(node); nodes.push(node); }
    } catch (_) {}
    for (const selector of nodes.length ? [] : selectors) {
      try {
        for (const node of root?.querySelectorAll?.(selector) || []) if (!seen.has(node)) { seen.add(node); nodes.push(node); }
      } catch (_) {}
    }
    if (!nodes.length) { const fallback = query(root, selectors); if (fallback) nodes.push(fallback); }
    return nodes.slice(0, 16);
  }
  function youtubeArtistCredit(byline, root) {
    const selectors = ['a[href*="/channel/"]', 'a[href^="channel/"]', 'a[href*="/browse/UC"]', 'a[href^="browse/UC"]', '[data-testid="artist"]'];
    const names = cleanArtistNames(allNodes(byline || root, selectors).map(nodeText));
    const prefix = splitByline(nodeText(byline));
    if (!prefix) return { artist: names.join(' & '), artistExact: names.length === 1, artistNames: names };
    if (!names.length) return { artist: prefix, artistExact: false, artistNames: [] };
    // Consume complete linked artist names; separators are considered only BETWEEN
    // those names, so commas and ampersands inside a band name stay intact.
    const comparable = value => clean(value).normalize('NFKC').toLocaleLowerCase('en');
    const credit = comparable(prefix), knownArtistNames = [];
    const beforeCredit = /(?:,|&|\band\b|\bfeaturing\b|\bfeat(?:\.|\b)|\bft(?:\.|\b))\s*$/iu;
    const afterCredit = /^\s*(?:,|&|\band\b|\bfeaturing\b|\bfeat(?:\.|\b)|\bft(?:\.|\b))/iu;
    let cursor = 0;
    for (const displayName of names) {
      const name = comparable(displayName);
      let offset = credit.indexOf(name, cursor);
      while (offset >= 0) {
        const before = credit.slice(0, offset), after = credit.slice(offset + name.length);
        if ((!before.trim() || beforeCredit.test(before)) && (!after.trim() || afterCredit.test(after))) {
          knownArtistNames.push(displayName); cursor = offset + name.length; break;
        }
        offset = credit.indexOf(name, offset + 1);
      }
    }
    let rest = credit, corroborated = true;
    for (let index = 0; index < names.length; index++) {
      const name = comparable(names[index]);
      if (index) {
        const offset = rest.indexOf(name), separator = offset < 0 ? '' : rest.slice(0, offset);
        if (!separator || separator.replace(/\s|,|&|\band\b|\bfeaturing\b|\bfeat\.?|\bft\.?/giu, '')) { corroborated = false; break; }
        rest = rest.slice(offset);
      }
      if (!rest.startsWith(name)) { corroborated = false; break; }
      rest = rest.slice(name.length);
    }
    return { artist: prefix, artistExact: corroborated && !rest.trim(), artistNames: knownArtistNames };
  }
  const adLabel = value => /^(?:advertisement|advertising|ad|sponsored)(?:\s*[-–—:]|$)/iu.test(clean(value));
  function flag(root, names) {
    return names.some(name => { const value = attr(root, name); return value === '' ? !!root?.hasAttribute?.(name) : value !== 'false' && value !== '0'; });
  }

  function youtube(document) {
    const root = query(document, ['ytmusic-player-bar']);
    if (!root) return {};
    const titleNode = query(root, ['.content-info-wrapper .title', '.title.ytmusic-player-bar', 'yt-formatted-string.title', '.title']);
    const byline = query(root, ['.byline.ytmusic-player-bar', '.content-info-wrapper .byline', '.byline']);
    const credit = youtubeArtistCredit(byline, root);
    const title = nodeText(titleNode);
    return { root, title, ...credit, album: firstText(byline, ['a[href*="/browse/MPRE"]', 'a[href^="browse/MPRE"]']), href: attr(query(root, ['.title a[href*="watch"]', 'a.title[href*="watch"]']), 'href'), state: stateFromButton(root, ['#play-pause-button', 'button[aria-label="Pause"]', 'button[aria-label="Play"]']), isAd: flag(root, ['is-ad']) || !!query(document, ['ytmusic-player[is-ad]:not([is-ad="false"])', '#player.ad-showing', '#movie_player.ad-showing']) || adLabel(title) };
  }
  function spotify(document) {
    const root = query(document, ['[data-testid="now-playing-widget"]', '[data-testid="now-playing-bar"]', '.Root__now-playing-bar']);
    if (!root) return {};
    const titleNode = query(root, ['[data-testid="context-item-info-title"]', '[data-testid="nowplaying-track-link"]']);
    const artist = firstText(root, ['[data-testid="context-item-info-artist"]', '[data-testid="context-item-info-subtitles"] a[href*="/artist/"]', 'a[href*="/artist/"]']);
    const link = attr(titleNode, 'href') || attr(query(titleNode, ['a[href]']), 'href') || attr(query(root, ['a[href*="/track/"]', 'a[href*="/episode/"]']), 'href');
    const title = nodeText(titleNode);
    return { root, title, artist, artistExact: !!artist, artistNames: cleanArtistNames(allNodes(root, ['a[href*="/artist/"]', '[data-testid="context-item-info-artist"]']).map(nodeText)), href: link, nonMusic: /\/episode\//u.test(link), state: stateFromButton(document, ['[data-testid="control-button-playpause"]']), isAd: adLabel(title) || !!query(root, ['[data-testid="ad-slot"]', '[data-testid="advertisement"]', '[data-testid="ad-banner"]']) };
  }
  function apple(document) {
    const root = query(document, ['.web-chrome-playback-lcd', '[data-testid="lcd"]', 'amp-lcd']);
    if (!root) return {};
    const titleNode = query(root, ['.web-chrome-playback-lcd__song-name', '.lcd-meta__primary', '[data-testid="now-playing-song"]']);
    const exactArtist = firstText(root, ['.web-chrome-playback-lcd__sub-caption a[href*="/artist/"]', '.lcd-meta__secondary a[href*="/artist/"]', '[data-testid="now-playing-artist"]']);
    const artist = exactArtist || splitByline(firstText(root, ['.web-chrome-playback-lcd__sub-caption', '.lcd-meta__secondary']));
    return { root, title: nodeText(titleNode), artist, artistExact: !!exactArtist, artistNames: cleanArtistNames(allNodes(root, ['a[href*="/artist/"]', '[data-testid="now-playing-artist"]']).map(nodeText)), href: attr(titleNode, 'href') || attr(query(titleNode, ['a[href]']), 'href') || attr(query(root, ['a[href*="/song/"]', 'a[href*="?i="]', 'a[href*="&i="]']), 'href'), state: stateFromButton(document, ['[data-testid="play-pause"]', '.web-chrome-playback-controls__playback-btn', 'button[aria-label="Pause"]', 'button[aria-label="Play"]']), isAd: false };
  }
  function read(document, location, metadata) {
    let page;
    try { page = new URL(typeof location === 'string' ? location : location.href); } catch (_) { return null; }
    const source = page.protocol === 'https:' && !page.port ? hosts[page.hostname] : null;
    if (!source || page.username || page.password) return null;
    const media = mediaInfo(metadata);
    const dom = source === 'youtube-music' ? youtube(document) : source === 'spotify' ? spotify(document) : apple(document);
    if (dom.nonMusic) return null;
    if (!dom.title && !media.title) return null;
    // A partially updated player must not combine a new title with the previous song's artist.
    const domArtistNames = cleanArtistNames(dom.artistNames);
    const knownMediaArtist = !!media.artist && domArtistNames.some(name => sameArtist(name, media.artist));
    const mainArtistAgrees = !!media.artist && (sameArtist(dom.artist, media.artist) || knownMediaArtist);
    const featuredAlias = mainArtistAgrees ? featuredTitleAlias(dom.title, media.title) : null;
    // When the two corroborated sources differ only by that featured credit,
    // the bare title is the song name sent to Echo and shown for review.
    const title = featuredAlias?.title || dom.title || media.title;
    const alignedMedia = !!dom.title && (same(dom.title, media.title) || !!featuredAlias);
    const conflict = !!dom.title && !!media.title && !alignedMedia;
    const artist = conflict ? '' : dom.artist || (alignedMedia || !dom.title ? media.artist : '');
    // A featured credit is one exact candidate; punctuation inside it never
    // creates guessed individual artists or splits a band name.
    const featuredArtists = conflict || !featuredAlias ? [] : cleanArtistNames([featuredAlias.credit]);
    const artistNames = conflict ? [] : cleanArtistNames([...domArtistNames, ...featuredArtists]);
    const mediaKnownArtist = alignedMedia && knownMediaArtist;
    const artistConflict = !!dom.artist && alignedMedia && !!media.artist && !sameArtist(dom.artist, media.artist) && !mediaKnownArtist;
    const isAd = !!dom.isAd || adLabel(title);
    const state = media.nativeState && media.state !== 'unknown' ? media.state : dom.state !== undefined && dom.state !== 'unknown' ? dom.state : media.state || 'unknown';
    const url = safeUrl(dom.href, page, source);
    const result = { source, title, artist, artistNames, featuredArtists, album: dom.album || (alignedMedia || !dom.title ? media.album : '') || '', trackId: idFromUrl(dom.href ? url : source === 'youtube-music' ? url : '', source), url, state, isAd, confidence: dom.title && artist && !conflict && !artistConflict && !isAd && (dom.artistExact || alignedMedia && (sameArtist(artist, media.artist) || mediaKnownArtist)) ? 'high' : 'review' };
    if (media.durationMs > 0) result.durationMs = media.durationMs;
    if (media.positionMs !== null && media.positionMs !== undefined) result.positionMs = media.positionMs;
    return result;
  }
  function control(document, location, action, stateHint = 'unknown') {
    if (!['play', 'pause', 'next'].includes(action)) return { ok: false, message: 'Choose Play, Pause or Next.' };
    let page;
    try { page = new URL(typeof location === 'string' ? location : location.href); } catch (_) { return { ok: false, message: 'Open a supported music website.' }; }
    const source = page.protocol === 'https:' && !page.port && !page.username && !page.password ? hosts[page.hostname] : null;
    if (!source) return { ok: false, message: 'Open Apple Music, Spotify or YouTube Music.' };
    const scopes = source === 'youtube-music' ? ['ytmusic-player-bar'] : source === 'spotify' ? ['[data-testid="now-playing-bar"]', '.Root__now-playing-bar'] : ['.web-chrome-playback-controls', 'amp-playback-controls'];
    const scope = query(document, scopes);
    if (!scope) return { ok: false, message: 'The website’s music-player controls could not be found. Refresh the music tab.' };
    const playback = source === 'youtube-music' ? ['#play-pause-button'] : source === 'spotify' ? ['[data-testid="control-button-playpause"]'] : ['[data-testid="play-pause"]', '.web-chrome-playback-controls__playback-btn', 'button[aria-label="Pause"]', 'button[aria-label="Play"]'];
    const next = source === 'youtube-music' ? ['.next-button', '#next-button', 'yt-icon-button[title="Next"]', 'button[aria-label="Next"]'] : source === 'spotify' ? ['[data-testid="control-button-skip-forward"]'] : ['.web-chrome-playback-controls__next-btn', '[data-testid="next"]', '[data-testid="next-button"]', 'button[aria-label="Next"]', 'button[aria-label="Next track"]'];
    const observed = stateFromButton(scope, playback);
    const hintedState = playbackState(stateHint);
    const state = hintedState === 'unknown' ? observed : hintedState;
    const desired = action === 'play' ? 'playing' : 'paused';
    if (action !== 'next' && state === desired) return { ok: true, source, clicked: false, state };
    if (action !== 'next' && state === 'unknown') return { ok: false, message: 'The browser player’s current state is unclear. Refresh its song details and try again.' };
    const control = query(scope, action === 'next' ? next : playback);
    const button = query(control, ['button', '[role="button"]']) || control;
    if (!button || typeof button.click !== 'function' || button.disabled === true || button.hasAttribute?.('disabled') || attr(button, 'aria-disabled') === 'true' || control?.disabled === true || control?.hasAttribute?.('disabled') || attr(control, 'aria-disabled') === 'true') return { ok: false, message: action === 'next' ? 'The website’s Next control is unavailable.' : 'The website’s playback control is unavailable.' };
    try { button.click(); return { ok: true, source, clicked: true, state }; }
    catch (_) { return { ok: false, message: 'The music website did not accept that playback action.' }; }
  }
  globalThis.EchoSources = Object.freeze({ read, clean, mediaInfo, idFromUrl, control });
})();
