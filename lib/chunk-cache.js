'use strict';
// A small bounded cache for verified storage chunks.
//
// Browsers stream media with many short range requests that land in the same
// 8 MiB chunk. Without a cache each of those would re-download the whole chunk
// from storage. Concurrent requests for the same chunk share one in-flight
// load, and the cache is capped by total bytes so it cannot exhaust memory.

function createChunkCache({ maxBytes = 48 * 1024 * 1024 } = {}) {
  const entries = new Map();   // key -> Buffer (Map order = least recently used first)
  const inflight = new Map();  // key -> Promise<Buffer>
  let bytes = 0;

  function remember(key, buffer) {
    if (buffer.length > maxBytes) return; // never cache something larger than the whole budget
    if (entries.has(key)) { bytes -= entries.get(key).length; entries.delete(key); }
    entries.set(key, buffer);
    bytes += buffer.length;
    while (bytes > maxBytes && entries.size > 1) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).length;
      entries.delete(oldest);
    }
  }

  // loader must resolve to an already integrity-verified Buffer.
  async function get(key, loader) {
    if (entries.has(key)) {
      const hit = entries.get(key);
      entries.delete(key); entries.set(key, hit); // refresh recency
      return hit;
    }
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      const buffer = await loader();
      remember(key, buffer);
      return buffer;
    })().finally(() => inflight.delete(key)); // a failed load is never cached
    inflight.set(key, pending);
    return pending;
  }

  return { get, stats: () => ({ entries: entries.size, bytes, inflight: inflight.size }), clear: () => { entries.clear(); bytes = 0; } };
}

module.exports = { createChunkCache };
