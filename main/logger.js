/**
 * File logger: mirrors all console output of the main process (including
 * GramJS logs and uncaught errors) to %LOCALAPPDATA%\globegram-terminal\app.log
 * so problems can be diagnosed from the file instead of a live terminal.
 * Rotates to app.log.1 when the file exceeds 1 MB.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const LOG_PATH = path.join(DATA_DIR, 'app.log');
const MAX_BYTES = 1024 * 1024;

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function install() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > MAX_BYTES) {
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`); // keep one previous log
      }
    } catch {
      /* no log yet */
    }
    const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

    for (const level of ['log', 'info', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        orig(...args);
        try {
          stream.write(`${new Date().toISOString()} [${level}] ${args.map(fmt).join(' ')}\n`);
        } catch {
          /* never break the app over logging */
        }
      };
    }

    process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
    process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

    console.log(`[logger] session start — writing to ${LOG_PATH}`);
  } catch (err) {
    console.warn('[logger] file logging disabled:', err.message);
  }
  return LOG_PATH;
}

module.exports = { install, LOG_PATH };
