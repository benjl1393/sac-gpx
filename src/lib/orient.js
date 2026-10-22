/**
 * Segment ordering and direction.
 *
 * SAC stores segment geometry in whatever direction it happened to be digitised
 * in — it does not encode the direction of travel. Route 207 ("Curaglia - Alp
 * Sura - Medelserhütte", category `ascent`) is stored hut-first, so a naive
 * export produces a track that descends 1197 m and climbs 3 m: a file that
 * navigates you off the mountain instead of up it.
 *
 * The payload does carry enough to recover the intended direction — a
 * `departure_point` and a `destination_poi` — so we chain segments outward from
 * the departure point, orienting each one as we go. This is nearest-neighbour
 * chaining rather than anything cleverer, which is appropriate: routes are a
 * handful of segments and the endpoints are unambiguous in practice.
 */

import { lv95Distance } from './swiss.js';

/**
 * Order and orient a route's segments for travel.
 * Main segments are chained from the departure point; variants are appended
 * afterwards, each oriented to run in the same broad direction as the main line.
 * Returns a new array; inputs are not mutated.
 */
export function orientSegments(segments, { departure, destination } = {}) {
  const main = segments.filter((segment) => !segment.isVariant);
  const variants = segments.filter((segment) => segment.isVariant);

  const anchor = departure
    ? [departure.easting, departure.northing]
    : startAnchorFrom(main);

  const chained = chain(main, anchor);

  // With no departure point to chain from, fall back to the destination: if the
  // chain ends further from the summit than it starts, we built it backwards.
  if (!departure && destination && chained.length) {
    const target = [destination.easting, destination.northing];
    const first = chained[0].coordinates[0];
    const last = chained[chained.length - 1].coordinates.at(-1);
    if (lv95Distance(last, target) > lv95Distance(first, target)) {
      return [...chained.reverse().map(reverseSegment), ...orientVariants(variants, anchor)];
    }
  }

  return [...chained, ...orientVariants(variants, anchor)];
}

/** Greedy nearest-endpoint chaining from a starting anchor. */
function chain(segments, anchor) {
  const remaining = [...segments];
  const ordered = [];
  let cursor = anchor;

  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    let bestReversed = false;

    remaining.forEach((segment, index) => {
      const first = segment.coordinates[0];
      const last = segment.coordinates.at(-1);
      const toFirst = cursor ? lv95Distance(cursor, first) : 0;
      const toLast = cursor ? lv95Distance(cursor, last) : Infinity;

      if (toFirst < bestDistance) {
        bestDistance = toFirst;
        bestIndex = index;
        bestReversed = false;
      }
      if (toLast < bestDistance) {
        bestDistance = toLast;
        bestIndex = index;
        bestReversed = true;
      }
    });

    const [picked] = remaining.splice(bestIndex, 1);
    const oriented = bestReversed ? reverseSegment(picked) : picked;
    ordered.push(oriented);
    cursor = oriented.coordinates.at(-1);
  }
  return ordered;
}

/** Variants are alternatives, not continuations — orient each toward the route. */
function orientVariants(variants, anchor) {
  if (!anchor) return variants;
  return variants.map((segment) => {
    const first = segment.coordinates[0];
    const last = segment.coordinates.at(-1);
    return lv95Distance(anchor, last) < lv95Distance(anchor, first)
      ? reverseSegment(segment)
      : segment;
  });
}

function startAnchorFrom(segments) {
  return segments.length ? segments[0].coordinates[0] : null;
}

export function reverseSegment(segment) {
  return {
    ...segment,
    coordinates: [...segment.coordinates].reverse(),
    elevations: segment.elevations ? [...segment.elevations].reverse() : undefined,
    reversed: !segment.reversed,
  };
}
