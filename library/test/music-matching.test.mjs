import test from 'node:test';
import assert from 'node:assert/strict';
import { getMusicRequestCandidates, comparePlayback } from '../music-matching.mjs';

const obvious = { id: 'trusted-search-id', title: 'OBVIOUS (feat. Hasan Raheem)', artist: 'Umair', requestArtist: 'Umair', durationMs: 200000 };
const playing = (title = 'OBVIOUS (feat. Hasan Raheem)', artist = 'Umair', extra = {}) => ({ state: 'PLAYING', title, artist, ...extra });

test('OBVIOUS candidates use the primary artist then the featured artist without changing display data', () => {
  const result = getMusicRequestCandidates(obvious);
  assert.deepEqual(result.map(track => track.requestArtist), ['Umair', 'Hasan Raheem']);
  assert.equal(result[1].title, 'OBVIOUS (feat. Hasan Raheem)');
  assert.equal(result[1].artist, 'Umair');
  assert.notEqual(result[0], obvious);
  assert.equal(obvious.requestArtist, 'Umair');
});

test('a learned preferred artist comes first, duplicates are removed, and candidate counts are bounded', () => {
  const track = { ...obvious, requestArtists: ['Hasan Raheem', 'Another Artist', 'Fourth Artist'] };
  assert.deepEqual(getMusicRequestCandidates(track, { preferredArtist: 'hasan raheem' }).map(item => item.requestArtist), ['hasan raheem', 'Umair', 'Another Artist']);
  assert.equal(getMusicRequestCandidates(track, { max: 999 }).length, 3);
  assert.equal(getMusicRequestCandidates(track, { max: 1 }).length, 1);
  assert.equal(getMusicRequestCandidates(track, { max: 0 }).length, 0);
  assert.deepEqual(getMusicRequestCandidates({ ...obvious, title: 'bad\nmetadata' }), []);
});

test('ordinary songs keep their primary artist and featured Baby still starts with Justin Bieber', () => {
  assert.deepEqual(getMusicRequestCandidates({ title: 'Ordinary Song', artist: 'Artist' }).map(item => item.requestArtist), ['Artist']);
  assert.deepEqual(getMusicRequestCandidates({ title: 'Baby (feat. Ludacris)', artist: 'Justin Bieber' }).map(item => item.requestArtist), ['Justin Bieber', 'Ludacris']);
});

test('band names and complete featured-artist phrases preserve punctuation', () => {
  assert.deepEqual(getMusicRequestCandidates({ title: 'September', artist: 'Earth, Wind & Fire' }).map(item => item.requestArtist), ['Earth, Wind & Fire']);
  assert.deepEqual(getMusicRequestCandidates({ title: 'Song [featuring Simon & Garfunkel]', artist: 'Artist' }).map(item => item.requestArtist), ['Artist', 'Simon & Garfunkel']);
  assert.deepEqual(getMusicRequestCandidates({ title: 'Song (ft. A, B & C)', artist: 'Artist' }).map(item => item.requestArtist), ['Artist', 'A, B & C']);
});

test('mixed guest and recording-version clauses are not treated as alternate artist names', () => {
  for (const title of ['Song (feat. Artist - Live)', 'Song [feat. Artist Remix]', 'Song (Acoustic featuring Artist)', 'Song (featuring Artist - Cover)']) {
    assert.deepEqual(getMusicRequestCandidates({ title, artist: 'Primary' }).map(item => item.requestArtist), ['Primary']);
  }
  assert.deepEqual(getMusicRequestCandidates({ title: 'Song (feat. Guest) (Live)', artist: 'Primary' }).map(item => item.requestArtist), ['Primary', 'Guest']);
});

test('a request through Hasan Raheem matches Echo metadata reporting the original Umair credit', () => {
  assert.equal(comparePlayback(obvious, playing(), { candidateArtists: ['Hasan Raheem'] }).verdict, 'match');
  assert.equal(comparePlayback({ ...obvious, requestArtist: 'Hasan Raheem' }, playing()).verdict, 'match');
  assert.equal(comparePlayback(obvious, playing('Obvious', 'Hasan Raheem')).verdict, 'match');
  assert.equal(comparePlayback(obvious, playing('Obvious', 'Umair feat. Hasan Raheem')).verdict, 'match');
  assert.equal(comparePlayback(obvious, playing('Obvious', 'Umair & Hasan Raheem')).verdict, 'mismatch', 'ambiguous joined names are not split without structured evidence');
});

test('matching ignores source and pure guest clauses but preserves live, remix, acoustic and cover versions', () => {
  const track = { title: 'Darmiyaan (From "Musafir Cafe")', artist: 'Rekha Bhardwaj' };
  assert.equal(comparePlayback(track, playing('darmiyaan', 'Rekha Bhardwaj')).verdict, 'match');
  for (const title of ['OBVIOUS (Live)', 'OBVIOUS - Remix', 'OBVIOUS (Acoustic)', 'OBVIOUS (Cover)', 'OBVIOUS (Unplugged)', 'OBVIOUS (Reprise)']) {
    assert.equal(comparePlayback(obvious, playing(title)).verdict, 'mismatch');
  }
  assert.equal(comparePlayback({ title: 'Song (Live)', artist: 'Artist' }, playing('Song', 'Artist')).verdict, 'mismatch');
  assert.equal(comparePlayback({ title: 'Song (feat. Guest - Remix)', artist: 'Artist' }, playing('Song', 'Artist')).verdict, 'mismatch');
});

test('same title with a wrong or partial artist does not count as success', () => {
  for (const artist of ['Another Artist', 'Umairish', 'Umair Khan']) assert.equal(comparePlayback(obvious, playing('OBVIOUS', artist)).verdict, 'mismatch');
  const band = { title: 'September', artist: 'Earth, Wind & Fire' };
  assert.equal(comparePlayback(band, playing('September', 'Earth, Wind & Fire')).verdict, 'match');
  assert.equal(comparePlayback(band, playing('September', 'Earth')).verdict, 'mismatch');
  assert.equal(comparePlayback({ title: 'Song', artist: 'Simon & Garfunkel' }, playing('Song', 'Simon')).verdict, 'mismatch');
});

test('known recording duration mismatches are rejected using the greater of five seconds or three percent', () => {
  assert.equal(comparePlayback(obvious, playing('OBVIOUS', 'Umair', { durationMs: 206000 })).verdict, 'match');
  assert.equal(comparePlayback(obvious, playing('OBVIOUS', 'Umair', { durationMs: 206001 })).verdict, 'mismatch');
  assert.equal(comparePlayback({ ...obvious, durationMs: 100000 }, playing('OBVIOUS', 'Umair', { durationMs: 105000 })).verdict, 'match');
  assert.equal(comparePlayback({ ...obvious, durationMs: 100000 }, playing('OBVIOUS', 'Umair', { durationMs: 105001 })).verdict, 'mismatch');
  assert.equal(comparePlayback(obvious, playing()).verdict, 'match', 'duration is optional when the player does not report it');
});

test('missing metadata, paused playback, and unknown state remain unconfirmed', () => {
  for (const player of [null, {}, { state: 'UNKNOWN' }, { state: 'PLAYING', title: 'OBVIOUS' }, { state: 'PLAYING', artist: 'Umair' }, playing('', 'Umair'), playing('OBVIOUS', ''), { ...playing(), state: 'PAUSED' }]) {
    assert.equal(comparePlayback(obvious, player).verdict, 'unknown');
  }
  assert.equal(comparePlayback(obvious, { ...playing(), state: 'STOPPED' }).verdict, 'mismatch');
  assert.equal(comparePlayback(obvious, playing('A different song', 'Umair')).verdict, 'mismatch');
});

test('Latin accents and punctuation normalize without deleting meaningful non-Latin marks', () => {
  assert.equal(comparePlayback({ title: 'Café — Song!', artist: 'Beyoncé' }, playing('Cafe Song', 'Beyonce')).verdict, 'match');
  assert.equal(comparePlayback({ title: 'गीत', artist: 'कलाकार' }, playing('गत', 'कलाकार')).verdict, 'mismatch');
  assert.equal(comparePlayback({ title: 'गीत', artist: 'कलाकार' }, playing('गीत', 'कलाकार')).verdict, 'match');
});


test('reported band names cannot be mistaken for one member by splitting punctuation or and', () => {
  const solo = { title: 'Song', artist: 'Simon' };
  for (const artist of ['Simon & Garfunkel', 'Simon and Garfunkel', 'Simon, Garfunkel']) {
    assert.equal(comparePlayback(solo, playing('Song', artist)).verdict, 'mismatch');
  }
  assert.equal(comparePlayback({ title: 'Song', artist: 'Simon & Garfunkel' }, playing('Song', 'Simon & Garfunkel')).verdict, 'match');
  assert.equal(comparePlayback({ title: 'Song', artist: 'Simon, Garfunkel' }, playing('Song', 'Simon, Garfunkel')).verdict, 'match');
  assert.equal(comparePlayback({ title: 'Song', artist: 'Earth' }, playing('Song', 'Earth, Wind & Fire')).verdict, 'mismatch');
  assert.equal(comparePlayback({ title: 'Song', artist: 'Earth, Wind & Fire' }, playing('Song', 'Earth, Wind & Fire feat. Guest')).verdict, 'match');
});

test('structured artist resources provide complete alternate names without splitting any band', () => {
  const track = { title: 'Song', artist: 'Primary, Earth, Wind & Fire', requestArtist: 'Primary', requestArtists: ['Primary', 'Earth, Wind & Fire'] };
  assert.deepEqual(getMusicRequestCandidates(track).map(candidate => candidate.requestArtist), ['Primary', 'Earth, Wind & Fire']);
  assert.equal(comparePlayback(track, playing('Song', 'Earth, Wind & Fire')).verdict, 'match');
  assert.equal(comparePlayback(track, playing('Song', 'Earth')).verdict, 'mismatch');
});


test('joined saved artist credits never precede or follow separately identified artists', () => {
  const track = { title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander, Arra Aria Khayal', requestArtists: ['Siri Xander', 'Arra Aria Khayal'] };
  for (const preferredArtist of [null, track.artist, 'Siri Xander & Arra Aria Khayal', 'Siri Xander and Arra Aria Khayal']) {
    assert.deepEqual(getMusicRequestCandidates(track, { preferredArtist }).map(item => item.requestArtist), ['Siri Xander', 'Arra Aria Khayal']);
  }
  assert.deepEqual(getMusicRequestCandidates(track, { preferredArtist: 'Arra Aria Khayal' }).map(item => item.requestArtist), ['Arra Aria Khayal', 'Siri Xander']);
  assert.equal(track.requestArtist, track.artist, 'request generation does not rewrite stored or displayed credits');
});

test('an individual primary artist does not fall back to the joined catalogue display', () => {
  const track = { title: 'Song', artist: 'Primary, Guest', requestArtist: 'Primary', requestArtists: ['Primary'] };
  assert.deepEqual(getMusicRequestCandidates(track).map(item => item.requestArtist), ['Primary']);
});


test('joined Echo credits match complete known artists across service separators without splitting bands', () => {
  const track = { title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander', requestArtists: ['Siri Xander', 'Arra Aria Khayal'] };
  assert.equal(comparePlayback(track, playing('Pesamale', 'Siri Xander & Arra Aria Khayal')).verdict, 'match');
  assert.equal(comparePlayback(track, playing('Pesamale', 'Siri Xander and Arra Aria Khayal')).verdict, 'match');
  assert.equal(comparePlayback(track, playing('Pesamale', 'Siri Xander & Unrelated Artist')).verdict, 'mismatch');
  const band = { title: 'Song', artist: 'Primary, Earth, Wind & Fire', requestArtist: 'Primary', requestArtists: ['Primary', 'Earth, Wind & Fire'] };
  assert.equal(comparePlayback(band, playing('Song', 'Primary & Earth, Wind & Fire')).verdict, 'match');
  assert.equal(comparePlayback(band, playing('Song', 'Primary & Earth')).verdict, 'mismatch');
  assert.equal(comparePlayback(band, playing('Song', 'Earth, Wind & Fire & Unknown')).verdict, 'mismatch');
});


test('a joined canonical variant uses the first whole artist resource instead', () => {
  const track = { title: 'Song', artist: 'Primary, Earth, Wind & Fire', requestArtist: 'Primary & Earth, Wind & Fire', requestArtists: ['Primary', 'Earth, Wind & Fire'] };
  assert.deepEqual(getMusicRequestCandidates(track).map(item => item.requestArtist), ['Primary', 'Earth, Wind & Fire']);
});
