/**
 * Append-only decision log for overnight review.
 * Each processed message → one JSON line describing what the pipeline
 * extracted and how it chose to present it on the globe.
 *
 * File: %LOCALAPPDATA%\globegram-terminal\decisions.jsonl
 * Rotates to decisions.jsonl.1 when larger than ~5 MB.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDirs } = require('./paths');

const LOG_PATH = path.join(DATA_DIR, 'decisions.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_PATH).size > MAX_BYTES) {
      const bak = `${LOG_PATH}.1`;
      try { fs.unlinkSync(bak); } catch { /* ignore */ }
      fs.renameSync(LOG_PATH, bak);
    }
  } catch {
    /* no file yet */
  }
}

/**
 * @param {object} row
 */
function logDecision(row) {
  try {
    ensureDataDirs();
    rotateIfNeeded();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...row,
    });
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8');
  } catch (err) {
    console.warn('[decisionLog]', err.message);
  }
}

module.exports = { logDecision, LOG_PATH };
