/**
 * FIFO camera fly-to queue.
 * Flies to an event's origin (bubble place). When the event has a from→to
 * route, frames both ends so the arrow is visible.
 *
 * Stay time ALWAYS honors popupMinSec / intervalSec — a long queue never
 * shortens how long the user gets to read a message (darknet bursts used
 * to collapse this to 1.5s).
 */
/* global Cesium */

const DEFAULT_INTERVAL_SEC = 8;
const NORMAL_HEIGHT = 120_000;
const STACK_HEIGHT = 900_000;
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
    // Live floods used to grow an hour-long queue so the globe looked stuck
    // on old news. Keep the newest events; drop the oldest overflow.
    const MAX_QUEUE = 12;
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
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
    this.intervalSec = Math.max(3, Number(sec) || DEFAULT_INTERVAL_SEC);
  }

  _tick() {
    if (this.paused || !this.queue.length) {
      this._updateBadge();
      return;
    }
    if (Date.now() < this._busyUntil) return;

    const event = this.queue.shift();
    const origin = event.origin || event.targets[0];
    const routes = event.routes || [];
    // Readable pacing — never collapse below the user's setting
    const minStay = Math.max(
      3,
      this.intervalSec,
      Number(event.popupMinSec) || this.intervalSec
    );
    const flyDuration = routes.length ? 2.4 : 2.0;
    // Stay clock starts when we BEGIN showing this event (includes fly time)
    this._busyUntil = Date.now() + minStay * 1000;

    // Swap globe graphics NOW: previous pins/lines vanish, this message's
    // places + connections appear while the camera flies to them.
    this.cesium.focusEvent(event);

    const done = () => {
      if (this.onArrive) this.onArrive(event, origin);
      this.cesium.showBubble(event, origin);
    };

    if (routes.length && routes[0].from && routes[0].to) {
      this._flyRoute(routes[0], flyDuration, done);
    } else if (origin) {
      const height = this.queue.length > 12 ? STACK_HEIGHT : NORMAL_HEIGHT;
      this.cesium.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(origin.lon, origin.lat, height),
        duration: flyDuration,
        complete: done,
      });
    } else {
      done();
    }
    this._updateBadge();
  }

  /** Frame both ends of a route so the arrow is in view. */
  _flyRoute(route, duration, complete) {
    const { from, to } = route;
    const midLat = (from.lat + to.lat) / 2;
    const midLon = (from.lon + to.lon) / 2;
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
      this._badge.textContent = `QUEUE ${this.queue.length} · ${this.intervalSec}s each`;
      this._badge.classList.remove('hidden');
    } else {
      this._badge.classList.add('hidden');
    }
  }
}
