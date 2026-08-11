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

    // WhatsApp-style place bubbles (HTML over Cesium canvas)
    this._bubblesEl = document.getElementById('globe-bubbles');
    this._bubbles = []; // {el, lon, lat, until, key}
    this.viewer.scene.preRender.addEventListener(() => this._positionBubbles());

    // Click an entity -> reopen its sticky card + bubble
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const picked = this.viewer.scene.pick(movement.position);
      if (picked && picked.id && picked.id._globegramEvent) {
        const { event, loc } = picked.id._globegramEvent;
        this.showPopup(event, loc);
        this.showBubble(event, event.origin || loc);
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

    const isDarknet = event.stream === 'darknet' || String(event.source || '').startsWith('DARKNET');
    const entities = [];
    (event.targets || []).forEach((target, i) => {
      const isCompany = target.kind === 'company';
      let color;
      if (isDarknet) color = Cesium.Color.fromCssColorString('#ff2d55');
      else if (isCompany) color = Cesium.Color.GOLD;
      else color = event.highPriority ? Cesium.Color.RED : Cesium.Color.CYAN;

      const labelText = isDarknet
        ? `🔒 ${isCompany ? `${target.name}${target.ticker ? ` [${target.ticker}]` : ''}` : target.name}`
        : isCompany
          ? `${target.name}${target.ticker ? ` [${target.ticker}]` : ''}`
          : target.name;

      const entity = this.viewer.entities.add({
        id: `${event.key}:t${i}`,
        availability,
        position: Cesium.Cartesian3.fromDegrees(target.lon, target.lat),
        point: {
          pixelSize: isDarknet ? 16 : (event.highPriority ? 13 : 9),
          color: color.withAlpha(0.95),
          outlineColor: isDarknet ? Cesium.Color.WHITE : Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: isDarknet ? 3 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: labelText,
          font: isDarknet || isCompany ? 'bold 12px "Segoe UI", sans-serif' : '13px "Segoe UI", sans-serif',
          fillColor: isDarknet ? Cesium.Color.fromCssColorString('#ff8fa3') : (isCompany ? Cesium.Color.GOLD : Cesium.Color.WHITE),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity._globegramEvent = { event, loc: target };
      entities.push(entity);
    });

    // From→to arrows (directed) or plain links (undirected)
    for (const route of event.routes || []) {
      const ent = this._addRouteEntity(event, route, start, availability);
      if (ent) entities.push(ent);
    }

    this.events.set(event.key, { event, entities });
  }

  /**
   * Great-circle polyline. Directed → arrow material; else soft glow line.
   */
  _addRouteEntity(event, route, start, availability) {
    if (!route.from || !route.to) return null;
    const isDarknet = event.stream === 'darknet';
    const color = isDarknet
      ? Cesium.Color.fromCssColorString('#ff2d55')
      : route.directed
        ? Cesium.Color.fromCssColorString('#4da3ff')
        : Cesium.Color.fromCssColorString('#9aa4b8');

    // Arc above ground so the path reads clearly
    const positions = this._arcPositions(route.from, route.to, 32);
    const material = route.directed
      ? new Cesium.PolylineArrowMaterialProperty(color)
      : new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: color.withAlpha(0.85) });

    const entity = this.viewer.entities.add({
      id: `${event.key}:route:${route.from.name}->${route.to.name}:${route.pattern}`,
      availability,
      polyline: {
        positions,
        width: route.directed ? 10 : 5,
        material,
        arcType: Cesium.ArcType.NONE, // we already built the arc
        clampToGround: false,
      },
    });
    entity._globegramEvent = { event, loc: route.from };
    return entity;
  }

  /** Raised geodesic-ish arc between two lat/lon points. */
  _arcPositions(a, b, n = 32) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lon = a.lon + (b.lon - a.lon) * t;
      // Peak height in the middle
      const h = Math.sin(Math.PI * t) * 180_000;
      out.push(Cesium.Cartesian3.fromDegrees(lon, lat, h));
    }
    return out;
  }

  /**
   * WhatsApp-style message bubble that "bumps out" from a place on the globe.
   * Stays at least popupMinSec seconds (from the event / settings).
   */
  showBubble(event, origin) {
    if (!this._bubblesEl || !event || !origin) return;
    const minSec = Math.max(3, Number(event.popupMinSec) || 6);

    // Replace existing bubble for same event key
    this._bubbles = this._bubbles.filter((b) => {
      if (b.key === event.key) {
        b.el.remove();
        return false;
      }
      return true;
    });

    const el = document.createElement('div');
    el.className = 'geo-bubble'
      + (event.stream === 'darknet' ? ' darknet' : '')
      + (event.highPriority ? ' high' : '');
    const time = new Date(event.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const routes = event.routes || [];
    let routeHint = '';
    if (routes[0] && routes[0].from && routes[0].to) {
      routeHint = routes[0].directed
        ? `${routes[0].from.name} → ${routes[0].to.name}`
        : `${routes[0].from.name} — ${routes[0].to.name}`;
    }
    el.innerHTML =
      `<div class="gb-head">` +
        `<span class="gb-chan">${escapeText(event.chatTitle || '')}</span>` +
        `<span class="gb-time">${time}</span>` +
      `</div>` +
      (routeHint ? `<div class="gb-route">${escapeText(routeHint)}</div>` : '') +
      `<div class="gb-place">${escapeText(origin.name || '')}</div>` +
      `<div class="gb-text">${escapeText((event.text || '').slice(0, 220))}</div>` +
      `<div class="gb-tail"></div>`;

    el.addEventListener('click', () => {
      this.showPopup(event, origin);
      if (event.media && !event.mediaPath && window.api?.events?.requestMedia) {
        window.api.events.requestMedia(event.chatId, event.msgId, event.key);
      }
    });

    this._bubblesEl.appendChild(el);
    // bump-in animation
    requestAnimationFrame(() => el.classList.add('in'));

    this._bubbles.push({
      el,
      lon: origin.lon,
      lat: origin.lat,
      until: Date.now() + minSec * 1000,
      key: event.key,
    });

    // Cap concurrent bubbles
    while (this._bubbles.length > 5) {
      const old = this._bubbles.shift();
      old.el.remove();
    }
  }

  _positionBubbles() {
    if (!this._bubbles.length) return;
    const scene = this.viewer.scene;
    const now = Date.now();
    const keep = [];
    for (const b of this._bubbles) {
      if (now > b.until) {
        b.el.classList.add('out');
        setTimeout(() => b.el.remove(), 280);
        continue;
      }
      const cartesian = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 0);
      const ok = new Cesium.Cartesian2();
      const pinned = Cesium.SceneTransforms.worldToWindowCoordinates(scene, cartesian, ok);
      if (!pinned) {
        b.el.style.visibility = 'hidden';
      } else {
        // Hide when on the far side of the globe
        const cam = scene.camera.positionWC;
        const ell = scene.globe.ellipsoid;
        const surface = ell.scaleToGeodeticSurface(cartesian) || cartesian;
        const toCam = Cesium.Cartesian3.subtract(cam, surface, new Cesium.Cartesian3());
        const normal = ell.geodeticSurfaceNormal(surface, new Cesium.Cartesian3());
        const facing = Cesium.Cartesian3.dot(toCam, normal) > 0;
        b.el.style.visibility = facing ? 'visible' : 'hidden';
        b.el.style.left = `${Math.round(ok.x)}px`;
        b.el.style.top = `${Math.round(ok.y)}px`;
      }
      keep.push(b);
    }
    this._bubbles = keep;
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
    const isDarknet = event.stream === 'darknet' || String(event.source || '').startsWith('DARKNET');
    p.el.classList.toggle('darknet-popup', isDarknet);
    const latest = p.el.querySelector('.latest-label');
    if (latest) latest.textContent = isDarknet ? 'DARKNET THREAT' : 'LATEST MATCH';
    p.title.textContent = isDarknet
      ? `${event.victim || target.name} — ${event.groupName || event.chatTitle}`
      : `${target.name} — ${event.chatTitle}`;
    let bodyText = event.text ? event.text.slice(0, 400) : '';
    if (isDarknet && event.leakUrl) bodyText += `\n${event.leakUrl}`;
    p.text.textContent = bodyText;
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
