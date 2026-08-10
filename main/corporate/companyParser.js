/**
 * Company entity recognition engine — runs in parallel with geonamesParser.
 *
 * Loads %LOCALAPPDATA%\globegram-terminal\companies.json when built
 * (npm run build-companies, Wikidata), otherwise the bundled seed-companies.json.
 *
 * Same multilingual matching strategy as the geocoder (Unicode n-grams,
 * Hebrew/Arabic proclitic prefixes, Cyrillic case endings, CJK substrings),
 * plus a generic-word blocklist ("Inc", "Ltd", "Corp", ...) and support for
 * short all-caps tickers (BP, GD, ZIM).
 */
'use strict';

const fs = require('fs');
const { COMPANIES_PATH, SEED_COMPANIES_PATH } = require('../paths');
const { normalize } = require('../geocoder/geonamesParser');

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;
const TOKEN_RE = /[\p{L}\p{M}\p{N}'’.]+/gu;
const MAX_NGRAM = 4;
const MAX_MATCHES = 4;
const HEBREW_PREFIXES = ['ו', 'ב', 'ל', 'מ', 'כ', 'ש', 'ה'];
const ARABIC_PREFIXES = ['و', 'ب', 'ل', 'ف', 'ك'];

// Never match these standalone generic corporate words
const GENERIC = new Set([
  'inc', 'ltd', 'llc', 'corp', 'corporation', 'company', 'co', 'group',
  'holdings', 'holding', 'plc', 'sa', 'ag', 'gmbh', 'spa', 's.p.a', 'bank',
  'systems', 'technologies', 'industries', 'international', 'global',
  'בע"מ', 'בעמ', 'חברה', 'קבוצת', 'بنك', 'شركة', 'مجموعة',
]);

class CompanyParser {
  constructor() {
    this.companies = [];
    this.nameIndex = new Map(); // normalized alias -> company idx
    this.cjkNames = [];
    this.source = null;
  }

  load() {
    let raw;
    if (fs.existsSync(COMPANIES_PATH)) {
      raw = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf-8'));
      this.source = 'wikidata-full';
    } else {
      raw = JSON.parse(fs.readFileSync(SEED_COMPANIES_PATH, 'utf-8'));
      this.source = 'seed';
    }
    this.companies = raw.companies || [];
    this._buildIndex();
    console.log(
      `[companies] loaded ${this.companies.length} companies ` +
      `(${this.nameIndex.size} aliases, ${this.cjkNames.length} CJK) from ${this.source}`
    );
    return this;
  }

  _buildIndex() {
    this.nameIndex.clear();
    this.cjkNames = [];
    this.companies.forEach((c, idx) => {
      const aliases = [c.name, c.ticker, ...(c.aliases || [])];
      for (const a of aliases) {
        if (!a) continue;
        if (CJK_RE.test(a)) {
          if (a.length >= 2) this.cjkNames.push({ name: a, idx });
          continue;
        }
        const key = normalize(a);
        // short keys allowed only for explicit all-caps tickers/acronyms (BP, GD, IAI)
        const isAcronym = /^[A-Z0-9.\-]{2,5}$/.test(a.trim());
        if (!key || GENERIC.has(key)) continue;
        if (key.length < 3 && !isAcronym) continue;
        if (!this.nameIndex.has(key)) this.nameIndex.set(key, idx);
      }
    });
    this.cjkNames.sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * @returns [{type:'COMPANY_MATCH', companyName, ticker, yahoo, exchange,
   *            country, countryCode, lat, lon, matchedWord}]
   */
  match(text) {
    if (!text || !this.companies.length) return [];
    const found = new Map(); // idx -> matchedWord

    const norm = normalize(text);
    const tokens = norm.match(TOKEN_RE) || [];
    for (let i = 0; i < tokens.length; i++) {
      for (let n = MAX_NGRAM; n >= 1; n--) {
        if (i + n > tokens.length) continue;
        const phrase = tokens.slice(i, i + n).join(' ');
        const idx = this._lookup(phrase, n === 1);
        if (idx !== undefined && !found.has(idx)) found.set(idx, phrase);
      }
    }

    if (CJK_RE.test(text)) {
      for (const { name, idx } of this.cjkNames) {
        if (!found.has(idx) && text.includes(name)) found.set(idx, name);
      }
    }

    const results = [];
    for (const [idx, matchedWord] of found) {
      const c = this.companies[idx];
      results.push({
        type: 'COMPANY_MATCH',
        companyName: c.name,
        ticker: c.ticker || null,
        yahoo: c.yahoo || null,
        exchange: c.exchange || null,
        country: c.country,
        countryCode: c.cc,
        lat: c.lat,
        lon: c.lon,
        matchedWord,
      });
      if (results.length >= MAX_MATCHES) break;
    }
    return results;
  }

  _lookup(phrase, allowMorph) {
    let idx = this.nameIndex.get(phrase);
    if (idx !== undefined) return idx;
    if (!allowMorph) {
      const stripped = this._stripPrefix(phrase);
      return stripped ? this.nameIndex.get(stripped) : undefined;
    }
    let candidate = phrase;
    for (let depth = 0; depth < 2; depth++) {
      const stripped = this._stripPrefix(candidate);
      if (!stripped) break;
      idx = this.nameIndex.get(stripped);
      if (idx !== undefined) return idx;
      candidate = stripped;
    }
    if (/[\u0400-\u04FF]/.test(phrase)) {
      const suffixes = ['ом', 'ем', 'ой', 'ей', 'ах', 'ях', 'у', 'е', 'ы', 'и', 'а', 'я'];
      for (const suf of suffixes) {
        if (!phrase.endsWith(suf) || phrase.length - suf.length < 3) continue;
        const stem = phrase.slice(0, -suf.length);
        for (const v of [stem, stem + 'а', stem + 'я', stem + 'ь']) {
          const found = this.nameIndex.get(v);
          if (found !== undefined) return found;
        }
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

module.exports = { CompanyParser };
