'use strict';

const readline = require('readline');
const store = require('./store');
const db = require('./db');
const logger = require('./logger');
const { formatBytes } = require('./images');

function createConsoleHandler(config) {
  const out = logger.paint.bind(logger);
  const bold = (t) => out('cyan', t);
  const ok = (t) => out('green', t);
  const warn = (t) => out('yellow', t);

  function banner() {
    logger.plain('');
    logger.plain(bold('Image host console'));
    logger.plain(bold('  code') + '              Generate a new upload code');
    logger.plain(bold('  delete') + '            Generate a temporary management code');
    logger.plain(bold('  status') + '            Show images, storage and token state');
    logger.plain(bold('  revoke upload') + '    Revoke the active upload code');
    logger.plain(bold('  revoke delete') + '    Revoke the active management code');
    logger.plain(bold('  revoke all') + '       Revoke every code');
    logger.plain(bold('  help') + '              Show this help');
    logger.plain(warn('  ctrl+c stops the server (never touches the database or files)'));
    logger.plain('');
  }

  async function cmdCode() {
    const ttl = config.uploadTokenTtlHours;
    const code = await store.issueToken('upload', ttl ? ttl * 60 : 0);
    logger.plain('');
    logger.plain(ok('Upload code: ') + bold(code));
    logger.plain(warn('Upload page: ') + config.domain + '/');
    if (ttl) logger.plain(logger.paint('gray', `This code expires in ${ttl} hour(s).`));
    else logger.plain(logger.paint('gray', 'This code stays valid until you replace or revoke it.'));
    logger.plain(logger.paint('gray', 'Any previously issued upload code has been invalidated.'));
    logger.plain('');
  }

  async function cmdDelete() {
    const code = await store.issueToken('management', config.managementTokenTtlMinutes);
    logger.plain('');
    logger.plain(ok('Management code: ') + bold(code));
    logger.plain(warn('Management URL: ') + config.domain + '/manage');
    logger.plain(logger.paint('gray', `Expires in ${config.managementTokenTtlMinutes} minutes.`));
    logger.plain(logger.paint('gray', 'Any previously issued management code has been invalidated.'));
    logger.plain('');
  }

  async function cmdStatus() {
    const stats = await store.getStats();
    const upload = await store.getActiveToken('upload');
    const management = await store.getActiveToken('management');

    const describe = (token) => {
      if (!token) return warn('inactive');
      const bits = [ok('active')];
      if (token.expires_at) {
        const mins = Math.max(0, Math.round((new Date(token.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 60000));
        bits.push(`expires in ~${mins} min`);
      } else {
        bits.push('no expiry');
      }
      bits.push(`issued ${token.created_at} UTC`);
      return bits.join(', ');
    };

    logger.plain('');
    logger.plain(bold('Images: ') + stats.image_count);
    logger.plain(bold('Storage used: ') + formatBytes(stats.total_bytes));
    logger.plain(bold('Upload code: ') + describe(upload));
    logger.plain(bold('Management token: ') + describe(management));
    logger.plain(bold('Domain: ') + config.domain);
    logger.plain(bold('Port: ') + config.port);
    logger.plain('');
  }

  async function cmdRevoke(target) {
    const which = String(target || '').trim().toLowerCase();
    if (which === 'upload') {
      const n = await store.revokeToken('upload');
      logger.plain(ok('Upload code revoked.') + (n ? '' : logger.paint('gray', ' (no active code)')));
    } else if (which === 'delete' || which === 'management') {
      const n = await store.revokeToken('management');
      logger.plain(ok('Management token revoked.') + (n ? '' : logger.paint('gray', ' (no active code)')));
    } else if (which === 'all') {
      const a = await store.revokeToken('upload');
      const b = await store.revokeToken('management');
      logger.plain(ok(`Revoked ${a + b} token(s).`));
    } else {
      logger.plain(warn('Usage: revoke upload | revoke delete | revoke all'));
    }
  }

  async function dispatch(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    const [command, ...args] = trimmed.split(/\s+/);
    const verb = command.toLowerCase();

    try {
      switch (verb) {
        case 'code':
          return await cmdCode();
        case 'delete':
        case 'manage':
        case 'management':
          return await cmdDelete();
        case 'status':
        case 'stats':
          return await cmdStatus();
        case 'revoke':
          return await cmdRevoke(args.join(' '));
        case 'help':
        case '?':
          return banner();
        case 'clear':
          process.stdout.write('\x1b[2J\x1b[0f');
          return undefined;
        default:
          return logger.plain(warn(`Unknown command "${command}". Type "help" for the command list.`));
      }
    } catch (err) {
      logger.error(`Command "${verb}" failed: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Attach the console REPL. Runs detached from the main process so typing in
   * the Pterodactyl console never blocks the HTTP server.
   */
  function attach() {
    if (!process.stdin.isTTY && process.env.NO_CONSOLE === '1') return null;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
      prompt: ''
    });

    rl.on('line', (line) => {
      dispatch(line).catch(() => {});
      if (process.stdin.isTTY) rl.prompt();
    });

    rl.on('close', () => {
      // Pterodactyl closed the console stream: keep serving, just drop the REPL.
      logger.debug('Console input closed; continuing to serve HTTP.');
    });

    banner();
    return rl;
  }

  return { attach, dispatch, cmdStatus };
}

module.exports = { createConsoleHandler };
