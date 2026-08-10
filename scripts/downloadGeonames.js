/**
 * Build the full multilingual GeoNames gazetteer.
 *
 * Downloads cities15000.zip, countryInfo.txt, and alternateNamesV2.zip from
 * download.geonames.org, streams through them, and writes a compact JSON
 * gazetteer to %LOCALAPPDATA%\globegram-terminal\gazetteer.json
 * (kept OUTSIDE the repo — it is large and regenerable).
 *
 * Countries are included (so "Bulgaria" / "בולגריה" match) using each country's
 * capital coordinates from cities15000 when available.
 *
 * Kept languages: en, he, ar, ru, zh, de  (+ canonical/ascii names).
 * Population filter: cities15000 already guarantees pop >= 15000, which
 * suppresses tiny-village false positives.
 *
 * Usage: npm run build-gazetteer
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');
const yauzl = require('yauzl');

const { GAZETTEER_PATH, DATA_DIR } = require('../main/paths');

const LANGS = new Set(['en', 'he', 'ar', 'ru', 'zh', 'zh-CN', 'zh-Hans', 'de']);
const MIN_NAME_LEN = 3;
const MIN_NAME_LEN_CJK = 2;
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const TMP_DIR = path.join(os.tmpdir(), 'globegram-geonames');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const COUNTRY_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';
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
 * Stream every line of the main data .txt inside a zip.
 * Skips readme / iso-languagecodes sidecar files (alternateNamesV2.zip
 * ships those first — previously we stopped after the sidecar and kept 0 names).
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
        if (opened) return zip.readEntry(); // already streaming the main file
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

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[1/5] Downloading GeoNames dumps');
  const citiesZip = await download(CITIES_URL, path.join(TMP_DIR, 'cities15000.zip'));
  const countryTxt = await download(COUNTRY_URL, path.join(TMP_DIR, 'countryInfo.txt'));
  const altZip = await download(ALT_URL, path.join(TMP_DIR, 'alternateNamesV2.zip'));

  console.log('[2/5] Parsing cities15000 (population-filtered cities)');
  /** geonameid -> entry */
  const cities = new Map();
  /** lowercase capital name -> {lat,lon} for country placement */
  const capitalCoords = new Map();
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
    cities.set(id, { id, name, lat, lon, cc, pop, names });
    capitalCoords.set(name.toLowerCase(), { lat, lon });
    if (ascii) capitalCoords.set(ascii.toLowerCase(), { lat, lon });
  });
  console.log(`  ${cities.size} cities loaded`);

  console.log('[3/5] Parsing countryInfo (countries so "Bulgaria"/"בולגריה" match)');
  let countriesAdded = 0;
  const countryLines = fs.readFileSync(countryTxt, 'utf-8').split(/\r?\n/);
  for (const line of countryLines) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    // ISO, ISO3, ISO-Numeric, fips, Country, Capital, Area, Population, Continent, ..., geonameid
    if (f.length < 17) continue;
    const cc = f[0];
    const name = f[4];
    const capital = f[5];
    const pop = Number(f[7]) || 0;
    const id = Number(f[16]);
    if (!id || !name || cities.has(id)) continue;
    const coords =
      (capital && capitalCoords.get(capital.toLowerCase())) ||
      { lat: 0, lon: 0 };
    if (!coords.lat && !coords.lon) continue;
    cities.set(id, {
      id,
      name,
      lat: coords.lat,
      lon: coords.lon,
      cc,
      pop: Math.max(pop, 1_000_000), // keep countries visible vs tiny towns
      names: new Set([name]),
    });
    countriesAdded++;
  }
  console.log(`  ${countriesAdded} countries added`);

  console.log('[4/5] Streaming alternateNamesV2 (multilingual names: en/he/ar/ru/zh/de)');
  let kept = 0;
  let scanned = 0;
  await eachZipLine(altZip, (line) => {
    scanned++;
    if (scanned % 2_000_000 === 0) process.stdout.write(`\r  ${scanned / 1e6}M rows scanned, ${kept} names kept`);
    const f = line.split('\t');
    if (f.length < 4) return;
    const geonameid = Number(f[1]);
    const lang = f[2];
    const altName = f[3];
    // f[4] isPreferredName, f[5] isShortName, f[6] isColloquial, f[7] isHistoric
    if (f[7] === '1') return; // skip historic names
    if (!LANGS.has(lang)) return;
    const entry = cities.get(geonameid);
    if (!entry) return;
    const minLen = CJK_RE.test(altName) ? MIN_NAME_LEN_CJK : MIN_NAME_LEN;
    if (!altName || altName.length < minLen) return;
    if (altName === entry.name) return;
    entry.names.add(altName);
    kept++;
  });
  process.stdout.write('\n');
  console.log(`  ${kept} alternate names kept`);

  console.log('[5/5] Writing gazetteer JSON');
  const entries = [...cities.values()].map((e) => ({
    id: e.id,
    name: e.name,
    lat: e.lat,
    lon: e.lon,
    cc: e.cc,
    pop: e.pop,
    names: [...e.names],
  }));
  entries.sort((a, b) => b.pop - a.pop);
  const out = {
    version: 1,
    source: 'GeoNames cities15000 + countryInfo + alternateNamesV2',
    builtAt: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(GAZETTEER_PATH, JSON.stringify(out), 'utf-8');
  const mb = (fs.statSync(GAZETTEER_PATH).size / 1e6).toFixed(1);
  console.log(`Done: ${entries.length} locations -> ${GAZETTEER_PATH} (${mb} MB)`);
  console.log('Restart the app to use the full gazetteer.');
}

main().catch((err) => {
  console.error('Gazetteer build failed:', err);
  process.exit(1);
});
