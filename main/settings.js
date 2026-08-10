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
  // alarm (siren + desktop notification) on any place/company match
  alarms: false,
  // automatically mount a matched company's chart
  autoChartCompany: false,
  // named monitoring profiles: { name: {monitoredChats, tickers, watch, alarms, autoChartCompany} }
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
  const merged = { ...load(), ...partial };
  ensureDataDirs();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

module.exports = { load, save, DEFAULTS };
