'use strict';

// Image validation is done by *sniffing magic bytes* rather than trusting the
// extension or the client-supplied Content-Type. The sniffed type is the only
// thing that ever reaches the database or an HTTP response header.

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg'
};

function ascii(buf, start, len) {
  let out = '';
  for (let i = start; i < start + len; i += 1) {
    out += String.fromCharCode(buf[i]);
  }
  return out;
}

function startsWith(buf, offset, hexString) {
  if (buf.length < offset + hexString.length / 2) return false;
  for (let i = 0; i < hexString.length / 2; i += 1) {
    if (buf[offset + i] !== parseInt(hexString.substr(i * 2, 2), 16)) return false;
  }
  return true;
}

/**
 * @returns {{mime:string, ext:string}|null}
 */
function sniffImage(buffer, { allowSvg = false } = {}) {
  if (!buffer || buffer.length < 12) return null;

  if (startsWith(buffer, 0, 'ffd8ff')) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (startsWith(buffer, 0, '89504e470d0a1a0a')) {
    return { mime: 'image/png', ext: 'png' };
  }
  const gif = ascii(buffer, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (ascii(buffer, 0, 2) === 'BM') {
    return { mime: 'image/bmp', ext: 'bmp' };
  }
  // ISO-BMFF based (AVIF/HEIF): ....ftyp<major brand>
  if (ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4).trim().toLowerCase();
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'heic') {
      return brand.startsWith('avi') ? { mime: 'image/avif', ext: 'avif' } : null;
    }
    return null;
  }
  if (allowSvg) {
    const head = buffer.slice(0, 1024).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--')) {
      const full = buffer.slice(0, 2048).toString('utf8').toLowerCase();
      if (full.includes('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
    }
  }

  return null;
}

function extensionForMime(mime) {
  return EXTENSION_BY_MIME[mime] || 'bin';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Strip anything unsafe from a user supplied filename; metadata only. */
function sanitizeOriginalFilename(name) {
  const base = String(name || 'image')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim();
  return (cleaned || 'image').slice(0, 200);
}

module.exports = { sniffImage, extensionForMime, formatBytes, sanitizeOriginalFilename, EXTENSION_BY_MIME };
