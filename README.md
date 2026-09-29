# Personal Image Host

A lightweight, single-user image hosting service for **Pterodactyl** (Node.js + MySQL/MariaDB).

Upload an image in the browser, get a direct URL you can paste into Markdown, HTML,
Discord or any forum. No Docker. No Pterodactyl variables. Runs with `node index.js`.

---

## Setup (2 steps)

### 1. Create `config.json`

Copy `config.example.json` to `config.json` and fill in the **username** and
**password** from your Pterodactyl **database panel** (use the current, rotated
password):

```json
{
  "database": {
    "host": "91.99.159.222",
    "port": 3306,
    "database": "s48751_DATA",
    "user": "YOUR_DATABASE_USERNAME",
    "password": "YOUR_DATABASE_PASSWORD"
  },
  "domain": "https://earth.hidenfree.com"
}
```

`config.json` is **gitignored**, is never served by Express, and never reaches the
browser. The app refuses to start with a clear error if it is missing or still
contains placeholder values.

### 2. Start it

```bash
node index.js
```

On boot the app creates its tables automatically and prints:

```
[2026-09-29 12:00:00] INFO  MySQL/MariaDB connected (91.99.159.222:3306/s48751_DATA).
[2026-09-29 12:00:00] INFO  Database tables ready.
[2026-09-29 12:00:00] INFO  Web server running on port 3000.
[2026-09-29 12:00:00] INFO  Domain: https://earth.hidenfree.com
```

The port is taken automatically from Pterodactyl's `PORT` variable — nothing to
configure.

---

## Console commands

Type these directly into the Pterodactyl console while the app is running.

| Command         | What it does                                                |
| --------------- | ----------------------------------------------------------- |
| `code`          | Generates a new **upload code** (`XXXX-XXXX`), invalidating the previous one |
| `delete`        | Generates a temporary **management code**, expires in 20 min |
| `status`        | Image count, storage used, and token state                   |
| `revoke upload` | Revokes the active upload code                              |
| `revoke delete` | Revokes the active management code                          |
| `revoke all`    | Revokes everything                                          |
| `help`          | Lists all commands                                          |

```
> code
Upload code: KFY3-88LF
Upload page: https://earth.hidenfree.com/

> delete
Management code: 5XM5-SLU5
Management URL: https://earth.hidenfree.com/manage
Expires in 20 minutes.

> status
Images: 37
Storage used: 428 MB
Upload code: active, no expiry, issued 2026-09-29 12:00:00 UTC
Management token: active, expires in ~20 min
```

These run through a readline interface that never blocks the HTTP server.

---

## Workflow

1. `code` in the console -> get an upload code.
2. Open `https://earth.hidenfree.com/`, paste the code, pick a file, optionally
   set a custom link, press **Upload**.
3. Copy the **Direct URL**, **Markdown** or **HTML** snippet.
4. Use it anywhere: `![image](https://earth.hidenfree.com/i/example)`
5. Later, run `delete` in the console -> open `/manage` -> enter the code ->
   view, copy or delete images.


---

## Project structure

```
index.js               entry point: config -> DB -> tables -> HTTP -> console
config.json            local config (gitignored, never exposed)
config.example.json    template to copy
package.json
src/
  config.js            loads + validates config.json
  db.js                mysql2 pool, table creation, migrations
  store.js             all SQL (images + tokens)
  server.js            Express app, routes, auth
  session.js           signed HttpOnly session cookies
  security.js          crypto-random codes/ids, hashing
  images.js            magic-byte sniffing, filename sanitising
  console.js           console command handling
  logger.js            timestamped console output
public/                frontend (index.html, manage.html, styles.css, *.js)
uploads/               stored image files
scripts/selftest.js    81-check end-to-end test suite (dev only)
```

---

## Security model

- **Two separate credentials.** `upload` and `management` are different token
  types. An upload code cannot delete; a management code cannot upload. This is
  enforced server-side on every request.
- **Tokens are hashed.** Only a SHA-256 hash is stored; the plaintext is shown
  once in the console. Codes use `crypto.randomBytes` with rejection sampling so
  every character is uniformly distributed.
- **Sessions** are HMAC-signed, `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS,
  and bound to the management token row id, so revoking the code kills sessions
  immediately.
- **Content is sniffed, not trusted.** File type comes from magic bytes, so a
  shell script renamed `.png` is rejected with 415.
- **Random internal filenames** (32 hex chars). The public slug is never used as
  a filesystem path.
- **Slugs** are restricted to `[A-Za-z0-9_-]{1,64}` with reserved words blocked,
  so path traversal and slash injection are impossible. All SQL uses prepared
  statements.
- **Secrets** never leave the server: `config.json`, `.session-secret`,
  `package.json` and `/src` are all explicitly 404'd.


---

## Database schema

Created automatically on startup (idempotent, plus additive column migrations).

**`images`** — `id`, `public_id` (unique), `original_filename`,
`stored_filename`, `custom_slug` (unique, nullable), `mime_type`, `byte_size`,
`upload_time`, with indexes on `public_id`, `custom_slug` and `upload_time`.

**`tokens`** — `id`, `token_hash` (unique), `type` ENUM(`upload`,`management`),
`created_at`, `expires_at`, `revoked_at`, `last_used_at`.

Image bytes are **never** stored in the database — only metadata. Files live in
`uploads/` and persist across restarts.

---

## Tests

```bash
node scripts/selftest.js
```

Runs 81 end-to-end checks against an in-memory database stand-in: token
separation and revocation, expiry, magic-byte validation, slug safety, path
traversal, secret exposure, direct image serving, and deletion (including a
missing physical file).

---

## Configuration options

All optional except `domain`; defaults shown.

| Key                         | Default                    | Meaning                   |
| --------------------------- | -------------------------- | ------------------------- |
| `domain`                    | —                          | **Required.** Public base URL |
| `port`                      | `null`                     | Leave as `null` on Pterodactyl — the panel's `PORT` is used automatically |
| `uploadsDir`                | `uploads`                  | Where files are stored    |
| `maxFileSizeMb`             | `25`                       | Upload size limit         |
| `allowSvg`                  | `false`                    | SVG is off by default     |
| `publicIdLength`            | `6`                        | Random URL id length      |
| `managementTokenTtlMinutes` | `20`                       | Management code lifetime  |
| `uploadTokenTtlHours`       | `null`                     | `null` = never expires    |
| `trustProxy`                | `false`                    | Enable if behind a proxy  |

### About `"port": null`

**Leave it as `null`.** The port is resolved automatically in this order:

1. **Pterodactyl's `PORT`** — used whenever present. This is the port the panel
   actually routes traffic to, so it always wins.
2. **`"port"` in config.json** — only used when there is no `PORT` in the
   environment (e.g. running locally on your own machine).
3. **`3000`** — last-resort default.

If you set `"port"` to something that disagrees with the Pterodactyl-assigned
port, the app ignores your value, uses the Pterodactyl one, and prints a warning,
because using the wrong port would make the domain stop working.

The resolved port and its source are shown at startup and in the `status` command.
