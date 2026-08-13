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
const { COMPANIES_PATH, BUNDLED_COMPANIES_PATH, SEED_COMPANIES_PATH } = require('../paths');
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

// English / common stopwords that Wikidata sometimes maps to dead tickers
// (WE, WITH, AT, ONE, MAJOR, 2024…) — never index as unigram company aliases.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'from', 'with', 'without', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'can', 'we', 'you',
  'they', 'he', 'she', 'it', 'our', 'your', 'their', 'this', 'that', 'these',
  'those', 'not', 'no', 'yes', 'all', 'any', 'some', 'one', 'two', 'major',
  'minor', 'new', 'old', 'next', 'last', 'first', 'second', 'third', 'best',
  'news', 'report', 'reports', 'said', 'says', 'today', 'yesterday', 'week',
  'month', 'year', 'years', 'day', 'days', 'via', 'per', 'vs', 'etc',
  'base', 'unit', 'units', 'flight', 'flights', 'force', 'forces', 'army',
  'naval', 'air', 'sea', 'land', 'tel', 'aviv', 'el', 'al', 'de', 'la', 'le',
  'des', 'du', 'van', 'von', 'der', 'und', 'mit',
  'kind', 'fuel', 'ceo', 'plan', 'work', 'apr', 'see', 'thai', 'elec',
  'just', 'card', 'zoom', 'progress', 'bar', 'sp', 'one', 'major',
]);

function yahooQuality(y) {
  if (!y) return 0;
  const s = String(y).trim();
  if (!s) return 0;
  // Exchange-qualified (ELAL.TA, 2222.SR) beats bare ticker (ELAL)
  if (/[.=]/.test(s)) return 3;
  if (/^[A-Z]{1,5}$/i.test(s)) return 2;
  return 1;
}

class CompanyParser {
  constructor() {
    this.companies = [];
    this.nameIndex = new Map(); // normalized alias -> company idx
    this.cjkNames = [];
    this.source = null;
  }

  load() {
    // Preference: locally rebuilt full DB → repo-bundled world DB → tiny seed
    // Always merge curated seed (EMCO, Elbit, Baykar, …) so OSINT names survive.
    let raw;
    if (fs.existsSync(COMPANIES_PATH)) {
      raw = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf-8'));
      this.source = 'wikidata-full+seed';
    } else if (fs.existsSync(BUNDLED_COMPANIES_PATH)) {
      raw = JSON.parse(fs.readFileSync(BUNDLED_COMPANIES_PATH, 'utf-8'));
      this.source = 'bundled+seed';
    } else {
      raw = JSON.parse(fs.readFileSync(SEED_COMPANIES_PATH, 'utf-8'));
      this.source = 'seed';
    }
    this.companies = this._mergeSeed(raw.companies || []);
    this._buildIndex();
    console.log(
      `[companies] loaded ${this.companies.length} companies ` +
      `(${this.nameIndex.size} aliases, ${this.cjkNames.length} CJK) from ${this.source}`
    );
    return this;
  }

  _mergeSeed(base) {
    if (!fs.existsSync(SEED_COMPANIES_PATH)) return base;
    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(SEED_COMPANIES_PATH, 'utf-8')).companies || [];
    } catch {
      return base;
    }
    const keyOf = (c) =>
      (c.ticker && String(c.ticker).toUpperCase()) ||
      String(c.name || '').toLowerCase();
    const byKey = new Map(base.map((c) => [keyOf(c), { ...c, aliases: [...(c.aliases || [])] }]));
    for (const c of seed) {
      const k = keyOf(c);
      if (!byKey.has(k)) {
        byKey.set(k, { ...c, aliases: [...(c.aliases || [])] });
      } else {
        const cur = byKey.get(k);
        cur.aliases = [...new Set([...(cur.aliases || []), ...(c.aliases || []), c.name, c.ticker].filter(Boolean))];
        // Prefer curated seed Yahoo ids (ELAL.TA) over bare Wikidata tickers (ELAL)
        if (c.yahoo && yahooQuality(c.yahoo) >= yahooQuality(cur.yahoo)) {
          cur.yahoo = c.yahoo;
          if (c.ticker) cur.ticker = c.ticker;
        }
        if (!cur.ticker && c.ticker) cur.ticker = c.ticker;
        if (c.exchange) cur.exchange = c.exchange;
        if (!cur.lat && c.lat) { cur.lat = c.lat; cur.lon = c.lon; }
      }
    }
    return [...byKey.values()];
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
        if (!key || GENERIC.has(key) || STOPWORDS.has(key)) continue;
        // Pure years / numeric codes ("2024", "8200") match news too eagerly and
        // often resolve to dead Yahoo ids (8200.SW). Never index as unigrams.
        if (/^\d{2,5}$/.test(key)) continue;
        if (key.length < 3 && !isAcronym) continue;
        if (!this.nameIndex.has(key)) this.nameIndex.set(key, idx);
      }
    });
    this.cjkNames.sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * @returns [{type:'COMPANY_MATCH', companyName, ticker, yahoo, exchange,
   *            country, countryCode, lat, lon, matchedWord}] — first-in-text order
   */
  match(text) {
    if (!text || !this.companies.length) return [];
    const found = new Map(); // idx -> {matchedWord, order}

    const norm = normalize(text);
    const tokens = norm.match(TOKEN_RE) || [];
    const consumed = new Array(tokens.length).fill(false);
    let order = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (consumed[i]) continue;
      for (let n = MAX_NGRAM; n >= 1; n--) {
        if (i + n > tokens.length) continue;
        let overlap = false;
        for (let k = 0; k < n; k++) if (consumed[i + k]) { overlap = true; break; }
        if (overlap) continue;
        const phrase = tokens.slice(i, i + n).join(' ');
        // Unigram stopwords / tiny tokens never match companies
        if (n === 1 && (STOPWORDS.has(phrase) || GENERIC.has(phrase))) continue;
        const idx = this._lookup(phrase, n === 1);
        if (idx !== undefined && !found.has(idx)) {
          found.set(idx, { matchedWord: phrase, order: order++ });
          for (let k = 0; k < n; k++) consumed[i + k] = true;
          break;
        }
      }
    }

    if (CJK_RE.test(text)) {
      for (const { name, idx } of this.cjkNames) {
        if (!found.has(idx) && text.includes(name)) {
          found.set(idx, { matchedWord: name, order: order++ });
        }
      }
    }

    return [...found.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .slice(0, MAX_MATCHES)
      .map(([idx, { matchedWord }]) => {
        const c = this.companies[idx];
        let yahoo = c.yahoo || null;
        // Drop junk Yahoo ids that only create delisted chart spam
        if (yahoo && !isPlausibleYahoo(yahoo)) yahoo = null;
        return {
          type: 'COMPANY_MATCH',
          companyName: c.name,
          ticker: c.ticker || null,
          yahoo,
          exchange: c.exchange || null,
          country: c.country,
          countryCode: c.cc,
          lat: c.lat,
          lon: c.lon,
          matchedWord,
        };
      });
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

/**
 * Accept exchange-qualified ids, US-style tickers (1–5 letters), crypto/FX,
 * and reject stopwords / bare years that poisoned overnight chart refresh.
 */
function isPlausibleYahoo(symbol) {
  if (!symbol) return false;
  const s = String(symbol).trim().toUpperCase();
  if (!s || s.length > 24) return false;
  if (STOPWORDS.has(s.toLowerCase()) || GENERIC.has(s.toLowerCase())) return false;
  if (/^\d{4}$/.test(s)) return false; // year
  if (/^[A-Z]{1,5}$/.test(s)) return true; // US listing
  if (/^[A-Z0-9][A-Z0-9.\-]{0,14}(\.[A-Z]{1,3}|-[A-Z]{1,5}|=[A-Z])$/i.test(s)) return true;
  if (/^[A-Z]{2,5}-USD$/i.test(s)) return true;
  return /[.=]/.test(s);
}

module.exports = { CompanyParser, isPlausibleYahoo, STOPWORDS };
