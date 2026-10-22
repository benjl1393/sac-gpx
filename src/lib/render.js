/**
 * Geometry -> SVG path data.
 *
 * Simplification and the elevation profile. Route projection used to live here
 * too, in LV95 against an arbitrary viewBox; both surfaces now draw in Web
 * Mercator so the line can sit on swisstopo tiles, so that part moved out to
 * mercator.js and this module kept the parts that are projection-agnostic.
 */

import { lv95Distance } from './swiss.js';


/**
 * Douglas–Peucker simplification, so a 2000-point line becomes a path a popup
 * can repaint instantly without visibly changing shape.
 */
export function simplify(points, tolerance = 1) {
  if (points.length < 3) return points;

  let maxDistance = 0;
  let index = 0;
  const [start] = points;
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], start, end);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }

  if (maxDistance <= tolerance) return [start, end];

  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

function perpendicularDistance([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function toPathData(points, { simplifyTolerance = 0.6 } = {}) {
  const reduced = simplifyTolerance ? simplify(points, simplifyTolerance) : points;
  return reduced
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`)
    .join('');
}

/**
 * Build an elevation profile across the non-variant segments.
 * Returns null when there is nothing to draw.
 */
export function projectProfile(segments, { width, height, padding = 6 }) {
  const points = [];
  let distance = 0;

  for (const segment of segments) {
    if (segment.isVariant) continue;
    const { coordinates, elevations } = segment;
    if (!elevations?.length) continue;

    for (let i = 0; i < coordinates.length; i++) {
      if (i > 0) distance += lv95Distance(coordinates[i - 1], coordinates[i]);
      const elevation = elevations[i];
      if (elevation != null) points.push([distance, elevation]);
    }
  }

  if (points.length < 2) return null;

  const totalDistance = points[points.length - 1][0] || 1;
  const altitudes = points.map((p) => p[1]);
  const minAltitude = Math.min(...altitudes);
  const maxAltitude = Math.max(...altitudes);
  const span = Math.max(maxAltitude - minAltitude, 1);

  const usableHeight = height - padding * 2;
  const projected = points.map(([d, a]) => [
    (d / totalDistance) * width,
    padding + (1 - (a - minAltitude) / span) * usableHeight,
  ]);

  const line = toPathData(projected, { simplifyTolerance: 0.4 });
  const area = `${line}L${round(width)} ${round(height)}L0 ${round(height)}Z`;

  return {
    line,
    area,
    minAltitude: Math.round(minAltitude),
    maxAltitude: Math.round(maxAltitude),
    distance: totalDistance,
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
