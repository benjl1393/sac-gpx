/**
 * Douglas–Peucker simplification, returning kept INDICES rather than points.
 *
 * Indices matter here: a track carries parallel arrays (coordinates and
 * elevations, and later slope and aspect), and every one of them has to be
 * reduced identically. Returning points would silently desynchronise them.
 */

/** Indices of the points to keep, always including the first and last. */
export function simplifyIndices(points, tolerance) {
  if (points.length <= 2) return points.map((_, i) => i);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative rather than recursive: a 20'000-point ski traverse would
  // otherwise be able to blow the stack.
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDistance = -1;
    let index = -1;

    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistance(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }

    if (maxDistance > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  const indices = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) indices.push(i);
  return indices;
}

/**
 * Simplify down to at most `maxCount` points.
 *
 * The caller knows how many points a device will tolerate, not what tolerance
 * produces them, so search for the tolerance instead of asking for one. Binary
 * search over tolerance is monotonic (a looser tolerance never keeps more
 * points), so ~20 iterations lands within a point or two of the target.
 */
export function simplifyToCount(points, maxCount) {
  if (points.length <= maxCount) return points.map((_, i) => i);

  let low = 0;
  let high = boundingDiagonal(points);
  let best = simplifyIndices(points, high);

  for (let i = 0; i < 24 && high - low > 1e-4; i++) {
    const mid = (low + high) / 2;
    const indices = simplifyIndices(points, mid);
    if (indices.length > maxCount) {
      low = mid; // still too detailed, loosen
    } else {
      best = indices;
      high = mid; // fits, try to keep more detail
    }
  }
  return best;
}

function boundingDiagonal(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY) || 1;
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
