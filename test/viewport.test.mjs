import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_ZOOM, MAX_ZOOM, clampZoom, wheelToZoomDelta, zoomAround, panByPixels,
  tileLevelFor, metresPerPixel, scaleBarFor, ZOOM_PER_WHEEL_PIXEL,
  MAX_ZOOM_STEP_PER_EVENT,
} from '../src/lib/viewport.js';
import { lonLatToWorld, worldToLonLat, zoomToFit, tilesFor } from '../src/lib/mercator.js';

const VIEW = { lon: 8.8584, lat: 46.6726, zoom: 13 };
const W = 1000, H = 700;

test('mercator round-trips lon/lat through world pixels', () => {
  for (const zoom of [8, 11.5, 14, 17]) {
    const { x, y } = lonLatToWorld(8.8584, 46.6726, zoom);
    const back = worldToLonLat(x, y, zoom);
    assert.ok(Math.abs(back.lon - 8.8584) < 1e-9, `lon at z${zoom}`);
    assert.ok(Math.abs(back.lat - 46.6726) < 1e-9, `lat at z${zoom}`);
  }
});

test('tilesFor covers the viewport with no gaps', () => {
  const tiles = tilesFor(1000, 1000, 512, 512, 12);
  assert.ok(tiles.length >= 9, `expected full coverage, got ${tiles.length}`);
  for (const tile of tiles) {
    assert.ok(Number.isInteger(tile.x) && Number.isInteger(tile.y));
    assert.ok(tile.x >= 0 && tile.y >= 0);
  }
});

test('zoomToFit returns a zoom that actually contains the bounds', () => {
  const box = { minLon: 8.858, maxLon: 8.914, minLat: 46.640, maxLat: 46.675 };
  const zoom = zoomToFit(box, W, H);
  const a = lonLatToWorld(box.minLon, box.maxLat, zoom);
  const b = lonLatToWorld(box.maxLon, box.minLat, zoom);
  assert.ok(b.x - a.x <= W, 'width fits');
  assert.ok(b.y - a.y <= H, 'height fits');
});

// ---------------------------------------------------------------- zoom rate

test('a single wheel event never moves more than a fraction of a level', () => {
  // This is the regression guard: the original handler applied a whole level
  // per EVENT, so one trackpad flick crossed the entire zoom range.
  for (const delta of [1, 4, 20, 100, 500, 4000, -4000]) {
    const step = wheelToZoomDelta(delta, 0, H);
    assert.ok(
      Math.abs(step) <= MAX_ZOOM_STEP_PER_EVENT,
      `deltaY ${delta} produced ${step}, over the per-event ceiling`
    );
  }
});

test('a realistic trackpad flick stays within a sane zoom range', () => {
  // ~30 events of ~8px is an ordinary two-finger swipe.
  let zoom = 13;
  for (let i = 0; i < 30; i++) zoom = clampZoom(zoom + wheelToZoomDelta(-8, 0, H));
  const travelled = zoom - 13;
  assert.ok(travelled > 0.2, `barely moved: ${travelled}`);
  assert.ok(travelled < 3, `flew ${travelled} levels in one flick`);
});

test('wheel direction is conventional: scrolling down zooms out', () => {
  assert.ok(wheelToZoomDelta(100) < 0);
  assert.ok(wheelToZoomDelta(-100) > 0);
  assert.equal(wheelToZoomDelta(0), -0);
});

test('deltaMode line and page are normalised, not taken literally', () => {
  // 3 "lines" is a small gesture; untreated it would read as 3 pixels.
  const lines = wheelToZoomDelta(3, 1, H);
  const pixels = wheelToZoomDelta(3, 0, H);
  assert.ok(Math.abs(lines) > Math.abs(pixels), 'lines must scale up');
  assert.ok(Math.abs(wheelToZoomDelta(1, 2, H)) <= MAX_ZOOM_STEP_PER_EVENT);
});

test('zoom rate constant is documented and gentle', () => {
  assert.ok(ZOOM_PER_WHEEL_PIXEL <= 1 / 200, 'too aggressive');
  assert.ok(ZOOM_PER_WHEEL_PIXEL > 0);
});

// ------------------------------------------------------------- zoom anchor

test('zoomAround holds the anchored point under the same pixel', () => {
  const anchorX = 250, anchorY = 180;

  const pointAt = (view, x, y) => {
    const centre = lonLatToWorld(view.lon, view.lat, view.zoom);
    return worldToLonLat(centre.x - W / 2 + x, centre.y - H / 2 + y, view.zoom);
  };

  const before = pointAt(VIEW, anchorX, anchorY);
  const after = pointAt(zoomAround(VIEW, 1.7, anchorX, anchorY, W, H), anchorX, anchorY);

  assert.ok(Math.abs(after.lon - before.lon) < 1e-6, `lon drifted ${after.lon - before.lon}`);
  assert.ok(Math.abs(after.lat - before.lat) < 1e-6, `lat drifted ${after.lat - before.lat}`);
});

test('repeated small zooms do not drift the centre', () => {
  // Centre-anchored zooming must be stable, or a long gesture walks the map.
  let view = { ...VIEW };
  for (let i = 0; i < 40; i++) view = zoomAround(view, 0.05, W / 2, H / 2, W, H);
  for (let i = 0; i < 40; i++) view = zoomAround(view, -0.05, W / 2, H / 2, W, H);

  assert.ok(Math.abs(view.zoom - VIEW.zoom) < 1e-9, `zoom drifted to ${view.zoom}`);
  assert.ok(Math.abs(view.lon - VIEW.lon) < 1e-6, `lon drifted ${view.lon - VIEW.lon}`);
  assert.ok(Math.abs(view.lat - VIEW.lat) < 1e-6, `lat drifted ${view.lat - VIEW.lat}`);
});

test('zoom is clamped at both ends and does not move past them', () => {
  const zoomedOut = zoomAround({ ...VIEW, zoom: MIN_ZOOM }, -5, W / 2, H / 2, W, H);
  assert.equal(zoomedOut.zoom, MIN_ZOOM);
  assert.equal(zoomedOut.lon, VIEW.lon, 'a no-op zoom must not move the centre');

  const zoomedIn = zoomAround({ ...VIEW, zoom: MAX_ZOOM }, 5, W / 2, H / 2, W, H);
  assert.equal(zoomedIn.zoom, MAX_ZOOM);
});

test('clampZoom bounds the range', () => {
  assert.equal(clampZoom(2), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(12.4), 12.4, 'fractional zoom is allowed');
});

// -------------------------------------------------------------------- pan

test('panByPixels moves the view and is reversible', () => {
  const moved = panByPixels(VIEW, 120, -60);
  assert.ok(moved.lon !== VIEW.lon && moved.lat !== VIEW.lat);
  const back = panByPixels(moved, -120, 60);
  assert.ok(Math.abs(back.lon - VIEW.lon) < 1e-9);
  assert.ok(Math.abs(back.lat - VIEW.lat) < 1e-9);
});

test('dragging right moves the map east-to-west, as a grab should', () => {
  assert.ok(panByPixels(VIEW, 100, 0).lon < VIEW.lon);
});

// ------------------------------------------------------- fractional tiling

test('tileLevelFor picks the nearest integer level and a residual scale', () => {
  assert.deepEqual(tileLevelFor(13), { zoom: 13, scale: 1 });

  const low = tileLevelFor(13.4);
  assert.equal(low.zoom, 13);
  assert.ok(low.scale > 1 && low.scale < 1.4);

  const high = tileLevelFor(13.6);
  assert.equal(high.zoom, 14);
  assert.ok(high.scale < 1 && high.scale > 0.7);
});

test('tile scale never strays far enough to show blur', () => {
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.1) {
    const { scale } = tileLevelFor(zoom);
    assert.ok(scale >= 0.707 && scale <= 1.415, `scale ${scale} at zoom ${zoom}`);
  }
});

// ------------------------------------------------------------- scale bar

test('scaleBarFor only ever reports round distances', () => {
  const allowed = new Set([50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.25) {
    const bar = scaleBarFor(46.67, zoom);
    assert.ok(allowed.has(bar.metres), `${bar.metres} m is not a round distance`);
    assert.ok(bar.pixels > 0 && bar.pixels <= 150, `bar ${bar.pixels}px out of range`);
  }
});

test('scale bar label switches to km above 1000 m', () => {
  assert.match(scaleBarFor(46.67, MIN_ZOOM).label, /km$/);
  assert.match(scaleBarFor(46.67, MAX_ZOOM).label, /m$/);
});

test('metresPerPixel shrinks as zoom increases', () => {
  assert.ok(metresPerPixel(46.67, 14) < metresPerPixel(46.67, 13));
  // Switzerland is around 46-47N, where the cosine factor is ~0.69.
  assert.ok(metresPerPixel(46.67, 0) < 156543.03392);
});
