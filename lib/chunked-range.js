'use strict';
// HTTP byte-range serving for files stored as an ordered manifest of chunks.
//
// PhoneBridge stores received files as verified 8 MiB chunks. This module lets
// a download or media element request any byte range (seek, resume, Safari's
// probing "bytes=0-1" request) and only fetches the chunks that cover it.
// Every chunk the caller's fetchChunk returns is expected to be integrity
// verified already, so ranged responses keep the same guarantees as full ones.

// Parse a Range header against a known entity size (RFC 9110 section 14.2).
// kind: none (no header) | ignore (syntactically invalid or multi-range: serve
// the whole entity) | unsatisfiable (416) | range (206 start..end inclusive).
function parseRange(header, size) {
  if (header === undefined || header === null || header === '') return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match) return { kind: 'ignore' };
  const first = match[1], last = match[2];
  if (first === '' && last === '') return { kind: 'ignore' };
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return { kind: 'ignore' };
    if (suffix <= 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start)) return { kind: 'ignore' };
  let end = size - 1;
  if (last !== '') {
    end = Number(last);
    if (!Number.isSafeInteger(end) || end < start) return { kind: 'ignore' };
  }
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

// Attach absolute byte offsets to an ordered chunk manifest.
function withOffsets(chunks) {
  let offset = 0;
  return chunks.map(chunk => {
    const length = Number(chunk.size_bytes);
    const entry = { ...chunk, offset, length };
    offset += length;
    return entry;
  });
}

function writeWithBackpressure(res, buffer) {
  if (res.write(buffer)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
}

// Serve [start..end] (or the whole file) of a chunked entity.
//   chunks:     ordered manifest rows ({ size_bytes, ...anything fetchChunk needs })
//   size:       total file size; must equal the sum of chunk sizes
//   fetchChunk: async (chunk) => Buffer of the entire, verified chunk
// Throws before any byte is sent when the first chunk cannot be fetched, so the
// caller can still answer with a clean JSON error. Once streaming has started a
// failure destroys the connection rather than delivering a silently short file.
async function serveChunkedFile({ req, res, chunks, size, contentType, disposition, etag, fetchChunk }) {
  const parts = withOffsets(chunks);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total !== size) throw new Error('Chunk manifest does not add up to the file size.');

  let range = parseRange(req.headers.range, size);
  const ifRange = req.headers['if-range'];
  if (range.kind === 'range' && ifRange && ifRange !== etag) range = { kind: 'none' };

  // Validators describe a real response, so they are attached only once one is certain.
  const applyValidators = () => { res.setHeader('Accept-Ranges', 'bytes'); if (etag) res.setHeader('ETag', etag); };

  if (range.kind === 'unsatisfiable') {
    applyValidators();
    res.statusCode = 416;
    res.setHeader('Content-Range', 'bytes */' + size);
    res.setHeader('Content-Length', '0');
    return res.end();
  }

  const partial = range.kind === 'range';
  const start = partial ? range.start : 0;
  const end = partial ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  const selected = size === 0 ? [] : parts.filter(part => part.length > 0 && part.offset <= end && part.offset + part.length - 1 >= start);

  // Fetch the first chunk before committing to headers (see header comment).
  // HEAD exposes the same metadata as GET without touching object storage.
  let pending = req.method === 'HEAD' || !selected.length ? null : fetchChunk(selected[0]);
  if (pending) pending.catch(() => {});
  const firstBuffer = pending ? await pending : null;

  applyValidators();
  res.statusCode = partial ? 206 : 200;
  if (contentType) res.setHeader('Content-Type', contentType);
  if (disposition) res.setHeader('Content-Disposition', disposition);
  if (partial) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  res.setHeader('Content-Length', String(length));
  if (req.method === 'HEAD' || length === 0) return res.end();

  let closed = false;
  res.once('close', () => { closed = true; });
  let current = firstBuffer;
  for (let i = 0; i < selected.length; i++) {
    const part = selected[i];
    // Prefetch the next chunk while this one is being written to the client.
    let next = null;
    if (i + 1 < selected.length && !closed) { next = fetchChunk(selected[i + 1]); next.catch(() => {}); }
    if (closed) return;
    const from = Math.max(start, part.offset) - part.offset;
    const to = Math.min(end, part.offset + part.length - 1) - part.offset;
    if (current.length !== part.length) throw new Error('Chunk length does not match its manifest entry.');
    await writeWithBackpressure(res, from === 0 && to === current.length - 1 ? current : current.subarray(from, to + 1));
    if (next) current = await next;
  }
  if (!closed) res.end();
}

module.exports = { parseRange, withOffsets, serveChunkedFile };
