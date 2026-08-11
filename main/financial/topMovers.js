/**
 * Top market-movers scanner: polls Yahoo's predefined day_gainers screener
 * and flags extreme moves (>20% and >100%).
 */
'use strict';

let _yf = null;
async function yf() {
  if (_yf) return _yf;
  const mod = await import('yahoo-finance2');
  // v3: default export is a class to instantiate; v2: ready-made instance.
  const D = mod.default;
  _yf = typeof D === 'function'
    ? new D({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false } })
    : D;
  return _yf;
}

let _cache = { at: 0, data: [] };
const CACHE_MS = 30 * 1000;

async function getTopMovers(count = 25) {
  if (Date.now() - _cache.at < CACHE_MS && _cache.data.length) return _cache.data;
  const api = await yf();
  let quotes = [];
  try {
    const res = await api.screener(
      { scrIds: 'day_gainers', count },
      { validateResult: false }
    );
    quotes = (res && res.quotes) || [];
  } catch (err) {
    // Older API name, kept as fallback
    try {
      const res = await api.dailyGainers({ count }, { validateResult: false });
      quotes = (res && res.quotes) || [];
    } catch (err2) {
      console.error('[topMovers] screener failed:', err.message, '|', err2.message);
      return _cache.data; // stale is better than nothing
    }
  }
  const data = quotes
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent || 0,
      volume: q.regularMarketVolume || 0,
      extreme: (q.regularMarketChangePercent || 0) >= 100,
      hot: (q.regularMarketChangePercent || 0) >= 20,
    }))
    .sort((a, b) => b.changePct - a.changePct);
  _cache = { at: Date.now(), data };
  return data;
}

module.exports = { getTopMovers };
