'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const store = require('./store');
const session = require('./session');
const logger = require('./logger');
const { generatePublicId, generateHexId } = require('./security');
const { sniffImage, extensionForMime, sanitizeOriginalFilename, formatBytes } = require('./images');

// Slugs are deliberately restrictive: letters, digits, hyphen and underscore only.
// This makes path traversal, slash injection and extension tricks impossible.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_SLUGS = new Set(['api', 'manage', 'i', 'uploads', 'public', 'admin', 'favicon.ico']);

// Second line of defence: a stored filename must look exactly like one we generate.
const STORED_NAME_PATTERN = /^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/;

function createApp(config, secret) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeBytes, files: 1, fields: 10 }
  });

  const isHttps = config.domain.startsWith('https://');
  const uploadsRoot = path.resolve(config.uploadsDir);

  const publicUrl = (identifier) => `${config.domain}/i/${identifier}`;

  /* ================================================================== *
   * GET /i/:id - serve the raw image bytes.
   * Works in <img>, Markdown, HTML, Discord, forums, etc.
   * ================================================================== */
  async function serveImage(req, res, next) {
    const raw = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const record = (await store.findImageBySlug(raw)) || (await store.findImageByPublicId(raw));
    if (!record) return res.status(404).type('text/plain').send('Not found');

    const stored = path.basename(String(record.stored_filename));
    if (!STORED_NAME_PATTERN.test(stored)) {
      logger.error(`Refusing to serve unexpected stored_filename: ${record.stored_filename}`);
      return res.status(500).type('text/plain').send('Server error');
    }

    const absolute = path.resolve(path.join(uploadsRoot, stored));
    if (absolute.indexOf(uploadsRoot) !== 0) {
      return res.status(400).type('text/plain').send('Bad request');
    }

    res.setHeader('Content-Type', record.mime_type);
    res.setHeader('Content-Length', String(record.byte_size));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${sanitizeOriginalFilename(record.original_filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (record.mime_type === 'image/svg+xml') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }

    res.sendFile(absolute, (err) => {
      if (!err) return;
      if (res.headersSent) return;
      if (err.code === 'ENOENT') {
        // File gone from disk but the DB row remains -> clean up, never crash.
        logger.warn(`File missing for image #${record.id} (${stored}); removing stale record.`);
        store.deleteImageRecords([record.id]).catch(() => {});
        return res.status(404).type('text/plain').send('Not found');
      }
      return next(err);
    });
  }

  /* ================================================================== *
   * POST /api/upload - requires a valid, non-revoked UPLOAD code.
   * The check is server-side; the browser's code is never trusted.
   * ================================================================== */
  async function handleUpload(req, res) {
    const suppliedCode = (req.body && req.body.code) || req.get('X-Upload-Code') || '';
    const token = await store.verifyToken('upload', suppliedCode);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'invalid_code', message: 'Invalid or revoked upload code.' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: 'no_file', message: 'No image file was received.' });
    }

    // Trust the bytes, not the extension or the browser's Content-Type.
    const sniffed = sniffImage(file.buffer, { allowSvg: config.allowSvg });
    if (!sniffed) {
      return res.status(415).json({
        ok: false,
        error: 'unsupported_type',
        message: config.allowSvg
          ? 'Unsupported file type. Use JPG, PNG, GIF, WebP, BMP, AVIF or SVG.'
          : 'Unsupported file type. Use JPG, PNG, GIF, WebP, BMP or AVIF.'
      });
    }

    const rawSlug = String((req.body && req.body.slug) || '').trim();
    let customSlug = null;
    if (rawSlug) {
      if (!SLUG_PATTERN.test(rawSlug) || RESERVED_SLUGS.has(rawSlug.toLowerCase())) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_slug',
          message:
            'Custom link may only use letters, numbers, hyphens and underscores (max 64 characters) and cannot be a reserved word.'
        });
      }
      if (await store.slugExists(rawSlug)) {
        return res.status(409).json({ ok: false, error: 'slug_taken', message: 'That custom link is already in use.' });
      }
      customSlug = rawSlug;
    }

    // Random internal filename (32 hex chars) - never derived from user input.
    const storedFilename = `${generateHexId(16)}.${extensionForMime(sniffed.mime)}`;

    let publicId = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatePublicId(config.publicIdLength);
      if (!(await store.publicIdExists(candidate))) {
        publicId = candidate;
        break;
      }
    }
    if (!publicId) {
      return res.status(503).json({ ok: false, error: 'id_exhausted', message: 'Could not allocate a unique id, please retry.' });
    }

    const absolute = path.join(uploadsRoot, storedFilename);
    await fsp.writeFile(absolute, file.buffer);

    let imageId;
    try {
      imageId = await store.insertImage({
        publicId,
        originalFilename: sanitizeOriginalFilename(file.originalname),
        storedFilename,
        customSlug,
        mimeType: sniffed.mime,
        byteSize: file.buffer.length
      });
    } catch (err) {
      await fsp.unlink(absolute).catch(() => {});
      if (db.isDuplicateKeyError(err)) {
        return res.status(409).json({ ok: false, error: 'slug_taken', message: 'That custom link is already in use.' });
      }
      throw err;
    }

    const url = publicUrl(customSlug || publicId);
    const name = sanitizeOriginalFilename(file.originalname);
    logger.info(`Upload #${imageId}: ${name} (${sniffed.mime}, ${formatBytes(file.buffer.length)}) -> ${url}`);

    return res.status(201).json({
      ok: true,
      id: imageId,
      url,
      markdown: `![${name}](${url})`,
      html: `<img src="${url}" alt="${name}">`,
      filename: name,
      mime: sniffed.mime,
      size: file.buffer.length,
      sizeLabel: formatBytes(file.buffer.length)
    });
  }


  /* ================================================================== *
   * Management authentication.
   * An upload code can never delete, and a management code can never
   * upload: the two token types are stored and verified separately, and
   * the session is bound to the management token's row id so that
   * revoking (or expiring) it kills active sessions immediately.
   * ================================================================== */
  async function resolveManagementSession(req) {
    const raw = session.readCookie(req);
    if (!raw) return null;
    const payload = session.verify(raw, secret);
    if (!payload || !payload.tid) return null;

    const rows = await db.query(
      `SELECT \`id\` FROM \`tokens\`
        WHERE \`id\` = ? AND \`type\` = 'management' AND \`revoked_at\` IS NULL
          AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
        LIMIT 1`,
      [payload.tid, store.utcNow()]
    );
    return rows.length ? payload : null;
  }

  async function requireManagementSession(req, res, next) {
    try {
      const payload = await resolveManagementSession(req);
      if (!payload) {
        return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Management code required.' });
      }
      req.managementSession = payload;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  async function handleManageLogin(req, res) {
    const token = await store.verifyToken('management', (req.body && req.body.code) || '');
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_code',
        message: 'Invalid, expired or revoked management code.'
      });
    }
    const value = session.create(secret, { tokenId: token.id });
    session.setCookie(res, value, { secure: isHttps });
    return res.json({ ok: true });
  }

  function handleManageLogout(req, res) {
    session.clearCookie(res);
    return res.json({ ok: true });
  }

  async function handleManageStatus(req, res) {
    const payload = await resolveManagementSession(req);
    return res.json({
      ok: true,
      authenticated: Boolean(payload),
      expiresAt: payload ? new Date(payload.exp).toISOString() : null
    });
  }

  /* ================================================================== *
   * Management listing / deletion
   * ================================================================== */
  function serializeImage(row) {
    const identifier = row.custom_slug || row.public_id;
    const url = publicUrl(identifier);
    return {
      id: row.id,
      identifier,
      filename: row.original_filename,
      mime: row.mime_type,
      size: Number(row.byte_size),
      sizeLabel: formatBytes(row.byte_size),
      uploadedAt: row.upload_time,
      url,
      markdown: `![${row.original_filename}](${url})`,
      html: `<img src="${url}" alt="${row.original_filename}">`
    };
  }

  async function handleListImages(req, res) {
    const rows = await store.listImages();
    return res.json({ ok: true, images: rows.map(serializeImage) });
  }


  async function handleDeleteImages(req, res) {
    const body = req.body || {};
    const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
    const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'no_ids', message: 'No valid image ids supplied.' });
    }

    const rows = await store.getImagesByIds(ids);
    const deleted = [];
    const missingFiles = [];

    // Step 1: remove the physical files. A file that is already gone is fine.
    for (const row of rows) {
      const stored = path.basename(String(row.stored_filename));
      if (STORED_NAME_PATTERN.test(stored)) {
        try {
          await fsp.unlink(path.join(uploadsRoot, stored));
        } catch (err) {
          if (err.code !== 'ENOENT') logger.warn(`Could not delete ${stored}: ${err.message}`);
          missingFiles.push(stored);
        }
      } else {
        missingFiles.push(stored);
      }
      deleted.push(row.id);
    }

    // Step 2: remove the DB rows -> the public URL stops resolving immediately.
    const removedRows = await store.deleteImageRecords(ids);

    logger.info(`Deleted ${deleted.length} image(s); ${removedRows} database row(s) removed.`);
    return res.json({
      ok: true,
      deleted,
      notFound: ids.filter((id) => !deleted.includes(id)),
      orphanedFiles: missingFiles,
      message: `Deleted ${deleted.length} image${deleted.length === 1 ? '' : 's'}.`
    });
  }

  /* ================================================================== *
   * Wiring
   * ================================================================== */
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Belt and braces: never serve secrets, even if a file ever lands in public/.
  app.use(['/config.json', '/config.example.json', '/.session-secret', '/package.json', '/src'], (req, res) =>
    res.status(404).type('text/plain').send('Not found')
  );

  // ---- API ----
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post(
    '/api/upload',
    (req, res, next) => {
      upload.single('image')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            ok: false,
            error: 'too_large',
            message: `File is larger than the ${Math.round(config.maxFileSizeBytes / (1024 * 1024))} MB limit.`
          });
        }
        return next(err);
      });
    },
    (req, res, next) => handleUpload(req, res).catch(next)
  );

  app.post('/api/manage/login', express.json({ limit: '10kb' }), (req, res, next) =>
    handleManageLogin(req, res).catch(next)
  );
  app.post('/api/manage/logout', (req, res) => handleManageLogout(req, res));
  app.get('/api/manage/status', (req, res, next) => handleManageStatus(req, res).catch(next));
  app.get('/api/manage/images', requireManagementSession, (req, res, next) =>
    handleListImages(req, res).catch(next)
  );
  app.post(
    '/api/manage/delete',
    requireManagementSession,
    express.json({ limit: '32kb' }),
    (req, res, next) => handleDeleteImages(req, res).catch(next)
  );

  // ---- Direct image delivery ----
  app.get('/i/:id', (req, res, next) => serveImage(req, res, next).catch(next));
  app.head('/i/:id', (req, res, next) => serveImage(req, res, next).catch(next));

  // ---- Static frontend (public/ only) ----
  app.use(express.static(config.publicDir, { index: 'index.html', maxAge: '1h', etag: true }));
  app.get('/manage', (req, res) => res.sendFile(path.join(config.publicDir, 'manage.html')));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('Unhandled request error:', err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
