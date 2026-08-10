/**
 * FIFO camera fly-to queue.
 * Events queue up and the camera visits them one by one every N seconds.
 * Burst handling: when more than 8 events are pending, fly time drops to 1s
 * and the camera stays higher to cover ground faster.
 */
/* global Cesium */

const DEFAULT_INTERVAL_SEC = 4;
const NORMAL_HEIGHT = 120_000;
const BURST_HEIGHT = 600_000;
const BURST_THRESHOLD = 8;

export class CameraQueue {
  /**
   * @param cesiumManager CesiumManager instance
   * @param onArrive callback(event, loc) fired when the camera reaches an event
   */
  constructor(cesiumManager, onArrive, intervalSec = DEFAULT_INTERVAL_SEC) {
    this.cesium = cesiumManager;
    this.onArrive = onArrive;
    this.queue = [];
    this.intervalSec = intervalSec;
    this._timer = null;
    this._busyUntil = 0;
    this.paused = false;
    this._badge = document.getElementById('queue-badge');
    this.start();
  }

  push(event) {
    // One queue slot per event; fly to its primary target
    // (first geographic location, else first company HQ).
    if (!event.targets || !event.targets.length) return;
    this.queue.push(event);
    this._updateBadge();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 1000);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (this.paused || !this.queue.length) {
      this._updateBadge();
      return;
    }
    if (Date.now() < this._busyUntil) return;

    const burst = this.queue.length > BURST_THRESHOLD;
    const flyDuration = burst ? 1.0 : 2.0;
    const height = burst ? BURST_HEIGHT : NORMAL_HEIGHT;

    const event = this.queue.shift();
    const loc = event.targets[0];
    this._busyUntil = Date.now() + (burst ? 1500 : this.intervalSec * 1000);

    this.cesium.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, height),
      duration: flyDuration,
      complete: () => {
        if (this.onArrive) this.onArrive(event, loc);
      },
    });
    this._updateBadge();
  }

  _updateBadge() {
    if (!this._badge) return;
    if (this.queue.length) {
      this._badge.textContent = `QUEUE ${this.queue.length}${this.queue.length > BURST_THRESHOLD ? ' ⚡BURST' : ''}`;
      this._badge.classList.remove('hidden');
    } else {
      this._badge.classList.add('hidden');
    }
  }
}
