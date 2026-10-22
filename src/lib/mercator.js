/**
 * Web Mercator tile maths.
 *
 * swisstopo serves WMTS in EPSG:3857 alongside its native LV95 grid, and 3857
 * is by far the simpler target: tile addressing is a pure function of zoom, so
 * a viewer needs no tile-matrix metadata and no dependency.
 *
 * The chain is LV95 -> WGS84 (swiss.js) -> Mercator world pixels (here).
 */

export const TILE_SIZE = 256;

/** WGS84 -> world pixel coordinates at a given zoom. */
export function lonLatToWorld(lon, lat, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/** World pixel coordinates -> WGS84. */
export function worldToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

/**
 * Zoom at which a bounding box fits inside a viewport, with padding.
 * Clamped to the range swisstopo actually serves for its national map.
 */
export function zoomToFit(bounds, width, height, { padding = 48, min = 8, max = 17 } = {}) {
  for (let zoom = max; zoom >= min; zoom--) {
    const a = lonLatToWorld(bounds.minLon, bounds.maxLat, zoom);
    const b = lonLatToWorld(bounds.maxLon, bounds.minLat, zoom);
    if (b.x - a.x <= width - padding * 2 && b.y - a.y <= height - padding * 2) {
      return zoom;
    }
  }
  return min;
}

/** Tile addresses covering a world-pixel viewport, plus their pixel offsets. */
export function tilesFor(originX, originY, width, height, zoom) {
  const count = 2 ** zoom;
  const minTileX = Math.floor(originX / TILE_SIZE);
  const minTileY = Math.floor(originY / TILE_SIZE);
  const maxTileX = Math.floor((originX + width) / TILE_SIZE);
  const maxTileY = Math.floor((originY + height) / TILE_SIZE);

  const tiles = [];
  for (let x = minTileX; x <= maxTileX; x++) {
    for (let y = minTileY; y <= maxTileY; y++) {
      // Wrapping x keeps the world continuous; y outside the range has no tile.
      if (y < 0 || y >= count) continue;
      tiles.push({
        x: ((x % count) + count) % count,
        y,
        left: x * TILE_SIZE - originX,
        top: y * TILE_SIZE - originY,
      });
    }
  }
  return tiles;
}
