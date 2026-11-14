import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrack } from '../extension/protocol.mjs';
const url = 'https://music.youtube.com/watch?v=abcdefghijk';
const track = { source: 'youtube-music', title: 'Raazi', artist: 'Denny, Sanah Moidutty & Shloke Lal', artistNames: ['Denny', 'Sanah Moidutty'], state: 'playing', confidence: 'high' };
test('protocol preserves bounded structured artists without changing canonical credits', () => {
  const result = normalizeTrack(track, url);
  assert.equal(result.artist, track.artist); assert.deepEqual(result.artistNames, ['Denny', 'Sanah Moidutty']);
});
test('structured artist names reject unsafe entries, deduplicate and remain bounded', () => {
  const result = normalizeTrack({ ...track, artistNames: ['Denny', 'DENNY', null, 'bad\nname', 'x'.repeat(251), 'Sanah Moidutty'] }, url);
  assert.deepEqual(result.artistNames, ['Denny', 'Sanah Moidutty']);
  assert.equal(normalizeTrack({ ...track, artistNames: Array.from({ length: 30 }, (_, i) => 'Artist ' + i) }, url).artistNames.length, 12);
});
test('a single band credit remains one artist and no candidates are inferred from a string', () => {
  assert.deepEqual(normalizeTrack({ ...track, artist: 'Earth, Wind & Fire', artistNames: ['Earth, Wind & Fire'] }, url).artistNames, ['Earth, Wind & Fire']);
  assert.deepEqual(normalizeTrack({ ...track, artistNames: 'Denny & Sanah Moidutty' }, url).artistNames, []);
  assert.deepEqual(normalizeTrack({ ...track, artist: '' }, url).artistNames, []);
});


test('protocol preserves BANNI featured credits without changing its main artist or bare title', () => {
  const artists = ['Aneesh', 'Krtin Kay', 'Kunnu', 'Gargei Lavekar'];
  const result = normalizeTrack({ ...track, title: 'BANNI', artist: 'Aneesh, Krtin Kay & Kunnu', artistNames: artists, featuredArtists: ['Gargei Lavekar'] }, url);
  assert.equal(result.title, 'BANNI'); assert.equal(result.artist, 'Aneesh, Krtin Kay & Kunnu');
  assert.deepEqual(result.artistNames, artists); assert.deepEqual(result.featuredArtists, ['Gargei Lavekar']);
});
test('featured artist arrays are bounded, validated and never split from punctuation', () => {
  const result = normalizeTrack({ ...track, featuredArtists: ['Earth, Wind & Fire', 'EARTH, WIND & FIRE', null, 'bad\nname', 'x'.repeat(251), 'Simon & Garfunkel'] }, url);
  assert.deepEqual(result.featuredArtists, ['Earth, Wind & Fire', 'Simon & Garfunkel']);
  assert.equal(normalizeTrack({ ...track, featuredArtists: Array.from({ length: 30 }, (_, i) => 'Featured ' + i) }, url).featuredArtists.length, 12);
  assert.deepEqual(normalizeTrack({ ...track, featuredArtists: 'Guest & Another Guest' }, url).featuredArtists, []);
  assert.deepEqual(normalizeTrack({ ...track, artist: '', featuredArtists: ['Guest'] }, url).featuredArtists, []);
});
