/**
 * Terrain slope and aspect along a route.
 *
 * For a ski or snowshoe tour the question that matters is not how much you
 * climb but what you cross: the SLF threshold for avalanche-relevant terrain is
 * 30°, and aspect decides how the snowpack got there. SAC publishes an
 * `expositions` field for winter disciplines but nothing per-segment, and the
 * geometry carries no terrain information at all.
 *
 * swisstopo's terrain model can supply both. Sampling the elevation a short
 * distance either side of each track point in the two grid axes gives the local
 * gradient, and from that slope and aspect fall out directly.
 *
 * IMPORTANT — what this is not. Slope at the track point is not the slope you
 * are standing on: a summer path cut into a hillside reads as steep, and what
 * matters for avalanche assessment is also what hangs *above* you, which this
 * does not model. Treat the output as "this route crosses terrain of this
 * steepness", never as a risk assessment. skitourenguru.ch does the real thing.
 */

const PROFILE_URL = 'https://api3.geo.admin.ch/rest/services/profile.json';
const CHUNK_SIZE = 900;

/** Sampling distance either side of the track point, in metres. */
export const SAMPLE_OFFSET = 25;

/** SLF-aligned bands. swisstopo's own slope layer starts at 30°. */
export const SLOPE_BANDS = [
  { from: 30, to: 35, label: '30–35°' },
  { from: 35, to: 40, label: '35–40°' },
  { from: 40, to: 45, label: '40–45°' },
  { from: 45, to: Infinity, label: '45°+' },
];

const CARDINALS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];

/**
 * Slope (degrees) and aspect (degrees, and cardinal) for every coordinate.
 * Points the terrain service could not resolve come back as null.
 */
export async function slopeAndAspect(coordinates, { signal, offset = SAMPLE_OFFSET } = {}) {
  if (!coordinates?.length) return [];

  // Four route-shaped lines rather than one line zig-zagging between offsets:
  // the service densifies sparse input, and a line that jumps back and forth
  // every 25 m would be densified into an enormous response. Offsetting the
  // whole route keeps each request the same shape and size as the route itself.
  const [west, east, south, north] = await Promise.all([
    sampleLine(coordinates.map(([e, n]) => [e - offset, n]), signal),
    sampleLine(coordinates.map(([e, n]) => [e + offset, n]), signal),
    sampleLine(coordinates.map(([e, n]) => [e, n - offset]), signal),
    sampleLine(coordinates.map(([e, n]) => [e, n + offset]), signal),
  ]);

  return coordinates.map((_, i) => {
    const w = west[i], e = east[i], s = south[i], n = north[i];
    if (w == null || e == null || s == null || n == null) return null;

    const dzdx = (e - w) / (2 * offset);
    const dzdy = (n - s) / (2 * offset);
    const slope = Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);

    // Aspect is the compass direction the slope faces — downhill, so the
    // gradient is negated.
    let aspect = (Math.atan2(-dzdy, -dzdx) * (180 / Math.PI) + 360) % 360;
    return {
      slope,
      aspect,
      cardinal: CARDINALS[Math.floor(((aspect + 22.5) % 360) / 45)],
    };
  });
}

/**
 * Contiguous runs of track above a slope threshold.
 * Short excursions are absorbed so a single noisy sample does not become a
 * reported "steep section".
 */
export function steepSections(coordinates, terrain, { threshold = 30, minPoints = 3 } = {}) {
  const sections = [];
  let start = null;

  const flush = (end) => {
    if (start === null) return;
    if (end - start + 1 >= minPoints) {
      const slice = terrain.slice(start, end + 1).filter(Boolean);
      const maxSlope = Math.max(...slice.map((t) => t.slope));
      sections.push({
        startIndex: start,
        endIndex: end,
        maxSlope,
        meanSlope: slice.reduce((sum, t) => sum + t.slope, 0) / slice.length,
        dominantAspect: dominant(slice.map((t) => t.cardinal)),
        length: lineLengthBetween(coordinates, start, end),
      });
    }
    start = null;
  };

  for (let i = 0; i < terrain.length; i++) {
    const steep = terrain[i] && terrain[i].slope >= threshold;
    if (steep && start === null) start = i;
    if (!steep) flush(i - 1);
  }
  flush(terrain.length - 1);

  return sections;
}

/** Headline numbers for the UI. */
export function summarise(terrain, sections) {
  const known = terrain.filter(Boolean);
  if (!known.length) return null;

  const maxSlope = Math.max(...known.map((t) => t.slope));
  const bands = SLOPE_BANDS.map((band) => ({
    ...band,
    count: known.filter((t) => t.slope >= band.from && t.slope < band.to).length,
  })).filter((band) => band.count > 0);

  const steepAspects = dominantList(
    known.filter((t) => t.slope >= 30).map((t) => t.cardinal)
  );

  return {
    maxSlope,
    coverage: known.length / terrain.length,
    sectionCount: sections.length,
    steepLength: sections.reduce((total, section) => total + section.length, 0),
    bands,
    steepAspects,
  };
}

async function sampleLine(points, signal) {
  const results = [];
  for (let i = 0; i < points.length; i += CHUNK_SIZE) {
    const chunk = points.slice(i, i + CHUNK_SIZE);
    results.push(...(await requestChunk(chunk, signal)));
  }
  return results;
}

async function requestChunk(points, signal) {
  const body = new URLSearchParams({
    geom: JSON.stringify({ type: 'LineString', coordinates: points }),
    sr: '2056',
    distinct_points: 'true',
  });

  const response = await fetch(PROFILE_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });
  if (!response.ok) throw new Error(`profile.json returned HTTP ${response.status}`);

  const sampled = await response.json();
  const byPosition = new Map();
  for (const point of sampled) {
    byPosition.set(
      `${point.easting.toFixed(1)},${point.northing.toFixed(1)}`,
      point.alts?.COMB ?? point.alts?.DTM2 ?? point.alts?.DTM25 ?? null
    );
  }
  return points.map(([e, n]) => byPosition.get(`${e.toFixed(1)},${n.toFixed(1)}`) ?? null);
}

function dominant(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function dominantList(values, limit = 3) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cardinal]) => cardinal);
}

function lineLengthBetween(coordinates, start, end) {
  let total = 0;
  for (let i = start + 1; i <= end && i < coordinates.length; i++) {
    total += Math.hypot(
      coordinates[i][0] - coordinates[i - 1][0],
      coordinates[i][1] - coordinates[i - 1][1]
    );
  }
  return total;
}
