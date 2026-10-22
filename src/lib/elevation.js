/**
 * Elevation enrichment via swisstopo.
 *
 * SAC route geometry is strictly 2D — there is no `ele` anywhere in the
 * payload, which is why GPX files produced by the existing scrapers have flat
 * elevation profiles and are close to useless for ski touring. swisstopo's
 * public profile service samples the national terrain model along a LineString,
 * so we can restore a real profile without asking the user for anything.
 *
 * Endpoint: POST https://api3.geo.admin.ch/rest/services/profile.json
 *   geom            GeoJSON LineString (LV95)
 *   sr              2056
 *   distinct_points true  -> guarantees every input vertex is represented
 *
 * The service is best-effort: if it is unreachable we still emit a valid GPX,
 * just without <ele>. Losing elevation must never lose the route.
 */

const PROFILE_URL = 'https://api3.geo.admin.ch/rest/services/profile.json';

/**
 * Requests are form-encoded in a POST body, so the practical limit is the
 * service's own body cap rather than a URL length. 900 points (~36 KB) is
 * comfortably inside what we have verified working, and keeps each round trip
 * short enough that a long ski traverse still feels responsive.
 */
const CHUNK_SIZE = 900;

/** Terrain model preference: COMB is swisstopo's merged best-available model. */
const ALTITUDE_MODELS = ['COMB', 'DTM2', 'DTM25'];

/**
 * Fetch elevations for one LV95 LineString.
 * Resolves to an array parallel to `coordinates`, holding metres or null.
 */
export async function elevationsFor(coordinates, { signal } = {}) {
  if (!coordinates?.length) return [];

  const chunks = chunk(coordinates, CHUNK_SIZE);
  const results = [];

  for (const piece of chunks) {
    const sampled = await requestProfile(piece, signal);
    // Chunks overlap by one point so the join is continuous; drop the
    // duplicate before appending.
    results.push(...(results.length ? sampled.slice(1) : sampled));
  }
  return results;
}

/**
 * Enrich every segment of a normalised route in place-ish, returning a new
 * array. Failures degrade to nulls rather than throwing.
 */
export async function enrichSegments(segments, { signal, onProgress } = {}) {
  const enriched = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    let elevations;
    try {
      elevations = await elevationsFor(segment.coordinates, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.warn('[sac-gpx] elevation lookup failed for segment', segment.id, error);
      elevations = segment.coordinates.map(() => null);
    }
    enriched.push({ ...segment, elevations });
    onProgress?.({ done: i + 1, total: segments.length });
  }
  return enriched;
}

/** Elevation for a handful of discrete points (waypoints), best-effort. */
export async function elevationForPoint(easting, northing, { signal } = {}) {
  const url = `https://api3.geo.admin.ch/rest/services/height?easting=${easting}&northing=${northing}&sr=2056`;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const data = await response.json();
    const height = Number.parseFloat(data.height);
    return Number.isFinite(height) ? height : null;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

async function requestProfile(coordinates, signal) {
  const body = new URLSearchParams({
    geom: JSON.stringify({ type: 'LineString', coordinates }),
    sr: '2056',
    distinct_points: 'true',
  });

  const response = await fetch(PROFILE_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`profile.json returned HTTP ${response.status}`);
  }

  const sampled = await response.json();
  return matchToInput(coordinates, sampled);
}

/**
 * The service may return more points than it was given — it densifies sparse
 * input. We only want an elevation per input vertex, so index what came back
 * by position and look each vertex up, falling back to the nearest sample.
 */
function matchToInput(coordinates, sampled) {
  const byPosition = new Map();
  for (const point of sampled) {
    byPosition.set(key(point.easting, point.northing), altitudeOf(point));
  }

  return coordinates.map(([e, n]) => {
    const exact = byPosition.get(key(e, n));
    if (exact !== undefined) return exact;

    let nearest = null;
    let nearestDistance = Infinity;
    for (const point of sampled) {
      const distance = Math.hypot(point.easting - e, point.northing - n);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = point;
      }
    }
    // Beyond ~20 m the sample is not describing this vertex; prefer honest
    // absence over a plausible-looking wrong number.
    return nearest && nearestDistance <= 20 ? altitudeOf(nearest) : null;
  });
}

function altitudeOf(point) {
  for (const model of ALTITUDE_MODELS) {
    const value = point?.alts?.[model];
    if (typeof value === 'number') return value;
  }
  return null;
}

function key(easting, northing) {
  return `${easting.toFixed(1)},${northing.toFixed(1)}`;
}

function chunk(coordinates, size) {
  if (coordinates.length <= size) return [coordinates];
  const chunks = [];
  // Overlap by one so chunk boundaries stay continuous.
  for (let i = 0; i < coordinates.length; i += size - 1) {
    const piece = coordinates.slice(i, i + size);
    if (piece.length) chunks.push(piece);
    if (i + size >= coordinates.length) break;
  }
  return chunks;
}
