/**
 * Device export profiles.
 *
 * A caveat worth stating plainly, because it shapes this whole module: neither
 * Garmin nor Suunto publishes a hard trackpoint limit for GPX. Anyone claiming
 * an exact figure is quoting folklore. What is documented or well-evidenced:
 *
 * - Garmin's much-cited "200 course points" limit applies to FIT and TCX, NOT
 *   GPX — a GPX track has no course points at all. The real constraint is
 *   performance: fenix users report ClimbPro stalling and navigation lag with
 *   ~14'000 trackpoints, and recommend staying a few thousand below that.
 *   Garmin Connect also silently downsamples on import, so an over-dense file
 *   buys nothing anyway.
 * - Suunto documents no limit either, but its app requires every waypoint to
 *   sit on a route point: a waypoint whose coordinates do not match a track
 *   coordinate is dropped on import. That one is a correctness bug, not a
 *   preference, and is why `snapWaypoints` exists.
 *
 * So the point budgets below are deliberately conservative working defaults
 * rather than claimed specifications, and the UI shows the resulting count so
 * the number is never hidden behind a brand name.
 */

import { simplifyToCount } from './simplify.js';
import { lv95Distance } from './swiss.js';

/**
 * One profile, tuned so a single file works on either brand.
 *
 * There used to be three (full / Garmin / Suunto), which made the user choose
 * between vendors before they could export. Since the constraints are not in
 * conflict — they are simply a cap and a snap — the safe move is to take the
 * stricter of each and ship one file that satisfies both:
 *
 *   - the lower point budget (Suunto's 2000 rather than Garmin's 2500)
 *   - waypoint snapping, which Suunto requires and Garmin is indifferent to
 *
 * The cost is that a desktop planner no longer gets every published point. At
 * 2000 points across a typical route the line is visually identical, and the
 * elevation profile is unaffected, so the trade is worth one fewer decision.
 */
export const DEVICE_PROFILES = {
  watch: {
    id: 'watch',
    label: 'Sports watch',
    hint: 'Optimised for Garmin and Suunto.',
    maxPoints: 2000,
    snapWaypoints: true,
    maxNameLength: 30,
  },
};

export const DEFAULT_PROFILE = 'watch';

export function profileFor(id) {
  return DEVICE_PROFILES[id] ?? DEVICE_PROFILES[DEFAULT_PROFILE];
}

/**
 * Apply a device profile to a route's segments and waypoints.
 *
 * Simplification runs per segment against the point budget shared across the
 * whole route, weighted by segment length — otherwise a long approach and a
 * short variant would each get the full budget.
 */
export function applyProfile(segments, waypoints, profileId) {
  const profile = profileFor(profileId);

  if (profile.maxPoints === Infinity) {
    return {
      profile,
      segments,
      waypoints: waypoints.map((w) => truncateName(w, profile)),
      pointsBefore: countPoints(segments),
      pointsAfter: countPoints(segments),
    };
  }

  const totalPoints = countPoints(segments);
  const reduced = segments.map((segment) => {
    // Share the budget in proportion to how much of the route this segment is.
    const share = Math.max(
      2,
      Math.round(profile.maxPoints * (segment.coordinates.length / totalPoints))
    );
    const indices = simplifyToCount(segment.coordinates, share);
    return {
      ...segment,
      coordinates: indices.map((i) => segment.coordinates[i]),
      elevations: segment.elevations
        ? indices.map((i) => segment.elevations[i])
        : undefined,
      slopes: segment.slopes ? indices.map((i) => segment.slopes[i]) : undefined,
    };
  });

  const placed = profile.snapWaypoints
    ? waypoints.map((waypoint) => snapToTrack(waypoint, reduced))
    : waypoints;

  return {
    profile,
    segments: reduced,
    waypoints: placed.map((w) => truncateName(w, profile)),
    pointsBefore: totalPoints,
    pointsAfter: countPoints(reduced),
  };
}

/**
 * Move a waypoint onto the nearest surviving trackpoint.
 *
 * Suunto drops waypoints that do not coincide with a route point. Snapping
 * moves them by a few metres at most — always less than the simplification
 * already moved the line — in exchange for the waypoint surviving at all.
 */
export function snapToTrack(waypoint, segments) {
  let best = null;
  let bestDistance = Infinity;

  for (const segment of segments) {
    for (let i = 0; i < segment.coordinates.length; i++) {
      const distance = lv95Distance(
        [waypoint.easting, waypoint.northing],
        segment.coordinates[i]
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { coordinate: segment.coordinates[i], elevation: segment.elevations?.[i] };
      }
    }
  }

  if (!best) return waypoint;
  return {
    ...waypoint,
    easting: best.coordinate[0],
    northing: best.coordinate[1],
    altitude: waypoint.altitude ?? best.elevation ?? null,
    snappedBy: Math.round(bestDistance),
  };
}

function truncateName(waypoint, profile) {
  if (!Number.isFinite(profile.maxNameLength)) return waypoint;
  if ((waypoint.name?.length ?? 0) <= profile.maxNameLength) return waypoint;
  return { ...waypoint, name: waypoint.name.slice(0, profile.maxNameLength - 1) + '…' };
}

function countPoints(segments) {
  return segments.reduce((total, segment) => total + segment.coordinates.length, 0);
}
