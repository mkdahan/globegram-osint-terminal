/**
 * Chat manager: list dialogs (channels/groups/supergroups), subscribe to
 * live messages on the user's monitored chats, and download media
 * (immediately for high-priority events, on-demand otherwise).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { NewMessage } = require('telegram/events');
const { MEDIA_DIR, ensureDataDirs } = require('../paths');

const MAX_MEDIA_BYTES = 200 * 1024 * 1024; // skip anything above 200 MB

class ChatManager {
  constructor(telegramService) {
    this.tg = telegramService;
    this.monitored = new Set(); // chat id strings
    this.onEvent = null; // callback(payload) — raw message event
    this._handlerAttached = false;
    this._chatTitles = new Map();
  }

  setMonitored(ids) {
    this.monitored = new Set((ids || []).map(String));
  }

  /** List all dialogs the account participates in. */
  async listDialogs() {
    const client = this.tg.client;
    if (!client || !(await this.tg.isAuthorized())) {
      throw new Error('Telegram not logged in — send code and sign in first');
    }
    const dialogs = await client.getDialogs({ limit: 500 });
    const out = [];
    for (const d of dialogs) {
      let kind = 'chat';
      if (d.isChannel) kind = d.entity && d.entity.megagroup ? 'supergroup' : 'channel';
      else if (d.isGroup) kind = 'group';
      else if (d.isUser) kind = 'user';
      const id = String(d.id);
      const title = d.title || d.name || 'Untitled';
      this._chatTitles.set(id, title);
      out.push({ id, title, kind, unread: d.unreadCount || 0 });
    }
    // Channels and groups first, alphabetical inside each kind
    const rank = { channel: 0, supergroup: 1, group: 2, user: 3, chat: 4 };
    out.sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.title.localeCompare(b.title));
    return out;
  }

  /** Attach the live NewMessage handler (idempotent). */
  startListening() {
    const client = this.tg.client;
    if (!client || this._handlerAttached) return;
    client.addEventHandler(async (event) => {
      try {
        await this._handleNewMessage(event);
      } catch (err) {
        console.error('[chatManager] message handler error:', err);
      }
    }, new NewMessage({}));
    this._handlerAttached = true;
  }

  async _handleNewMessage(event) {
    const msg = event.message;
    if (!msg) return;
    const chatId = String(msg.chatId != null ? msg.chatId : (msg.peerId && msg.peerId.channelId) || '');
    if (!this.monitored.has(chatId)) return;

    const text = msg.message || '';
    const media = this._mediaInfo(msg);
    const payload = {
      key: `${chatId}:${msg.id}`,
      chatId,
      chatTitle: this._chatTitles.get(chatId) || chatId,
      msgId: msg.id,
      date: (msg.date || Math.floor(Date.now() / 1000)) * 1000, // ms epoch
      text,
      media, // {kind, mime, size} or null
    };
    if (this.onEvent) this.onEvent(payload, msg);
  }

  _mediaInfo(msg) {
    if (msg.photo) {
      return { kind: 'photo', mime: 'image/jpeg', size: null };
    }
    if (msg.video || (msg.document && (msg.document.mimeType || '').startsWith('video'))) {
      const size = msg.document ? Number(msg.document.size || 0) : null;
      return { kind: 'video', mime: (msg.document && msg.document.mimeType) || 'video/mp4', size };
    }
    if (msg.document) {
      const mime = msg.document.mimeType || '';
      let kind = 'file';
      if (mime.startsWith('image')) kind = 'photo';
      else if (mime.startsWith('audio')) kind = 'audio';
      return { kind, mime, size: Number(msg.document.size || 0) };
    }
    return null;
  }

  /**
   * Download media of a message to the local media dir (outside repo).
   * Returns absolute file path or null.
   */
  async downloadMedia(chatId, msgId) {
    const client = this.tg.client;
    if (!client) throw new Error('Not connected');
    ensureDataDirs();

    const msgs = await client.getMessages(chatId, { ids: [Number(msgId)] });
    const msg = msgs && msgs[0];
    if (!msg || !msg.media) return null;

    const info = this._mediaInfo(msg) || { kind: 'file', mime: '' };
    if (info.size && info.size > MAX_MEDIA_BYTES) {
      throw new Error(`Media too large (${Math.round(info.size / 1e6)} MB), skipping`);
    }

    const ext =
      info.kind === 'photo' ? 'jpg'
      : info.kind === 'video' ? 'mp4'
      : (info.mime.split('/')[1] || 'bin');
    const fileName = `${String(chatId).replace(/[^\w-]/g, '')}_${msgId}.${ext}`;
    const outPath = path.join(MEDIA_DIR, fileName);
    if (fs.existsSync(outPath)) return outPath;

    const buffer = await client.downloadMedia(msg, {});
    if (!buffer || !buffer.length) return null;
    fs.writeFileSync(outPath, buffer);
    return outPath;
  }
}

module.exports = { ChatManager };
