import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const context = vm.createContext({ URL, URLSearchParams });
vm.runInContext(await fs.readFile(new URL('../extension/sources.js', import.meta.url), 'utf8'), context);
const { read, mediaInfo } = context.EchoSources;
const node = (textContent = '', attributes = {}, children = {}) => ({ textContent, getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name), querySelector: selector => children[selector] || null });
const doc = entries => node('', {}, entries);
const plain = value => JSON.parse(JSON.stringify(value));
function youtube({ title = 'Lover', artist = 'Taylor Swift', label = 'Pause', attributes = {}, bylineArtist = false } = {}) {
  const artistNode = node(artist);
  const byline = node(artist, {}, bylineArtist ? {} : { 'a[href*="/channel/"]': artistNode });
  const root = node('', attributes, { '.content-info-wrapper .title': node(title), '.byline.ytmusic-player-bar': byline, '#play-pause-button': node('', { 'aria-label': label }) });
  return doc({ 'ytmusic-player-bar': root });
}
const ytmUrl = 'https://music.youtube.com/watch?v=123456789ab&list=private-list&secret=discard';

test('only the three exact HTTPS music hosts are eligible', () => {
  for (const url of ['https://music.youtube.com.evil.test/watch?v=123456789ab', 'http://music.youtube.com/', 'https://open.spotify.com:444/', 'https://youtube.com/', 'https://music.apple.com@evil.test/']) {
    assert.equal(read(doc({}), url, { title: 'Lover', artist: 'Taylor Swift' }), null);
  }
});
test('scoped YouTube Music player yields stable title, artist and video id', () => {
  const result = plain(read(youtube(), ytmUrl));
  assert.equal(result.source, 'youtube-music'); assert.equal(result.title, 'Lover'); assert.equal(result.artist, 'Taylor Swift');
  assert.equal(result.trackId, '123456789ab'); assert.equal(result.state, 'playing'); assert.equal(result.confidence, 'high');
  assert.equal(result.url, 'https://music.youtube.com/watch?v=123456789ab');
});
test('an ad is visible for review but never eligible for follow', () => {
  const result = read(youtube({ attributes: { 'is-ad': '' } }), ytmUrl);
  assert.equal(result.isAd, true); assert.equal(result.confidence, 'review');
  assert.equal(read(youtube({ attributes: { 'is-ad': 'false' } }), ytmUrl).isAd, false);
});
test('missing artist preserves partial metadata for manual correction', () => {
  const result = read(youtube({ artist: '' }), ytmUrl);
  assert.equal(result.title, 'Lover'); assert.equal(result.artist, ''); assert.equal(result.confidence, 'review');
});
test('versions and complete artist names are preserved verbatim', () => {
  const result = read(youtube({ title: 'Lover (Live From Paris)', artist: 'Earth, Wind & Fire' }), ytmUrl);
  assert.equal(result.title, 'Lover (Live From Paris)'); assert.equal(result.artist, 'Earth, Wind & Fire');
});
test('conflicting media-session and DOM titles cannot combine different songs', () => {
  const result = read(youtube({ title: 'New song', artist: 'Old artist' }), ytmUrl, { title: 'Old song', artist: 'Old artist', state: 'playing' });
  assert.equal(result.title, 'New song'); assert.equal(result.artist, ''); assert.equal(result.confidence, 'review');
});
test('conflicting artists downgrade otherwise matching titles', () => {
  const result = read(youtube(), ytmUrl, { title: 'Lover', artist: 'Different artist' });
  assert.equal(result.artist, 'Taylor Swift'); assert.equal(result.confidence, 'review');
});
test('unstructured byline requires matching media-session corroboration', () => {
  const document = youtube({ artist: 'Taylor Swift • Lover • 2019', bylineArtist: true });
  assert.equal(read(document, ytmUrl).confidence, 'review');
  const result = read(document, ytmUrl, { title: 'Lover', artist: 'Taylor Swift' });
  assert.equal(result.artist, 'Taylor Swift'); assert.equal(result.confidence, 'high');
});
test('media-session-only detection is review-only and does not use document title', () => {
  const document = doc({}); document.title = 'Unrelated page title';
  const result = read(document, 'https://music.apple.com/in/browse', { title: 'Lover', artist: 'Taylor Swift', state: 'paused' });
  assert.equal(result.title, 'Lover'); assert.equal(result.state, 'paused'); assert.equal(result.confidence, 'review'); assert.equal(result.trackId, '');
  assert.equal(read(document, 'https://music.apple.com/in/browse', {}), null);
});
test('hostile or overlong text does not pass through as song metadata', () => {
  assert.equal(read(doc({}), 'https://music.apple.com/', { title: 'x'.repeat(251), artist: 'a' }), null);
  const result = read(doc({}), 'https://music.apple.com/', { title: 'Fine title', artist: 'bad\u0000artist', album: 'x'.repeat(251) });
  assert.equal(result.artist, ''); assert.equal(result.album, ''); assert.equal(result.confidence, 'review');
});
test('Spotify requires now-playing scope and distinguishes podcast episodes', () => {
  const titleNode = node('Lover', { href: '/track/1234567890123456789012?si=tracking' });
  const root = node('', {}, { '[data-testid="context-item-info-title"]': titleNode, '[data-testid="context-item-info-artist"]': node('Taylor Swift') });
  const document = doc({ '[data-testid="now-playing-widget"]': root, '[data-testid="control-button-playpause"]': node('', { 'aria-label': 'Pause' }) });
  const result = read(document, 'https://open.spotify.com/playlist/not-current');
  assert.equal(result.trackId, '1234567890123456789012'); assert.equal(result.confidence, 'high'); assert.equal(result.url, 'https://open.spotify.com/track/1234567890123456789012');
  const episodeRoot = node('', {}, { '[data-testid="context-item-info-title"]': node('Episode', { href: '/episode/1234567890123456789012' }) });
  assert.equal(read(doc({ '[data-testid="now-playing-widget"]': episodeRoot }), 'https://open.spotify.com/'), null);
  assert.equal(read(doc({ 'a[href*="/track/"]': titleNode }), 'https://open.spotify.com/'), null);
});
test('Apple player preserves song identity but strips unrelated URL parameters', () => {
  const titleNode = node('Lover', { href: '/in/album/lover/1468058165?i=1468058173&tracking=private' });
  const root = node('', {}, { '.web-chrome-playback-lcd__song-name': titleNode, '[data-testid="now-playing-artist"]': node('Taylor Swift') });
  const result = read(doc({ '.web-chrome-playback-lcd': root }), 'https://music.apple.com/in/browse');
  assert.equal(result.trackId, '1468058173'); assert.equal(result.confidence, 'high'); assert.equal(result.url, 'https://music.apple.com/in/album/lover/1468058165?i=1468058173');
});
test('progress is retained for repeat detection, unknown or absurd timing is dropped', () => {
  const result = read(youtube(), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', positionMs: 1200.4, durationMs: 220000 });
  assert.equal(result.positionMs, 1200); assert.equal(result.durationMs, 220000);
  const invalid = plain(mediaInfo({ title: 'Lover', positionMs: NaN, durationMs: 90000000 }));
  assert.equal(invalid.positionMs, null); assert.equal(invalid.durationMs, null);
});
test('paused UI takes precedence over stale playing media-session state', () => {
  const result = read(youtube({ label: 'Play' }), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', state: 'playing' });
  assert.equal(result.state, 'paused');
});


// DOM-shaped fixtures use real tags, attributes and text-node order. This small
// selector subset lets regressions exercise actual relative hrefs and nesting.
function element(tagName, attributes = {}, ...children) {
  const item = { tagName: tagName.toLowerCase(), parent: null, children, getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name) };
  for (const child of children) if (typeof child !== 'string') child.parent = item;
  Object.defineProperty(item, 'textContent', { get: () => children.map(child => typeof child === 'string' ? child : child.textContent).join('') });
  function compound(candidate, selector) {
    if (!candidate || selector.includes(':')) return false;
    let rest = selector;
    const tag = /^[a-z][\w-]*/i.exec(rest)?.[0];
    if (tag && tag.toLowerCase() !== candidate.tagName) return false;
    if (tag) rest = rest.slice(tag.length);
    let matches = true;
    rest = rest.replace(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g, (_all, name, op, value) => {
      const actual = candidate.getAttribute(name);
      if (actual === null || op === '=' && actual !== value || op === '^=' && !actual.startsWith(value) || op === '*=' && !actual.includes(value)) matches = false;
      return '';
    });
    rest = rest.replace(/\.([\w-]+)/g, (_all, name) => { if (!(candidate.getAttribute('class') || '').split(/\s+/).includes(name)) matches = false; return ''; });
    rest = rest.replace(/#([\w-]+)/g, (_all, name) => { if (candidate.getAttribute('id') !== name) matches = false; return ''; });
    return matches && !rest.trim();
  }
  function matches(candidate, selector) {
    const parts = selector.trim().split(/\s+(?![^\[]*\])/); let cursor = candidate;
    if (!compound(cursor, parts.pop())) return false;
    while (parts.length) { const part = parts.pop(); cursor = cursor.parent; while (cursor && !compound(cursor, part)) cursor = cursor.parent; if (!cursor) return false; }
    return true;
  }
  item.querySelectorAll = selectors => {
    const results = [], alternatives = selectors.split(',').map(value => value.trim());
    const visit = parent => { for (const child of parent.children) if (typeof child !== 'string') { if (alternatives.some(selector => matches(child, selector))) results.push(child); visit(child); } };
    visit(item); return results;
  };
  item.querySelector = selector => item.querySelectorAll(selector)[0] || null;
  return item;
}
function liveYoutube({ title = 'Banda Kaam Ka', separators = [], nestedLabel = 'Play', parentTitle = 'Play', artists = ['Chaar Diwaari', 'Sanjith Hegde'], linked = artists, slash = false } = {}) {
  const prefix = slash ? '/' : '';
  const bylineChildren = [];
  for (let i = 0; i < artists.length; i++) {
    if (i) bylineChildren.push(separators[i - 1] || ' & ');
    bylineChildren.push(linked.includes(artists[i]) ? element('a', { href: prefix + 'channel/' + (i ? 'UCGCzMLhz0ucUUACQAHw-rmg' : 'UCMcnoDQxbY2Esd3E0NmJ9Bg') }, artists[i]) : artists[i]);
  }
  bylineChildren.push(' • ', element('a', { href: prefix + 'browse/MPREb_BAgEZAJCF56' }, title), ' • 2025');
  return element('document', {}, element('ytmusic-player-bar', {},
    element('div', { class: 'content-info-wrapper' }, element('yt-formatted-string', { class: 'title ytmusic-player-bar' }, title), element('span', { class: 'byline ytmusic-player-bar' }, ...bylineChildren)),
    element('yt-icon-button', { id: 'play-pause-button', title: parentTitle }, element('button', nestedLabel ? { 'aria-label': nestedLabel } : {}))
  ));
}
test('live YTM DOM keeps full collaboration credit from relative artist and album links', () => {
  const result = read(liveYoutube(), ytmUrl, { title: 'Banda Kaam Ka', artist: 'Chaar Diwaari & Sanjith Hegde', state: 'playing' });
  assert.equal(result.title, 'Banda Kaam Ka'); assert.equal(result.artist, 'Chaar Diwaari & Sanjith Hegde');
  assert.equal(result.album, 'Banda Kaam Ka'); assert.equal(result.confidence, 'high'); assert.equal(result.state, 'paused');
});
test('YTM nested button aria-label is read, with parent title as fallback', () => {
  assert.equal(read(liveYoutube({ nestedLabel: 'Pause', parentTitle: 'Play' }), ytmUrl).state, 'playing');
  assert.equal(read(liveYoutube({ nestedLabel: '', parentTitle: 'Pause' }), ytmUrl).state, 'playing');
});
test('YTM slash-prefixed links and band punctuation retain their complete credits', () => {
  const result = read(liveYoutube({ slash: true, artists: ['Earth, Wind & Fire', 'Another Artist'] }), ytmUrl);
  assert.equal(result.artist, 'Earth, Wind & Fire & Another Artist'); assert.equal(result.confidence, 'high');
});
test('an unlinked part of a collaboration remains intact and requires review', () => {
  const result = read(liveYoutube({ linked: ['Chaar Diwaari'] }), ytmUrl);
  assert.equal(result.artist, 'Chaar Diwaari & Sanjith Hegde'); assert.equal(result.confidence, 'review');
});

test('known structured artist reported alone corroborates a complete collaboration credit', () => {
  const result = read(liveYoutube({ nestedLabel: 'Pause', parentTitle: 'Pause' }), ytmUrl, { title: 'Banda Kaam Ka', artist: 'Sanjith Hegde', state: 'playing' });
  assert.deepEqual(plain(result.artistNames), ['Chaar Diwaari', 'Sanjith Hegde']);
  assert.equal(result.artist, 'Chaar Diwaari & Sanjith Hegde'); assert.equal(result.confidence, 'high');
});
test('Raazi keeps two linked artists and its unlinked third credit without inventing candidates', () => {
  const document = liveYoutube({ title: 'Raazi', artists: ['Denny', 'Sanah Moidutty', 'Shloke Lal'], linked: ['Denny', 'Sanah Moidutty'], separators: [', ', ' & '], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const withoutMedia = read(document, ytmUrl);
  assert.equal(withoutMedia.confidence, 'review');
  const result = read(document, ytmUrl, { title: 'Raazi', artist: 'Denny', state: 'playing' });
  assert.equal(result.artist, 'Denny, Sanah Moidutty & Shloke Lal');
  assert.deepEqual(plain(result.artistNames), ['Denny', 'Sanah Moidutty']); assert.equal(result.confidence, 'high'); assert.equal(result.state, 'playing');
  assert.equal(read(document, ytmUrl, { title: 'Raazi', artist: 'Unrelated Artist' }).confidence, 'review');
});
test('a single joint credit or band link is preserved rather than split at punctuation', () => {
  for (const artist of ['Hardik Bhardwaj & Scxtch', 'Earth, Wind & Fire', 'Simon & Garfunkel']) {
    const result = read(liveYoutube({ title: 'Madira', artists: [artist] }), ytmUrl);
    assert.equal(result.artist, artist); assert.deepEqual(plain(result.artistNames), [artist]);
  }
});
test('a title transition clears structured credits from the previous track', () => {
  const result = read(liveYoutube(), ytmUrl, { title: 'Previous Song', artist: 'Old Artist' });
  assert.deepEqual(plain(result.artistNames), []); assert.equal(result.artist, ''); assert.equal(result.confidence, 'review');
});

test('Kaafi Hai Na preserves exact linked credits across an unlinked middle artist', () => {
  const artists = ['Priyansh Srivastava', 'Jonita Gandhi', 'Garvit-Priyansh', 'Aniket Shukla'];
  const document = liveYoutube({ title: 'Kaafi Hai Na', artists, linked: [artists[0], artists[2], artists[3]], separators: [', ', ', ', ' & '], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'Kaafi Hai Na', artist: 'Priyansh Srivastava', state: 'playing' });
  assert.equal(result.artist, 'Priyansh Srivastava, Jonita Gandhi, Garvit-Priyansh & Aniket Shukla');
  assert.deepEqual(plain(result.artistNames), ['Priyansh Srivastava', 'Garvit-Priyansh', 'Aniket Shukla']);
  assert.equal(result.confidence, 'high'); assert.equal(result.state, 'playing');
});
test('confirmed separate Madira artist links remain separate ordered retry candidates', () => {
  const document = liveYoutube({ title: 'Madira', artists: ['Hardik Bhardwaj', 'Scxtch'], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'Madira', artist: 'Hardik Bhardwaj', state: 'playing' });
  assert.equal(result.artist, 'Hardik Bhardwaj & Scxtch'); assert.deepEqual(plain(result.artistNames), ['Hardik Bhardwaj', 'Scxtch']); assert.equal(result.confidence, 'high');
});
test('partial artist-name substrings are not promoted to standalone retry candidates', () => {
  const document = element('document', {}, element('ytmusic-player-bar', {},
    element('div', { class: 'content-info-wrapper' }, element('span', { class: 'title ytmusic-player-bar' }, 'Song'), element('span', { class: 'byline ytmusic-player-bar' }, element('a', { href: 'channel/UCtest' }, 'Ali'), 'na • Album • 2026'))
  ));
  const result = read(document, ytmUrl);
  assert.equal(result.artist, 'Alina'); assert.deepEqual(plain(result.artistNames), []); assert.equal(result.confidence, 'review');
});

test('live YTM Next uses its class and nested button when the wrapper has no id', () => {
  const clicks = [];
  const button = element('button', { id: 'button', 'aria-label': 'Next' }); button.click = () => clicks.push('player next');
  const next = element('yt-icon-button', { class: 'next-button style-scope ytmusic-player-bar', title: 'Next' }, button);
  const unrelated = element('button', { 'aria-label': 'Next' }); unrelated.click = () => clicks.push('wrong global next');
  const document = element('document', {}, unrelated, element('ytmusic-player-bar', {}, next));
  const result = context.EchoSources.control(document, ytmUrl, 'next');
  assert.equal(result.ok, true); assert.equal(result.clicked, true); assert.deepEqual(clicks, ['player next']);
});


test('Lihaaz full linked credit tolerates Media Session spelling its ampersand as and', () => {
  const artists = ['Abhijeet Srivastava', 'Shayra Apoorva', 'Samyak Prasana'];
  const document = liveYoutube({ title: 'Lihaaz', artists, separators: [', ', ' & '], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'Lihaaz', artist: 'Abhijeet Srivastava, Shayra Apoorva and Samyak Prasana', state: 'playing' });
  assert.equal(result.confidence, 'high'); assert.equal(result.state, 'playing');
  assert.equal(result.artist, 'Abhijeet Srivastava, Shayra Apoorva & Samyak Prasana');
  assert.deepEqual(plain(result.artistNames), artists);
});
test('Tum Se Hi keeps all linked credits when Media Session uses and', () => {
  const artists = ['Pritam', 'Mohit Chauhan', 'Irshad Kamil'];
  const document = liveYoutube({ title: 'Tum Se Hi', artists, separators: [', ', ' & '], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'Tum Se Hi', artist: 'Pritam, Mohit Chauhan and Irshad Kamil', state: 'playing' });
  assert.equal(result.confidence, 'high'); assert.equal(result.artist, 'Pritam, Mohit Chauhan & Irshad Kamil');
  assert.deepEqual(plain(result.artistNames), artists);
  assert.equal(read(document, ytmUrl, { title: 'Tum Se Hi', artist: 'Pritam, Mohit Chauhan and Different Artist', state: 'playing' }).confidence, 'review');
});
test('band ampersand and word-and aliases agree but a missing conjunction conflicts', () => {
  for (const [display, media] of [['Florence & the Machine', 'Florence and the Machine'], ['Florence and the Machine', 'Florence & the Machine']]) {
    const document = liveYoutube({ title: 'Song', artists: [display], nestedLabel: 'Pause', parentTitle: 'Pause' });
    const result = read(document, ytmUrl, { title: 'Song', artist: media, state: 'playing' });
    assert.equal(result.confidence, 'high'); assert.equal(result.artist, display);
    assert.deepEqual(plain(result.artistNames), [display]);
    assert.equal(read(document, ytmUrl, { title: 'Song', artist: 'Florence the Machine', state: 'playing' }).confidence, 'review');
  }
});
test('an exact linked band alias corroborates a collaboration without splitting its name', () => {
  const document = liveYoutube({ title: 'Song', artists: ['Earth, Wind & Fire', 'Another Artist'], linked: ['Earth, Wind & Fire'], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'Song', artist: 'Earth, Wind and Fire', state: 'playing' });
  assert.equal(result.confidence, 'high'); assert.equal(result.artist, 'Earth, Wind & Fire & Another Artist');
  assert.deepEqual(plain(result.artistNames), ['Earth, Wind & Fire']);
});
test('artist conjunction aliases do not broaden title matching', () => {
  const result = read(liveYoutube({ title: 'You & Me', artists: ['Artist'] }), ytmUrl, { title: 'You and Me', artist: 'Artist', state: 'playing' });
  assert.equal(result.confidence, 'review'); assert.equal(result.artist, '');
});


test('BANNI uses its bare corroborated song name when DOM adds a featured-credit annotation', () => {
  const artists = ['Aneesh', 'Krtin Kay', 'Kunnu'];
  const title = 'BANNI (feat. Gargei Lavekar)';
  const document = liveYoutube({ title, artists, separators: [', ', ' & '], nestedLabel: 'Pause', parentTitle: 'Pause' });
  const result = read(document, ytmUrl, { title: 'BANNI', artist: 'Aneesh, Krtin Kay and Kunnu', state: 'playing' });
  assert.equal(result.title, 'BANNI'); assert.equal(result.artist, 'Aneesh, Krtin Kay & Kunnu');
  assert.deepEqual(plain(result.artistNames), [...artists, 'Gargei Lavekar']);
  assert.deepEqual(plain(result.featuredArtists), ['Gargei Lavekar']); assert.equal(result.confidence, 'high'); assert.equal(result.state, 'playing');
});
test('a trailing featured annotation matches either side only with corroborated main artist credits', () => {
  for (const annotation of ['(feat. Guest Artist)', '(ft. Guest Artist)', '[featuring Guest Artist]']) {
    const fullTitle = 'Song ' + annotation;
    const document = liveYoutube({ title: fullTitle, artists: ['First Artist', 'Second Artist'], nestedLabel: 'Pause', parentTitle: 'Pause' });
    const result = read(document, ytmUrl, { title: 'Song', artist: 'Second Artist', state: 'playing' });
    assert.equal(result.confidence, 'high'); assert.equal(result.title, 'Song');
    assert.deepEqual(plain(result.featuredArtists), ['Guest Artist']);
    assert.deepEqual(plain(result.artistNames), ['First Artist', 'Second Artist', 'Guest Artist']);
    for (const artist of ['', 'Unrelated Artist']) {
      const conflict = read(document, ytmUrl, { title: 'Song', artist, state: 'playing' });
      assert.equal(conflict.confidence, 'review'); assert.equal(conflict.artist, ''); assert.deepEqual(plain(conflict.artistNames), []);
    }
    const reverse = read(liveYoutube({ title: 'Song', artists: ['Artist'] }), ytmUrl, { title: fullTitle, artist: 'Artist' });
    assert.equal(reverse.confidence, 'high'); assert.equal(reverse.title, 'Song');
    assert.deepEqual(plain(reverse.featuredArtists), ['Guest Artist']); assert.deepEqual(plain(reverse.artistNames), ['Artist', 'Guest Artist']);
  }
});
test('different featured artists remain a conflicting title even when the main artist agrees', () => {
  const result = read(liveYoutube({ title: 'Song (feat. First Guest)', artists: ['Artist'] }), ytmUrl, { title: 'Song (feat. Different Guest)', artist: 'Artist' });
  assert.equal(result.confidence, 'review'); assert.equal(result.artist, '');
});
test('featured annotations never remove recording versions, nested groups or mixed suffixes', () => {
  const cases = [
    ['Song (Live)', 'Song'], ['Song (Remix)', 'Song'], ['Song (Acoustic)', 'Song'], ['Song (Radio Edit)', 'Song'],
    ['Song (Live) (feat. Guest)', 'Song (Live)'], ['Song (feat. Guest) (Live)', 'Song'],
    ['Song (feat. Guest (Live))', 'Song'], ['Song (Live feat. Guest)', 'Song'],
    ['Song (feat. Guest - Remix)', 'Song'], ['Song [ft. Guest - Acoustic]', 'Song'],
    ['Song (feat. Guest - Instrumental)', 'Song'], ['Song (feat. Guest - Remastered)', 'Song'],
    ['Song - Live (feat. Guest)', 'Song'], ['Song (feat. Guest]', 'Song']
  ];
  for (const [title, mediaTitle] of cases) {
    const result = read(liveYoutube({ title, artists: ['Artist'] }), ytmUrl, { title: mediaTitle, artist: 'Artist' });
    assert.equal(result.confidence, 'review', title + ' / ' + mediaTitle); assert.equal(result.artist, '', title);
  }
});


test('matching exact titles retain their featured annotation without a one-sided alias', () => {
  const title = 'Song (feat. Guest Artist)';
  const result = read(liveYoutube({ title, artists: ['Artist'] }), ytmUrl, { title, artist: 'Artist' });
  assert.equal(result.title, title); assert.equal(result.confidence, 'high');
});


test('featured band credits remain one exact candidate and separately linked duplicates are not repeated', () => {
  const featured = 'Earth, Wind & Fire';
  const document = liveYoutube({ title: 'Song (feat. ' + featured + ')', artists: ['Main Artist', featured] });
  const result = read(document, ytmUrl, { title: 'Song', artist: 'Main Artist' });
  assert.equal(result.title, 'Song'); assert.equal(result.artist, 'Main Artist & Earth, Wind & Fire');
  assert.deepEqual(plain(result.artistNames), ['Main Artist', featured]); assert.deepEqual(plain(result.featuredArtists), [featured]);
});
test('unvalidated featured annotations cannot add featured artists or retry candidates', () => {
  const document = liveYoutube({ title: 'Song (feat. Guest)', artists: ['Main Artist'] });
  for (const metadata of [{ title: 'Song', artist: 'Other Artist' }, { title: 'Song (feat. Different Guest)', artist: 'Main Artist' }, { title: 'Song (feat. Guest)', artist: 'Main Artist' }]) {
    const result = read(document, ytmUrl, metadata);
    assert.deepEqual(plain(result.featuredArtists), []);
    assert.equal(result.artistNames.includes('Guest'), false);
  }
});

test('paused source snapshots keep a valid current media position and duration for an Echo handoff', () => {
  const result = read(youtube({ label: 'Play' }), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', state: 'paused', positionMs: 1250, durationMs: 221000 });
  assert.equal(result.state, 'paused'); assert.equal(result.positionMs, 1250); assert.equal(result.durationMs, 221000); assert.equal(result.confidence, 'high');
});


test('actual loaded-media state wins over a lagging player label while untagged session state does not', () => {
  assert.equal(read(youtube({ label: 'Pause' }), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', state: 'paused', nativeState: true }).state, 'paused');
  assert.equal(read(youtube({ label: 'Play' }), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', state: 'playing', nativeState: true }).state, 'playing');
  assert.equal(read(youtube({ label: 'Pause' }), ytmUrl, { title: 'Lover', artist: 'Taylor Swift', state: 'paused' }).state, 'playing');
});
