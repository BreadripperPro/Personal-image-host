'use strict';

/**
 * Personal image host for Pterodactyl.
 *
 * Start with:  node index.js
 *
 * Configuration comes from ./config.json (never from Pterodactyl variables and
 * never from the environment). The listening port is taken automatically from
 * the Pterodactyl-assigned PORT when present.
 */

const configLoader = require('./src/config');
const logger = require('./src/logger');

function printFatal(title, message, extra) {
  const line = '='.repeat(64);
  console.error('');
  console.error(logger.paint('red', line));
  console.error(logger.paint('red', `  ${title}`));
  console.error(logger.paint('red', line));
  console.error(`  ${String(message).split('\n').join('\n  ')}`);
  if (extra) console.error(`\n${extra}`);
  console.error('');
}

async function main() {
  // ---- 1. Load configuration -------------------------------------------
  const config = configLoader.load();
  configLoader.ensureUploadsDir(config.uploadsDir);

  // ---- 2. Port ----------------------------------------------------------
  // Pterodactyl's assigned PORT is authoritative (the panel routes to it).
  // config.json "port" is only a fallback for non-Pterodactyl/local runs.
  const resolvedPort = configLoader.resolvePort(config.port, process.env);
  config.port = resolvedPort.port;
  config.host = process.env.HOST || '0.0.0.0';
  if (resolvedPort.conflict) {
    logger.warn(
      `Ignoring "port": ${resolvedPort.conflict} in config.json - Pterodactyl assigned PORT=${resolvedPort.port}, which is where traffic is routed.`
    );
  }

  // Load these after config is available (they need the resolved port/domain).
  const db = require('./src/db');
  const store = require('./src/store');
  const session = require('./src/session');
  const { createApp } = require('./src/server');
  const { createConsoleHandler } = require('./src/console');

  // ---- 3. Connect to MySQL/MariaDB -------------------------------------
  try {
    await db.connect(config.database);
  } catch (err) {
    printFatal(
      'DATABASE CONNECTION FAILED',
      err.message,
      `Check config.json -> database.host / database.port / database.database /\n` +
        `database.user / database.password (use the CURRENT, rotated password).\n` +
        `Also confirm the panel allows connections from this server's IP.`
    );
    process.exit(1);
  }

  // ---- 4. Create / migrate tables --------------------------------------
  try {
    await db.initializeSchema();
  } catch (err) {
    printFatal(
      'DATABASE INITIALISATION FAILED',
      err.message,
      'The database user needs CREATE / ALTER permission on this database.'
    );
    await db.close().catch(() => {});
    process.exit(1);
  }

  // ---- 5. Start the web server ------------------------------------------
  const secret = session.loadOrCreateSecret(config.sessionSecretFile);
  const app = createApp(config, secret);

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Web server running on port ${config.port} (${resolvedPort.source}).`);
    logger.info(`Domain: ${config.domain}`);
    logger.info(`Uploads directory: ${config.uploadsDir}`);
    logger.info(`Type "code" for an upload code, "delete" for a management code, "help" for all commands.`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      printFatal('PORT ALREADY IN USE', `Port ${config.port} is already in use.`, 'Stop the other process or restart the server.');
    } else {
      printFatal('SERVER FAILED TO START', err.message);
    }
    process.exit(1);
  });

  // Keep-alive tweaks for reverse proxies / CDNs in front of Pterodactyl.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---- 6. Console commands ----------------------------------------------
  const consoleHandler = createConsoleHandler(config);
  consoleHandler.attach();

  // ---- 7. Graceful shutdown ---------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      db.close()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    // Never hang the container stop.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err && err.message ? err.message : err);
  });
}

main().catch((err) => {
  printFatal('STARTUP FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
