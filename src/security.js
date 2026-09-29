'use strict';

const crypto = require('crypto');

// Alphabet without ambiguous characters (no 0/O/1/I/l) for human-typed codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Cryptographically secure random string built with rejection sampling
 * so every character is uniformly distributed.
 */
function randomString(length, alphabet) {
  const chars = alphabet || ID_ALPHABET;
  const max = 256 - (256 % chars.length); // largest unbiased multiple
  let out = '';

  while (out.length < length) {
    const buf = crypto.randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i += 1) {
      if (buf[i] < max) out += chars[buf[i] % chars.length];
    }
  }
  return out;
}

function generateCode() {
  return `${randomString(4, CODE_ALPHABET)}-${randomString(4, CODE_ALPHABET)}`;
}

function generatePublicId(length) {
  return randomString(length || 6, ID_ALPHABET);
}

/**
 * Lowercase hex id used for on-disk filenames. Kept separate from the
 * URL-friendly alphabet so stored names always match /^[a-f0-9]+\.[a-z0-9]+$/
 * and can never contain uppercase, slashes or dots.
 */
function generateHexId(bytes) {
  return crypto.randomBytes(bytes || 16).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Constant-time string comparison (safe against timing attacks). */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Normalize user input to the canonical XXXX-XXXX shape for hashing. */
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function isCodeShape(input) {
  return normalizeCode(input) !== null;
}

module.exports = {
  generateCode,
  generatePublicId,
  generateHexId,
  sha256,
  safeEqual,
  normalizeCode,
  isCodeShape,
  randomString
};
