/**
 * Pure view maths for the map: zoom clamping, wheel normalisation, and the
 * anchored zoom that keeps a point fixed under the cursor.
 *
 * Kept out of map.js so it can be tested without a DOM — the zoom-rate
 * behaviour in particular is a thing you want a regression test on, because
 * getting it wrong is not a crash, it is a map that flies through six zoom
 * levels on one trackpad flick and nobody notices until they use it.
 */

import { lonLatToWorld, worldToLonLat } from './mercator.js';

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 17;

/** Roughly one zoom level per 400 px of scroll. */
export const ZOOM_PER_WHEEL_PIXEL = 1 / 400;

/** Ceiling per event, so a single coarse mouse detent cannot jump a level. */
export const MAX_ZOOM_STEP_PER_EVENT = 0.28;

export function clampZoom(zoom) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Wheel event -> zoom delta.
 *
 * Normalises the three deltaModes to pixels first: a mouse reporting lines and
 * a trackpad reporting pixels otherwise differ by more than an order of
 * magnitude. Positive deltaY means scrolling down, which zooms out.
 */
export function wheelToZoomDelta(deltaY, deltaMode = 0, viewportHeight = 800) {
  const pixels =
    deltaMode === 1 ? deltaY * 16 :
    deltaMode === 2 ? deltaY * viewportHeight :
    deltaY;

  const raw = -pixels * ZOOM_PER_WHEEL_PIXEL;
  return Math.max(-MAX_ZOOM_STEP_PER_EVENT, Math.min(MAX_ZOOM_STEP_PER_EVENT, raw));
}

/**
 * Apply a zoom delta while holding the geographic point currently under
 * (anchorX, anchorY) at that same screen position.
 *
 * @param {{lon:number, lat:number, zoom:number}} view
 * @returns {{lon:number, lat:number, zoom:number}} a new view
 */
export function zoomAround(view, delta, anchorX, anchorY, width, height) {
  const zoom = clampZoom(view.zoom + delta);
  if (zoom === view.zoom) return { ...view };

  const before = lonLatToWorld(view.lon, view.lat, view.zoom);
  const anchor = worldToLonLat(
    before.x - width / 2 + anchorX,
    before.y - height / 2 + anchorY,
    view.zoom
  );

  const anchorWorld = lonLatToWorld(anchor.lon, anchor.lat, zoom);
  const centre = worldToLonLat(
    anchorWorld.x - anchorX + width / 2,
    anchorWorld.y - anchorY + height / 2,
    zoom
  );
  return { lon: centre.lon, lat: centre.lat, zoom };
}

/** Move the view by a screen-pixel delta. */
export function panByPixels(view, dx, dy) {
  const centre = lonLatToWorld(view.lon, view.lat, view.zoom);
  const moved = worldToLonLat(centre.x - dx, centre.y - dy, view.zoom);
  return { ...view, lon: moved.lon, lat: moved.lat };
}

/** Integer tile level plus the residual scale factor for fractional zoom. */
export function tileLevelFor(zoom) {
  const level = clampZoom(Math.round(zoom));
  return { zoom: level, scale: 2 ** (zoom - level) };
}

/** Metres per screen pixel at a latitude and zoom. */
export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Largest round distance whose bar stays under `maxWidth` pixels. */
export function scaleBarFor(lat, zoom, maxWidth = 150) {
  const perPixel = metresPerPixel(lat, zoom);
  const targets = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const metres = [...targets].reverse().find((t) => t / perPixel <= maxWidth) ?? targets[0];
  return {
    metres,
    pixels: Math.round(metres / perPixel),
    label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m`,
  };
}
