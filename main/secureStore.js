/**
 * Secrets stored OUTSIDE the project folder (never in git / OneDrive app dir).
 *
 * Location: %LOCALAPPDATA%\globegram-terminal\secrets.json
 * Holds: tg_api_id, tg_api_hash, tg_session (StringSession).
 * Never return secret values to the renderer — booleans only.
 */
'use strict';

const fs = require('fs');
const { SECRETS_PATH, ensureDataDirs } = require('./paths');

function readAll() {
  ensureDataDirs();
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureDataDirs();
  const tmp = SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, SECRETS_PATH);
  try {
    fs.chmodSync(SECRETS_PATH, 0o600);
  } catch {
    /* windows: best effort */
  }
}

function getSecret(name) {
  const val = readAll()[name];
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

function setSecret(name, value) {
  const data = readAll();
  data[name] = String(value || '').trim();
  writeAll(data);
}

function deleteSecret(name) {
  const data = readAll();
  if (name in data) {
    delete data[name];
    writeAll(data);
  }
}

function saveTelegramCredentials(apiId, apiHash) {
  setSecret('tg_api_id', String(apiId));
  setSecret('tg_api_hash', String(apiHash));
}

function loadTelegramCredentials() {
  return { apiId: getSecret('tg_api_id'), apiHash: getSecret('tg_api_hash') };
}

function saveSession(sessionString) {
  setSecret('tg_session', sessionString);
}

function loadSession() {
  return getSecret('tg_session') || '';
}

function wipeSession() {
  deleteSecret('tg_session');
}

/** Booleans only — safe to ship to the UI. */
function secretsStatus() {
  const { apiId, apiHash } = loadTelegramCredentials();
  return {
    secretsPath: SECRETS_PATH,
    hasApiId: Boolean(apiId),
    hasApiHash: Boolean(apiHash),
    hasSession: Boolean(loadSession()),
  };
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  saveTelegramCredentials,
  loadTelegramCredentials,
  saveSession,
  loadSession,
  wipeSession,
  secretsStatus,
};
