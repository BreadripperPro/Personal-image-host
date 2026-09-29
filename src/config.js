'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const PLACEHOLDER_VALUES = new Set([
  'your_database_username',
  'your_database_password',
  'your_database_name',
  'your_password',
  'your_username',
  'password',
  'changeme',
  'change_me',
  'todo',
  ''
]);

class ConfigError extends Error {}

function looksLikePlaceholder(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim().toLowerCase();
  if (PLACEHOLDER_VALUES.has(v)) return true;
  return v.includes('your_') || v.includes('xxx') || v.includes('<') || v.includes('example');
}

function normalizeDomain(domain) {
  if (!domain) return '';
  let d = String(domain).trim();
  if (!d) return '';
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  return d.replace(/\/+$/, '');
}

function readConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        `Configuration file not found: ${filePath}\n` +
          `Create it by copying config.example.json -> config.json and filling in your\n` +
          `database username and password from the Pterodactyl database panel.`
      );
    }
    throw new ConfigError(`Could not read ${filePath}: ${err.message}`);
  }

  try {
    // Strip a UTF-8 BOM if present (Windows editors add one silently).
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

function validate(fileConfig) {
  const errors = [];
  const db = fileConfig.database;

  if (!db || typeof db !== 'object') {
    errors.push('"database" section is missing.');
  } else {
    if (!db.host) errors.push('"database.host" is missing.');
    if (!db.database) errors.push('"database.database" is missing.');
    if (looksLikePlaceholder(db.user)) {
      errors.push('"database.user" still contains a placeholder value.');
    }
    if (looksLikePlaceholder(db.password)) {
      errors.push('"database.password" still contains a placeholder value.');
    }
  }

  if (!normalizeDomain(fileConfig.domain)) {
    errors.push('"domain" is missing (example: https://earth.hidenfree.com).');
  }

  return errors;
}

/**
 * Resolve the listening port.
 *
 * Priority: Pterodactyl's assigned PORT wins, because that is the port the
 * panel actually routes traffic to. An explicit "port" in config.json is only
 * used when there is no PORT in the environment (local runs, non-Pterodactyl
 * hosts). Returns { port, source, conflict }.
 */
function resolvePort(filePort, env) {
  const envPort = Number(env.PORT || env.SERVER_PORT);
  const hasEnvPort = Number.isInteger(envPort) && envPort > 0;
  const explicit = Number(filePort);
  const hasFilePort = Number.isInteger(explicit) && explicit > 0;

  if (hasEnvPort) {
    return {
      port: envPort,
      source: 'Pterodactyl PORT',
      conflict: hasFilePort && explicit !== envPort ? explicit : null
    };
  }
  if (hasFilePort) {
    return { port: explicit, source: 'config.json "port"', conflict: null };
  }
  return { port: 3000, source: 'default', conflict: null };
}

function load() {
  const fileConfig = readConfigFile(CONFIG_PATH);

  if (typeof fileConfig !== 'object' || fileConfig === null || Array.isArray(fileConfig)) {
    throw new ConfigError(`${CONFIG_PATH} must contain a JSON object.`);
  }

  const errors = validate(fileConfig);
  if (errors.length) {
    throw new ConfigError(
      `Invalid configuration in ${CONFIG_PATH}:\n` +
        errors.map((e) => `  - ${e}`).join('\n') +
        `\n\nFix config.json (see config.example.json) and restart the server.`
    );
  }

  const db = fileConfig.database;
  const uploadsDir = path.resolve(ROOT_DIR, fileConfig.uploadsDir || 'uploads');

  return {
    rootDir: ROOT_DIR,
    configPath: CONFIG_PATH,
    database: {
      host: db.host,
      port: Number(db.port) || 3306,
      database: db.database,
      user: db.user,
      password: db.password,
      connectionLimit: Number(db.connectionLimit) || 10,
      connectTimeout: Number(db.connectTimeout) || 10000
    },
    domain: normalizeDomain(fileConfig.domain),
    // Kept verbatim; index.js resolves the final value via resolvePort().
    port: fileConfig.port === undefined ? null : fileConfig.port,
    uploadsDir,
    publicDir: path.join(ROOT_DIR, 'public'),
    maxFileSizeBytes: Math.round((Number(fileConfig.maxFileSizeMb) || 25) * 1024 * 1024),
    allowSvg: fileConfig.allowSvg === true,
    publicIdLength: Math.min(Math.max(Number(fileConfig.publicIdLength) || 6, 4), 16),
    managementTokenTtlMinutes: Math.max(Number(fileConfig.managementTokenTtlMinutes) || 20, 1),
    uploadTokenTtlHours:
      fileConfig.uploadTokenTtlHours === null || fileConfig.uploadTokenTtlHours === undefined
        ? null
        : Math.max(Number(fileConfig.uploadTokenTtlHours), 1),
    trustProxy: fileConfig.trustProxy === true,
    sessionSecretFile: path.join(ROOT_DIR, '.session-secret')
  };
}

function ensureUploadsDir(uploadsDir) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  // Hard guarantee that nothing in the uploads folder is ever served as HTML/JS.
  const guard = path.join(uploadsDir, '.htaccess');
  if (!fs.existsSync(guard)) {
    fs.writeFileSync(guard, 'Options -Indexes\nRemoveHandler .php .phtml .pl .py .cgi\n');
  }
  const readme = path.join(uploadsDir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, 'Uploaded images are stored here. Files are served only via /i/:id.\n');
  }
}

module.exports = { load, ensureUploadsDir, normalizeDomain, resolvePort, ConfigError, CONFIG_PATH, ROOT_DIR };
