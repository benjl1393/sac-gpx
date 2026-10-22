/**
 * Popup controller.
 *
 * Talks to the content script (which owns the authenticated fetch and the file
 * write) and to the service worker (which owns the cross-origin terrain call).
 * It holds no credentials and makes no request to sac-cas.ch itself.
 */

import { projectProfile, toPathData } from '../lib/render.js';
import { lv95ToWgs84 } from '../lib/swiss.js';
import { lonLatToWorld, zoomToFit, tilesFor } from '../lib/mercator.js';
import { PREVIEW_LAYER } from '../lib/layers.js';
import { statsFor } from '../lib/gpx.js';
import { DEFAULT_PROFILE, applyProfile, profileFor } from '../lib/devices.js';
import { slopeAndAspect, steepSections, summarise } from '../lib/terrain.js';
import { routeColour, disciplineLabel } from '../lib/disciplines.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const views = {
  loading: document.getElementById('state-loading'),
  idle: document.getElementById('state-idle'),
  gated: document.getElementById('state-gated'),
  error: document.getElementById('state-error'),
  route: document.getElementById('state-route'),
};

const els = {
  sheetId: document.getElementById('sheet-id'),
  destination: document.getElementById('route-destination'),
  title: document.getElementById('route-title'),
  map: document.getElementById('map'),
  mapTiles: document.getElementById('map-tiles'),
  mapCaption: document.getElementById('map-caption-text'),
  profile: document.getElementById('profile'),
  profileStatus: document.getElementById('profile-status'),
  facts: document.getElementById('facts'),
  exportButton: document.getElementById('export'),
  viewMap: document.getElementById('view-map'),
  deviceHint: document.getElementById('device-hint'),
  retry: document.getElementById('retry'),
  gatedHint: document.getElementById('gated-hint'),
  errorHint: document.getElementById('error-hint'),
};

const MAP_STORAGE_KEY = 'sac-gpx:map-route';

let activeTabId = null;
let currentRoute = null;
let enrichedSegments = null;
let activeDevice = DEFAULT_PROFILE;
let terrainSummary = null;
let elevationFailed = false;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  if (!tab?.url?.startsWith('https://www.sac-cas.ch/')) {
    return show('idle');
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(activeTabId, { type: 'sac-gpx:inspect' });
  } catch {
    // The content script is not present — usually a page loaded before install.
    els.errorHint.textContent = 'Reload the route page, then reopen this panel.';
    return show('error');
  }

  if (!response?.ok) {
    els.errorHint.textContent = response?.error || 'Unknown error.';
    return show('error');
  }
  if (!response.route) return show('idle');

  currentRoute = response.route;
  els.sheetId.textContent = `ROUTE ${currentRoute.id}`;

  if (!response.hasGeometry) {
    // Name the remedy, not just the problem: "route locked" on its own leaves
    // the user with nothing to do about it.
    els.gatedHint.textContent =
      currentRoute.availability === 'limited'
        ? 'This route is included with SAC membership. Sign in to the Route Portal in this tab, reload the page, then reopen this panel.'
        : 'This route has no mapped line in the portal, so there is nothing to export.';
    return show('gated');
  }


  renderRoute(currentRoute);
  renderDeviceHint();
  show('route');
  loadElevation(currentRoute);
}


/**
 * Show what the chosen profile will actually do to this route, in points.
 * A brand name alone tells the user nothing about what they are about to lose.
 */
/**
 * What this profile will do to THIS route, framed as a change rather than a
 * fact. "1941 points" tells the user nothing; "1941 → 500, simplified to fit"
 * tells them they are trading detail for compatibility, which is the actual
 * decision in front of them.
 */
function renderDeviceHint() {
  els.deviceHint.classList.remove('is-done');
  const profile = profileFor(activeDevice);
  els.deviceHint.title = profile.hint;
  const segments = enrichedSegments ?? currentRoute?.segments ?? [];
  if (!segments.length) {
    els.deviceHint.textContent = profile.hint;
    return;
  }

  const result = applyProfile(segments, currentRoute.waypoints, activeDevice);
  const thinned = result.pointsAfter < result.pointsBefore;
  const snapped = result.waypoints.filter((w) => w.snappedBy !== undefined).length;

  els.deviceHint.replaceChildren();
  const count = document.createElement('b');
  count.textContent = thinned
    ? `${result.pointsBefore} → ${result.pointsAfter} points`
    : `${result.pointsAfter} points`;
  els.deviceHint.append(count);

  const notes = ['optimised for sports watches'];
  if (thinned) notes.push('simplified to fit');
  els.deviceHint.append(` · ${notes.join(' · ')}`);
}

function show(name) {
  for (const [key, element] of Object.entries(views)) {
    element.hidden = key !== name;
  }
}

function renderRoute(route) {
  els.destination.textContent = route.destination || route.title || `Route ${route.id}`;
  els.title.textContent = route.title || '';

  applyRouteColour(route);
  if (els.mapCaption) {
    els.mapCaption.textContent = `${disciplineLabel(route.discipline)} · north up`;
  }
  drawMap(route);
  renderFacts(route, null);
}

/**
 * The line takes its colour from the route's discipline, so a ski tour and an
 * alpine route are distinguishable before you read anything. Set as a custom
 * property rather than per-element, so the preview, the waypoints and the map
 * all follow one value.
 *
 * The two themes need different values — a violet that reads on paper is muddy
 * on a dark ground — and CSS cannot pick between two JS-set values, so the
 * scheme is resolved here and re-resolved if the system flips.
 */
function applyRouteColour(route) {
  // Scoped to the route section rather than the document root: the value
  // belongs to the route being shown, and everything that consumes it (the
  // preview line, the waypoints, the caption swatch) lives inside.
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const paint = () => {
    views.route.style.setProperty(
      '--route',
      routeColour(route.discipline, dark.matches ? 'dark' : 'light')
    );
  };
  paint();
  dark.addEventListener('change', paint);
}

/**
 * Draw the preview over real swisstopo terrain.
 *
 * The route used to be projected in LV95 straight into an arbitrary viewBox,
 * which was fine while the background was blank. Putting map tiles behind it
 * means the line has to sit in the tiles' own projection, so the preview now
 * works in Web Mercator exactly as the full map view does — same helpers, same
 * maths, just a much smaller viewport.
 */
function drawMap(route) {
  const width = els.map.clientWidth || 324;
  const height = els.map.clientHeight || 150;
  els.map.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const box = lonLatBounds(route.segments);
  if (!box) return;

  const zoom = zoomToFit(box, width, height, { padding: 12, min: 8, max: 16 });
  const a = lonLatToWorld(box.minLon, box.maxLat, zoom);
  const b = lonLatToWorld(box.maxLon, box.minLat, zoom);
  // Whole pixels, so every tile lands on the pixel grid. At a fractional offset
  // two neighbouring tiles each anti-alias their shared edge, and the paper shows
  // through as a pale seam across the relief.
  const originX = Math.round((a.x + b.x) / 2 - width / 2);
  const originY = Math.round((a.y + b.y) / 2 - height / 2);

  const toScreen = ([easting, northing]) => {
    const { lat, lon } = lv95ToWgs84(easting, northing);
    const point = lonLatToWorld(lon, lat, zoom);
    return [point.x - originX, point.y - originY];
  };

  drawPreviewTiles(zoom, originX, originY, width, height);
  clear(els.map);

  for (const segment of route.segments) {
    if (!segment.coordinates.length) continue;
    // Variants are drawn dashed, the way an alternative line is printed.
    // Styling lives in CSS: SVG presentation attributes do not resolve var().
    els.map.append(
      svg('path', {
        d: toPathData(segment.coordinates.map(toScreen), { simplifyTolerance: 0.5 }),
        class:
          `route-line route-line--${segment.style}` +
          (segment.isVariant ? ' route-line--variant' : ''),
      })
    );
  }

  for (const waypoint of route.waypoints) {
    const [x, y] = toScreen([waypoint.easting, waypoint.northing]);
    const isStart = waypoint.role === 'Start';
    els.map.append(
      svg('circle', {
        cx: x,
        cy: y,
        r: isStart ? 4 : 3.4,
        class: isStart ? 'waypoint waypoint--start' : 'waypoint',
      })
    );
  }
}

/** Bounding box of a route's segments, in WGS84. */
function lonLatBounds(segments) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let seen = false;
  for (const segment of segments) {
    for (const [easting, northing] of segment.coordinates) {
      const { lat, lon } = lv95ToWgs84(easting, northing);
      seen = true;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return seen ? { minLon, maxLon, minLat, maxLat } : null;
}

/** Shaded relief behind the line. Failures are silent by design. */
function drawPreviewTiles(zoom, originX, originY, width, height) {
  const layer = PREVIEW_LAYER;
  els.mapTiles.replaceChildren();

  for (const tile of tilesFor(originX, originY, width, height, zoom)) {
    const img = document.createElement('img');
    img.src = layer.url(zoom, tile.x, tile.y);
    img.alt = '';
    img.decoding = 'async';
    img.style.transform = `translate(${tile.left}px, ${tile.top}px)`;
    // A missing tile is normal at a coverage edge; leave the ground blank.
    img.addEventListener('error', () => img.remove(), { once: true });
    els.mapTiles.append(img);
  }
}

function renderFacts(route, stats) {
  const pending = '·····';
  const rows = [
    { label: 'Grade', value: route.difficulty || '—' },
    {
      label: 'Distance',
      value: stats ? `${(stats.distance / 1000).toFixed(1)} km` : pending,
      pending: !stats,
    },
    {
      label: 'Ascent',
      value: elevationFailed
        ? 'n/a'
        : stats?.ascent != null ? `↑${stats.ascent} m` : pending,
      pending: !elevationFailed && stats?.ascent == null,
    },
  ];

  // Max slope is a measurement like the others, so it sits with them rather
  // than in a bordered notice below. Winter disciplines only — on a summer
  // path the figure is noise.
  if (terrainSummary) {
    rows.push({
      label: 'Max slope',
      value: `${Math.round(terrainSummary.maxSlope)}°`,
      warn: terrainSummary.maxSlope >= 30,
    });
  }

  els.facts.replaceChildren(
    ...rows.map((row) => {
      const wrapper = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      if (row.pending) dd.classList.add('is-pending');
      if (row.warn) dd.classList.add('is-warn');
      if (row.title) dd.title = row.title;
      wrapper.append(dt, dd);
      return wrapper;
    })
  );
}

async function loadElevation(route) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'sac-gpx:elevations',
      segments: route.segments.map((segment) => ({ coordinates: segment.coordinates })),
    });
    if (!response?.ok) throw new Error(response?.error || 'terrain service unavailable');

    enrichedSegments = route.segments.map((segment, index) => ({
      ...segment,
      elevations: response.elevations[index],
    }));

    const stats = statsFor(enrichedSegments);
    renderFacts(route, stats);
    drawProfile(enrichedSegments, stats);
    renderDeviceHint();
    loadTerrain(route);
  } catch (error) {
    console.warn('[sac-gpx] elevation preview failed', error);
    elevationFailed = true;
    els.profileStatus.textContent =
      'swisstopo unreachable — the GPX will export without elevation';
    renderFacts(route, statsFor(route.segments));
    renderDeviceHint();
  }
}

/**
 * Winter disciplines only.
 *
 * On a summer hiking route the number would be noise — a path cut into a
 * hillside samples steep whether or not that matters to anyone walking it.
 * On skis it is the first thing you want to know.
 */
const WINTER_DISCIPLINES = ['ski_tour', 'snowshoe_tour'];

async function loadTerrain(route) {
  if (!WINTER_DISCIPLINES.includes(route.discipline)) return;

  const main = route.segments.filter((segment) => !segment.isVariant);
  if (!main.length) return;

  try {
    const everyTerrain = [];
    const allSections = [];
    for (const segment of main) {
      const terrain = await slopeAndAspect(segment.coordinates);
      allSections.push(...steepSections(segment.coordinates, terrain));
      everyTerrain.push(...terrain);
    }

    const summary = summarise(everyTerrain, allSections);
    if (!summary) return;

    terrainSummary = summary;
    renderFacts(route, statsFor(enrichedSegments ?? route.segments));

    // The qualifier rides along in the profile caption, which is already there
    // and already about the vertical dimension of the route.
    // Max slope now has its own cell in the facts row, so the caption only has
    // to carry what that cell cannot: how much, and facing where.
    const qualifier = summary.sectionCount
      ? `${summary.sectionCount}× over 30°, ${Math.round(summary.steepLength)} m` +
        (summary.steepAspects.length ? `, facing ${summary.steepAspects.join(' ')}` : '')
      : 'no sustained 30°+';
    els.profileStatus.textContent = `${els.profileStatus.textContent} · ${qualifier}`;
  } catch (error) {
    console.warn('[sac-gpx] terrain sampling failed', error);
  }
}

function drawProfile(segments, stats) {
  const profile = projectProfile(segments, { width: 320, height: 74 });
  clear(els.profile);

  if (!profile) {
    els.profileStatus.textContent = 'No elevation profile';
    return;
  }

  els.profile.append(
    svg('path', { d: profile.area, class: 'profile-area' }),
    svg('path', { d: profile.line, class: 'profile-line' })
  );

  // Distance and ascent already have a column in the stat row below; the
  // caption carries what that row has no space for.
  // Descent is worth stating only when there is some; on a pure ascent route
  // "descent 0 m" is a line of caption spent saying nothing.
  const parts = [`Elevation ${profile.minAltitude}–${profile.maxAltitude} m`];
  if (stats.descent >= 10) parts.push(`descent ↓${stats.descent} m`);
  els.profileStatus.textContent = parts.join(' · ');
}

els.exportButton.addEventListener('click', async () => {
  const label = els.exportButton.querySelector('.export__label');
  els.exportButton.disabled = true;
  label.textContent = 'Writing…';

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      type: 'sac-gpx:export',
      device: activeDevice,
    });
    if (!response?.ok) throw new Error(response?.error || 'Export failed');

    // Confirm in the hint slot, which is already reserved space — the user
    // clicked the one big button and previously got silence back.
    label.textContent = 'Saved';
    els.deviceHint.classList.add('is-done');
    els.deviceHint.replaceChildren('Saved to Downloads · ');
    const file = document.createElement('b');
    file.textContent = response.filename;
    els.deviceHint.append(file);
  } catch (error) {
    label.textContent = 'Failed';
    els.deviceHint.classList.remove('is-done');
    els.deviceHint.textContent = String(error.message || error);
  } finally {
    setTimeout(() => {
      label.textContent = 'Export GPX';
      els.exportButton.disabled = false;
    }, 2500);
  }
});

els.retry?.addEventListener('click', () => location.reload());

// Repeat use is the norm when planning a hut trip, so give it an accelerator.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !els.exportButton.disabled) {
    event.preventDefault();
    els.exportButton.click();
  }
});

els.viewMap.addEventListener('click', async () => {
  if (!currentRoute) return;
  els.viewMap.disabled = true;
  // Hand the route over through storage rather than the URL: a route is tens
  // of thousands of coordinates and would not survive a query string.
  await chrome.storage.local.set({
    [MAP_STORAGE_KEY]: { ...currentRoute, segments: enrichedSegments ?? currentRoute.segments },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/map/map.html') });
  window.close();
});

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
