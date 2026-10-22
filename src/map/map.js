/**
 * Map viewer.
 *
 * A deliberately small tile renderer rather than a mapping library: the whole
 * extension has no build step and no dependencies, and pulling in Leaflet to
 * draw one route would cost more than it saves. Tiles are plain <img> elements
 * positioned in a translated container, which the browser is already very good
 * at recycling and decoding.
 */

import { lv95ToWgs84, lineLength } from '../lib/swiss.js';
import { lonLatToWorld, worldToLonLat, zoomToFit, tilesFor } from '../lib/mercator.js';
import {
  MIN_ZOOM, MAX_ZOOM, clampZoom, wheelToZoomDelta, zoomAround,
  panByPixels, tileLevelFor, scaleBarFor,
} from '../lib/viewport.js';
import { BASE_LAYERS, OVERLAY_LAYERS, ATTRIBUTION, SLOPE_LEGEND, defaultOverlaysFor } from '../lib/layers.js';
import { slopeAndAspect, steepSections, summarise } from '../lib/terrain.js';
import { routeColour, disciplineLabel, styleMeaning } from '../lib/disciplines.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'sac-gpx:map-route';

const els = {
  stage: document.getElementById('stage'),
  tiles: document.getElementById('tiles'),
  overlay: document.getElementById('overlay'),
  baseLayers: document.getElementById('base-layers'),
  overlayLayers: document.getElementById('overlay-layers'),
  info: document.getElementById('info'),
  legend: document.getElementById('legend'),
  legendBands: document.getElementById('legend-bands'),
  notation: document.getElementById('notation'),
  notationKeys: document.getElementById('notation-keys'),
  routeName: document.getElementById('route-name'),
  empty: document.getElementById('empty'),
  scale: document.getElementById('scale'),
  scaleLabel: document.getElementById('scale-label'),
  controls: document.getElementById('controls'),
  attribution: document.getElementById('attribution'),
};

/**
 * The view is held as a geographic centre plus a FRACTIONAL zoom.
 *
 * Storing the centre in world pixels made it zoom-dependent, which is why the
 * old wheel handler had to recompute it on every step. Longitude and latitude
 * do not change when you zoom, so the maths gets simpler and the centre stays
 * exact across repeated zooms instead of drifting.
 */
const view = { zoom: 13, lon: 8, lat: 46.8 };


let route = null;
let projected = [];         // segments as WGS84 + world-pixel caches
let activeBase = BASE_LAYERS[0].id;
let activeOverlays = new Set();
let terrainBySegment = new Map();

els.attribution.textContent = ATTRIBUTION;

init();

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  route = stored[STORAGE_KEY] ?? null;

  if (!route?.segments?.length) {
    els.empty.hidden = false;
    els.routeName.textContent = 'No route';
    return;
  }

  document.title = `${route.destination || route.title} — SAC GPX`;
  els.routeName.textContent = [route.destination, route.title].filter(Boolean).join(' · ');

  // The LIGHT variant, despite the dark chrome. The chrome is only the surround
  // — the line is drawn over swisstopo's national map, which is pale paper, and
  // the light variants are the ones tuned to read against it (and against the
  // slope bands). Using the dark variant here put a hot coral red 16° in hue
  // from the 35–40° slope band.
  els.stage.style.setProperty('--route', routeColour(route.discipline, 'light'));
  renderNotation(route);

  projected = route.segments.map((segment) => ({
    ...segment,
    lonLat: segment.coordinates.map(([e, n]) => {
      const { lat, lon } = lv95ToWgs84(e, n);
      return [lon, lat];
    }),
  }));

  for (const id of defaultOverlaysFor(route.discipline)) activeOverlays.add(id);

  buildLayerChips();
  buildControls();
  renderInfo();
  fitToRoute();
  render();
  els.stage.tabIndex = 0;
  wireInteraction();

  loadTerrain();
}

/**
 * Sample terrain for the main line and mark the steep ground.
 *
 * Runs after the first paint: the map is useful immediately, and the slope
 * analysis costs a few hundred milliseconds it should not delay.
 */
async function loadTerrain() {
  const main = route.segments.filter((segment) => !segment.isVariant);
  if (!main.length) return;

  try {
    const everyTerrain = [];
    for (const segment of main) {
      const terrain = await slopeAndAspect(segment.coordinates);
      const sections = steepSections(segment.coordinates, terrain);
      terrainBySegment.set(segment.id, sections);
      everyTerrain.push(...terrain);
    }

    const allSections = [...terrainBySegment.values()].flat();
    route.terrain = summarise(everyTerrain, allSections);
    renderOverlay();
    renderInfo();
  } catch (error) {
    console.warn('[sac-gpx] terrain sampling failed', error);
  }
}

// ------------------------------------------------------------------ layout

function bounds() {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const segment of projected) {
    for (const [lon, lat] of segment.lonLat) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

function fitToRoute() {
  const box = bounds();
  const { clientWidth: width, clientHeight: height } = els.stage;
  view.zoom = clampZoom(zoomToFit(box, width, height));
  view.lon = (box.minLon + box.maxLon) / 2;
  // Latitude is not linear in Mercator, so average in projected space.
  const a = lonLatToWorld(box.minLon, box.maxLat, view.zoom);
  const b = lonLatToWorld(box.maxLon, box.minLat, view.zoom);
  view.lat = worldToLonLat((a.x + b.x) / 2, (a.y + b.y) / 2, view.zoom).lat;
}

/** Top-left of the viewport in world pixels at the current fractional zoom. */
function origin(zoom = view.zoom) {
  const centre = lonLatToWorld(view.lon, view.lat, zoom);
  return {
    x: centre.x - els.stage.clientWidth / 2,
    y: centre.y - els.stage.clientHeight / 2,
  };
}

/** Integer zoom the tiles are fetched at, and the fraction rendered by scaling. */
function tileLevel() {
  return tileLevelFor(view.zoom);
}

// ------------------------------------------------------------------ render

function render() {
  renderTiles();
  renderOverlay();
  renderScale();
}

function renderTiles() {
  // Tiles only exist at integer zooms. Fetch the nearest level and let CSS
  // scale the container for the fraction, so zooming stays continuous instead
  // of snapping between levels.
  const { zoom: tileZoom, scale } = tileLevel();
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;

  // In unscaled tile space the viewport covers width/scale by height/scale.
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  const centre = lonLatToWorld(view.lon, view.lat, tileZoom);
  const originX = centre.x - viewWidth / 2;
  const originY = centre.y - viewHeight / 2;

  els.tiles.style.width = `${viewWidth}px`;
  els.tiles.style.height = `${viewHeight}px`;
  els.tiles.style.left = `${(width - viewWidth) / 2}px`;
  els.tiles.style.top = `${(height - viewHeight) / 2}px`;
  els.tiles.style.transform = `scale(${scale})`;

  const addresses = tilesFor(originX, originY, viewWidth, viewHeight, tileZoom);

  const layers = [
    BASE_LAYERS.find((l) => l.id === activeBase),
    ...OVERLAY_LAYERS.filter((l) => activeOverlays.has(l.id)),
  ].filter(Boolean);

  const wanted = new Map();
  for (const layer of layers) {
    for (const tile of addresses) {
      wanted.set(`${layer.id}/${tileZoom}/${tile.x}/${tile.y}`, { layer, tile });
    }
  }

  // Reuse the <img> elements already showing the right tile; drop the rest.
  for (const node of [...els.tiles.children]) {
    if (wanted.has(node.dataset.key)) {
      const { tile } = wanted.get(node.dataset.key);
      node.style.transform = `translate(${tile.left}px, ${tile.top}px)`;
      wanted.delete(node.dataset.key);
    } else {
      node.remove();
    }
  }

  for (const [key, { layer, tile }] of wanted) {
    const img = document.createElement('img');
    img.dataset.key = key;
    img.src = layer.url(tileZoom, tile.x, tile.y);
    img.alt = '';
    img.loading = 'eager';
    img.decoding = 'async';
    img.style.transform = `translate(${tile.left}px, ${tile.top}px)`;
    if (layer.opacity != null) img.style.opacity = String(layer.opacity);
    // Missing tiles are normal at the edges of a layer's coverage.
    img.addEventListener('error', () => img.remove(), { once: true });
    els.tiles.append(img);
  }
}

function renderOverlay() {
  const { x: originX, y: originY } = origin();
  const toScreen = ([lon, lat]) => {
    const { x, y } = lonLatToWorld(lon, lat, view.zoom);
    return [x - originX, y - originY];
  };

  clear(els.overlay);

  for (const segment of projected) {
    const points = segment.lonLat.map(toScreen);
    const d = pathData(points);
    // The casing carries the same dash as the line, so a dashed leg reads as
    // gaps in the route rather than as a solid white ribbon with colour on top.
    if (!segment.isVariant) {
      els.overlay.append(
        svg('path', { d, class: `route-halo route-halo--${segment.style}` })
      );
    }
    els.overlay.append(
      svg('path', {
        d,
        class:
          `route-line route-line--${segment.style}` +
          (segment.isVariant ? ' route-line--variant' : ''),
      })
    );

    // Overprint the steep stretches so they read on the line itself.
    const sections = terrainBySegment.get(segment.id);
    for (const section of sections ?? []) {
      const slice = points.slice(section.startIndex, section.endIndex + 1);
      if (slice.length > 1) {
        els.overlay.append(svg('path', { d: pathData(slice), class: 'route-steep' }));
      }
    }
  }

  for (const waypoint of route.waypoints ?? []) {
    const { lat, lon } = lv95ToWgs84(waypoint.easting, waypoint.northing);
    const [x, y] = toScreen([lon, lat]);
    const isStart = waypoint.role === 'Start';
    els.overlay.append(
      svg('circle', { cx: x, cy: y, r: isStart ? 6 : 5, class: isStart ? 'waypoint waypoint--start' : 'waypoint' })
    );
    const label = svg('text', { x: x + 10, y: y + 4, class: 'waypoint-label' });
    label.textContent = waypoint.name;
    els.overlay.append(label);
  }
}

function renderScale() {
  // Metres per pixel at the view's latitude, from the Mercator scale factor.
  // 2 ** zoom accepts the fractional zoom directly, so the bar stays truthful
  // mid-gesture rather than snapping between integer levels.
  const bar = scaleBarFor(view.lat, view.zoom);
  els.scale.style.width = `${bar.pixels}px`;
  els.scaleLabel.textContent = bar.label;
}


// ------------------------------------------------------------------- chips

/**
 * Two control types, two forms.
 *
 * Base maps are an exclusive choice and overlays are additive, but both were
 * rendered as the same `aria-pressed` chip — which is semantically wrong for
 * the exclusive one and gave the user no way to tell the two behaviours apart
 * by looking. Base maps are now a segmented radiogroup; overlays keep the chip
 * form but carry an explicit on/off mark so "on" is readable without comparing
 * one chip against another.
 */
function buildLayerChips() {
  els.baseLayers.replaceChildren(
    ...BASE_LAYERS.map((layer) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'switcher__option';
      button.textContent = layer.label;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(activeBase === layer.id));
      button.addEventListener('click', () => {
        activeBase = layer.id;
        buildLayerChips();
        renderTiles();
      });
      return button;
    })
  );

  els.overlayLayers.replaceChildren(
    ...OVERLAY_LAYERS.map((layer) => {
      const on = activeOverlays.has(layer.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.setAttribute('aria-pressed', String(on));
      if (layer.hint) button.title = layer.hint;

      const mark = document.createElement('span');
      mark.className = 'chip__mark';
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark, document.createTextNode(layer.label));

      button.addEventListener('click', () => {
        if (on) activeOverlays.delete(layer.id);
        else activeOverlays.add(layer.id);
        buildLayerChips();
        renderLegend();
        renderTiles();
      });
      return button;
    })
  );

  renderLegend();
}

/**
 * Route summary, overlaid on the map.
 *
 * This used to be a full-width strip along the bottom of the window, which was
 * removed because it framed the map rather than letting it fill the view. The
 * information was worth keeping though, so it returns as a card floating over
 * the map itself — same data, no chrome bar.
 */
function renderInfo() {
  const main = route.segments.filter((segment) => !segment.isVariant);
  const distance = main.reduce((total, segment) => total + lineLength(segment.coordinates), 0);

  const rows = [
    { label: 'Discipline', value: disciplineLabel(route.discipline) },
    { label: 'Grade', value: route.difficulty || '—' },
    { label: 'Distance', value: `${(distance / 1000).toFixed(1)} km` },
  ];

  // Only once the terrain pass has run; on a summer route it never does.
  if (route.terrain) {
    rows.push({
      label: 'Max slope',
      value: `${Math.round(route.terrain.maxSlope)}°`,
      warn: route.terrain.maxSlope >= 30,
    });
  }

  els.info.replaceChildren(
    ...rows.flatMap((row) => {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      if (row.warn) dd.classList.add('is-warn');
      return [dt, dd];
    })
  );
}

/**
 * The SAC terrain key.
 *
 * Only the styles this route actually draws are listed, and only when there is
 * more than one of them: on a route that is solid end to end the key would
 * explain a distinction the map never makes.
 */
function renderNotation(route) {
  const present = [...new Set(route.segments.map((segment) => segment.style))];
  const keys = present
    .map((style) => ({ style, meaning: styleMeaning(route.discipline, style) }))
    .filter((key) => key.meaning);

  els.notation.hidden = keys.length < 2;
  if (els.notation.hidden) return;

  const colour = routeColour(route.discipline, 'light');
  const dash = { plain: null, dashed: '7.5 3.8', dotted: '0 4.6' };

  els.notationKeys.replaceChildren(
    ...keys.map(({ style, meaning }) => {
      const item = document.createElement('li');
      const sample = svg('svg', { class: 'legend__line', viewBox: '0 0 26 8' });
      sample.append(
        svg('path', {
          d: 'M0 4H26',
          fill: 'none',
          stroke: colour,
          'stroke-width': 2.6,
          'stroke-linecap': style === 'dotted' ? 'round' : 'butt',
          ...(dash[style] ? { 'stroke-dasharray': dash[style] } : {}),
        })
      );
      const label = document.createElement('span');
      label.textContent = meaning;
      item.append(sample, label);
      return item;
    })
  );
}

/** The slope wash means nothing without its bands named. */
function renderLegend() {
  const showing = activeOverlays.has('slope');
  els.legend.hidden = !showing;
  if (!showing) return;

  els.legendBands.replaceChildren(
    ...SLOPE_LEGEND.map((band) => {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'legend__swatch';
      swatch.style.background = band.colour;
      const label = document.createElement('span');
      label.textContent = band.label;
      item.append(swatch, label);
      return item;
    })
  );
}

// ------------------------------------------------------------- interaction

function wireInteraction() {
  let pointerId = null;
  let last = null;

  els.stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.mapctl')) return;   // controls are not the canvas
    pointerId = event.pointerId;
    last = { x: event.clientX, y: event.clientY };
    els.stage.setPointerCapture(pointerId);
    els.stage.classList.add('is-panning');
  });

  els.stage.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    panBy(event.clientX - last.x, event.clientY - last.y);
    last = { x: event.clientX, y: event.clientY };
    scheduleRender();
  });

  const endPan = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    els.stage.classList.remove('is-panning');
  };
  els.stage.addEventListener('pointerup', endPan);
  els.stage.addEventListener('pointercancel', endPan);

  els.stage.addEventListener('wheel', (event) => {
    event.preventDefault();

    const step = wheelToZoomDelta(event.deltaY, event.deltaMode, els.stage.clientHeight);
    if (!step) return;

    const rect = els.stage.getBoundingClientRect();
    zoomBy(step, event.clientX - rect.left, event.clientY - rect.top);
    scheduleRender();
  }, { passive: false });

  // Double click zooms in on the point, the convention everywhere else.
  els.stage.addEventListener('dblclick', (event) => {
    if (event.target.closest('.mapctl')) return;
    const rect = els.stage.getBoundingClientRect();
    zoomBy(1, event.clientX - rect.left, event.clientY - rect.top);
    render();
  });

  els.stage.addEventListener('keydown', (event) => {
    const centreX = els.stage.clientWidth / 2;
    const centreY = els.stage.clientHeight / 2;
    const nudge = 80;
    const actions = {
      '+': () => zoomBy(0.5, centreX, centreY),
      '=': () => zoomBy(0.5, centreX, centreY),
      '-': () => zoomBy(-0.5, centreX, centreY),
      '_': () => zoomBy(-0.5, centreX, centreY),
      '0': () => fitToRoute(),
      ArrowLeft: () => panBy(nudge, 0),
      ArrowRight: () => panBy(-nudge, 0),
      ArrowUp: () => panBy(0, nudge),
      ArrowDown: () => panBy(0, -nudge),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
    render();
  });

  window.addEventListener('resize', scheduleRender);
}

/** Move the view by a screen-pixel delta, keeping the centre geographic. */
function panBy(dx, dy) {
  Object.assign(view, panByPixels(view, dx, dy));
}

/**
 * Zoom by `delta` levels, holding the point under (anchorX, anchorY) still.
 * Anchoring is what makes wheel zoom feel like it is following the cursor
 * rather than dragging the map out from under it.
 */
function zoomBy(delta, anchorX, anchorY) {
  Object.assign(
    view,
    zoomAround(view, delta, anchorX, anchorY, els.stage.clientWidth, els.stage.clientHeight)
  );
}

/**
 * Coalesce renders to one per frame.
 * Wheel and pointermove both fire far faster than the display refreshes, and
 * re-laying out seventy tiles per event is what made panning feel heavy.
 */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/** Zoom / fit controls. Kept as real buttons so they are keyboard reachable. */
function buildControls() {
  const make = (label, title, onClick, extraClass = '') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mapctl__button ${extraClass}`.trim();
    button.innerHTML = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => { onClick(); render(); });
    return button;
  };

  const centreX = () => els.stage.clientWidth / 2;
  const centreY = () => els.stage.clientHeight / 2;

  els.controls.replaceChildren(
    make('&plus;', 'Zoom in', () => zoomBy(1, centreX(), centreY())),
    make('&minus;', 'Zoom out', () => zoomBy(-1, centreX(), centreY())),
    make(fitIcon(), 'Fit route to view', () => fitToRoute(), 'mapctl__button--fit')
  );
}

/** Corner-brackets mark, matching the registration ticks used elsewhere. */
function fitIcon() {
  return `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4"
          fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
    <circle cx="8" cy="8" r="1.9" fill="currentColor"/>
  </svg>`;
}

// ----------------------------------------------------------------- helpers

function pathData(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join('');
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function svg(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
