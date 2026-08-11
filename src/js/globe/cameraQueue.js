/**
 * FIFO camera fly-to queue.
 * Flies to an event's origin (bubble place). When the event has a from→to
 * route, frames both ends so the arrow is visible. Respects popupMinSec so
 * bubbles stay readable before the next flight.
 */
/* global Cesium */

const DEFAULT_INTERVAL_SEC = 4;
const NORMAL_HEIGHT = 120_000;
const BURST_HEIGHT = 600_000;
const BURST_THRESHOLD = 8;
const ROUTE_HEIGHT = 2_800_000;

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
    if (!event.targets || !event.targets.length) return;
    this.queue.push(event);
    this._updateBadge();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 250);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  setIntervalSec(sec) {
    this.intervalSec = Math.max(1, Number(sec) || DEFAULT_INTERVAL_SEC);
  }

  _tick() {
    if (this.paused || !this.queue.length) {
      this._updateBadge();
      return;
    }
    if (Date.now() < this._busyUntil) return;

    const burst = this.queue.length > BURST_THRESHOLD;
    const flyDuration = burst ? 1.0 : 2.2;

    const event = this.queue.shift();
    const origin = event.origin || event.targets[0];
    const routes = event.routes || [];
    const minStay = Math.max(
      this.intervalSec,
      Number(event.popupMinSec) || this.intervalSec
    );
    this._busyUntil = Date.now() + (burst ? 1500 : minStay * 1000);

    const done = () => {
      if (this.onArrive) this.onArrive(event, origin);
      // Bubble bumps from the origin place
      this.cesium.showBubble(event, origin);
    };

    if (!burst && routes.length && routes[0].from && routes[0].to) {
      this._flyRoute(routes[0], flyDuration, done);
    } else {
      const height = burst ? BURST_HEIGHT : NORMAL_HEIGHT;
      this.cesium.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(origin.lon, origin.lat, height),
        duration: flyDuration,
        complete: done,
      });
    }
    this._updateBadge();
  }

  /** Frame both ends of a route so the arrow is in view. */
  _flyRoute(route, duration, complete) {
    const { from, to } = route;
    const midLat = (from.lat + to.lat) / 2;
    const midLon = (from.lon + to.lon) / 2;
    // Rough distance → height so both ends fit
    const dLat = Math.abs(from.lat - to.lat);
    const dLon = Math.abs(from.lon - to.lon) * Math.cos((midLat * Math.PI) / 180);
    const deg = Math.sqrt(dLat * dLat + dLon * dLon);
    const height = Math.min(8_000_000, Math.max(ROUTE_HEIGHT, deg * 180_000));

    this.cesium.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(midLon, midLat, height),
      duration,
      complete,
    });
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
