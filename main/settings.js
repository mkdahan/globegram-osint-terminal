/**
 * Non-secret user settings persisted OUTSIDE the repo
 * (%LOCALAPPDATA%\globegram-terminal\settings.json):
 * monitored channel ids, chart tickers, queue interval, etc.
 */
'use strict';

const fs = require('fs');
const { SETTINGS_PATH, ensureDataDirs } = require('./paths');

const DEFAULTS = {
  monitoredChats: [],
  tickers: ['GLD'],
  cameraQueueIntervalSec: 4,
  moversRefreshSec: 60,
  liveCandleRefreshSec: 15,
  downloadAllMedia: false,
  // what to look for in messages
  watch: { places: true, companies: true },
  // which ingest streams are live
  sources: { telegram: true, darknet: false },
  // Darknet / CTI module (optional; clearnet RSS works without Tor)
  darknet: {
    enabled: true, // honored only when sources.darknet is true
    pollMinutes: 5,
    minSeverity: 'MEDIUM',
    useTor: false,
    torProxy: 'socks5h://127.0.0.1:9050',
  },
  // alarm (siren + desktop notification) on any place/company match
  alarms: false,
  // automatically mount a matched company's chart
  autoChartCompany: false,
  // UI panel visibility
  ui: { sidebarOpen: true, chartsOpen: true },
  // Minimum seconds a place-bubble / message stays visible on the globe
  popupMinSec: 6,
  // named monitoring profiles
  profiles: {},
};

function load() {
  ensureDataDirs();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return { ...DEFAULTS, ...data };
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS };
}

function save(partial) {
  const cur = load();
  const merged = { ...cur, ...partial };
  // Deep-merge nested config objects so a partial update can't wipe keys
  for (const key of ['watch', 'sources', 'darknet', 'ui']) {
    if (partial[key] && typeof partial[key] === 'object') {
      merged[key] = { ...(cur[key] || DEFAULTS[key] || {}), ...partial[key] };
    }
  }
  ensureDataDirs();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

module.exports = { load, save, DEFAULTS };
