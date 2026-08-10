/**
 * CesiumJS viewer setup + event entity management + anchored media popup.
 * Uses Carto's free dark basemap (no token required); falls back to the
 * offline Natural Earth II imagery bundled with Cesium if offline.
 */
/* global Cesium */

const EVENT_VISIBILITY_HOURS = 12; // how long an event stays on the globe when scrubbing

/** ISO-3166 alpha-2 -> flag emoji */
function countryFlag(cc) {
  if (!cc || cc.length !== 2) return '';
  const base = 0x1f1e6;
  const a = 'A'.charCodeAt(0);
  return String.fromCodePoint(
    base + cc.toUpperCase().charCodeAt(0) - a,
    base + cc.toUpperCase().charCodeAt(1) - a
  );
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function darkBasemap() {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    credit: new Cesium.Credit('© OpenStreetMap contributors © CARTO'),
    maximumLevel: 19,
  });
}

export class CesiumManager {
  constructor(containerId) {
    this.viewer = new Cesium.Viewer(containerId, {
      baseLayer: new Cesium.ImageryLayer(darkBasemap()),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      animation: true,
      timeline: true,
      fullscreenButton: false,
      shouldAnimate: true,
    });

    const clock = this.viewer.clock;
    clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    clock.shouldAnimate = true;

    // Timeline window: last 24h .. +1h
    const now = Cesium.JulianDate.now();
    const start = Cesium.JulianDate.addHours(now, -24, new Cesium.JulianDate());
    const stop = Cesium.JulianDate.addHours(now, 1, new Cesium.JulianDate());
    this.viewer.timeline.zoomTo(start, stop);

    this.events = new Map(); // key -> {event, entities: [Entity]}
    this.lastEvent = null; // last matched event (sticky card always shows this)
    this.lastTarget = null;
    this.onLoadTicker = null; // callback(yahooSymbol) from corporate popup button
    this._popup = {
      el: document.getElementById('media-popup'),
      title: document.getElementById('media-popup-title'),
      body: document.getElementById('media-popup-body'),
      text: document.getElementById('media-popup-text'),
      key: null,
      dismissed: false, // user closed it — reopen only on a new match
    };
    document.getElementById('media-popup-close').addEventListener('click', () => this.hidePopup());

    // Click an entity -> reopen its sticky card
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const picked = this.viewer.scene.pick(movement.position);
      if (picked && picked.id && picked.id._globegramEvent) {
        const { event, loc } = picked.id._globegramEvent;
        this.showPopup(event, loc);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Initial camera: Middle East overview
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(35.0, 31.5, 2_500_000),
    });

    this._installOfflineFallback();
  }

  /** If Carto tiles keep failing (offline), swap to bundled Natural Earth II. */
  _installOfflineFallback() {
    const layer = this.viewer.imageryLayers.get(0);
    if (!layer) return;
    let failures = 0;
    let swapped = false;
    const remove = layer.imageryProvider.errorEvent.addEventListener(async () => {
      failures++;
      if (swapped || failures < 10) return;
      swapped = true;
      remove();
      try {
        const provider = await Cesium.TileMapServiceImageryProvider.fromUrl(
          Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
        );
        this.viewer.imageryLayers.removeAll();
        this.viewer.imageryLayers.addImageryProvider(provider);
        console.warn('[globe] network tiles unavailable — using offline Natural Earth II');
      } catch (err) {
        console.error('[globe] offline fallback failed:', err);
      }
    });
  }

  /**
   * Add globe entities for a geo-event. Each target is either a
   * {kind:'place'} geographic match or a {kind:'company'} HQ match.
   */
  addEvent(event) {
    if (this.events.has(event.key)) return;
    const start = Cesium.JulianDate.fromDate(new Date(event.date));
    const stop = Cesium.JulianDate.addHours(start, EVENT_VISIBILITY_HOURS, new Cesium.JulianDate());
    const availability = new Cesium.TimeIntervalCollection([
      new Cesium.TimeInterval({ start, stop }),
    ]);

    const entities = [];
    (event.targets || []).forEach((target, i) => {
      const isCompany = target.kind === 'company';
      const color = isCompany
        ? Cesium.Color.GOLD
        : event.highPriority ? Cesium.Color.RED : Cesium.Color.CYAN;
      const labelText = isCompany
        ? `${target.name}${target.ticker ? ` [${target.ticker}]` : ''}`
        : target.name;
      const entity = this.viewer.entities.add({
        id: `${event.key}:t${i}`,
        availability,
        position: Cesium.Cartesian3.fromDegrees(target.lon, target.lat),
        point: {
          pixelSize: event.highPriority ? 13 : 9,
          color: color.withAlpha(0.9),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: labelText,
          font: isCompany ? 'bold 12px "Segoe UI", sans-serif' : '13px "Segoe UI", sans-serif',
          fillColor: isCompany ? Cesium.Color.GOLD : Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity._globegramEvent = { event, loc: target };
      entities.push(entity);
    });
    this.events.set(event.key, { event, entities });
  }

  /** Attach downloaded media to the sticky card if it is showing this event. */
  attachMedia(key, filePath) {
    const rec = this.events.get(key);
    if (rec) rec.event.mediaPath = filePath;
    if (this.lastEvent && this.lastEvent.key === key) {
      this.lastEvent.mediaPath = filePath;
    }
    if (this._popup.key === key && !this._popup.dismissed) {
      this._renderPopupMedia(this.lastEvent || (rec && rec.event));
    }
  }

  /**
   * Show the sticky "latest match" card. Screen-fixed (not world-anchored),
   * so it stays visible after the camera moves / queue finishes.
   * New matches replace the content; it does not auto-hide.
   */
  showPopup(event, target) {
    if (!event || !target) return;
    this.lastEvent = event;
    this.lastTarget = target;
    const p = this._popup;
    p.dismissed = false;
    p.key = event.key;
    p.title.textContent = `${target.name} — ${event.chatTitle}`;
    p.text.textContent = event.text ? event.text.slice(0, 400) : '';
    this._renderCorporateBadge(event, target);
    this._renderPopupMedia(event);
    p.el.classList.remove('hidden');
    p.el.style.display = '';
  }

  /** Corporate badge: [Name] | Ticker | Flag + "Load chart" button. */
  _renderCorporateBadge(event, target) {
    const holder = document.getElementById('media-popup-corp');
    holder.innerHTML = '';
    const company = target.kind === 'company'
      ? target
      : (event.targets || []).find((t) => t.kind === 'company');
    if (!company) return;
    const badge = document.createElement('div');
    badge.className = 'corp-badge';
    const flag = countryFlag(company.cc);
    badge.innerHTML =
      `<span class="corp-name">🏢 ${escapeText(company.name)}</span>` +
      (company.ticker ? `<span class="corp-ticker">${escapeText(company.ticker)}</span>` : '') +
      `<span class="corp-flag">${flag} ${escapeText(company.country || company.cc || '')}</span>`;
    holder.appendChild(badge);
    if (company.yahoo && this.onLoadTicker) {
      const btn = document.createElement('button');
      btn.className = 'corp-chart-btn';
      btn.textContent = `Load ${company.ticker || company.yahoo} chart`;
      btn.addEventListener('click', () => this.onLoadTicker(company.yahoo));
      holder.appendChild(btn);
    }
  }

  _renderPopupMedia(event) {
    const body = this._popup.body;
    body.innerHTML = '';
    if (event.mediaPath) {
      const url = 'file:///' + String(event.mediaPath).replace(/\\/g, '/');
      if (/\.(mp4|webm|mov)$/i.test(event.mediaPath)) {
        const v = document.createElement('video');
        v.src = url;
        v.autoplay = true;
        v.loop = true;
        v.muted = true;
        v.controls = true;
        body.appendChild(v);
      } else {
        const img = document.createElement('img');
        img.src = url;
        body.appendChild(img);
      }
    } else if (event.media) {
      const d = document.createElement('div');
      d.className = 'placeholder';
      d.textContent = event.highPriority
        ? `Downloading ${event.media.kind}…`
        : `${event.media.kind} available — click event card to download`;
      body.appendChild(d);
    }
  }

  hidePopup() {
    // Manual dismiss only — does not clear lastEvent, so a new match still works.
    this._popup.dismissed = true;
    this._popup.el.classList.add('hidden');
    this._popup.body.innerHTML = '';
    document.getElementById('media-popup-corp').innerHTML = '';
  }
}
