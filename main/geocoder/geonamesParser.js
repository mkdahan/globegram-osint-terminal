/**
 * Multilingual exact-location engine over a GeoNames gazetteer.
 *
 * Loads %LOCALAPPDATA%\globegram-terminal\gazetteer.json when it has been
 * built (npm run build-gazetteer), otherwise falls back to the bundled
 * seed-gazetteer.json (major world + Middle East cities).
 *
 * Matching strategy (regex \b word boundaries do not work for Hebrew/Arabic/CJK):
 *  - tokenize text with a Unicode-aware regex, check 1..4-gram phrases
 *    against a normalized name index
 *  - strip common Hebrew (ב,ל,מ,ו,ה,כ,ש) and Arabic (و,ب,ل,ف,ك) proclitic
 *    prefixes so "בירושלים" still matches "ירושלים"
 *  - CJK names (no word separators) are matched by substring scan
 *  - homonyms resolve to the highest-population entry
 */
'use strict';

const fs = require('fs');
const { GAZETTEER_PATH, SEED_GAZETTEER_PATH } = require('../paths');

const HEBREW_PREFIXES = ['ו', 'ב', 'ל', 'מ', 'כ', 'ש', 'ה'];
const ARABIC_PREFIXES = ['و', 'ب', 'ل', 'ف', 'ك'];
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const TOKEN_RE = /[\p{L}\p{M}\p{N}'’]+/gu;
const MAX_NGRAM = 4;
const MAX_MATCHES_PER_MESSAGE = 5;

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Arabic diacritics + tatweel
    .replace(/[أإآ]/g, 'ا') // Alef variants
    .replace(/[\u0591-\u05C7]/g, '') // Hebrew niqqud/cantillation
    .replace(/[‐‑–—\-]/g, ' ') // hyphen family -> space
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

class GeonamesParser {
  constructor() {
    this.entries = [];
    this.nameIndex = new Map(); // normalized name -> entry index (highest pop wins)
    this.cjkNames = []; // [{name, idx}] sorted by name length desc
    this.source = null;
  }

  load() {
    let raw = null;
    if (fs.existsSync(GAZETTEER_PATH)) {
      raw = JSON.parse(fs.readFileSync(GAZETTEER_PATH, 'utf-8'));
      this.source = 'geonames-full';
    } else {
      raw = JSON.parse(fs.readFileSync(SEED_GAZETTEER_PATH, 'utf-8'));
      this.source = 'seed';
    }
    this.entries = raw.entries || [];
    this._buildIndex();
    console.log(
      `[geocoder] loaded ${this.entries.length} locations ` +
      `(${this.nameIndex.size} names, ${this.cjkNames.length} CJK) from ${this.source}`
    );
    return this;
  }

  _buildIndex() {
    this.nameIndex.clear();
    this.cjkNames = [];
    this.entries.forEach((entry, idx) => {
      const allNames = [entry.name, ...(entry.names || [])];
      for (const n of allNames) {
        if (!n) continue;
        if (CJK_RE.test(n)) {
          if (n.length >= 2) this.cjkNames.push({ name: n, idx });
          continue;
        }
        const key = normalize(n);
        if (key.length < 3) continue;
        const existing = this.nameIndex.get(key);
        if (existing === undefined || (this.entries[existing].pop || 0) < (entry.pop || 0)) {
          this.nameIndex.set(key, idx);
        }
      }
    });
    this.cjkNames.sort((a, b) => b.name.length - a.name.length);
  }

  /** @returns [{lat, lon, name, matchedWord, cc, pop, geonameid}] */
  match(text) {
    if (!text || !this.entries.length) return [];
    const found = new Map(); // entryIdx -> matchedWord

    // --- token/n-gram pass ---
    const norm = normalize(text);
    const tokens = norm.match(TOKEN_RE) || [];
    for (let i = 0; i < tokens.length; i++) {
      for (let n = MAX_NGRAM; n >= 1; n--) {
        if (i + n > tokens.length) continue;
        const phrase = tokens.slice(i, i + n).join(' ');
        const idx = this._lookup(phrase, n === 1);
        if (idx !== undefined && !found.has(idx)) {
          found.set(idx, phrase);
        }
      }
    }

    // --- CJK substring pass ---
    if (CJK_RE.test(text)) {
      for (const { name, idx } of this.cjkNames) {
        if (!found.has(idx) && text.includes(name)) found.set(idx, name);
      }
    }

    const results = [];
    for (const [idx, matchedWord] of found) {
      const e = this.entries[idx];
      results.push({
        geonameid: e.id,
        name: e.name,
        matchedWord,
        lat: e.lat,
        lon: e.lon,
        cc: e.cc || null,
        pop: e.pop || 0,
      });
      if (results.length >= MAX_MATCHES_PER_MESSAGE) break;
    }
    results.sort((a, b) => b.pop - a.pop);
    return results;
  }

  _lookup(phrase, allowPrefixStrip) {
    let idx = this.nameIndex.get(phrase);
    if (idx !== undefined) return idx;
    if (!allowPrefixStrip) {
      // For multi-word phrases, also try stripping a prefix off the first word
      const stripped = this._stripPrefix(phrase);
      return stripped ? this.nameIndex.get(stripped) : undefined;
    }
    // Single token: try stripping up to two proclitic prefix letters (e.g. "ומירושלים")
    let candidate = phrase;
    for (let depth = 0; depth < 2; depth++) {
      const stripped = this._stripPrefix(candidate);
      if (!stripped) break;
      idx = this.nameIndex.get(stripped);
      if (idx !== undefined) return idx;
      candidate = stripped;
    }
    // Cyrillic: undo common grammatical case endings ("в Москве" -> "москва")
    if (/[\u0400-\u04FF]/.test(phrase)) {
      const found = this._cyrillicCaseLookup(phrase);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  _cyrillicCaseLookup(token) {
    const suffixes = ['ами', 'ями', 'ове', 'еве', 'ом', 'ем', 'ой', 'ей', 'ах', 'ях', 'у', 'е', 'ы', 'и', 'а', 'я'];
    for (const suf of suffixes) {
      if (!token.endsWith(suf) || token.length - suf.length < 3) continue;
      const stem = token.slice(0, -suf.length);
      for (const variant of [stem, stem + 'а', stem + 'я', stem + 'ь']) {
        const idx = this.nameIndex.get(variant);
        if (idx !== undefined) return idx;
      }
    }
    return undefined;
  }

  _stripPrefix(phrase) {
    const first = phrase[0];
    if (!HEBREW_PREFIXES.includes(first) && !ARABIC_PREFIXES.includes(first)) return null;
    const rest = phrase.slice(1);
    return rest.length >= 3 ? rest : null;
  }
}

module.exports = { GeonamesParser, normalize };
