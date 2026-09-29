'use strict';

const db = require('./db');
const { sha256 } = require('./security');

/**
 * Current UTC time as a MySQL DATETIME string.
 *
 * Expiry is always compared against this JS-generated UTC value rather than
 * MySQL's NOW(), so token expiry stays correct regardless of the session
 * time_zone or the container's local timezone.
 */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/* ---------------------------------------------------------------------------
 * Tokens
 * ------------------------------------------------------------------------ */

// Issuing a new token always revokes every previous token of the same type,
// so "code" replaces the old upload code and "delete" replaces the old
// management code. Only the SHA-256 hash is ever persisted.
async function issueToken(type, ttlMinutes) {
  // Imported lazily to keep this module free of circular requires.
  const { generateCode } = require('./security');

  await db.query(
    'UPDATE `tokens` SET `revoked_at` = NOW() WHERE `type` = ? AND `revoked_at` IS NULL',
    [type]
  );

  const plain = generateCode();
  const hash = sha256(plain);

  if (ttlMinutes && ttlMinutes > 0) {
    // The expiry timestamp is computed in JS and passed as a plain DATETIME
    // value rather than using "INTERVAL ? MINUTE", which is not portable
    // across every MySQL/MariaDB build when sent as a prepared statement.
    const expiresAt = new Date(Date.now() + Math.round(ttlMinutes) * 60000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await db.query('INSERT INTO `tokens` (`token_hash`, `type`, `expires_at`) VALUES (?, ?, ?)', [
      hash,
      type,
      expiresAt
    ]);
  } else {
    await db.query('INSERT INTO `tokens` (`token_hash`, `type`) VALUES (?, ?)', [hash, type]);
  }

  return plain;
}

async function revokeToken(type) {
  const result = await db.query(
    'UPDATE `tokens` SET `revoked_at` = NOW() WHERE `type` = ? AND `revoked_at` IS NULL',
    [type]
  );
  return result.affectedRows || 0;
}

/**
 * Validate a plaintext code against the database.
 * @returns {Promise<object|null>} the token row, or null when invalid.
 */
async function verifyToken(type, plainCode) {
  const { normalizeCode } = require('./security');
  const normalized = normalizeCode(plainCode);
  if (!normalized) return null;

  const rows = await db.query(
    `SELECT \`id\`, \`token_hash\`, \`type\`, \`created_at\`, \`expires_at\`
       FROM \`tokens\`
      WHERE \`token_hash\` = ? AND \`type\` = ? AND \`revoked_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
      LIMIT 1`,
    [sha256(normalized), type, utcNow()]
  );

  if (rows.length === 0) return null;

  // Fire-and-forget usage tracking; failure here must never break a request.
  db.query('UPDATE `tokens` SET `last_used_at` = NOW() WHERE `id` = ?', [rows[0].id]).catch(() => {});

  return rows[0];
}

async function getActiveToken(type) {
  const rows = await db.query(
    `SELECT \`id\`, \`created_at\`, \`expires_at\`
       FROM \`tokens\`
      WHERE \`type\` = ? AND \`revoked_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
      ORDER BY \`id\` DESC LIMIT 1`,
    [type, utcNow()]
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
 * Images
 * ------------------------------------------------------------------------ */

async function slugExists(slug) {
  const rows = await db.query('SELECT `id` FROM `images` WHERE `custom_slug` = ? LIMIT 1', [slug]);
  return rows.length > 0;
}

async function publicIdExists(publicId) {
  const rows = await db.query('SELECT `id` FROM `images` WHERE `public_id` = ? LIMIT 1', [publicId]);
  return rows.length > 0;
}

async function insertImage({ publicId, originalFilename, storedFilename, customSlug, mimeType, byteSize }) {
  const result = await db.query(
    `INSERT INTO \`images\`
       (\`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`, \`mime_type\`, \`byte_size\`)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [publicId, originalFilename, storedFilename, customSlug || null, mimeType, byteSize]
  );
  return result.insertId;
}

async function findImageByPublicId(publicId) {
  const rows = await db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, \`upload_time\`
       FROM \`images\`
      WHERE \`public_id\` = ?
      LIMIT 1`,
    [publicId]
  );
  return rows[0] || null;
}

async function findImageBySlug(slug) {
  const rows = await db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, \`upload_time\`
       FROM \`images\`
      WHERE \`custom_slug\` = ?
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function listImages() {
  return db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, DATE_FORMAT(\`upload_time\`, '%Y-%m-%d %H:%i:%s') AS \`upload_time\`
       FROM \`images\`
      ORDER BY \`upload_time\` DESC, \`id\` DESC`
  );
}

async function getImagesByIds(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`
       FROM \`images\`
      WHERE \`id\` IN (${placeholders})`,
    ids
  );
}

async function deleteImageRecords(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.query(`DELETE FROM \`images\` WHERE \`id\` IN (${placeholders})`, ids);
  return result.affectedRows || 0;
}

async function getStats() {
  const rows = await db.query(
    `SELECT COUNT(*) AS \`image_count\`, COALESCE(SUM(\`byte_size\`), 0) AS \`total_bytes\`
       FROM \`images\``
  );
  return rows[0] || { image_count: 0, total_bytes: 0 };
}

module.exports = {
  utcNow,
  issueToken,
  revokeToken,
  verifyToken,
  getActiveToken,
  slugExists,
  publicIdExists,
  insertImage,
  findImageByPublicId,
  findImageBySlug,
  listImages,
  getImagesByIds,
  deleteImageRecords,
  getStats
};
