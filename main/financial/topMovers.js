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
let _backoffUntil = 0;
let _failStreak = 0;
const CACHE_MS = 30 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

async function getTopMovers(count = 25) {
  const now = Date.now();
  if (now - _cache.at < CACHE_MS && _cache.data.length) return _cache.data;
  if (now < _backoffUntil) return _cache.data; // stale better than hammering

  const api = await yf();
  let quotes = [];
  try {
    const res = await api.screener(
      { scrIds: 'day_gainers', count },
      { validateResult: false }
    );
    quotes = (res && res.quotes) || [];
    _failStreak = 0;
    _backoffUntil = 0;
  } catch (err) {
    _failStreak++;
    const wait = Math.min(MAX_BACKOFF_MS, 30_000 * (2 ** Math.min(_failStreak - 1, 4)));
    _backoffUntil = Date.now() + wait;
    // Log once per backoff window — never call deprecated dailyGainers
    if (_failStreak <= 2 || _failStreak % 10 === 0) {
      console.warn(
        `[topMovers] screener failed (streak=${_failStreak}, backoff ${Math.round(wait / 1000)}s):`,
        err.message
      );
    }
    return _cache.data;
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
