'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMedia, directPlayCandidate, mediaContentType, extensionOf } = require('../lib/media-formats');
const { createChunkCache } = require('../lib/chunk-cache');

test('every format named in the product spec is classified correctly', () => {
  const video = ['clip.mp4', 'clip.MOV', 'clip.webm', 'clip.mkv', 'clip.avi', 'clip.m4v', 'clip.3gp', 'clip.wmv', 'clip.flv', 'clip.mpg'];
  const audio = ['song.mp3', 'song.wav', 'song.m4a', 'song.aac', 'song.flac', 'song.ogg', 'song.opus', 'song.oga', 'song.wma', 'song.aiff'];
  for (const name of video) assert.equal(classifyMedia(name, ''), 'video', name);
  for (const name of audio) assert.equal(classifyMedia(name, ''), 'audio', name);
});

test('classification falls back to the stored MIME type and rejects non-media', () => {
  assert.equal(classifyMedia('recording', 'audio/webm'), 'audio');
  assert.equal(classifyMedia('screen', 'video/webm'), 'video');
  assert.equal(classifyMedia('report.pdf', 'application/pdf'), null);
  assert.equal(classifyMedia('photo.jpg', 'image/jpeg'), null);
  assert.equal(classifyMedia('archive.zip', 'application/zip'), null);
  assert.equal(classifyMedia('', ''), null);
  assert.equal(classifyMedia(undefined, undefined), null);
});

test('extensions are read from the end of the name only', () => {
  assert.equal(extensionOf('holiday.mp4.txt'), 'txt');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('weird name (1).MP3'), 'mp3');
  assert.equal(classifyMedia('holiday.mp4.txt', 'text/plain'), null, 'a text file is not media because its name contains .mp4');
});

test('browser-friendly containers are tried directly, legacy ones are converted straight away', () => {
  for (const name of ['a.mp4', 'a.mov', 'a.webm', 'a.mkv', 'a.m4v', 'a.mp3', 'a.m4a', 'a.aac', 'a.wav', 'a.flac', 'a.ogg', 'a.opus']) assert.equal(directPlayCandidate(name), true, name);
  for (const name of ['a.avi', 'a.wmv', 'a.flv', 'a.ts', 'a.vob', 'a.mpg', 'a.wma', 'a.3gp', 'a.txt', 'a']) assert.equal(directPlayCandidate(name), false, name);
});

test('Content-Type is canonical for media and can never be a document type', () => {
  assert.equal(mediaContentType('v.mov', '', 'video'), 'video/quicktime', 'phones often send an empty type for MOV');
  assert.equal(mediaContentType('v.mkv', 'application/octet-stream', 'video'), 'video/x-matroska');
  assert.equal(mediaContentType('s.opus', 'application/octet-stream', 'audio'), 'audio/ogg');
  assert.equal(mediaContentType('s.m4a', '', 'audio'), 'audio/mp4');
  assert.equal(mediaContentType('s.mp3', 'audio/mpeg', 'audio'), 'audio/mpeg');
  assert.equal(mediaContentType('rec', 'audio/webm; codecs=opus', 'audio'), 'audio/webm', 'a valid stored audio type is kept');
  for (const hostile of ['text/html', 'application/javascript', 'image/svg+xml', 'video/mp4<script>']) {
    const type = mediaContentType('x.avi', hostile, 'video');
    assert.match(type, /^video\//, hostile + ' is never echoed back as an inline type');
    assert.doesNotMatch(type, /[<>]/);
  }
  assert.equal(mediaContentType('x.avi', 'text/html', 'video'), 'video/mp4');
  assert.equal(mediaContentType('x.wma', 'text/html', 'audio'), 'audio/mpeg');
});

test('chunk cache returns hits without reloading and refreshes recency', async () => {
  const cache = createChunkCache({ maxBytes: 100 });
  let loads = 0;
  const loader = size => async () => { loads++; return Buffer.alloc(size, 1); };
  await cache.get('a', loader(40)); await cache.get('b', loader(40));
  await cache.get('a', loader(40)); // hit; a is now most recent
  assert.equal(loads, 2);
  await cache.get('c', loader(40)); // 120 > 100 evicts least recent = b
  assert.equal(loads, 3);
  await cache.get('a', loader(40)); assert.equal(loads, 3, 'a survived because it was recently used');
  await cache.get('b', loader(40)); assert.equal(loads, 4, 'b was evicted and had to be reloaded');
  assert.ok(cache.stats().bytes <= 100, 'cache never exceeds its byte budget');
});

test('concurrent requests for one chunk share a single storage load', async () => {
  const cache = createChunkCache({ maxBytes: 1000 });
  let loads = 0;
  const slow = async () => { loads++; await new Promise(r => setTimeout(r, 20)); return Buffer.from('chunk'); };
  const results = await Promise.all([cache.get('k', slow), cache.get('k', slow), cache.get('k', slow)]);
  assert.equal(loads, 1);
  assert.ok(results.every(buffer => buffer.equals(Buffer.from('chunk'))));
  assert.equal(cache.stats().inflight, 0);
});

test('a failed load is not cached and the next request retries', async () => {
  const cache = createChunkCache({ maxBytes: 1000 });
  let attempts = 0;
  const flaky = async () => { attempts++; if (attempts === 1) throw new Error('storage hiccup'); return Buffer.from('ok'); };
  await assert.rejects(() => cache.get('k', flaky), /storage hiccup/);
  assert.equal(cache.stats().entries, 0);
  assert.ok((await cache.get('k', flaky)).equals(Buffer.from('ok')));
});

test('a chunk bigger than the whole budget is served but never retained', async () => {
  const cache = createChunkCache({ maxBytes: 10 });
  const big = await cache.get('big', async () => Buffer.alloc(50));
  assert.equal(big.length, 50);
  assert.equal(cache.stats().entries, 0);
});
