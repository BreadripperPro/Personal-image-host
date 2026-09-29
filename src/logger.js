'use strict';

// Tiny console logger with timestamps + levels. No external dependency needed.
const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';

function paint(color, text) {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : String(text);
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, color, args) {
  const prefix = `${paint('gray', `[${stamp()}]`)} ${paint(color, level.padEnd(5))}`;
  const stream = level === 'ERROR' ? console.error : console.log;
  stream(prefix, ...args);
}

const logger = {
  info: (...a) => emit('INFO', 'green', a),
  warn: (...a) => emit('WARN', 'yellow', a),
  error: (...a) => emit('ERROR', 'red', a),
  debug: (...a) => {
    if (process.env.DEBUG === '1') emit('DEBUG', 'cyan', a);
  },
  plain: (...a) => console.log(...a),
  colors: COLORS,
  paint
};

module.exports = logger;
