/**
 * Build the full corporate database from Wikidata (public domain).
 *
 * SPARQL: public companies that have a stock-exchange listing (P414) with a
 * ticker qualifier (P249) and a headquarters location (P159) that has
 * coordinates (P625). Collects labels + aliases in en/he/ar/ru/zh/de.
 *
 * Output: %LOCALAPPDATA%\globegram-terminal\companies.json (outside the repo).
 * The bundled seed keeps working if this script is never run.
 *
 * Usage: npm run build-companies
 */
'use strict';

const fs = require('fs');
const https = require('https');
const { COMPANIES_PATH, DATA_DIR } = require('../main/paths');

const LANGS = ['en', 'he', 'ar', 'ru', 'zh', 'de'];

// Yahoo Finance symbol suffix per exchange (Wikidata entity id)
const EXCHANGE_SUFFIX = {
  Q13677: { name: 'NYSE', suffix: '' },
  Q82059: { name: 'NASDAQ', suffix: '' },
  Q517750: { name: 'TASE', suffix: '.TA' },
  Q171240: { name: 'LSE', suffix: '.L' },
  Q2385849: { name: 'XETRA', suffix: '.DE' },
  Q152139: { name: 'FWB', suffix: '.DE' },
  Q2013380: { name: 'Euronext Paris', suffix: '.PA' },
  Q1141387: { name: 'Borsa Italiana', suffix: '.MI' },
  Q217475: { name: 'SIX', suffix: '.SW' },
  Q373340: { name: 'MCX', suffix: '.ME' },
  Q496672: { name: 'HKEX', suffix: '.HK' },
  Q186773: { name: 'KRX', suffix: '.KS' },
  Q217012: { name: 'TSE', suffix: '.T' },
  Q909548: { name: 'TSX', suffix: '.TO' },
  Q1019992: { name: 'Nasdaq Stockholm', suffix: '.ST' },
  Q1019987: { name: 'Copenhagen', suffix: '.CO' },
  Q1043309: { name: 'Tadawul', suffix: '.SR' },
};

const SPARQL = `
SELECT DISTINCT ?c ?ticker ?exch ?cc ?coord ?label (LANG(?label) AS ?lang) WHERE {
  ?c p:P414 ?listing.
  ?listing ps:P414 ?exch.
  ?listing pq:P249 ?ticker.
  ?c wdt:P159 ?hq.
  ?hq wdt:P625 ?coord.
  OPTIONAL { ?hq wdt:P17 ?country. ?country wdt:P297 ?cc. }
  { ?c rdfs:label ?label. } UNION { ?c skos:altLabel ?label. }
  FILTER(LANG(?label) IN (${LANGS.map((l) => `"${l}"`).join(', ')}))
}
LIMIT 200000
`;

function fetchSparql(query) {
  return new Promise((resolve, reject) => {
    const body = 'query=' + encodeURIComponent(query);
    const req = https.request(
      {
        hostname: 'query.wikidata.org',
        path: '/sparql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/sparql-results+json',
          // WDQS requires a descriptive User-Agent
          'User-Agent': 'GlobeGram-OSINT-Terminal/0.1 (open-source research tool)',
        },
        timeout: 300000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`WDQS HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('WDQS timeout')));
    req.write(body);
    req.end();
  });
}

function parseCoord(wkt) {
  // "Point(lon lat)"
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt || '');
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[1/2] Querying Wikidata SPARQL (may take a few minutes)...');
  const json = await fetchSparql(SPARQL);
  const rows = json.results.bindings;
  console.log(`  ${rows.length} rows received`);

  console.log('[2/2] Aggregating companies');
  const byId = new Map();
  for (const row of rows) {
    const qid = row.c.value.split('/').pop();
    const coord = parseCoord(row.coord && row.coord.value);
    if (!coord) continue;
    const exchQid = row.exch ? row.exch.value.split('/').pop() : null;
    const exchInfo = EXCHANGE_SUFFIX[exchQid];
    let rec = byId.get(qid);
    if (!rec) {
      rec = {
        id: qid,
        name: null,
        ticker: row.ticker ? row.ticker.value : null,
        yahoo: null,
        exchange: exchInfo ? exchInfo.name : exchQid,
        country: null,
        cc: row.cc ? row.cc.value : null,
        lat: coord.lat,
        lon: coord.lon,
        aliases: new Set(),
      };
      byId.set(qid, rec);
    }
    if (exchInfo && rec.ticker && !rec.yahoo) {
      rec.yahoo = rec.ticker + exchInfo.suffix;
    }
    const label = row.label && row.label.value;
    const lang = row.lang && row.lang.value;
    if (label && label.length >= 2 && label.length <= 60) {
      rec.aliases.add(label);
      if (lang === 'en' && !rec.name) rec.name = label;
    }
  }

  const companies = [];
  let i = 0;
  for (const rec of byId.values()) {
    if (!rec.name) rec.name = [...rec.aliases][0] || rec.ticker;
    if (!rec.name) continue;
    companies.push({
      id: ++i,
      name: rec.name,
      ticker: rec.ticker,
      yahoo: rec.yahoo || rec.ticker,
      exchange: rec.exchange,
      country: rec.country,
      cc: rec.cc,
      lat: rec.lat,
      lon: rec.lon,
      aliases: [...rec.aliases],
    });
  }

  const out = {
    version: 1,
    source: 'Wikidata SPARQL (P414 listings + P159 HQ)',
    builtAt: new Date().toISOString(),
    companies,
  };
  fs.writeFileSync(COMPANIES_PATH, JSON.stringify(out), 'utf-8');
  const mb = (fs.statSync(COMPANIES_PATH).size / 1e6).toFixed(1);
  console.log(`Done: ${companies.length} companies -> ${COMPANIES_PATH} (${mb} MB)`);
  console.log('Restart the app to use the full corporate database.');
}

main().catch((err) => {
  console.error('Company DB build failed:', err.message);
  process.exit(1);
});
