/**
 * Build a worldwide GeoNames gazetteer: countries + cities + regions.
 *
 * Sources (download.geonames.org):
 *   - cities1000.zip     — every city with population ≥ 1,000
 *   - countryInfo.txt    — every country
 *   - admin1CodesASCII.txt — states / provinces / regions (ADM1)
 *   - alternateNamesV2.zip — multilingual aliases
 *
 * Languages kept (priority: Hebrew + English):
 *   en, he, and GeoNames empty-lang rows (official English short names),
 *   plus ar / ru / zh / de for OSINT coverage.
 *
 * Output: %LOCALAPPDATA%\globegram-terminal\gazetteer.json
 * Usage:  npm run build-gazetteer
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');
const yauzl = require('yauzl');

const { GAZETTEER_PATH, DATA_DIR } = require('../main/paths');

// Empty string = GeoNames "no language" rows (almost always English)
// 'iw' = old ISO 639 code for Hebrew (still used in many GeoNames rows)
const LANGS = new Set(['', 'en', 'he', 'iw', 'ar', 'ru', 'zh', 'zh-CN', 'zh-Hans', 'de']);
const MIN_NAME_LEN = 3;
const MIN_NAME_LEN_HE = 2; // Hebrew can be short (e.g. עכו)
const MIN_NAME_LEN_CJK = 2;
const HE_RE = /[\u0590-\u05FF]/;
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/
const TMP_DIR = path.join(os.tmpdir(), 'globegram-geonames');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities1000.zip';
const COUNTRY_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';
const ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';
const ALT_URL = 'https://download.geonames.org/export/dump/alternateNamesV2.zip';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  cached: ${path.basename(dest)}`);
      return resolve(dest);
    }
    console.log(`  downloading ${url} ...`);
    const file = fs.createWriteStream(dest + '.part');
    const get = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const total = Number(res.headers['content-length'] || 0);
          let got = 0;
          res.on('data', (c) => {
            got += c.length;
            if (total && got % (20 * 1024 * 1024) < c.length) {
              process.stdout.write(`\r  ${Math.round((got / total) * 100)}% of ${Math.round(total / 1e6)} MB`);
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              process.stdout.write('\n');
              fs.renameSync(dest + '.part', dest);
              resolve(dest);
            });
          });
        })
        .on('error', reject);
    };
    get(url);
  });
}

/**
 * Stream the main data .txt inside a zip (skip readme / language-code sidecars).
 */
function eachZipLine(zipPath, onLine) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let opened = false;
      zip.readEntry();
      zip.on('entry', (entry) => {
        const name = (entry.fileName || '').toLowerCase();
        const skip =
          !name.endsWith('.txt') ||
          name.includes('readme') ||
          name.includes('iso-language') ||
          name.includes('languagecode');
        if (skip) return zip.readEntry();
        if (opened) return zip.readEntry();
        opened = true;
        console.log(`  reading zip entry: ${entry.fileName}`);
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          rl.on('line', onLine);
          rl.on('close', () => {
            zip.close();
            resolve();
          });
          rl.on('error', reject);
        });
      });
      zip.on('end', () => {
        if (!opened) reject(new Error(`No data .txt found in ${zipPath}`));
      });
      zip.on('error', reject);
    });
  });
}

function minLenFor(name) {
  if (CJK_RE.test(name)) return MIN_NAME_LEN_CJK;
  if (HE_RE.test(name)) return MIN_NAME_LEN_HE;
  return MIN_NAME_LEN;
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[1/6] Downloading GeoNames dumps (cities1000 + countries + admin1 regions)');
  const citiesZip = await download(CITIES_URL, path.join(TMP_DIR, 'cities1000.zip'));
  const countryTxt = await download(COUNTRY_URL, path.join(TMP_DIR, 'countryInfo.txt'));
  const admin1Txt = await download(ADMIN1_URL, path.join(TMP_DIR, 'admin1CodesASCII.txt'));
  const altZip = await download(ALT_URL, path.join(TMP_DIR, 'alternateNamesV2.zip'));

  /** geonameid -> entry */
  const places = new Map();
  /** lowercase city name -> {lat,lon} — used to place countries near their capital */
  const cityCoords = new Map();
  /** admin1 geonameid -> {code, name, ascii} — coords filled when we see the id in alt pass or cities */
  const admin1Pending = new Map();

  console.log('[2/6] Parsing cities1000 (all cities with population ≥ 1,000)');
  await eachZipLine(citiesZip, (line) => {
    const f = line.split('\t');
    if (f.length < 15) return;
    const id = Number(f[0]);
    const name = f[1];
    const ascii = f[2];
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    const cc = f[8];
    const pop = Number(f[14]) || 0;
    if (!id || !name || Number.isNaN(lat) || Number.isNaN(lon)) return;
    const names = new Set();
    if (ascii && ascii !== name) names.add(ascii);
    places.set(id, { id, name, lat, lon, cc, pop, kind: 'city', names });
    cityCoords.set(name.toLowerCase(), { lat, lon });
    if (ascii) cityCoords.set(ascii.toLowerCase(), { lat, lon });
  });
  console.log(`  ${places.size} cities loaded`);

  console.log('[3/6] Parsing countryInfo (every country)');
  let countriesAdded = 0;
  for (const line of fs.readFileSync(countryTxt, 'utf-8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 17) continue;
    const cc = f[0];
    const name = f[4];
    const capital = f[5];
    const pop = Number(f[7]) || 0;
    const id = Number(f[16]);
    if (!id || !name) continue;
    if (places.has(id)) {
      // Upgrade existing city-as-country-id (rare) / ensure country aliases
      const cur = places.get(id);
      cur.kind = 'country';
      cur.names.add(name);
      cur.pop = Math.max(cur.pop || 0, pop, 1_000_000);
      continue;
    }
    const coords = (capital && cityCoords.get(capital.toLowerCase())) || null;
    if (!coords) continue;
    places.set(id, {
      id,
      name,
      lat: coords.lat,
      lon: coords.lon,
      cc,
      pop: Math.max(pop, 1_000_000),
      kind: 'country',
      names: new Set([name]),
    });
    countriesAdded++;
  }
  console.log(`  ${countriesAdded} countries added`);

  console.log('[4/6] Parsing admin1CodesASCII (states / provinces / regions)');
  let admin1Count = 0;
  for (const line of fs.readFileSync(admin1Txt, 'utf-8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    // code \t name \t asciiName \t geonameid
    if (f.length < 4) continue;
    const code = f[0]; // e.g. "US.CA", "IL.02"
    const name = f[1];
    const ascii = f[2];
    const id = Number(f[3]);
    if (!id || !name) continue;
    const cc = code.split('.')[0] || '';
    admin1Pending.set(id, { code, name, ascii, cc });
    if (places.has(id)) {
      const cur = places.get(id);
      cur.kind = cur.kind === 'country' ? 'country' : 'region';
      cur.names.add(name);
      if (ascii && ascii !== name) cur.names.add(ascii);
      admin1Count++;
    } else {
      // Placeholder — coordinates filled from alternateNames linked place or centroid later
      places.set(id, {
        id,
        name,
        lat: null,
        lon: null,
        cc,
        pop: 500_000, // mid-tier so regions rank above tiny towns
        kind: 'region',
        names: new Set([name, ascii].filter(Boolean)),
        _admin1: code,
      });
      admin1Count++;
    }
  }
  console.log(`  ${admin1Count} admin1 regions registered`);

  console.log('[5/6] Streaming alternateNamesV2 (Hebrew + English first, plus ar/ru/zh/de)');
  let kept = 0;
  let scanned = 0;
  let heKept = 0;
  let enKept = 0;
  // While scanning alts we also harvest lat/lon? Alts don't have coords.
  // Fill region coords from any city in the same country that shares the region name,
  // or leave for a second pass.
  await eachZipLine(altZip, (line) => {
    scanned++;
    if (scanned % 2_000_000 === 0) {
      process.stdout.write(`\r  ${scanned / 1e6}M rows · ${kept} names (he=${heKept} en=${enKept})`);
    }
    const f = line.split('\t');
    if (f.length < 4) return;
    const geonameid = Number(f[1]);
    const lang = f[2] == null ? '' : f[2];
    const altName = f[3];
    if (f[7] === '1') return; // historic
    if (!LANGS.has(lang)) return;
    const entry = places.get(geonameid);
    if (!entry) return;
    if (!altName || altName.length < minLenFor(altName)) return;
    if (altName === entry.name) return;
    if (!entry.names.has(altName)) {
      entry.names.add(altName);
      kept++;
      if (lang === 'he' || lang === 'iw' || HE_RE.test(altName)) heKept++;
      if (lang === 'en' || lang === '') enKept++;
    }
  });
  process.stdout.write('\n');
  console.log(`  ${kept} alternate names kept (Hebrew≈${heKept}, English≈${enKept})`);

  console.log('[6/6] Filling region coordinates + writing gazetteer');
  // For admin1 regions without coords: use average of cities in that country
  // whose ascii/name appears in the region name, else country centroid.
  const countryCentroid = new Map(); // cc -> {lat,lon,n}
  for (const e of places.values()) {
    if (e.kind !== 'city' || e.lat == null || !e.cc) continue;
    const c = countryCentroid.get(e.cc) || { lat: 0, lon: 0, n: 0 };
    c.lat += e.lat;
    c.lon += e.lon;
    c.n++;
    countryCentroid.set(e.cc, c);
  }
  for (const [cc, c] of countryCentroid) {
    countryCentroid.set(cc, { lat: c.lat / c.n, lon: c.lon / c.n });
  }

  let regionsFixed = 0;
  let regionsDropped = 0;
  for (const e of places.values()) {
    if (e.lat != null && e.lon != null) continue;
    // Try to find a city with the same name in the same country
    let found = null;
    for (const c of places.values()) {
      if (c.kind !== 'city' || c.cc !== e.cc) continue;
      if (c.name === e.name || (e.names && e.names.has(c.name))) {
        found = c;
        break;
      }
    }
    if (found) {
      e.lat = found.lat;
      e.lon = found.lon;
      regionsFixed++;
    } else if (countryCentroid.has(e.cc)) {
      const cen = countryCentroid.get(e.cc);
      e.lat = cen.lat;
      e.lon = cen.lon;
      regionsFixed++;
    } else {
      regionsDropped++;
    }
  }

  const entries = [];
  for (const e of places.values()) {
    if (e.lat == null || e.lon == null || Number.isNaN(e.lat) || Number.isNaN(e.lon)) continue;
    entries.push({
      id: e.id,
      name: e.name,
      lat: e.lat,
      lon: e.lon,
      cc: e.cc,
      pop: e.pop || 0,
      kind: e.kind || 'city',
      names: [...e.names],
    });
  }
  entries.sort((a, b) => b.pop - a.pop);

  const out = {
    version: 2,
    source: 'GeoNames cities1000 + countryInfo + admin1CodesASCII + alternateNamesV2',
    builtAt: new Date().toISOString(),
    stats: {
      total: entries.length,
      countries: entries.filter((e) => e.kind === 'country').length,
      regions: entries.filter((e) => e.kind === 'region').length,
      cities: entries.filter((e) => e.kind === 'city').length,
      regionsFixed,
      regionsDropped,
      alternateNames: kept,
      hebrewNames: heKept,
      englishNames: enKept,
    },
    entries,
  };
  fs.writeFileSync(GAZETTEER_PATH, JSON.stringify(out), 'utf-8');
  const mb = (fs.statSync(GAZETTEER_PATH).size / 1e6).toFixed(1);
  console.log(
    `Done: ${entries.length} places ` +
      `(${out.stats.countries} countries, ${out.stats.regions} regions, ${out.stats.cities} cities) ` +
      `-> ${GAZETTEER_PATH} (${mb} MB)`
  );
  console.log('Run `npm run bundle-databases` to ship this into the repo.');
}

main().catch((err) => {
  console.error('Gazetteer build failed:', err);
  process.exit(1);
});
