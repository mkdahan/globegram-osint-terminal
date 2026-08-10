/**
 * After building full DBs into %LOCALAPPDATA%, copy trimmed/bundled copies
 * into the repo so clones work out-of-the-box without re-downloading.
 *
 *   npm run build-gazetteer
 *   npm run build-companies
 *   npm run bundle-databases
 *
 * Or: npm run build-all   (runs all three)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  GAZETTEER_PATH,
  COMPANIES_PATH,
  SEED_GAZETTEER_PATH,
  SEED_COMPANIES_PATH,
  ROOT,
} = require('../main/paths');

const OUT_GAZ = path.join(ROOT, 'main', 'geocoder', 'bundled-gazetteer.json');
const OUT_CO = path.join(ROOT, 'main', 'corporate', 'bundled-companies.json');

// Worldwide cities1000 + countries + admin1 regions ≈ 150–200k entries.
// GitHub hard limit is 100 MB/file — keep aliases lean (he/en first).
const MAX_GAZETTEER_ENTRIES = 250000;
const MAX_NAMES_PER_PLACE = 16;
const MAX_COMPANY_ENTRIES = 12000;
const MAX_ALIASES_PER_COMPANY = 12;

const HE_RE = /[\u0590-\u05FF]/
const LAT_RE = /^[\x00-\x7F]+$/; // prefer ASCII/English among non-Hebrew

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function bundleGazetteer() {
  const raw = loadJson(GAZETTEER_PATH);
  const seed = loadJson(SEED_GAZETTEER_PATH);
  if (!raw || !raw.entries) {
    console.warn(`[skip] no full gazetteer at ${GAZETTEER_PATH} — run npm run build-gazetteer first`);
    return false;
  }
  const pickNames = (names) => {
    const list = [...new Set(names || [])];
    // Prefer Hebrew + English/ASCII, then others
    list.sort((a, b) => {
      const score = (n) => (HE_RE.test(n) ? 2 : 0) + (LAT_RE.test(n) ? 1 : 0);
      return score(b) - score(a);
    });
    return list.slice(0, MAX_NAMES_PER_PLACE);
  };

  const byId = new Map();
  for (const e of raw.entries.slice(0, MAX_GAZETTEER_ENTRIES)) {
    byId.set(e.id, {
      id: e.id,
      name: e.name,
      lat: e.lat,
      lon: e.lon,
      cc: e.cc,
      pop: e.pop,
      kind: e.kind || 'city',
      names: pickNames(e.names),
    });
  }
  // Merge curated seed entries (Tryavna, Kiryat Gat, Hebrew country aliases, …)
  for (const e of (seed && seed.entries) || []) {
    if (!byId.has(e.id)) {
      byId.set(e.id, e);
    } else {
      const cur = byId.get(e.id);
      const names = new Set([...(cur.names || []), ...(e.names || []), e.name]);
      cur.names = [...names].slice(0, 30);
    }
  }
  const entries = [...byId.values()].sort((a, b) => (b.pop || 0) - (a.pop || 0));
  const out = {
    version: 1,
    source: `bundled from ${raw.source || 'geonames'} + seed`,
    builtAt: new Date().toISOString(),
    entries,
  };
  writeAtomic(OUT_GAZ, JSON.stringify(out));
  const mb = (fs.statSync(OUT_GAZ).size / 1e6).toFixed(1);
  console.log(`[gazetteer] ${entries.length} locations -> ${OUT_GAZ} (${mb} MB)`);
  return true;
}

/** Write via temp+rename (avoids OneDrive locks on in-place overwrite). */
function writeAtomic(dest, data) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  } catch {
    /* locked — try replace anyway */
  }
  fs.renameSync(tmp, dest);
}

function bundleCompanies() {
  const raw = loadJson(COMPANIES_PATH);
  const seed = loadJson(SEED_COMPANIES_PATH);
  if (!raw || !raw.companies) {
    console.warn(`[skip] no full companies DB at ${COMPANIES_PATH} — run npm run build-companies first`);
    return false;
  }
  const keyOf = (c) =>
    (c.ticker && String(c.ticker).toUpperCase()) ||
    String(c.name || '').toLowerCase();

  const ranked = [...raw.companies].sort((a, b) => {
    const score = (c) => (c.yahoo ? 2 : 0) + (c.ticker ? 1 : 0) + Math.min((c.aliases || []).length, 5) * 0.1;
    return score(b) - score(a);
  });

  const byKey = new Map();
  for (const c of ranked.slice(0, MAX_COMPANY_ENTRIES)) {
    byKey.set(keyOf(c), c);
  }
  // Always keep curated OSINT seed companies (EMCO, Elbit, Baykar, …)
  for (const c of (seed && seed.companies) || []) {
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, c);
    else {
      const cur = byKey.get(k);
      const aliases = new Set([...(cur.aliases || []), ...(c.aliases || []), c.name, c.ticker]);
      cur.aliases = [...aliases].filter(Boolean);
      if (!cur.yahoo && c.yahoo) cur.yahoo = c.yahoo;
      if (!cur.ticker && c.ticker) cur.ticker = c.ticker;
    }
  }

  const companies = [...byKey.values()].map((c, i) => ({
    id: i + 1,
    name: c.name,
    ticker: c.ticker || null,
    yahoo: c.yahoo || null,
    exchange: c.exchange || null,
    country: c.country || null,
    cc: c.cc || null,
    lat: c.lat,
    lon: c.lon,
    aliases: [c.name, c.ticker, ...(c.aliases || [])]
      .filter(Boolean)
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .slice(0, MAX_ALIASES_PER_COMPANY),
  }));
  const out = {
    version: 1,
    source: `bundled from ${raw.source || 'wikidata'} + seed`,
    builtAt: new Date().toISOString(),
    companies,
  };
  writeAtomic(OUT_CO, JSON.stringify(out));
  const mb = (fs.statSync(OUT_CO).size / 1e6).toFixed(1);
  console.log(`[companies] ${companies.length} companies -> ${OUT_CO} (${mb} MB)`);
  return true;
}

const g = bundleGazetteer();
const c = bundleCompanies();
if (!g && !c) {
  console.error('Nothing to bundle. Build the databases first.');
  process.exit(1);
}
console.log('Done. Restart the app to load the bundled databases.');
