/**
 * Chat manager: list dialogs, subscribe to live messages, poll as backup,
 * download media. Chat IDs are normalized across GramJS forms
 * (-100… vs bare channel id) so monitored channels actually receive events.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { NewMessage } = require('telegram/events');
const { MEDIA_DIR, ensureDataDirs } = require('../paths');

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const POLL_MS = 12_000;
const POLL_LIMIT = 15;

/** Canonical string form (no BigInt "n" suffix, trimmed). */
function canonId(id) {
  if (id == null || id === '') return '';
  let s = typeof id === 'bigint' ? id.toString() : String(id);
  if (s.endsWith('n')) s = s.slice(0, -1);
  return s.trim();
}

/**
 * All equivalent IDs GramJS / Bot API may use for the same chat.
 * Channels: -100XXXXXXXXXX ↔ XXXXXXXXXX
 */
function chatIdAliases(id) {
  const s = canonId(id);
  const out = new Set();
  if (!s) return out;
  out.add(s);
  if (/^-100\d+$/.test(s)) {
    out.add(s.slice(4));
    out.add('-' + s.slice(4));
  } else if (/^\d+$/.test(s)) {
    out.add('-100' + s);
    out.add('-' + s);
  } else if (/^-\d+$/.test(s) && !s.startsWith('-100')) {
    const bare = s.slice(1);
    out.add(bare);
    out.add('-100' + bare);
  }
  return out;
}

class ChatManager {
  constructor(telegramService) {
    this.tg = telegramService;
    this.monitored = new Set(); // all aliases of selected chats
    this._monitoredPrimary = []; // original ids from UI
    this.onEvent = null;
    this._handlerAttached = false;
    this._chatTitles = new Map(); // any alias -> title
    this._seen = new Set(); // chatId:msgId already emitted
    this._lastMsgId = new Map(); // primary chat id -> highest msg id polled
    this._pollTimer = null;
    this.stats = { received: 0, emitted: 0, skippedUnmonitored: 0, lastText: '', lastChat: '', lastAt: 0 };
  }

  setMonitored(ids) {
    this._monitoredPrimary = (ids || []).map(canonId).filter(Boolean);
    this.monitored = new Set();
    for (const id of this._monitoredPrimary) {
      for (const a of chatIdAliases(id)) this.monitored.add(a);
    }
    console.log(`[chatManager] monitoring ${this._monitoredPrimary.length} chats (${this.monitored.size} id aliases)`);
    this.startPolling();
  }

  isMonitored(id) {
    return chatIdAliases(id).some((a) => this.monitored.has(a));
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
      const id = canonId(d.id);
      const title = d.title || d.name || 'Untitled';
      for (const a of chatIdAliases(id)) this._chatTitles.set(a, title);
      out.push({ id, title, kind, unread: d.unreadCount || 0 });
    }
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
        await this._handleNewMessage(event.message, 'live');
      } catch (err) {
        console.error('[chatManager] message handler error:', err);
      }
    }, new NewMessage({}));
    this._handlerAttached = true;
    console.log('[chatManager] live NewMessage handler attached');
    this.startPolling();
  }

  /** Backup poll — GramJS update gaps happen; this catches missed posts. */
  startPolling() {
    if (!this._monitoredPrimary.length) return;
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => {
        this.pollMonitored().catch((err) => console.error('[chatManager] poll error:', err.message));
      }, POLL_MS);
      console.log(`[chatManager] poll backup every ${POLL_MS / 1000}s`);
    }
    // Kick a poll soon (entity cache may not be ready at app boot)
    setTimeout(() => {
      this.pollMonitored().catch(() => {});
    }, 1500);
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /** Resolve a dialog id GramJS will accept (try aliases). */
  async _fetchMessages(chatId, opts) {
    const client = this.tg.client;
    const tried = [];
    for (const id of [canonId(chatId), ...chatIdAliases(chatId)]) {
      if (!id || tried.includes(id)) continue;
      tried.push(id);
      try {
        return await client.getMessages(id, opts);
      } catch (err) {
        if (/ENTITY|PEER|Could not find/i.test(err.message || '')) continue;
        throw err;
      }
    }
    throw new Error(`no entity for chat ${chatId} (tried ${tried.join(',')})`);
  }

  async pollMonitored() {
    const client = this.tg.client;
    if (!client || !(await this.tg.isAuthorized())) return;
    if (!this._monitoredPrimary.length) return;

    for (const chatId of this._monitoredPrimary) {
      try {
        const minId = this._lastMsgId.get(chatId) || 0;
        const msgs = await this._fetchMessages(chatId, { limit: POLL_LIMIT });
        if (!msgs || !msgs.length) continue;
        // oldest → newest so feed order is natural
        const ordered = [...msgs].reverse();
        for (const msg of ordered) {
          if (!msg || !msg.id) continue;
          if (msg.id <= minId) continue;
          await this._handleNewMessage(msg, 'poll');
          this._lastMsgId.set(chatId, Math.max(this._lastMsgId.get(chatId) || 0, msg.id));
        }
        // Track high-water even if all were seen
        const top = Math.max(...msgs.map((m) => m.id || 0));
        if (top) this._lastMsgId.set(chatId, Math.max(this._lastMsgId.get(chatId) || 0, top));
      } catch (err) {
        console.warn(`[chatManager] poll ${chatId}:`, err.message);
      }
    }
  }

  _resolveChatId(msg) {
    if (!msg) return '';
    if (msg.chatId != null) return canonId(msg.chatId);
    const peer = msg.peerId;
    if (!peer) return '';
    if (peer.channelId != null) {
      // Bare channel id → Bot API style
      return canonId('-100' + String(peer.channelId));
    }
    if (peer.chatId != null) return canonId(-Number(peer.chatId));
    if (peer.userId != null) return canonId(peer.userId);
    return '';
  }

  async _handleNewMessage(msg, source) {
    if (!msg) return;
    this.stats.received++;

    const chatId = this._resolveChatId(msg);
    if (!chatId) return;

    if (!this.isMonitored(chatId)) {
      this.stats.skippedUnmonitored++;
      // Occasional log so we can diagnose ID mismatches
      if (this.stats.skippedUnmonitored <= 5 || this.stats.skippedUnmonitored % 50 === 0) {
        console.log(
          `[chatManager] skip unmonitored chatId=${chatId} ` +
          `(aliases=[...${[...chatIdAliases(chatId)].join(',')}] source=${source})`
        );
      }
      return;
    }

    const text = (msg.message || msg.text || '').trim();
    const media = this._mediaInfo(msg);
    // Deduplicate live vs poll
    const primaryKey = `${[...chatIdAliases(chatId)][0]}:${msg.id}`;
    const dedupeKeys = [...chatIdAliases(chatId)].map((a) => `${a}:${msg.id}`);
    if (dedupeKeys.some((k) => this._seen.has(k))) return;
    for (const k of dedupeKeys) {
      this._seen.add(k);
      if (this._seen.size > 5000) {
        // drop oldest-ish: reset when huge
        this._seen = new Set([...this._seen].slice(-2000));
      }
    }

    // Advance poll watermark for this chat
    for (const id of this._monitoredPrimary) {
      if (chatIdAliases(id).has(canonId(chatId))) {
        this._lastMsgId.set(id, Math.max(this._lastMsgId.get(id) || 0, msg.id));
      }
    }

    const payload = {
      key: primaryKey,
      chatId: canonId(chatId),
      chatTitle: this._chatTitles.get(canonId(chatId)) || this._chatTitles.get(String(msg.chatId)) || chatId,
      msgId: msg.id,
      date: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      text,
      media,
      source,
    };

    this.stats.emitted++;
    this.stats.lastText = text.slice(0, 120);
    this.stats.lastChat = payload.chatTitle;
    this.stats.lastAt = Date.now();

    if (this.stats.emitted <= 20 || this.stats.emitted % 25 === 0) {
      console.log(
        `[chatManager] emit #${this.stats.emitted} [${source}] ${payload.chatTitle}: ` +
        `${(text || '(media)').slice(0, 80)}`
      );
    }

    if (this.onEvent) this.onEvent(payload, msg);
  }

  get emitted() {
    return this.stats.emitted;
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

  async downloadMedia(chatId, msgId) {
    const client = this.tg.client;
    if (!client) throw new Error('Not connected');
    ensureDataDirs();

    const msgs = await this._fetchMessages(chatId, { ids: [Number(msgId)] });
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

module.exports = { ChatManager, chatIdAliases, canonId };
