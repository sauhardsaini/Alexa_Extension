import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSongTitle, songTitleLanguages } from '../library/song-title.mjs';
import { buildMusicCommand } from '../library/catalog.mjs';
import { comparePlayback, getMusicRequestCandidates } from '../library/music-matching.mjs';

const title = 'Veezha Veera (From "OM Chapter 1: Udhiram - The Blood Wood") [Tamil]';
const track = Object.freeze({ title, artist: 'Sai Abhyankkar, Tippu, Arun Srinivasan', requestArtist: 'Arun Srinivasan', requestArtists: Object.freeze(['Sai Abhyankkar', 'Tippu', 'Arun Srinivasan']), durationMs: 200000 });
const echo = (value = 'Veezha Veera', artist = 'Arun Srinivasan') => ({ state: 'PLAYING', title: value, artist, durationMs: 200000 });

test('Veezha Veera requests only the song name and selected single artist, without changing display metadata', () => {
  const command = buildMusicCommand(track, 'apple-music');
  assert.equal(command, 'play song Veezha Veera by Arun Srinivasan on Apple Music');
  assert.equal(command.toLowerCase(), 'play song veezha veera by arun srinivasan on apple music');
  assert.equal(track.title, title); assert.equal(track.requestArtists.length, 3);
  assert.equal(getMusicRequestCandidates(track)[0].requestArtist, 'Arun Srinivasan');
});

test('year-qualified backups share the clean song title while normal requests still omit the year', () => {
  assert.equal(buildMusicCommand({ ...track, releaseYear: 2026 }, 'apple-music'), 'play song Veezha Veera by Arun Srinivasan on Apple Music');
  assert.equal(buildMusicCommand({ ...track, requestYear: 2026 }, 'apple-music'), 'play song Veezha Veera 2026 by Arun Srinivasan on Apple Music');
  assert.equal(buildMusicCommand(track), 'play song Veezha Veera by Arun Srinivasan');
  assert.equal(buildMusicCommand(track, 'spotify'), 'play song Veezha Veera by Arun Srinivasan on Spotify');
});

test('language-only tags and quoted film credits are ignored when Echo reports the plain song name', () => {
  assert.equal(comparePlayback(track, echo()).verdict, 'match');
  assert.equal(comparePlayback(track, echo('Veezha Veera', 'Sai Abhyankkar, Tippu & Arun Srinivasan')).verdict, 'match');
  for (const suffix of ['[Tamil]', '(Hindi)', '(Telugu Version)', '[Malayalam Language Version]', '(Kannada Language)', '[Punjabi]', '[Bengali]', '[Gujarati]', '[Marathi]', '[Odia]', '[Urdu]', '[English]', '[Brazilian Portuguese]', '[Hindi and Tamil]']) {
    assert.equal(cleanSongTitle('Song ' + suffix), 'Song', suffix);
    assert.equal(comparePlayback({ title: 'Song ' + suffix, artist: 'Artist' }, echo('Song', 'Artist')).verdict, 'match', suffix);
  }
  for (const credit of ['(From "Film")', "(From 'Film')", '(From “Film”)', '[From Film]', '[From "Film"]']) assert.equal(cleanSongTitle('Song ' + credit + ' [Tamil]'), 'Song', credit);
});

test('recording versions, duets, and meaningful parentheticals remain in requests and verification', () => {
  for (const suffix of ['(Live)', '[Remix]', '(Acoustic)', '(Unplugged)', '(Reprise)', '(Cover)', '(Male Version)', '[Duet]', '(Tamil Remix)', '[Hindi Live]', '(Do Not Leave Me)']) {
    const selected = { title: 'Song [Tamil] ' + suffix, artist: 'Artist' };
    assert.equal(cleanSongTitle(selected.title), 'Song ' + suffix, suffix);
    assert.equal(buildMusicCommand(selected), 'play song Song ' + suffix + ' by Artist');
    assert.equal(comparePlayback(selected, echo('Song', 'Artist')).verdict, 'mismatch', suffix);
  }
  assert.match(cleanSongTitle('Song [From "Film" - Live]'), /Live/u);
  assert.equal(cleanSongTitle('Tamil'), 'Tamil', 'a language name in the actual title is not a metadata tag');
});

test('Taylor’s Version remains explicit while independent language tags are removed', () => {
  const selected = { title: "Shake It Off (Taylor's Version) [English]", album: "1989 (Taylor's Version)", artist: 'Taylor Swift' };
  assert.equal(buildMusicCommand(selected, 'apple-music'), "play song Shake It Off (Taylor's Version) by Taylor Swift on Apple Music");
  assert.equal(comparePlayback(selected, { state: 'PLAYING', title: 'Shake It Off', artist: 'Taylor Swift', album: "1989 (Taylor's Version)" }).verdict, 'match');
  assert.equal(comparePlayback(selected, { state: 'PLAYING', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989' }).verdict, 'mismatch');
});

test('guest credits remain available as artists while pure guest-title noise is removed', () => {
  const selected = { title: 'Song (feat. Guest) [Hindi]', artist: 'Primary' };
  assert.equal(buildMusicCommand(selected), 'play song Song by Primary');
  assert.deepEqual(getMusicRequestCandidates(selected).map(item => item.requestArtist), ['Primary', 'Guest']);
  for (const suffix of ['(feat. Guest - Live)', '[featuring Guest Remix]', '(featuring Guest - Cover)']) assert.equal(cleanSongTitle('Song ' + suffix + ' [Hindi]'), 'Song ' + suffix);
});

test('explicit conflicting language evidence remains a mismatch while missing language evidence is allowed', () => {
  assert.deepEqual(songTitleLanguages('Song [Bangla] (Tamil Version)'), ['bengali', 'tamil']);
  assert.equal(comparePlayback({ title: 'Song [Tamil]', artist: 'Artist' }, echo('Song [Hindi]', 'Artist')).verdict, 'mismatch');
  assert.equal(comparePlayback({ title: 'Song [Tamil and Hindi]', artist: 'Artist' }, echo('Song [Hindi]', 'Artist')).verdict, 'match');
  assert.equal(comparePlayback({ title: 'Song [Tamil]', artist: 'Artist' }, echo('Song', 'Artist')).verdict, 'match');
  assert.equal(comparePlayback({ title: 'Song [Odia]', artist: 'Artist' }, echo('Song [Oriya]', 'Artist')).verdict, 'match');
});

test('cleaning never turns missing song metadata into a year-only or version-only request', () => {
  for (const value of ['[Tamil]', '(Hindi Version)', '(From "Film") [Tamil]', '(feat. Guest) [Tamil]']) assert.throws(() => buildMusicCommand({ title: value, artist: 'Artist', requestYear: 2026 }), { code: 'INVALID_TRACK' });
  assert.equal(cleanSongTitle(null), ''); assert.deepEqual(songTitleLanguages(undefined), []);
});
