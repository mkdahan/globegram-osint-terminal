/**
 * Personal-account Telegram client (GramJS / MTProto — the Node.js equivalent
 * of Telethon used in the reference project).
 *
 * Auth state machine driven from the UI:
 *   1. UI supplies api_id/api_hash once (stored outside repo via secureStore)
 *   2. UI calls beginLogin(phone)  -> Telegram sends a code
 *   3. UI calls submitCode(code)   -> success, or 'password_needed' (2FA)
 *   4. UI calls submitPassword(pw) -> success
 * On success the StringSession is persisted in %LOCALAPPDATA% (never in repo).
 */
'use strict';

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const secureStore = require('../secureStore');

class TelegramService {
  constructor() {
    this.client = null;
    this._loginPromise = null;
    this._pendingCode = null; // {resolve}
    this._pendingPassword = null; // {resolve}
    this._authState = 'idle'; // idle|connecting|wait_code|wait_password|authorized|error
    this._authError = null;
    this.onAuthStateChange = null; // callback(state)
  }

  _setState(state, error = null) {
    this._authState = state;
    this._authError = error;
    if (this.onAuthStateChange) {
      this.onAuthStateChange({ state, error });
    }
  }

  get authState() {
    return { state: this._authState, error: this._authError };
  }

  async _ensureClient() {
    if (this.client) return this.client;
    const { apiId, apiHash } = secureStore.loadTelegramCredentials();
    if (!apiId || !apiHash) {
      throw new Error('Missing Telegram api_id / api_hash. Save them first (my.telegram.org).');
    }
    const session = new StringSession(secureStore.loadSession());
    this.client = new TelegramClient(session, Number(apiId), apiHash, {
      connectionRetries: 5,
    });
    return this.client;
  }

  /** Connect with a stored session. Returns true if already authorized. */
  async connect() {
    const client = await this._ensureClient();
    if (!client.connected) {
      this._setState('connecting');
      await client.connect();
    }
    const authorized = await client.checkAuthorization();
    this._setState(authorized ? 'authorized' : 'idle');
    return authorized;
  }

  /**
   * Start the interactive login. Resolves the code/password from UI events.
   * Never throws directly into the caller: state changes are broadcast.
   */
  async beginLogin(phone) {
    const client = await this._ensureClient();
    if (!client.connected) await client.connect();
    if (await client.checkAuthorization()) {
      this._setState('authorized');
      return;
    }
    this._setState('wait_code');
    this._loginPromise = client
      .start({
        phoneNumber: async () => phone.trim(),
        phoneCode: async () =>
          new Promise((resolve) => {
            this._pendingCode = { resolve };
            this._setState('wait_code');
          }),
        password: async () =>
          new Promise((resolve) => {
            this._pendingPassword = { resolve };
            this._setState('wait_password');
          }),
        onError: (err) => {
          console.error('[tg-auth]', err.message);
          this._setState('error', err.message);
        },
      })
      .then(() => {
        secureStore.saveSession(client.session.save());
        this._setState('authorized');
      })
      .catch((err) => {
        this._setState('error', err.message);
      });
  }

  submitCode(code) {
    if (!this._pendingCode) throw new Error('No pending login code. Click "Send code" again.');
    this._pendingCode.resolve(String(code).trim());
    this._pendingCode = null;
  }

  submitPassword(password) {
    if (!this._pendingPassword) throw new Error('No pending 2FA password prompt.');
    this._pendingPassword.resolve(String(password));
    this._pendingPassword = null;
  }

  async isAuthorized() {
    if (!this.client || !this.client.connected) return false;
    try {
      return await this.client.checkAuthorization();
    } catch {
      return false;
    }
  }

  async logout() {
    try {
      if (this.client) {
        await this.client.invoke(
          new (require('telegram').Api.auth.LogOut)()
        );
        await this.client.disconnect();
      }
    } catch (err) {
      console.warn('[tg-logout]', err.message);
    }
    this.client = null;
    secureStore.wipeSession();
    this._setState('idle');
  }

  async disconnect() {
    try {
      if (this.client) await this.client.disconnect();
    } catch {
      /* best effort */
    }
  }
}

module.exports = { TelegramService };
