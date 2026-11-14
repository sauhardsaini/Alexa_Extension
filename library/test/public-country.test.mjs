import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../catalog.mjs';

const base = { kind: 'song', trackId: 1, trackName: 'OBVIOUS (feat. Hasan Raheem)', artistName: 'Umair', country: 'IND', trackViewUrl: 'https://music.apple.com/in/album/obvious/1740701022?i=1740701208', isStreamable: true };
const jsonResponse = results => ({ ok: true, json: async () => ({ results }) });

test('public India results require matching response country and content-link storefront', async () => {
  const rows = [
    { ...base, country: 'USA' },
    { ...base, trackId: 2, trackViewUrl: 'https://music.apple.com/us/album/obvious/1740701022?i=1740701208' },
    { ...base, trackId: 3, country: undefined },
    { ...base, trackId: 4, trackViewUrl: 'https://music.apple.com/album/obvious/1740701022?i=1740701208' },
    { ...base, trackId: 5, trackViewUrl: 'https://music.apple.com/ind/album/obvious/1740701022?i=1740701208' },
    null,
    base,
  ];
  const catalog = new Catalog({ fetcher: async () => jsonResponse(rows) });
  const result = await catalog.search('OBVIOUS', 'IN');
  assert.equal(result.tracks.length, 1, 'foreign duplicate IDs must not hide the valid local row');
  assert.equal(result.tracks[0].title, 'OBVIOUS (feat. Hasan Raheem)');
  assert.equal(result.tracks[0].artist, 'Umair');
  assert.match(result.tracks[0].url, /^https:\/\/music\.apple\.com\/in\//);
  assert.equal(result.country, 'IN');
  assert.equal(result.source, 'itunes');
  assert.equal(result.availability, 'unverified', 'an iTunes result must not claim verified Apple Music availability');
});

test('public results reject explicit non-streamability and retain unknown availability honestly', async () => {
  const catalog = new Catalog({ fetcher: async () => jsonResponse([
    { ...base, trackId: 1, trackName: 'Not streamable', isStreamable: false },
    { ...base, trackId: 2, trackName: 'Streamability unknown', isStreamable: undefined },
    { ...base, trackId: 3, trackName: 'Store streamable', isStreamable: true },
  ]) });
  const result = await catalog.search('OBVIOUS', 'IN');
  assert.deepEqual(result.tracks.map(track => track.title), ['Streamability unknown', 'Store streamable']);
  assert.equal(result.availability, 'unverified');
});

test('each supported public country uses its corresponding ISO alpha-3 response code', async () => {
  const mapping = { IN: 'IND', US: 'USA', GB: 'GBR', DE: 'DEU', CA: 'CAN', AU: 'AUS', JP: 'JPN' };
  for (const [country, responseCountry] of Object.entries(mapping)) {
    const catalog = new Catalog({ fetcher: async url => {
      assert.equal(url.searchParams.get('country'), country);
      return jsonResponse([{ ...base, country: responseCountry, trackViewUrl: `https://music.apple.com/${country.toLowerCase()}/album/obvious/1740701022?i=1740701208` }]);
    } });
    const result = await catalog.search('OBVIOUS', country);
    assert.equal(result.tracks.length, 1, `matching storefront accepted for ${country}`);
    assert.equal(result.country, country);
    assert.equal(result.availability, 'unverified');
  }
});

test('public caches and trusted playback choices stay bound to their selected country', async () => {
  const calls = [];
  const catalog = new Catalog({ fetcher: async url => {
    const country = url.searchParams.get('country');
    calls.push(country);
    return jsonResponse([{ ...base, country: country === 'IN' ? 'IND' : 'USA', trackViewUrl: `https://music.apple.com/${country.toLowerCase()}/album/obvious/1740701022?i=1740701208` }]);
  } });
  const india = await catalog.search('OBVIOUS', 'IN');
  const usa = await catalog.search('OBVIOUS', 'US');
  const cachedIndia = await catalog.search('obvious', 'IN');
  assert.deepEqual(calls, ['IN', 'US']);
  assert.equal(cachedIndia.tracks[0].id, india.tracks[0].id);
  assert.notEqual(india.tracks[0].id, usa.tracks[0].id);
  await assert.rejects(catalog.prepareTrack(india.tracks[0].id, 'US'), { code: 'COUNTRY_MISMATCH' });
  await assert.rejects(catalog.prepareTrack(usa.tracks[0].id, 'IN'), { code: 'COUNTRY_MISMATCH' });
  assert.equal((await catalog.prepareTrack(india.tracks[0].id, 'IN')).artist, 'Umair');
  assert.equal((await catalog.prepareTrack(usa.tracks[0].id, 'US')).artist, 'Umair');
  assert.deepEqual(calls, ['IN', 'US'], 'country validation must not trigger extra external requests');
});
