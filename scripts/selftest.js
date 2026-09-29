'use strict';

/**
 * Development self-test. Boots the real Express app against an in-memory
 * stand-in for MySQL so the whole HTTP flow (auth separation, slug rules,
 * image serving, deletion) can be verified without real credentials.
 *
 * Run with:  node scripts/selftest.js
 * Never loaded by index.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const store = require('../src/store');
const session = require('../src/session');
const { createApp } = require('../src/server');
const { resolvePort } = require('../src/config');

/* ------------------------------------------------------------------ *
 * In-memory database stub matching the SQL used by src/store.js
 * ------------------------------------------------------------------ */
const TABLES = { images: [], tokens: [] };
let nextImagesId = 1;
let nextTokensId = 1;

const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

db.query = async function query(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (/^INSERT INTO `tokens`/.test(s)) {
    const id = nextTokensId++;
    const hasExpiry = /expires_at/.test(s);
    TABLES.tokens.push({
      id,
      token_hash: params[0],
      type: params[1],
      created_at: stamp(),
      expires_at: hasExpiry ? params[2] : null,
      revoked_at: null,
      last_used_at: null
    });
    return { insertId: id, affectedRows: 1 };
  }

  if (/^UPDATE `tokens` SET `revoked_at`/.test(s)) {
    let n = 0;
    for (const t of TABLES.tokens) {
      if (t.type === params[0] && !t.revoked_at) { t.revoked_at = stamp(); n += 1; }
    }
    return { affectedRows: n };
  }

  if (/^UPDATE `tokens` SET `last_used_at`/.test(s)) {
    const t = TABLES.tokens.find((x) => x.id === Number(params[0]));
    if (t) t.last_used_at = stamp();
    return { affectedRows: t ? 1 : 0 };
  }

  if (/^SELECT `id`, `token_hash`/.test(s)) {
    const now = params[2];
    const t = TABLES.tokens.find(
      (x) => x.token_hash === params[0] && x.type === params[1] && !x.revoked_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id, token_hash: t.token_hash, type: t.type, created_at: t.created_at, expires_at: t.expires_at }] : [];
  }

  if (/^SELECT `id`, `created_at`, `expires_at`/.test(s)) {
    const now = params[1];
    const t = [...TABLES.tokens].reverse().find(
      (x) => x.type === params[0] && !x.revoked_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id, created_at: t.created_at, expires_at: t.expires_at }] : [];
  }

  if (/^SELECT `id` FROM `tokens`/.test(s)) {
    const now = params[1];
    const t = TABLES.tokens.find(
      (x) => x.id === Number(params[0]) && x.type === 'management' && !x.revoked_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id }] : [];
  }

  if (/^SELECT `id` FROM `images` WHERE `custom_slug`/.test(s)) {
    return TABLES.images.filter((r) => r.custom_slug === params[0]).slice(0, 1).map((r) => ({ id: r.id }));
  }

  if (/^SELECT `id` FROM `images` WHERE `public_id`/.test(s)) {
    return TABLES.images.filter((r) => r.public_id === params[0]).slice(0, 1).map((r) => ({ id: r.id }));
  }

  if (/^INSERT INTO `images`/.test(s)) {
    const id = nextImagesId++;
    TABLES.images.push({
      id,
      public_id: params[0],
      original_filename: params[1],
      stored_filename: params[2],
      custom_slug: params[3],
      mime_type: params[4],
      byte_size: Number(params[5]),
      upload_time: stamp()
    });
    return { insertId: id, affectedRows: 1 };
  }

  if (/WHERE `public_id` = \? LIMIT/.test(s)) {
    return TABLES.images.filter((r) => r.public_id === params[0]).slice(0, 1);
  }

  if (/WHERE `custom_slug` = \? LIMIT/.test(s)) {
    return TABLES.images.filter((r) => r.custom_slug === params[0]).slice(0, 1);
  }

  if (/^SELECT COUNT\(\*\)/.test(s)) {
    return [{ image_count: TABLES.images.length, total_bytes: TABLES.images.reduce((a, b) => a + b.byte_size, 0) }];
  }

  if (/^DELETE FROM `images`/.test(s)) {
    const ids = params.map(Number);
    const before = TABLES.images.length;
    TABLES.images = TABLES.images.filter((r) => !ids.includes(r.id));
    return { affectedRows: before - TABLES.images.length };
  }

  if (/WHERE `id` IN/.test(s)) {
    const ids = params.map(Number);
    return TABLES.images.filter((r) => ids.includes(r.id));
  }

  throw new Error('selftest: unhandled SQL -> ' + s);
};

// listImages() uses DATE_FORMAT(); the stub already stores "YYYY-MM-DD HH:MM:SS".
store.listImages = async function listImages() {
  return [...TABLES.images].sort((a, b) => b.id - a.id);
};

/* ------------------------------------------------------------------ *
 * Test scaffolding
 * ------------------------------------------------------------------ */
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imghost-selftest-'));
const config = {
  domain: 'https://earth.hidenfree.com',
  uploadsDir,
  publicDir: path.join(__dirname, '..', 'public'),
  maxFileSizeBytes: 25 * 1024 * 1024,
  allowSvg: false,
  publicIdLength: 6,
  managementTokenTtlMinutes: 20,
  uploadTokenTtlHours: null,
  trustProxy: false
};

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail !== undefined ? ` -> ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const lastImage = () => TABLES.images[TABLES.images.length - 1];

async function main() {
  const secret = session.loadOrCreateSecret(path.join(os.tmpdir(), 'selftest-secret'));
  const app = createApp(config, secret);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const uploadForm = (code, buffer, name, slug) => {
    const fd = new FormData();
    if (code !== undefined) fd.append('code', code);
    if (slug) fd.append('slug', slug);
    fd.append('image', new Blob([buffer], { type: 'image/png' }), name);
    return fetch(`${base}/api/upload`, { method: 'POST', body: fd });
  };

  const postJson = (route, body, cookie) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    });

  console.log('Self-test: personal image host\n' + '='.repeat(62));

  /* ---------------- 0. port resolution ---------------- */
  section('0. Port resolution (no Pterodactyl variables needed)');
  check('Pterodactyl PORT wins over config.json', resolvePort(9999, { PORT: '8080' }).port === 8080);
  check('SERVER_PORT is honoured too', resolvePort(null, { SERVER_PORT: '7777' }).port === 7777);
  check('config.json port used when no PORT in env', resolvePort(9999, {}).port === 9999);
  check('falls back to 3000 when nothing is set', resolvePort(null, {}).port === 3000);
  check('undefined config port falls back to 3000', resolvePort(undefined, {}).port === 3000);
  check('empty-string PORT is ignored', resolvePort(null, { PORT: '' }).port === 3000);
  check('non-numeric PORT is ignored', resolvePort(null, { PORT: 'abc' }).port === 3000);
  check('conflicting config port is reported as a conflict', resolvePort(9999, { PORT: '8080' }).conflict === 9999);
  check('matching config port produces no conflict', resolvePort(8080, { PORT: '8080' }).conflict === null);
  check('port 0 is rejected as invalid', resolvePort(0, {}).port === 3000);
  check('negative port is rejected as invalid', resolvePort(-1, {}).port === 3000);

  /* ---------------- 1. tokens ---------------- */
  section('1. Console commands and token generation');
  const firstCode = await store.issueToken('upload', 0);
  const mgmtCode = await store.issueToken('management', 20);
  check('`code` produces an XXXX-XXXX upload code', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(firstCode), firstCode);
  check('`delete` produces a different management code', mgmtCode !== firstCode, mgmtCode);

  let up = await store.issueToken('upload', 0);
  check('re-running `code` replaces the previous code', up !== firstCode);
  check('the replaced code no longer verifies', (await store.verifyToken('upload', firstCode)) === null);
  check('the new code verifies', Boolean(await store.verifyToken('upload', up)));
  check('only a 64-char hash is stored, never the plaintext', TABLES.tokens.every((t) => t.token_hash.length === 64 && !Object.values(t).includes(up)));
  check('management code does NOT verify as an upload code', (await store.verifyToken('upload', mgmtCode)) === null);
  check('upload code does NOT verify as a management code', (await store.verifyToken('management', up)) === null);

  /* ---------------- 2. upload auth ---------------- */
  section('2. Upload authentication (server-side)');
  check('upload without a code -> 401', (await uploadForm(undefined, PNG_BYTES, 'a.png')).status === 401);
  check('upload with a wrong code -> 401', (await uploadForm('AAAA-BBBB', PNG_BYTES, 'a.png')).status === 401);
  check('management code cannot upload -> 401', (await uploadForm(mgmtCode, PNG_BYTES, 'a.png')).status === 401);

  const revokedCode = await store.issueToken('upload', 0);
  await store.revokeToken('upload');
  check('revoked upload code -> 401', (await uploadForm(revokedCode, PNG_BYTES, 'a.png')).status === 401);
  up = await store.issueToken('upload', 0);
  check('a fresh upload code can be issued after revocation', up !== revokedCode);

  const emptyForm = new FormData();
  emptyForm.append('code', up);
  check('upload with a code but no file -> 400', (await fetch(`${base}/api/upload`, { method: 'POST', body: emptyForm })).status === 400);

  /* ---------------- 3. content validation ---------------- */
  section('3. Image content validation (magic bytes)');
  check('a shell script renamed .png -> 415', (await uploadForm(up, Buffer.from('#!/bin/sh\necho hacked\n'), 'evil.png', 'evil')).status === 415);

  const renamed = await uploadForm(up, PNG_BYTES, 'photo.jpg', 'renamed-jpeg');
  const renamedBody = await renamed.json();
  check('a PNG renamed .jpg is stored as its real type', renamedBody.mime === 'image/png', renamedBody.mime);

  /* ---------------- 4. successful upload ---------------- */
  section('4. Upload and direct URL generation');
  const r1 = await uploadForm(up, PNG_BYTES, 'cat.png');
  const b1 = await r1.json();
  const row1 = lastImage();
  check('upload succeeds -> 201', r1.status === 201, r1.status);
  check('url uses the configured domain', b1.url === `https://earth.hidenfree.com/i/${row1.public_id}`, b1.url);
  check('random public id matches the a82KF2 format', /^[A-Za-z0-9]{6}$/.test(row1.public_id), row1.public_id);
  check('markdown snippet is correct', b1.markdown === `![cat.png](${b1.url})`, b1.markdown);
  check('html snippet is correct', b1.html === `<img src="${b1.url}" alt="cat.png">`, b1.html);
  check('internal filename is random hex + ext', /^[a-f0-9]{32}\.png$/.test(row1.stored_filename), row1.stored_filename);
  check('public id is NOT used as the filesystem name', row1.stored_filename !== row1.public_id);
  check('original filename kept as metadata', row1.original_filename === 'cat.png');
  check('file written to the uploads dir', fs.existsSync(path.join(uploadsDir, row1.stored_filename)));
  check('no binary image data stored in the DB', row1.byte_size === PNG_BYTES.length && !('data' in row1));

  const r2 = await uploadForm(up, PNG_BYTES, 'logo.jpg', 'summer2026');
  const b2 = await r2.json();
  check('custom slug produces /i/<slug>', b2.url === 'https://earth.hidenfree.com/i/summer2026', b2.url);
  check('custom slug stored separately from the random id', lastImage().custom_slug === 'summer2026');

  /* ---------------- 5. slug safety ---------------- */
  section('5. Custom slug safety');
  const badSlugs = ['../etc/passwd', 'a/b', 'a\\b', '.hidden', 'has space', 'x'.repeat(65), 'manage', 'api'];
  const badResults = [];
  for (const s of badSlugs) {
    const res = await uploadForm(up, PNG_BYTES, 'x.png', s);
    if (res.status !== 400) badResults.push(`${s}->${res.status}`);
  }
  check('all unsafe / reserved slugs rejected with 400', badResults.length === 0, badResults.join(', '));
  check('duplicate custom slug -> 409', (await uploadForm(up, PNG_BYTES, 'x.png', 'summer2026')).status === 409);
  check('path traversal on /i/:id -> 404', (await fetch(`${base}/i/${encodeURIComponent('../../config.json')}`)).status === 404);
  check('empty slug falls back to a random id', (await uploadForm(up, PNG_BYTES, 'x.png', '')).status === 201);

  /* ---------------- 6. direct image route ---------------- */
  section('6. Direct image route /i/:id');
  const getRandom = await fetch(`${base}/i/${TABLES.images.find((x) => !x.custom_slug).public_id}`);
  const bytes = Buffer.from(await getRandom.arrayBuffer());
  check('GET /i/<id> -> 200', getRandom.status === 200, getRandom.status);
  check('Content-Type is image/png', getRandom.headers.get('content-type') === 'image/png', getRandom.headers.get('content-type'));
  check('bytes match the uploaded file exactly', bytes.equals(PNG_BYTES));
  check('served inline (not as an attachment)', (getRandom.headers.get('content-disposition') || '').startsWith('inline'));
  check('long-lived cache headers set', (getRandom.headers.get('cache-control') || '').includes('immutable'));
  check('X-Content-Type-Options: nosniff set', getRandom.headers.get('x-content-type-options') === 'nosniff');

  check('GET /i/<custom slug> -> 200', (await fetch(`${base}/i/summer2026`)).status === 200);
  check('HEAD /i/<slug> -> 200 (Discord-style checks)', (await fetch(`${base}/i/summer2026`, { method: 'HEAD' })).status === 200);
  check('unknown id -> 404', (await fetch(`${base}/i/doesnotexist`)).status === 404);
  check('malformed id -> 404 (no crash)', (await fetch(`${base}/i/..%2f..%2fconfig.json`)).status === 404);


  /* ---------------- 7. secret protection ---------------- */
  section('7. Secret exposure');
  for (const p of ['/config.json', '/config.example.json', '/.session-secret', '/package.json', '/src/server.js']) {
    const res = await fetch(base + p);
    check(`${p} is not publicly served`, res.status === 404, res.status);
  }
  const indexHtml = await (await fetch(`${base}/`)).text();
  check('index page contains no DB host', !indexHtml.includes('91.99.159.222'));
  check('index page contains no DB name', !indexHtml.includes('s48751_DATA'));
  check('/uploads/ is not browsable', (await fetch(`${base}/uploads/`)).status === 404);
  check('/manage serves the management page', (await fetch(`${base}/manage`)).status === 200);
  check('/api/health responds ok', (await (await fetch(`${base}/api/health`)).json()).ok === true);

  /* ---------------- 8. management auth ---------------- */
  section('8. Management authentication');
  check('listing without a session -> 401', (await fetch(`${base}/api/manage/images`)).status === 401);
  check('deleting without a session -> 401', (await postJson('/api/manage/delete', { ids: [1] })).status === 401);
  check('status without a session -> authenticated:false', (await (await fetch(`${base}/api/manage/status`)).json()).authenticated === false);

  check('upload code cannot log into the manager -> 401', (await postJson('/api/manage/login', { code: up })).status === 401);
  check('wrong management code -> 401', (await postJson('/api/manage/login', { code: 'ZZZZ-ZZZZ' })).status === 401);

  const login = await postJson('/api/manage/login', { code: mgmtCode });
  check('management code logs in -> 200', login.status === 200, login.status);
  const rawCookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).join(';');
  const cookie = rawCookie.split(';')[0];
  check('session cookie is HttpOnly', /HttpOnly/i.test(rawCookie), rawCookie);
  check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(rawCookie), rawCookie);

  const list = await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } });
  const listBody = await list.json();
  check('authenticated listing -> 200', list.status === 200, list.status);
  check('listing has filename, url, upload time, size and type', Boolean(
    listBody.images[0] && listBody.images[0].filename && listBody.images[0].url &&
    listBody.images[0].uploadedAt && listBody.images[0].sizeLabel && listBody.images[0].mime
  ), JSON.stringify(listBody.images[0] || {}));
  check('listing exposes no internal stored_filename', !JSON.stringify(listBody).includes('stored_filename'));
  check('listing exposes no raw DB columns', !/"(public_id|token_hash|byte_size)"/.test(JSON.stringify(listBody)));

  /* ---------------- 9. deletion ---------------- */
  section('9. Deletion');
  const target = TABLES.images.find((x) => x.custom_slug === 'summer2026');
  const targetFile = path.join(uploadsDir, target.stored_filename);

  const del = await postJson('/api/manage/delete', { ids: [target.id] }, cookie);
  const delBody = await del.json();
  check('delete -> 200', del.status === 200, del.status);
  check('delete reports the removed id', delBody.deleted[0] === target.id);
  check('physical file removed from disk', !fs.existsSync(targetFile));
  check('database row removed', !TABLES.images.some((x) => x.id === target.id));
  check('public URL stops working -> 404', (await fetch(`${base}/i/summer2026`)).status === 404);

  const orphan = TABLES.images[0];
  fs.unlinkSync(path.join(uploadsDir, orphan.stored_filename));
  const delOrphan = await postJson('/api/manage/delete', { ids: [orphan.id] }, cookie);
  check('delete tolerates a missing physical file -> 200', delOrphan.status === 200, delOrphan.status);
  check('orphan DB row cleaned up instead of crashing', !TABLES.images.some((x) => x.id === orphan.id));

  check('invalid delete payload -> 400', (await postJson('/api/manage/delete', { ids: 'nope' }, cookie)).status === 400);

  const multiIds = TABLES.images.slice(0, 2).map((x) => x.id);
  const delMany = await postJson('/api/manage/delete', { ids: multiIds }, cookie);
  check('multi-image delete -> 200', delMany.status === 200, delMany.status);
  check('multi-image delete removed every selected id', (await delMany.json()).deleted.length === multiIds.length);

  /* ---------------- 10. revocation ---------------- */
  section('10. Revocation and expiry');
  await store.revokeToken('management');
  check('revoking the management code kills the session -> 401', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 401);
  const mgmt2 = await store.issueToken('management', 20);
  check('a fresh management code can be issued after revocation', (await postJson('/api/manage/login', { code: mgmt2 })).status === 200);

  // Simulate the 20 minute TTL elapsing.
  TABLES.tokens.filter((t) => t.type === 'management' && !t.revoked_at).forEach((t) => { t.expires_at = '2000-01-01 00:00:00'; });
  check('an expired management code no longer verifies', (await store.verifyToken('management', mgmt2)) === null);
  check('an expired management code cannot log in -> 401', (await postJson('/api/manage/login', { code: mgmt2 })).status === 401);
  check('an expired management session is rejected -> 401', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 401);

  const mgmt3 = await store.issueToken('management', 20);
  check('an unexpired management code still works', (await postJson('/api/manage/login', { code: mgmt3 })).status === 200);

  const stats = await store.getStats();
  check('status stats work after deletes', typeof stats.image_count === 'number' && typeof stats.total_bytes === 'number');

  /* ---------------- summary ---------------- */
  console.log('\n' + '='.repeat(62));
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  await new Promise((r) => server.close(r));
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nSelf-test crashed:', err);
  process.exitCode = 1;
});

