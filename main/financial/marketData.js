/**
 * Yahoo Finance market data (via yahoo-finance2): 1-minute intraday candles
 * for any symbol, and simple quotes for live tape updates.
 */
'use strict';

let _yf = null;
async function yf() {
  if (_yf) return _yf;
  const mod = await import('yahoo-finance2');
  // v3: default export is a class to instantiate; v2: ready-made instance.
  const D = mod.default;
  _yf = typeof D === 'function'
    ? new D({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
      // Yahoo often returns schema-drifted chart payloads; don't spam app.log
      validation: { logErrors: false },
    })
    : D;
  return _yf;
}

/** Dead / empty symbols — skip network for NEGATIVE_TTL_MS after a hard miss. */
const NEGATIVE_TTL_MS = 12 * 60 * 60 * 1000;
const WARN_COOLDOWN_MS = 60 * 60 * 1000;
const _negCache = new Map(); // symbol -> { until, reason, warnedAt }

function _symKey(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isBlocked(symbol) {
  const k = _symKey(symbol);
  const hit = _negCache.get(k);
  if (!hit) return false;
  if (Date.now() >= hit.until) {
    _negCache.delete(k);
    return false;
  }
  return true;
}

function _block(symbol, reason) {
  const k = _symKey(symbol);
  const now = Date.now();
  const prev = _negCache.get(k);
  const warnedRecently = prev && prev.warnedAt && now - prev.warnedAt < WARN_COOLDOWN_MS;
  _negCache.set(k, {
    until: now + NEGATIVE_TTL_MS,
    reason,
    warnedAt: warnedRecently ? prev.warnedAt : now,
  });
  if (!warnedRecently) {
    console.warn(`[market] chart ${k}: ${reason} (caching ${NEGATIVE_TTL_MS / 3600000}h)`);
  }
}

function clearNegativeCache(symbol) {
  if (symbol) _negCache.delete(_symKey(symbol));
  else _negCache.clear();
}

/**
 * Fetch intraday candles.
 * @param symbol e.g. "GLD", "BTC-USD", "ILS=X"
 * @param opts {dateMs?: number, interval?: string}
 *   dateMs: any timestamp inside the requested trading day (default: now).
 * @returns [{time, open, high, low, close, volume}] time = unix seconds
 */
async function getCandles(symbol, opts = {}) {
  const k = _symKey(symbol);
  if (!k) return [];
  if (isBlocked(k)) return [];

  const api = await yf();
  const interval = opts.interval || '1m';
  const now = Date.now();
  // Globe scrub can jump into the future — never ask Yahoo for start > end.
  const anchorMs = Math.min(opts.dateMs != null ? Number(opts.dateMs) : now, now);
  const anchor = new Date(anchorMs);

  // Window: start of anchor day (UTC-4h padding) .. +1 day, capped at now.
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setTime(start.getTime() - 6 * 3600 * 1000); // pad for exchanges behind local tz
  const endMs = Math.min(start.getTime() + 36 * 3600 * 1000, now);
  if (start.getTime() >= endMs) {
    _block(k, 'start date cannot be after end date');
    return [];
  }
  const end = new Date(endMs);

  let result;
  try {
    result = await api.chart(
      k,
      { period1: start, period2: end, interval },
      { validateResult: false }
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Hard misses (delisted / empty) get a long negative cache so refreshLive
    // cannot spam app.log every 15s overnight.
    if (/delisted|No data found|not found|Invalid|Unknown symbol/i.test(msg)) {
      _block(k, msg);
    } else {
      // Transient network — short cooldown, rate-limit identical warns
      const prev = _negCache.get(k);
      const now2 = Date.now();
      if (!prev || !prev.warnedAt || now2 - prev.warnedAt > WARN_COOLDOWN_MS) {
        console.warn(`[market] chart ${k}:`, msg);
        _negCache.set(k, {
          until: now2 + 5 * 60 * 1000,
          reason: msg,
          warnedAt: now2,
        });
      } else {
        _negCache.set(k, {
          until: now2 + 5 * 60 * 1000,
          reason: msg,
          warnedAt: prev.warnedAt,
        });
      }
    }
    return [];
  }
  const quotes = (result && result.quotes) || [];
  const candles = quotes
    .filter((q) => q.open != null && q.close != null)
    .map((q) => ({
      time: Math.floor(new Date(q.date).getTime() / 1000),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume || 0,
    }));
  if (!candles.length) {
    _block(k, 'No data found, symbol may be delisted');
    return [];
  }
  // Success — clear any prior negative cache
  _negCache.delete(k);
  return candles;
}

/** Lightweight quote for tape / validation. */
async function getQuote(symbol) {
  const k = _symKey(symbol);
  if (!k || isBlocked(k)) return null;
  const api = await yf();
  try {
    const q = await api.quote(k, {}, { validateResult: false });
    if (!q) return null;
    return {
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent,
      currency: q.currency,
      marketState: q.marketState,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/delisted|No data found|not found|Invalid|Unknown symbol/i.test(msg)) {
      _block(k, msg);
    }
    return null;
  }
}

module.exports = { getCandles, getQuote, isBlocked, clearNegativeCache };
