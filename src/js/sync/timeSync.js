/**
 * Bi-directional timeline synchronization: Cesium master clock <-> charts.
 *
 * LIVE mode: Cesium clock follows the system clock; charts append live ticks.
 * SCRUB mode: entered when the user drags the Cesium timeline or clicks a
 * candle. Globe->chart: clock onTick drives the chart crosshair. Chart->globe:
 * candle click sets the Cesium clock (and globe entity availability filtering
 * does the rest).
 */
/* global Cesium */

const LIVE_TOLERANCE_MS = 90 * 1000; // how far from "now" still counts as live
const CROSSHAIR_THROTTLE_MS = 250;

export class TimeSync {
  constructor(cesiumManager, chartManager) {
    this.cesium = cesiumManager;
    this.charts = chartManager;
    this.mode = 'live';
    this._lastCrosshairPush = 0;
    this._suppressTick = false;

    this._badge = document.getElementById('mode-badge');
    this._goLiveBtn = document.getElementById('go-live');
    this._goLiveBtn.addEventListener('click', () => this.goLive());

    // Globe -> charts
    this.cesium.viewer.clock.onTick.addEventListener((clock) => this._onTick(clock));

    // Charts -> globe (wired by app.js through chartManager.onBarClick)
  }

  _onTick(clock) {
    if (this._suppressTick) return;
    const nowMs = Date.now();
    const clockMs = Cesium.JulianDate.toDate(clock.currentTime).getTime();
    const drift = Math.abs(nowMs - clockMs);

    if (drift > LIVE_TOLERANCE_MS) {
      if (this.mode !== 'scrub') this._setMode('scrub');
      // throttled crosshair + (possibly) historical day load
      if (nowMs - this._lastCrosshairPush > CROSSHAIR_THROTTLE_MS) {
        this._lastCrosshairPush = nowMs;
        this.charts.loadDate(clockMs).then(() => this.charts.setCrosshairAt(clockMs));
      }
    } else if (this.mode !== 'live') {
      this._setMode('live');
      this.charts.loadDate(null);
      this.charts.clearCrosshair();
    }
  }

  /** Chart candle clicked -> move the globe clock to that instant. */
  onChartClick(unixMs) {
    const clock = this.cesium.viewer.clock;
    this._suppressTick = true;
    clock.currentTime = Cesium.JulianDate.fromDate(new Date(unixMs));
    clock.shouldAnimate = false;
    clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
    this._suppressTick = false;
    this._setMode('scrub');
    this.charts.setCrosshairAt(unixMs);
    // keep the timeline widget centered on the scrub point
    const t = Cesium.JulianDate.fromDate(new Date(unixMs));
    const start = Cesium.JulianDate.addHours(t, -6, new Cesium.JulianDate());
    const stop = Cesium.JulianDate.addHours(t, 6, new Cesium.JulianDate());
    this.cesium.viewer.timeline.zoomTo(start, stop);
  }

  goLive() {
    const clock = this.cesium.viewer.clock;
    clock.currentTime = Cesium.JulianDate.now();
    clock.multiplier = 1;
    clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    clock.shouldAnimate = true;
    const now = Cesium.JulianDate.now();
    const start = Cesium.JulianDate.addHours(now, -24, new Cesium.JulianDate());
    const stop = Cesium.JulianDate.addHours(now, 1, new Cesium.JulianDate());
    this.cesium.viewer.timeline.zoomTo(start, stop);
    this._setMode('live');
    this.charts.loadDate(null);
    this.charts.clearCrosshair();
  }

  _setMode(mode) {
    this.mode = mode;
    if (mode === 'live') {
      this._badge.textContent = '● LIVE';
      this._badge.className = 'live';
      this._goLiveBtn.classList.add('hidden');
    } else {
      this._badge.textContent = '◆ SCRUB';
      this._badge.className = 'scrub';
      this._goLiveBtn.classList.remove('hidden');
    }
  }
}
