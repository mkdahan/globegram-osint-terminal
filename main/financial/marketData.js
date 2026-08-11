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

/**
 * Fetch intraday candles.
 * @param symbol e.g. "GLD", "BTC-USD", "ILS=X"
 * @param opts {dateMs?: number, interval?: string}
 *   dateMs: any timestamp inside the requested trading day (default: now).
 * @returns [{time, open, high, low, close, volume}] time = unix seconds
 */
async function getCandles(symbol, opts = {}) {
  const api = await yf();
  const interval = opts.interval || '1m';
  const anchor = opts.dateMs ? new Date(opts.dateMs) : new Date();

  // Window: start of anchor day (UTC-4h padding) .. +1 day, capped at now.
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setTime(start.getTime() - 6 * 3600 * 1000); // pad for exchanges behind local tz
  const end = new Date(Math.min(start.getTime() + 36 * 3600 * 1000, Date.now()));

  let result;
  try {
    result = await api.chart(
      symbol,
      { period1: start, period2: end, interval },
      { validateResult: false }
    );
  } catch (err) {
    // Schema drift / empty sessions — don't bury app.log in yahoo noise
    console.warn(`[market] chart ${symbol}:`, err.message);
    return [];
  }
  const quotes = (result && result.quotes) || [];
  return quotes
    .filter((q) => q.open != null && q.close != null)
    .map((q) => ({
      time: Math.floor(new Date(q.date).getTime() / 1000),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume || 0,
    }));
}

/** Lightweight quote for tape / validation. */
async function getQuote(symbol) {
  const api = await yf();
  const q = await api.quote(symbol);
  if (!q) return null;
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    changePct: q.regularMarketChangePercent,
    currency: q.currency,
    marketState: q.marketState,
  };
}

module.exports = { getCandles, getQuote };
