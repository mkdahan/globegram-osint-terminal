/**
 * TradingView Lightweight Charts multi-chart grid manager.
 * - dynamic add/remove of tickers (1-minute candles via main-process Yahoo fetch)
 * - live tail updates
 * - telegram-event markers on every chart
 * - programmatic crosshair (driven by the Cesium clock) + click-to-scrub
 */
/* global LightweightCharts */

const CHART_OPTS = {
  layout: {
    background: { type: 'solid', color: '#0b0e14' },
    textColor: '#7d8598',
    fontSize: 11,
  },
  grid: {
    vertLines: { color: '#161b28' },
    horzLines: { color: '#161b28' },
  },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232a3b' },
  rightPriceScale: { borderColor: '#232a3b' },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
    vertLine: { color: '#4da3ff55', labelBackgroundColor: '#4da3ff' },
    horzLine: { color: '#4da3ff55', labelBackgroundColor: '#4da3ff' },
  },
  autoSize: true,
};

const SERIES_OPTS = {
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
};

export class ChartManager {
  /**
   * @param gridEl container element
   * @param onBarClick callback(unixMs) when the user clicks a candle (chart -> globe sync)
   */
  constructor(gridEl, onBarClick) {
    this.grid = gridEl;
    this.onBarClick = onBarClick;
    this.charts = new Map(); // symbol -> {chart, series, cell, candles, markers}
    this.eventMarkers = []; // shared across charts
    this.currentDateMs = null; // null = today/live
    this.onTickersChanged = null;
  }

  get symbols() {
    return [...this.charts.keys()];
  }

  async addChart(symbol) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol || this.charts.has(symbol)) return;
    // Reject obvious junk tickers before they enter the live refresh loop
    if (!/^[A-Z0-9][A-Z0-9.\-=]{0,22}$/.test(symbol)) return;
    if (/^(WE|WITH|AT|ONE|MAJOR|FOR|ARE|THE|AND|2024|2025)$/i.test(symbol)) return;

    const cell = document.createElement('div');
    cell.className = 'chart-cell';
    cell.innerHTML = `
      <div class="chart-head">
        <span class="sym">${symbol}</span>
        <span class="px">—</span>
        <span class="chg"></span>
        <button class="close-chart" title="Remove">×</button>
      </div>
      <div class="chart-body"></div>`;
    this.grid.appendChild(cell);
    this._reflow();

    const body = cell.querySelector('.chart-body');
    const chart = LightweightCharts.createChart(body, CHART_OPTS);
    const series = chart.addCandlestickSeries(SERIES_OPTS);

    const rec = { chart, series, cell, candles: [], symbol, failCount: 0, dead: false };
    this.charts.set(symbol, rec);

    cell.querySelector('.close-chart').addEventListener('click', () => this.removeChart(symbol));
    chart.subscribeClick((param) => {
      if (param && param.time && this.onBarClick) {
        this.onBarClick(Number(param.time) * 1000);
      }
    });

    await this._loadData(rec);
    if (this.onTickersChanged) this.onTickersChanged(this.symbols);
  }

  removeChart(symbol) {
    const rec = this.charts.get(symbol);
    if (!rec) return;
    rec.chart.remove();
    rec.cell.remove();
    this.charts.delete(symbol);
    this._reflow();
    if (this.onTickersChanged) this.onTickersChanged(this.symbols);
  }

  _reflow() {
    this.grid.classList.toggle('two-col', this.grid.children.length > 3);
  }

  async _loadData(rec) {
    const res = await window.api.market.candles(rec.symbol, this.currentDateMs, '1m');
    const errEl = rec.cell.querySelector('.chart-err');
    if (errEl) errEl.remove();
    if (!res.ok || !res.candles.length) {
      rec.failCount = (rec.failCount || 0) + 1;
      if (rec.failCount >= 2) rec.dead = true;
      const d = document.createElement('div');
      d.className = 'chart-err';
      d.textContent = res.error || 'no data for this date';
      rec.cell.querySelector('.chart-body').appendChild(d);
      rec.candles = [];
      rec.series.setData([]);
      return;
    }
    rec.failCount = 0;
    rec.dead = false;
    rec.candles = res.candles;
    rec.series.setData(res.candles);
    rec.series.setMarkers(this._markersFor());
    rec.chart.timeScale().fitContent();
    this._updateHeader(rec);
  }

  _updateHeader(rec) {
    if (!rec.candles.length) return;
    const last = rec.candles[rec.candles.length - 1];
    const first = rec.candles[0];
    const chg = ((last.close - first.open) / first.open) * 100;
    rec.cell.querySelector('.px').textContent = last.close.toFixed(last.close < 10 ? 4 : 2);
    const chgEl = rec.cell.querySelector('.chg');
    chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    chgEl.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
  }

  /** Live mode: refresh the tail of every chart. */
  async refreshLive() {
    if (this.currentDateMs !== null) return; // scrubbed to history — don't touch
    for (const rec of this.charts.values()) {
      if (rec.dead) continue; // stop hammering delisted / junk symbols
      const res = await window.api.market.candles(rec.symbol, null, '1m');
      if (!res.ok || !res.candles.length) {
        rec.failCount = (rec.failCount || 0) + 1;
        if (rec.failCount >= 3) {
          rec.dead = true;
          if (!rec.cell.querySelector('.chart-err')) {
            const d = document.createElement('div');
            d.className = 'chart-err';
            d.textContent = 'no data — paused refresh';
            rec.cell.querySelector('.chart-body').appendChild(d);
          }
        }
        continue;
      }
      rec.failCount = 0;
      // Cheap + safe: replace data (1 day of 1m bars is small)
      rec.candles = res.candles;
      rec.series.setData(res.candles);
      rec.series.setMarkers(this._markersFor());
      this._updateHeader(rec);
    }
  }

  /** Scrub to a specific historical day (or null to return to today/live). */
  async loadDate(dateMs) {
    const now = Date.now();
    // Future globe clock → clamp to today so Yahoo never sees start > end
    if (dateMs != null && dateMs > now) dateMs = now;
    const sameDay =
      (dateMs === null && this.currentDateMs === null) ||
      (dateMs !== null && this.currentDateMs !== null &&
        new Date(dateMs).toDateString() === new Date(this.currentDateMs).toDateString());
    this.currentDateMs = dateMs;
    if (sameDay) return;
    for (const rec of this.charts.values()) {
      rec.dead = false;
      rec.failCount = 0;
      await this._loadData(rec);
    }
  }

  /** Telegram event -> marker at time T on every chart. */
  addEventMarker(event) {
    const timeSec = Math.floor(event.date / 1000);
    this.eventMarkers.push({
      time: timeSec,
      position: 'aboveBar',
      color: event.highPriority ? '#ff5252' : '#4da3ff',
      shape: 'circle',
      text: (event.targets && event.targets[0] ? event.targets[0].name : '').slice(0, 12),
      size: event.highPriority ? 2 : 1,
    });
    this.eventMarkers.sort((a, b) => a.time - b.time);
    for (const rec of this.charts.values()) {
      rec.series.setMarkers(this._markersFor());
    }
  }

  _markersFor() {
    return this.eventMarkers;
  }

  /** Globe -> chart sync: move the crosshair on all charts to unix ms T. */
  setCrosshairAt(unixMs) {
    const t = Math.floor(unixMs / 1000 / 60) * 60; // snap to minute
    for (const rec of this.charts.values()) {
      if (!rec.candles.length) continue;
      const bar = this._nearestBar(rec.candles, t);
      if (bar) {
        rec.series && rec.chart.setCrosshairPosition(bar.close, bar.time, rec.series);
      }
    }
  }

  clearCrosshair() {
    for (const rec of this.charts.values()) {
      rec.chart.clearCrosshairPosition();
    }
  }

  _nearestBar(candles, timeSec) {
    // binary search for closest bar
    let lo = 0;
    let hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time < timeSec) lo = mid + 1;
      else hi = mid;
    }
    return candles[lo];
  }
}
