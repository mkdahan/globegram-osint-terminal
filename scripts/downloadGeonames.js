/**
 * Build the full multilingual GeoNames gazetteer.
 *
 * Downloads cities15000.zip (~2 MB) and alternateNamesV2.zip (~190 MB) from
 * download.geonames.org, streams through them, and writes a compact JSON
 * gazetteer to %LOCALAPPDATA%\globegram-terminal\gazetteer.json
 * (kept OUTSIDE the repo — it is large and regenerable).
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

/** Stream every line of the first .txt entry inside a zip file. */
function eachZipLine(zipPath, onLine) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (!entry.fileName.endsWith('.txt') || entry.fileName.includes('readme')) {
          return zip.readEntry();
        }
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
      zip.on('error', reject);
    });
  });
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[1/4] Downloading GeoNames dumps');
  const citiesZip = await download(CITIES_URL, path.join(TMP_DIR, 'cities15000.zip'));
  const altZip = await download(ALT_URL, path.join(TMP_DIR, 'alternateNamesV2.zip'));

  console.log('[2/4] Parsing cities15000 (population-filtered cities)');
  /** geonameid -> entry */
  const cities = new Map();
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
  });
  console.log(`  ${cities.size} cities loaded`);

  console.log('[3/4] Streaming alternateNamesV2 (multilingual names: en/he/ar/ru/zh/de)');
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

  console.log('[4/4] Writing gazetteer JSON');
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
    source: 'GeoNames cities15000 + alternateNamesV2',
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
