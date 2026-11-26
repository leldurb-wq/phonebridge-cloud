'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { parseRange, serveChunkedFile } = require('../lib/chunked-range');

const CHUNK = 1000;
const SIZE = 4437; // 4 full chunks + a 437-byte tail
const DATA = crypto.randomBytes(SIZE);
const ETAG = '"pb-test-' + SIZE + '"';

function manifest(data, chunkSize) {
  const rows = [];
  for (let i = 0, off = 0; off < data.length; i++, off += chunkSize) rows.push({ chunk_index: i, size_bytes: Math.min(chunkSize, data.length - off), off });
  return rows;
}

async function withServer(options, run) {
  const fetched = [];
  const data = options.data || DATA;
  const chunks = manifest(data, CHUNK);
  const server = http.createServer(async (req, res) => {
    try {
      await serveChunkedFile({
        req, res, chunks, size: data.length, contentType: 'video/mp4', etag: ETAG,
        disposition: "attachment; filename*=UTF-8''clip.mp4",
        fetchChunk: async chunk => {
          fetched.push(chunk.chunk_index);
          if (options.failAt === chunk.chunk_index) throw new Error('storage unavailable');
          return Buffer.from(data.subarray(chunk.off, chunk.off + chunk.size_bytes));
        }
      });
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":false}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ base: 'http://127.0.0.1:' + server.address().port, fetched }); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}

async function get(base, headers = {}, method = 'GET') {
  const response = await fetch(base + '/f', { method, headers });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

test('parseRange handles every Range form and rejects nonsense safely', () => {
  assert.deepEqual(parseRange(undefined, 100), { kind: 'none' });
  assert.deepEqual(parseRange('bytes=0-0', 100), { kind: 'range', start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=10-', 100), { kind: 'range', start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { kind: 'range', start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { kind: 'range', start: 0, end: 99 }, 'suffix longer than file returns the whole file');
  assert.deepEqual(parseRange('bytes=90-5000', 100), { kind: 'range', start: 90, end: 99 }, 'end is clamped');
  assert.deepEqual(parseRange('bytes=100-', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=0-1', 0), { kind: 'unsatisfiable' });
  for (const bad of ['bytes=5-2', 'bytes=abc', 'items=0-5', 'bytes=0-1,5-6', 'bytes=-', 'bytes=99999999999999999999-']) {
    assert.equal(parseRange(bad, 100).kind, 'ignore', bad + ' is ignored, not trusted');
  }
});

test('no Range header streams the whole file with Accept-Ranges, length and validators', async () => {
  await withServer({}, async ({ base, fetched }) => {
    const { response, body } = await get(base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(SIZE));
    assert.equal(response.headers.get('etag'), ETAG);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.ok(body.equals(DATA), 'full body is byte-identical to the original');
    assert.deepEqual(fetched, [0, 1, 2, 3, 4]);
  });
});

test('ranges return exactly the requested bytes, including across chunk boundaries', async () => {
  await withServer({}, async ({ base }) => {
    const cases = [
      ['bytes=0-0', 0, 0], ['bytes=0-1', 0, 1], ['bytes=999-1000', 999, 1000],
      ['bytes=500-2499', 500, 2499], ['bytes=4000-', 4000, SIZE - 1], ['bytes=-100', SIZE - 100, SIZE - 1],
      ['bytes=4436-4436', SIZE - 1, SIZE - 1], ['bytes=1000-1999', 1000, 1999]
    ];
    for (const [header, start, end] of cases) {
      const { response, body } = await get(base, { Range: header });
      assert.equal(response.status, 206, header);
      assert.equal(response.headers.get('content-range'), 'bytes ' + start + '-' + end + '/' + SIZE, header);
      assert.equal(response.headers.get('content-length'), String(end - start + 1), header);
      assert.ok(body.equals(DATA.subarray(start, end + 1)), header + ' bytes match the original');
    }
  });
});

test('a range inside one chunk fetches only that chunk', async () => {
  await withServer({}, async ({ base, fetched }) => {
    await get(base, { Range: 'bytes=2100-2200' });
    assert.deepEqual(fetched, [2]);
  });
});

test('a range spanning chunks fetches only the covering chunks', async () => {
  await withServer({}, async ({ base, fetched }) => {
    await get(base, { Range: 'bytes=1500-3200' });
    assert.deepEqual(fetched, [1, 2, 3]);
  });
});

test('unsatisfiable ranges return 416 with the real size, never file bytes', async () => {
  await withServer({}, async ({ base, fetched }) => {
    const { response, body } = await get(base, { Range: 'bytes=' + SIZE + '-' });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */' + SIZE);
    assert.equal(body.length, 0);
    assert.deepEqual(fetched, [], 'no storage reads for an invalid range');
  });
});

test('malformed and multi-range requests fall back to the full file', async () => {
  await withServer({}, async ({ base }) => {
    for (const header of ['bytes=9-3', 'garbage', 'bytes=0-10,20-30']) {
      const { response, body } = await get(base, { Range: header });
      assert.equal(response.status, 200, header);
      assert.ok(body.equals(DATA), header);
    }
  });
});

test('If-Range honours the validator: match resumes, mismatch restarts from zero', async () => {
  await withServer({}, async ({ base }) => {
    const match = await get(base, { Range: 'bytes=100-199', 'If-Range': ETAG });
    assert.equal(match.response.status, 206);
    assert.ok(match.body.equals(DATA.subarray(100, 200)));
    const stale = await get(base, { Range: 'bytes=100-199', 'If-Range': '"changed"' });
    assert.equal(stale.response.status, 200, 'a changed file is never stitched onto a stale partial download');
    assert.ok(stale.body.equals(DATA));
  });
});

test('HEAD returns headers only and reads no storage', async () => {
  await withServer({}, async ({ base, fetched }) => {
    const { response, body } = await get(base, {}, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(SIZE));
    assert.equal(body.length, 0);
    assert.deepEqual(fetched, [0, 1, 2, 3, 4].slice(0, fetched.length));
    assert.ok(fetched.length <= 1, 'at most the pre-flight chunk is touched');
  });
});

test('an interrupted download can be resumed with Range and reassembles byte-identically', async () => {
  await withServer({}, async ({ base }) => {
    const first = await get(base, { Range: 'bytes=0-2345' });
    const resumed = await get(base, { Range: 'bytes=' + first.body.length + '-', 'If-Range': ETAG });
    assert.equal(resumed.response.status, 206);
    const rebuilt = Buffer.concat([first.body, resumed.body]);
    assert.equal(crypto.createHash('sha256').update(rebuilt).digest('hex'), crypto.createHash('sha256').update(DATA).digest('hex'));
  });
});

test('storage failure before the first byte yields a clean error, not a corrupt 200', async () => {
  await withServer({ failAt: 0 }, async ({ base }) => {
    const { response } = await get(base);
    assert.equal(response.status, 503);
    assert.notEqual(response.headers.get('content-length'), String(SIZE), 'the error body does not advertise the file length');
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.notEqual(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''clip.mp4", 'no download headers leak into the error response');
  });
});

test('storage failure mid-stream aborts the connection so the client cannot mistake it for a complete file', async () => {
  await withServer({ failAt: 3 }, async ({ base }) => {
    await assert.rejects(async () => { const r = await fetch(base + '/f'); await r.arrayBuffer(); });
  });
});

test('a manifest that does not add up to the file size is refused', async () => {
  const chunks = manifest(DATA, CHUNK);
  await assert.rejects(() => serveChunkedFile({
    req: { headers: {}, method: 'GET' }, res: {}, chunks, size: SIZE + 1, fetchChunk: async () => Buffer.alloc(0)
  }), /add up/);
});

test('zero-byte files are served as empty 200 and reject any range', async () => {
  await withServer({ data: Buffer.alloc(0) }, async ({ base }) => {
    const full = await get(base);
    assert.equal(full.response.status, 200);
    assert.equal(full.body.length, 0);
    const ranged = await get(base, { Range: 'bytes=0-0' });
    assert.equal(ranged.response.status, 416);
  });
});

test('wiring guard: both Drive download branches go through the range-aware serializer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/chunked-range'\)/);
  assert.equal((server.match(/await serveChunkedFile\(/g) || []).length, 2, 'chunked transfers and legacy single-object files both use serveChunkedFile');
  assert.match(server, /async function streamDriveDownload\(userId,id,req,res\)/, 'the request is passed through so Range headers are visible');
  assert.equal((server.match(/streamDriveDownload\([^)]*req,res\)/g) || []).length, 2, 'both download routes pass req');
  assert.doesNotMatch(server, /res\.setHeader\('Content-Length',String\(file\.size_bytes\)\)/, 'no code path advertises a fixed length without Range handling');
});
