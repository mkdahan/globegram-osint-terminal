/**
 * Darknet / CTI ingestion: poll ransomware leak aggregators + optional
 * .onion mirrors via Tor, extract victim text, emit geo-events through
 * the same pipeline as Telegram (company HQ + place matching).
 *
 * Clearnet feeds work without Tor. Onion feeds only run when Tor is up
 * and the user enables useTor.
 */
'use strict';

const crypto = require('crypto');
const { createTorClient, createClearnetClient, probeTor, DEFAULT_TOR } = require('./torClient');

/** Public aggregators — no Tor required. */
const CLEARNET_FEEDS = [
  {
    id: 'ransomware.live',
    groupName: 'Ransomware.live',
    url: 'https://www.ransomware.live/rss.xml',
    severity: 'CRITICAL_CYBER',
  },
  {
    id: 'ransomwatch-posts',
    groupName: 'Ransomwatch',
    // JSON mirror of recent posts (joshhighet/ransomwatch)
    url: 'https://raw.githubusercontent.com/joshhighet/ransomwatch/main/posts.json',
    kind: 'ransomwatch-json',
    severity: 'CRITICAL_CYBER',
  },
];

/** Optional .onion mirrors — only polled when Tor is available + enabled. */
const ONION_FEEDS = [
  // Placeholders: user can extend; require Tor. Kept empty-safe.
];

const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL_CYBER: 4, CRITICAL: 4 };

class DarknetScraper {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent || null;
    this.clearnet = createClearnetClient();
    this.tor = null;
    this.torOk = false;
    this._timer = null;
    this._running = false;
    this._seen = new Set(); // content hashes already emitted
    this._primed = false; // first successful poll only keeps a small backlog
    this.cfg = {
      enabled: false,
      pollMinutes: 5,
      minSeverity: 'MEDIUM',
      useTor: false,
      torProxy: DEFAULT_TOR,
    };
    this.stats = {
      polls: 0,
      emitted: 0,
      lastPollAt: 0,
      lastError: '',
      torOk: false,
      feedsOk: 0,
    };
  }

  configure(partial = {}) {
    const prev = { ...this.cfg };
    this.cfg = { ...this.cfg, ...partial };
    if (this.cfg.torProxy && this.cfg.torProxy !== prev.torProxy) {
      this.tor = createTorClient(this.cfg.torProxy);
    }
    const wantOn = !!this.cfg.enabled;
    const wasOn = !!this._timer;
    const intervalChanged =
      Number(prev.pollMinutes) !== Number(this.cfg.pollMinutes) ||
      !!prev.useTor !== !!this.cfg.useTor;
    // Idempotent: settings:set fires often (tickers, UI) — don't flap stop/start.
    if (!wantOn) {
      this.stop();
      return;
    }
    if (wasOn && intervalChanged) {
      this.stop();
      this.start();
      return;
    }
    if (!wasOn) this.start();
  }

  start() {
    if (!this.cfg.enabled) return;
    if (this._timer) return;
    const ms = Math.max(1, Number(this.cfg.pollMinutes) || 5) * 60_000;
    console.log(`[darknet] polling every ${ms / 1000}s (tor=${this.cfg.useTor})`);
    this._timer = setInterval(() => {
      this.poll().catch((err) => {
        this.stats.lastError = err.message;
        console.warn('[darknet] poll error:', err.message);
      });
    }, ms);
    // First poll shortly after enable (don't block UI)
    setTimeout(() => {
      this.poll().catch((err) => console.warn('[darknet] first poll:', err.message));
    }, 4_000);
  }

  stop() {
    if (!this._timer) return; // already stopped — silence spam from settings:set
    clearInterval(this._timer);
    this._timer = null;
    console.log('[darknet] stopped');
  }

  async poll() {
    if (this._running || !this.cfg.enabled) return;
    this._running = true;
    this.stats.polls++;
    this.stats.lastPollAt = Date.now();
    let feedsOk = 0;
    try {
      if (this.cfg.useTor) {
        this.torOk = await probeTor(this.cfg.torProxy);
        this.stats.torOk = this.torOk;
        if (this.torOk && !this.tor) this.tor = createTorClient(this.cfg.torProxy);
        if (!this.torOk) {
          console.warn('[darknet] Tor requested but SOCKS proxy unreachable — clearnet only');
        }
      }

      const feeds = [
        ...CLEARNET_FEEDS,
        ...(this.cfg.useTor && this.torOk ? ONION_FEEDS : []),
      ];

      for (const feed of feeds) {
        try {
          let items = await this._fetchFeed(feed);
          feedsOk++;
          // First poll: only a few so enabling CTI doesn't flood the camera
          // queue. Later polls are incremental via _seen.
          if (!this._primed) items = items.slice(0, 3);
          for (const item of items) {
            await this._emitItem(feed, item);
          }
        } catch (err) {
          console.warn(`[darknet] feed ${feed.id}:`, err.message);
          this.stats.lastError = `${feed.id}: ${err.message}`;
        }
      }
      this.stats.feedsOk = feedsOk;
      if (feedsOk > 0) this._primed = true;
    } finally {
      this._running = false;
    }
  }

  async _fetchFeed(feed) {
    const client = feed.onion ? this.tor : this.clearnet;
    if (!client) throw new Error('no HTTP client');
    const res = await client.get(feed.url, { responseType: 'text', transformResponse: [(d) => d] });
    const body = typeof res.data === 'string' ? res.data : String(res.data || '');

    if (feed.kind === 'ransomwatch-json') {
      return this._parseRansomwatchJson(body, feed);
    }
    return this._parseRss(body, feed);
  }

  _parseRss(xml, feed) {
    const items = [];
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    for (const block of blocks.slice(0, 40)) {
      const title = this._clean(this._decode(this._tag(block, 'title')));
      const link = this._tag(block, 'link') || this._tag(block, 'guid');
      const descRaw = this._tag(block, 'description') || this._tag(block, 'content:encoded') || '';
      const desc = this._clean(this._decode(this._stripHtml(descRaw)));
      const pub = this._tag(block, 'pubDate') || this._tag(block, 'published') || '';
      if (!title) continue;
      const groupHint = this._guessGroup(title, desc) || feed.groupName;
      const victimHint = this._guessVictim(title, desc, groupHint);
      // Skip pure "Group has published a new victim" banners with no name
      if (/has just published/i.test(victimHint) || /^new victim$/i.test(victimHint)) continue;
      items.push({
        title,
        text: `${title}. ${desc}`.trim(),
        url: this._decode(link),
        date: pub ? Date.parse(pub) || Date.now() : Date.now(),
        victimHint,
        groupHint,
      });
    }
    return items;
  }

  _parseRansomwatchJson(body, feed) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    // posts.json is an array of {post_title, group_name, discovered, ...}
    const arr = Array.isArray(data) ? data : (data.posts || []);
    return arr.slice(-40).reverse().map((p) => {
      const title = p.post_title || p.title || p.victim || '';
      const group = p.group_name || p.group || feed.groupName;
      const discovered = p.discovered || p.date || p.published;
      return {
        title,
        text: `${title} claimed by ${group}`.trim(),
        url: p.post_url || p.url || '',
        date: discovered ? Date.parse(discovered) || Date.now() : Date.now(),
        victimHint: title,
        groupHint: group,
      };
    }).filter((x) => x.title);
  }

  async _emitItem(feed, item) {
    const severity = feed.severity || 'CRITICAL_CYBER';
    if ((SEVERITY_RANK[severity] || 0) < (SEVERITY_RANK[this.cfg.minSeverity] || 0)) return;

    const hash = crypto
      .createHash('sha1')
      .update(`${feed.id}|${item.title}|${item.url || ''}`)
      .digest('hex')
      .slice(0, 16);
    if (this._seen.has(hash)) return;
    this._seen.add(hash);
    if (this._seen.size > 5000) {
      this._seen = new Set([...this._seen].slice(-2500));
    }

    const victim = item.victimHint || item.title;
    const groupName = item.groupHint || feed.groupName;
    const text =
      `DARKNET LEAK — ${groupName}: ${victim}. ` +
      `${item.text || ''}`.slice(0, 800);

    const payload = {
      key: `darknet:${feed.id}:${hash}`,
      chatId: 'darknet',
      chatTitle: `CTI · ${groupName}`,
      msgId: hash,
      date: item.date || Date.now(),
      text,
      media: null,
      source: 'DARKNET_LEAK_BLOG',
      severity,
      groupName,
      victim,
      leakUrl: item.url || '',
      highPriorityHint: true,
    };

    this.stats.emitted++;
    if (this.onEvent) await this.onEvent(payload);
  }

  _tag(block, name) {
    const re = new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m = block.match(re);
    return m ? (m[1] != null && m[1] !== undefined ? m[1] : m[2] || '').trim() : '';
  }

  _stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _decode(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  _clean(s) {
    return String(s || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * "LockBit adds Contoso Ltd" / "Contoso — LockBit" /
   * "Qilin has just published a new victim" (+ victim in description)
   */
  _guessVictim(title, desc = '', group = '') {
    const t = String(title || '').trim();
    const d = String(desc || '').trim();

    // Banner titles → dig into description for the actual victim name
    if (/has just published/i.test(t) || /new victim/i.test(t)) {
      const fromDesc =
        d.match(/(?:victim|company|target)\s*[:\-–—]\s*(.+)$/i) ||
        d.match(/^([A-Z0-9][\w .,&'()-]{2,80})/);
      if (fromDesc) return fromDesc[1].split(/[.|]/)[0].trim();
      // description sometimes is just the company name
      if (d && d.length < 80 && !/has just published/i.test(d)) return d;
      return t; // caller may skip
    }

    const m1 = t.match(/adds?\s+(.+)$/i);
    if (m1) return m1[1].replace(/\s*[—|-].*$/, '').trim();
    const m2 = t.match(/^(.+?)\s+(?:added|claimed|leaked|posted|hacked)/i);
    if (m2) return m2[1].replace(new RegExp(`^${group}\\s+`, 'i'), '').trim();
    const parts = t.split(/\s+[—–|-]\s+/);
    if (parts.length >= 2) {
      // Prefer the side that is NOT the group name
      const a = parts[0].trim();
      const b = parts[1].trim();
      if (group && new RegExp(`^${group}$`, 'i').test(a)) return b;
      if (group && new RegExp(`^${group}$`, 'i').test(b)) return a;
      return a;
    }
    return t;
  }

  _guessGroup(title, desc) {
    const blob = `${title} ${desc}`;
    const known = [
      'LockBit', 'BlackCat', 'ALPHV', 'Cl0p', 'Clop', 'PLAY', 'Akira',
      'Royal', 'BlackBasta', 'Black Basta', 'RansomHub', 'Qilin', '8Base',
      'Medusa', 'BianLian', 'Rhysida', 'Cactus', 'Hunters International',
    ];
    for (const g of known) {
      if (new RegExp(`\\b${g.replace(/\s+/g, '\\s+')}\\b`, 'i').test(blob)) return g;
    }
    return null;
  }
}

module.exports = { DarknetScraper, CLEARNET_FEEDS };
