'use strict';

const crypto = require('crypto');
const fs = require('fs');
const logger = require('./logger');

const COOKIE_NAME = 'imgmgmt';
const SESSION_TTL_MINUTES = 30;

/**
 * The session secret is generated once and persisted next to the app so that
 * management sessions survive a restart. It is gitignored and never leaves the
 * server (no database credentials, no secret material in responses).
 */
function loadOrCreateSecret(secretFile) {
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Could not read session secret: ${err.message}`);
  }

  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    logger.info('Generated a new session secret (.session-secret).');
  } catch (err) {
    logger.warn(`Could not persist session secret (${err.message}); sessions end on restart.`);
  }
  return secret;
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  if (!body || !mac) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function create(secret, { tokenId }) {
  return sign(
    {
      tid: tokenId,
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MINUTES * 60 * 1000
    },
    secret
  );
}

function setCookie(res, value, { secure }) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_MINUTES * 60}`
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

module.exports = { loadOrCreateSecret, create, verify, setCookie, clearCookie, readCookie, COOKIE_NAME, SESSION_TTL_MINUTES };
