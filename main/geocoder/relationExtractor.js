/**
 * Multilingual origin→destination relation extractor.
 *
 * Given message text + already-matched places (with matchedWord), decide
 * directed routes (arrow) vs undirected links (plain line).
 *
 * Languages: English, Hebrew, Arabic, Russian (common OSINT patterns).
 */
'use strict';

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[‐‑–—\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape for RegExp */
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verbs / frames that imply A acts toward B (origin = subject side).
 * Used when two places appear around such a verb.
 */
const EN_DIRECTED = [
  'send', 'sends', 'sent', 'sending',
  'deploy', 'deploys', 'deployed',
  'attack', 'attacks', 'attacked', 'strike', 'strikes', 'struck',
  'invade', 'invades', 'invaded',
  'invest', 'invests', 'invested', 'investment',
  'supply', 'supplies', 'supplied',
  'transfer', 'transfers', 'transferred',
  'export', 'exports', 'exported',
  'launch', 'launches', 'launched',
  'fire', 'fires', 'fired',
  'bomb', 'bombs', 'bombed',
  'aid', 'assist', 'assists',
  'target', 'targets', 'targeted',
  'hit', 'hits',
  'move', 'moves', 'moved', 'moving',
  'advance', 'advances', 'advancing',
];

const HE_DIRECTED = [
  'שלח', 'שלחה', 'שלחו', 'שולח', 'שולחת', 'שולחים',
  'תקף', 'תקפה', 'תקפו', 'תוקף', 'תוקפת',
  'השקיע', 'השקיעה', 'השקיעו', 'משקיע',
  'העביר', 'העבירה', 'העבירו',
  'שיגר', 'שיגרה', 'שיגרו',
  'תקף', 'תקיפה', 'תקיפת',
  'פלש', 'פלשו',
  'סייע', 'סייעה',
  'יצא', 'יצאה', 'יצאו',
  'הפציץ', 'הפציצה', 'הפציצו',
  'ירה', 'ירו',
];

const RU_DIRECTED = [
  'направил', 'направила', 'направили', 'направляет',
  'атаковал', 'атаковала', 'атакует',
  'ударил', 'ударила', 'ударили',
  'инвестировал', 'инвестирует',
  'поставил', 'поставляет',
  'перебросил', 'перебрасывает',
];

/**
 * @param {string} text
 * @param {Array<{name,lat,lon,cc,matchedWord,locativeScore,pop?}>} places
 * @returns {{
 *   routes: Array<{from,to,directed:boolean,pattern:string}>,
 *   origin: object|null,  // where the message bubble should bump from
 * }}
 */
function extractRoutes(text, places) {
  if (!places || places.length === 0) {
    return { routes: [], origin: null };
  }
  if (places.length === 1) {
    return { routes: [], origin: places[0] };
  }

  const norm = normalize(text);
  const indexed = places.map((p, i) => {
    const mw = normalize(p.matchedWord || p.name);
    const pos = mw ? norm.indexOf(mw) : -1;
    return { ...p, _i: i, _mw: mw, _pos: pos < 0 ? 1e9 + i : pos };
  }).sort((a, b) => a._pos - b._pos);

  const routes = [];
  const seen = new Set();

  function addRoute(from, to, directed, pattern) {
    if (!from || !to || from._i === to._i) return;
    // Same country + almost same coords → skip noise
    if (
      from.cc && to.cc && from.cc === to.cc &&
      Math.abs(from.lat - to.lat) < 0.4 && Math.abs(from.lon - to.lon) < 0.4
    ) return;
    const key = `${from._i}->${to._i}:${directed ? 'd' : 'u'}`;
    const rev = `${to._i}->${from._i}:d`;
    if (seen.has(key) || (directed && seen.has(rev))) return;
    seen.add(key);
    routes.push({
      from: strip(from),
      to: strip(to),
      directed,
      pattern,
    });
  }

  function strip(p) {
    const { _i, _mw, _pos, ...rest } = p;
    return rest;
  }

  // --- Pattern sweeps between every ordered pair (by text order) ---
  for (let a = 0; a < indexed.length; a++) {
    for (let b = 0; b < indexed.length; b++) {
      if (a === b) continue;
      const A = indexed[a];
      const B = indexed[b];
      if (!A._mw || !B._mw) continue;

      const between = sliceBetween(norm, A, B);
      const around = norm; // full text for some frames

      // English: from A … to B
      if (
        new RegExp(`\\bfrom\\s+${esc(A._mw)}\\b`).test(around) &&
        new RegExp(`\\bto\\s+${esc(B._mw)}\\b`).test(around)
      ) {
        addRoute(A, B, true, 'en:from-to');
        continue;
      }

      // English: invest/send/… from earlier place toward later place
      if (A._pos < B._pos && hasAny(between, EN_DIRECTED)) {
        addRoute(A, B, true, 'en:verb-to');
        continue;
      }

      // Hebrew: מA … לB  (from A to B) — proclitic or separate
      const heFromA = new RegExp(`(?:^|[\\s])מ${esc(A._mw)}\\b|\\bמ\\s+${esc(A._mw)}\\b`);
      const heToB = new RegExp(`(?:^|[\\s])ל${esc(B._mw)}\\b|\\bל\\s+${esc(B._mw)}\\b|\\bלעבר\\s+${esc(B._mw)}\\b|\\bבכיוון\\s+${esc(B._mw)}\\b`);
      // Also matchedWord itself may include מ/ל
      const aIsFrom = A._mw.startsWith('מ') || heFromA.test(around) || (A.locativeHint || '').includes('prefix:מ');
      const bIsTo =
        B._mw.startsWith('ל') ||
        heToB.test(around) ||
        (B.locativeHint || '').includes('prefix:ל') ||
        (B.matchedWord && /^ל/.test(B.matchedWord));

      if (aIsFrom && bIsTo) {
        addRoute(A, B, true, 'he:mi-le');
        continue;
      }

      // Hebrew: A … directed-verb … לB / לעבר B
      if (A._pos < B._pos && hasAny(between, HE_DIRECTED) && (bIsTo || /לעבר|בכיוון|אל /.test(between))) {
        addRoute(A, B, true, 'he:verb-le');
        continue;
      }

      // Arabic: من A … إلى B
      if (
        new RegExp(`من\\s+${esc(A._mw)}`).test(around) &&
        new RegExp(`(إلى|الى|على)\\s+${esc(B._mw)}`).test(around)
      ) {
        addRoute(A, B, true, 'ar:min-ila');
        continue;
      }

      // Russian: из A … в B / на B
      if (
        new RegExp(`\\bиз\\s+${esc(A._mw)}\\b`).test(around) &&
        new RegExp(`\\b(в|на|к)\\s+${esc(B._mw)}\\b`).test(around)
      ) {
        addRoute(A, B, true, 'ru:iz-v');
        continue;
      }
      if (A._pos < B._pos && hasAny(between, RU_DIRECTED)) {
        addRoute(A, B, true, 'ru:verb');
        continue;
      }
    }
  }

  // If we found directed routes, origin = first route's from
  if (routes.length) {
    const directed = routes.filter((r) => r.directed);
    const use = directed.length ? directed : routes;
    return { routes: use.slice(0, 6), origin: use[0].from };
  }

  // No directed structure → undirected spokes from the primary place
  // (highest locative / earliest) to each other place
  const origin = indexed[0];
  for (let i = 1; i < indexed.length; i++) {
    addRoute(origin, indexed[i], false, 'link:undirected');
  }
  return { routes: routes.slice(0, 6), origin: strip(origin) };
}

function sliceBetween(norm, A, B) {
  const start = Math.min(A._pos, B._pos);
  const end = Math.max(A._pos + A._mw.length, B._pos + B._mw.length);
  if (start >= 1e9) return norm;
  return norm.slice(start, end + 40);
}

function hasAny(text, words) {
  for (const w of words) {
    if (text.includes(w.toLowerCase())) return true;
  }
  return false;
}

module.exports = { extractRoutes, normalize };
