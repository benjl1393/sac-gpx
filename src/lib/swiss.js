/**
 * Swiss coordinate handling.
 *
 * SAC serves route geometry in EPSG:2056 (LV95) — eastings ~2.6M, northings ~1.2M.
 * GPX requires WGS84. swisstopo publishes an approximation of the rigorous
 * transform that is accurate to ~0.1 m within Switzerland, which is far below
 * the precision of the underlying route data and needs no dependencies.
 *
 * Reference: swisstopo, "Approximate formulas for the transformation between
 * Swiss projection coordinates and WGS84".
 */

/** LV95 easting/northing (metres) -> WGS84 { lat, lon } in decimal degrees. */
export function lv95ToWgs84(easting, northing) {
  const y = (easting - 2600000) / 1000000;
  const x = (northing - 1200000) / 1000000;

  const lon =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * x * x -
    0.0436 * y * y * y;

  const lat =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.0140 * x * x * x;

  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}

/** True when a coordinate pair plausibly sits inside the LV95 domain. */
export function isLv95(easting, northing) {
  return (
    easting > 2450000 && easting < 2850000 &&
    northing > 1050000 && northing < 1310000
  );
}

/** Planar distance in metres between two LV95 points. */
export function lv95Distance([e1, n1], [e2, n2]) {
  return Math.hypot(e2 - e1, n2 - n1);
}

/**
 * Cumulative length of an LV95 LineString, in metres.
 * LV95 is a conformal projection over a small country, so planar summation is
 * accurate enough here; we deliberately do not do great-circle maths.
 */
export function lineLength(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += lv95Distance(coordinates[i - 1], coordinates[i]);
  }
  return total;
}

/** Bounding box of LV95 coordinate arrays: { minE, minN, maxE, maxN }. */
export function bounds(coordinateLists) {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const list of coordinateLists) {
    for (const [e, n] of list) {
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
  }
  return { minE, minN, maxE, maxN };
}
