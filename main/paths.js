/**
 * Filesystem layout.
 *
 * ALL runtime data (secrets, telegram session, settings, downloaded media,
 * gazetteer build) lives OUTSIDE the repo, under %LOCALAPPDATA%\globegram-terminal.
 * This keeps the repo safe to publish on GitHub and keeps SQLite/large files
 * off OneDrive (OneDrive file locking causes corruption/freezes).
 * Override the data dir with env GLOBEGRAM_DATA_DIR.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.dirname(__dirname);

const localAppData =
  process.env.GLOBEGRAM_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'globegram-terminal');

const DATA_DIR = localAppData;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SESSION_PATH = path.join(DATA_DIR, 'session.txt');
const GAZETTEER_PATH = path.join(DATA_DIR, 'gazetteer.json');
const BUNDLED_GAZETTEER_PATH = path.join(ROOT, 'main', 'geocoder', 'bundled-gazetteer.json');
const SEED_GAZETTEER_PATH = path.join(ROOT, 'main', 'geocoder', 'seed-gazetteer.json');
const COMPANIES_PATH = path.join(DATA_DIR, 'companies.json');
const BUNDLED_COMPANIES_PATH = path.join(ROOT, 'main', 'corporate', 'bundled-companies.json');
const SEED_COMPANIES_PATH = path.join(ROOT, 'main', 'corporate', 'seed-companies.json');
const SYNC_STATE_PATH = path.join(DATA_DIR, 'sync-state.json');
const DECISIONS_LOG_PATH = path.join(DATA_DIR, 'decisions.jsonl');

function ensureDataDirs() {
  for (const p of [DATA_DIR, MEDIA_DIR]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

module.exports = {
  ROOT,
  DATA_DIR,
  MEDIA_DIR,
  SECRETS_PATH,
  SETTINGS_PATH,
  SESSION_PATH,
  GAZETTEER_PATH,
  BUNDLED_GAZETTEER_PATH,
  SEED_GAZETTEER_PATH,
  COMPANIES_PATH,
  BUNDLED_COMPANIES_PATH,
  SEED_COMPANIES_PATH,
  SYNC_STATE_PATH,
  DECISIONS_LOG_PATH,
  ensureDataDirs,
};
