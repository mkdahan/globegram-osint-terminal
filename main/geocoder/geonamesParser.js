/**
 * Multilingual exact-location engine over a GeoNames gazetteer.
 *
 * Matching strategy (regex \b word boundaries do not work for Hebrew/Arabic/CJK):
 *  - tokenize text with a Unicode-aware regex, check 1..4-gram phrases
 *  - strip Hebrew/Arabic proclitic prefixes so "בבולגריה" → Bulgaria
 *  - score locative context ("ב"/"in"/"at"/"near") so the event place ranks
 *    above secondary mentions ("לאוקראינה" = to Ukraine)
 *  - CJK substring scan; Cyrillic case endings
 */
'use strict';

const fs = require('fs');
const { GAZETTEER_PATH, BUNDLED_GAZETTEER_PATH, SEED_GAZETTEER_PATH } = require('../paths');

const HEBREW_PREFIXES = ['ו', 'ב', 'ל', 'מ', 'כ', 'ש', 'ה'];
const ARABIC_PREFIXES = ['و', 'ب', 'ل', 'ف', 'ك'];
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const HE_AR_RE = /[\u0590-\u05FF\u0600-\u06FF]/;
const TOKEN_RE = /[\p{L}\p{M}\p{N}'’]+/gu;
const MAX_NGRAM = 4;
const MAX_MATCHES_PER_MESSAGE = 5;

/** English prepositions before a place name */
const EN_STRONG = new Set([
  'in', 'at', 'near', 'over', 'around', 'inside', 'within', 'across',
  'into', 'onto', 'above', 'below', 'outside', 'beside',
]);
const EN_MID = new Set(['from', 'of', 'by', 'on']);
const EN_WEAK = new Set(['to', 'for', 'toward', 'towards', 'vs', 'versus', 'via']);

/** Hebrew/Arabic standalone context tokens (already normalized/lowercase) */
const HE_CTX_STRONG = new Set([
  'באזור', 'ליד', 'לידי', 'סמוך', 'בקרבת', 'בתוך', 'מעל', 'מתחת', 'בין',
  'במרכז', 'בדרום', 'בצפון', 'במזרח', 'במערב', 'על־יד', 'על יד',
  'על', // "על זאפורוזיה" = attacks on Zaporizhzhia
]);
const AR_CTX_STRONG = new Set(['في', 'بـ', 'قرب', 'بجانب', 'داخل', 'على']);

/**
 * Stems that look like places after prefix-strip but are actually grammar/context
 * ("באזור" → אזור ≠ Azor; "over" ≠ Over, England).
 */
const BLOCK_STEMS = new Set([
  'אזור', 'מרכז', 'דרום', 'צפון', 'מזרח', 'מערב', 'עיירה', 'עיר', 'כפר',
  'מפעל', 'מחסן', 'שדה', 'אזורי', 'רחוב', 'שכונה', 'גבעה',
  'פרק', 'הפרק', // "על הפרק" = on the agenda, not Perak (MY)
  'חדשות', 'דיווח', 'עודכן', 'דקות', 'שעות', 'היום', 'אתמול',
  'ממשלה', 'צבא', 'כוחות', 'טנקים', 'טנק', 'חיילים',
  'over', 'near', 'area', 'region', 'center', 'centre', 'town', 'city',
  'village', 'facility', 'plant', 'factory', 'warehouse', 'district',
  'news', 'update', 'today', 'yesterday', 'government', 'army', 'forces',
  'gat', // fragment of "Kiryat Gat"
  // Demonyms / adjectives that collide with tiny place names
  'german', 'russian', 'ukrainian', 'american', 'israeli', 'syrian',
  'french', 'british', 'chinese', 'iranian', 'turkish', 'polish',
  'italian', 'spanish', 'greek', 'dutch', 'swedish', 'norwegian',
  'egyptian', 'lebanese', 'jordanian', 'saudi', 'qatari', 'emirati',
  // Hebrew function words / stems that geocode to random towns
  'מהווה', 'מדובר', 'שנים', 'שנה', 'השלימה', 'שלימה', 'שגרה', 'לשגרה',
  'שבו', 'כבר', 'משבר', 'מדינה', 'המדינה', 'טורקי', 'הטורקי', 'וואלה',
  'כרך', 'בכרך', 'ציון', 'מאזן',
]);

/** Tiny / ambiguous aliases that need a locative cue or huge population */
const AMBIGUOUS_MIN_POP = 250_000;

/** Locative strength of an attached proclitic letter */
const PREFIX_SCORE = {
  ב: 100, // Hebrew in/at
  ب: 100, // Arabic in/at
  מ: 45, // from
  ل: 15, // Arabic to/for
  ל: 15, // Hebrew to (often recipient, not event site)
  ف: 35,
  ك: 25,
  כ: 25,
  ه: 20,
  ה: 20,
  ש: 15,
  و: 5,
  ו: 5,
};

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[‐‑–—\-]/g, ' ')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

class GeonamesParser {
  constructor() {
    this.entries = [];
    this.nameIndex = new Map();
    this.cjkNames = [];
    this.source = null;
  }

  load() {
    let raw = null;
    if (fs.existsSync(GAZETTEER_PATH)) {
      raw = JSON.parse(fs.readFileSync(GAZETTEER_PATH, 'utf-8'));
      this.source = 'geonames-full+seed';
    } else if (fs.existsSync(BUNDLED_GAZETTEER_PATH)) {
      raw = JSON.parse(fs.readFileSync(BUNDLED_GAZETTEER_PATH, 'utf-8'));
      this.source = 'bundled+seed';
    } else {
      raw = JSON.parse(fs.readFileSync(SEED_GAZETTEER_PATH, 'utf-8'));
      this.source = 'seed';
    }
    this.entries = this._mergeSeed(raw.entries || [], SEED_GAZETTEER_PATH, 'entries');
    this._buildIndex();
    console.log(
      `[geocoder] loaded ${this.entries.length} locations ` +
      `(${this.nameIndex.size} names, ${this.cjkNames.length} CJK) from ${this.source}`
    );
    return this;
  }

  _mergeSeed(base, seedPath, key) {
    if (!fs.existsSync(seedPath) || seedPath.includes('bundled')) return base;
    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'))[key] || [];
    } catch {
      return base;
    }
    if (!seed.length) return base;
    const byId = new Map(base.map((e) => [e.id, { ...e, names: [...(e.names || [])] }]));
    const norm = (s) => String(s || '').toLowerCase();
    for (const e of seed) {
      if (!byId.has(e.id)) {
        byId.set(e.id, { ...e, names: [...(e.names || [])] });
        continue;
      }
      const cur = byId.get(e.id);
      const same =
        norm(cur.name) === norm(e.name) ||
        (cur.names || []).some((n) => norm(n) === norm(e.name)) ||
        (e.names || []).some((n) => norm(n) === norm(cur.name));
      if (same) {
        // Seed wins for coords / population / canonical name — bundled
        // GeoNames rows are sometimes wrong (e.g. Germany pinned in Wisconsin).
        cur.names = [...new Set([...(cur.names || []), ...(e.names || []), e.name, cur.name])];
        if (e.lat != null) cur.lat = e.lat;
        if (e.lon != null) cur.lon = e.lon;
        if (e.pop != null) cur.pop = e.pop;
        if (e.cc) cur.cc = e.cc;
        if (e.name) cur.name = e.name;
      } else {
        byId.set(`seed:${e.name}:${e.id}`, { ...e, names: [...(e.names || [])] });
      }
    }
    return [...byId.values()];
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
        const isHebrew = /[\u0590-\u05FF]/.test(n);
        if (key.length < (isHebrew ? 2 : 3)) continue;
        const existing = this.nameIndex.get(key);
        if (existing === undefined || (this.entries[existing].pop || 0) < (entry.pop || 0)) {
          this.nameIndex.set(key, idx);
        }
      }
    });
    this.cjkNames.sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * @returns [{lat, lon, name, matchedWord, cc, pop, geonameid, locativeScore, locativeHint}]
   * Sorted: strongest locative ("ב"/"in"/"at") first, then earlier in text, then population.
   */
  match(text) {
    if (!text || !this.entries.length) return [];
    const found = new Map(); // entryIdx -> best hit

    const norm = normalize(text);
    const tokens = norm.match(TOKEN_RE) || [];
    let order = 0;

    for (let i = 0; i < tokens.length; i++) {
      for (let n = MAX_NGRAM; n >= 1; n--) {
        if (i + n > tokens.length) continue;
        const phrase = tokens.slice(i, i + n).join(' ');
        // Never treat locative/preposition words themselves as place names
        if (
          EN_STRONG.has(phrase) || EN_MID.has(phrase) || EN_WEAK.has(phrase) ||
          HE_CTX_STRONG.has(phrase) || AR_CTX_STRONG.has(phrase)
        ) continue;

        const hit = this._lookupDetailed(phrase, n === 1);
        if (!hit) continue;
        if (hit.stem && BLOCK_STEMS.has(hit.stem)) continue;
        if (BLOCK_STEMS.has(phrase)) continue;

        // Skip short 1-grams already covered by a longer match ("gat" ⊂ "kiryat gat")
        if (n === 1 && phrase.length <= 4) {
          let covered = false;
          for (const v of found.values()) {
            if (v.matchedWord !== phrase && v.matchedWord.split(' ').includes(phrase)) {
              covered = true;
              break;
            }
          }
          if (covered) continue;
        }

        const prev = i > 0 ? tokens[i - 1] : '';
        // Alias may be stored WITH the proclitic (בחמוט) — still count as ב-locative
        let prefix = hit.prefix;
        if (!prefix && phrase.length > 2 && (HEBREW_PREFIXES.includes(phrase[0]) || ARABIC_PREFIXES.includes(phrase[0]))) {
          prefix = phrase[0];
        }
        const loc = this._locativeScore({
          prefix,
          prevToken: prev,
          matchedWord: phrase,
        });
        const prevBest = found.get(hit.idx);
        if (
          !prevBest ||
          loc.score > prevBest.locativeScore ||
          (loc.score === prevBest.locativeScore && order < prevBest.order)
        ) {
          found.set(hit.idx, {
            matchedWord: phrase,
            order: prevBest ? prevBest.order : order++,
            locativeScore: loc.score,
            locativeHint: loc.hint,
          });
        }
      }
    }

    if (CJK_RE.test(text)) {
      for (const { name, idx } of this.cjkNames) {
        if (!found.has(idx) && text.includes(name)) {
          found.set(idx, {
            matchedWord: name,
            order: order++,
            locativeScore: 0,
            locativeHint: null,
          });
        }
      }
    }

    const results = [...found.entries()]
      .map(([idx, meta]) => {
        const e = this.entries[idx];
        return {
          geonameid: e.id,
          name: e.name,
          matchedWord: meta.matchedWord,
          lat: e.lat,
          lon: e.lon,
          cc: e.cc || null,
          pop: e.pop || 0,
          locativeScore: meta.locativeScore || 0,
          locativeHint: meta.locativeHint || null,
          _order: meta.order,
        };
      })
      // Drop weak / ambiguous matches that cause "red dots jumping" to
      // random towns (short alias, no locative cue, small population).
      .filter((r) => {
        const word = String(r.matchedWord || '');
        const letters = word.replace(/[^\p{L}]/gu, '');
        const short = letters.length > 0 && letters.length <= 3;
        const weak = (r.locativeScore || 0) < 15;
        if (short && weak && (r.pop || 0) < AMBIGUOUS_MIN_POP) return false;
        if (weak && (r.pop || 0) < 50_000 && letters.length <= 5) return false;
        return true;
      })
      .sort(
        (a, b) =>
          b.locativeScore - a.locativeScore ||
          a._order - b._order ||
          b.pop - a.pop
      )
      .slice(0, MAX_MATCHES_PER_MESSAGE);

    for (const r of results) delete r._order;
    return results;
  }

  /**
   * Score how strongly this mention looks like "the place where it happened".
   * ב / in / at / near  → high
   * ל / to / for        → low (often a recipient, not the scene)
   */
  _locativeScore({ prefix, prevToken, matchedWord }) {
    let score = 0;
    let hint = null;

    if (prefix && PREFIX_SCORE[prefix] != null) {
      score = PREFIX_SCORE[prefix];
      hint = `prefix:${prefix}`;
    }

    if (prevToken) {
      if (EN_STRONG.has(prevToken)) {
        if (score < 100) { score = 100; hint = `en:${prevToken}`; }
      } else if (EN_MID.has(prevToken)) {
        if (score < 45) { score = 45; hint = `en:${prevToken}`; }
      } else if (EN_WEAK.has(prevToken)) {
        if (score < 15) { score = 15; hint = `en:${prevToken}`; }
      }

      if (HE_CTX_STRONG.has(prevToken) || AR_CTX_STRONG.has(prevToken)) {
        if (score < 95) { score = 95; hint = `ctx:${prevToken}`; }
      } else if (prevToken[0] === 'ב' && prevToken.length >= 2) {
        // באזור / במרכז / בדרום… — "in the X of PLACE"
        if (score < 85) { score = 85; hint = `he-ctx:${prevToken}`; }
      } else if (prevToken === 'в' || prevToken === 'на' || prevToken === 'около') {
        if (score < 100) { score = 100; hint = `ru:${prevToken}`; }
      } else if (prevToken === 'к' || prevToken === 'для') {
        if (score < 15) { score = 15; hint = `ru:${prevToken}`; }
      }
    }

    // Bare name with no locative cue
    if (!score && matchedWord) {
      score = 0;
      hint = null;
    }
    return { score, hint };
  }

  /** @returns {{idx, prefix, stem}|null} */
  _lookupDetailed(phrase, allowMorph) {
    let idx = this.nameIndex.get(phrase);
    if (idx !== undefined) return { idx, prefix: null, stem: phrase };

    if (!allowMorph) {
      const stripped = this._stripPrefix(phrase);
      if (stripped) {
        idx = this.nameIndex.get(stripped.rest);
        if (idx !== undefined) return { idx, prefix: stripped.prefix, stem: stripped.rest };
      }
      return null;
    }

    // Single token: strip up to two proclitic letters (ומבולגריה → בולגריה)
    let candidate = phrase;
    let bestPrefix = null;
    for (let depth = 0; depth < 2; depth++) {
      const stripped = this._stripPrefix(candidate);
      if (!stripped) break;
      if (!bestPrefix) bestPrefix = stripped.prefix;
      if (PREFIX_SCORE[stripped.prefix] > (PREFIX_SCORE[bestPrefix] || 0)) {
        bestPrefix = stripped.prefix;
      }
      idx = this.nameIndex.get(stripped.rest);
      if (idx !== undefined) return { idx, prefix: bestPrefix, stem: stripped.rest };
      candidate = stripped.rest;
    }

    if (/[\u0400-\u04FF]/.test(phrase)) {
      const found = this._cyrillicCaseLookup(phrase);
      if (found !== undefined) return { idx: found, prefix: null, stem: phrase };
    }
    return null;
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

  /** @returns {{prefix, rest}|null} */
  _stripPrefix(phrase) {
    if (!phrase) return null;
    const first = phrase[0];
    if (!HEBREW_PREFIXES.includes(first) && !ARABIC_PREFIXES.includes(first)) return null;
    const rest = phrase.slice(1);
    // Hebrew/Arabic stems can be 2 letters; Latin after a prefix is rare — keep ≥3
    const minRest = HE_AR_RE.test(rest) ? 2 : 3;
    if (rest.length < minRest) return null;
    return { prefix: first, rest };
  }
}

module.exports = { GeonamesParser, normalize };
