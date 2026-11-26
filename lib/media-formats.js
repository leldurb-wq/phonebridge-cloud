'use strict';
// Media format knowledge shared by the preview and streaming endpoints.
//
// classifyMedia keeps the server's existing precedence (audio, then video) so
// nothing that previewed before stops previewing. DIRECT_FIRST lists the
// containers worth trying on the original file before falling back to an
// FFmpeg conversion: they are what phones and desktops actually record, and
// the original streams instantly with range support. Everything else (AVI,
// WMV, FLV, MPEG-TS, ...) is converted straight away because no mainstream
// browser plays them.

const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'oga', 'wma', 'aiff', 'aif'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', '3gp', '3g2', 'mpeg', 'mpg', 'mpe', 'm2v', 'avi', 'mkv', 'wmv', 'flv', 'f4v', 'ts', 'm2ts', 'mts', 'vob'];

// Canonical Content-Type per extension. Phones frequently report an empty or
// generic type for MOV/MKV/OPUS, which makes browsers refuse to play them.
const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff'
};
const DIRECT_FIRST = new Set(Object.keys(MIME_BY_EXT));

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name || '').trim());
  return match ? match[1].toLowerCase() : '';
}

function classifyMedia(name, mime) {
  const ext = extensionOf(name), type = String(mime || '').toLowerCase();
  if (AUDIO_EXT.includes(ext) || type.startsWith('audio/')) return 'audio';
  if (VIDEO_EXT.includes(ext) || type.startsWith('video/')) return 'video';
  return null;
}

// True when the original is worth trying in the browser before converting it.
function directPlayCandidate(name) {
  return DIRECT_FIRST.has(extensionOf(name));
}

// Content-Type to serve the original with. Only ever audio/* or video/*, so an
// inline response can never be interpreted as a document or script.
function mediaContentType(name, mime, kind) {
  const known = MIME_BY_EXT[extensionOf(name)];
  if (known && known.startsWith(kind + '/')) return known;
  const stored = String(mime || '').toLowerCase().split(';')[0].trim();
  if (stored.startsWith(kind + '/') && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(stored)) return stored;
  return kind === 'audio' ? 'audio/mpeg' : 'video/mp4';
}

module.exports = { AUDIO_EXT, VIDEO_EXT, MIME_BY_EXT, extensionOf, classifyMedia, directPlayCandidate, mediaContentType };
