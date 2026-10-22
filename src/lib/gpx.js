/**
 * GPX 1.1 serialisation.
 *
 * The point of this extension is that the exported file keeps the information
 * that makes an SAC route worth having — the difficulty grade, the timings, the
 * per-segment prose — rather than reducing it to a bare line. Garmin, Komoot,
 * Gaia and SwissTopo all surface <desc>, so that text travels with you.
 */

import { lv95ToWgs84, lineLength } from './swiss.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const CREATOR = 'sac-gpx';

/**
 * Build a GPX document from a normalised route.
 * @param {object} route      output of sac.normalise()
 * @param {Array}  segments   segments, optionally carrying `elevations`
 * @param {object} options    { waypointElevations?: Map }
 */
export function buildGpx(route, segments, options = {}) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<gpx version="1.1" creator="${CREATOR}" xmlns="${GPX_NS}">`
  );

  lines.push('  <metadata>');
  lines.push(`    <name>${esc(documentName(route))}</name>`);
  const description = metadataDescription(route);
  if (description) lines.push(`    <desc>${esc(description)}</desc>`);
  if (route.author) {
    lines.push(`    <author><name>${esc(route.author)}</name></author>`);
  }
  lines.push(
    `    <link href="${esc(routeUrl(route.id))}"><text>SAC Route Portal</text></link>`
  );
  lines.push(`    <time>${new Date().toISOString()}</time>`);
  const box = boundsOf(segments);
  if (box) {
    lines.push(
      `    <bounds minlat="${f(box.minlat)}" minlon="${f(box.minlon)}" ` +
        `maxlat="${f(box.maxlat)}" maxlon="${f(box.maxlon)}"/>`
    );
  }
  lines.push('  </metadata>');

  for (const waypoint of route.waypoints) {
    const { lat, lon } = lv95ToWgs84(waypoint.easting, waypoint.northing);
    const elevation =
      options.waypointElevations?.get(waypointKey(waypoint)) ?? waypoint.altitude;
    lines.push(`  <wpt lat="${f(lat)}" lon="${f(lon)}">`);
    if (elevation != null) lines.push(`    <ele>${round(elevation, 1)}</ele>`);
    lines.push(`    <name>${esc(waypoint.name)}</name>`);
    lines.push(`    <desc>${esc(waypoint.role)}</desc>`);
    lines.push('    <sym>Summit</sym>');
    lines.push('  </wpt>');
  }

  for (const segment of segments) {
    lines.push('  <trk>');
    lines.push(`    <name>${esc(trackName(route, segment))}</name>`);
    const segmentDescription = trackDescription(segment);
    if (segmentDescription) {
      lines.push(`    <desc>${esc(segmentDescription)}</desc>`);
    }
    if (segment.discipline) {
      lines.push(`    <type>${esc(segment.discipline)}</type>`);
    }
    lines.push('    <trkseg>');
    for (let i = 0; i < segment.coordinates.length; i++) {
      const [easting, northing] = segment.coordinates[i];
      const { lat, lon } = lv95ToWgs84(easting, northing);
      const elevation = segment.elevations?.[i];
      if (elevation == null) {
        lines.push(`      <trkpt lat="${f(lat)}" lon="${f(lon)}"/>`);
      } else {
        lines.push(
          `      <trkpt lat="${f(lat)}" lon="${f(lon)}"><ele>${round(elevation, 1)}</ele></trkpt>`
        );
      }
    }
    lines.push('    </trkseg>');
    lines.push('  </trk>');
  }

  lines.push('</gpx>');
  return lines.join('\n');
}

/** Filename-safe export name, e.g. "SAC-207 Medelserhuette SAC.gpx". */
export function gpxFilename(route) {
  const label = route.destination || route.title || `route-${route.id}`;
  const safe = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `SAC-${route.id} ${safe || 'route'}.gpx`;
}

/** Ascent/descent/length summary, computed from the enriched geometry. */
export function statsFor(segments) {
  let distance = 0;
  let ascent = 0;
  let descent = 0;
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let hasElevation = false;

  for (const segment of segments) {
    // Variants are alternative lines, not part of the main route's total.
    if (segment.isVariant) continue;
    distance += lineLength(segment.coordinates);

    const elevations = (segment.elevations ?? []).filter((v) => v != null);
    if (elevations.length < 2) continue;
    hasElevation = true;
    for (const value of elevations) {
      if (value < minElevation) minElevation = value;
      if (value > maxElevation) maxElevation = value;
    }
    // A 2 m threshold suppresses terrain-model noise being counted as climbing.
    let previous = elevations[0];
    for (const value of elevations.slice(1)) {
      const delta = value - previous;
      if (Math.abs(delta) < 2) continue;
      if (delta > 0) ascent += delta;
      else descent -= delta;
      previous = value;
    }
  }

  return {
    distance,
    ascent: hasElevation ? Math.round(ascent) : null,
    descent: hasElevation ? Math.round(descent) : null,
    minElevation: hasElevation ? Math.round(minElevation) : null,
    maxElevation: hasElevation ? Math.round(maxElevation) : null,
  };
}

export function waypointKey(waypoint) {
  return `${waypoint.easting.toFixed(1)},${waypoint.northing.toFixed(1)}`;
}

export function routeUrl(id) {
  return `https://www.sac-cas.ch/de/?type=1567765346410&tx_usersaccas2020_sac2020%5BrouteId%5D=${id}&output_lang=de`;
}

function documentName(route) {
  const destination = route.destination || '';
  const title = route.title || '';
  if (destination && title) return `${destination} — ${title}`;
  return destination || title || `SAC route ${route.id}`;
}

function metadataDescription(route) {
  const parts = [];
  if (route.teaser) parts.push(route.teaser);

  const facts = route.facts
    .filter((fact) => fact.label && fact.value)
    .map((fact) => `${fact.label}: ${fact.value}`);
  if (route.difficulty && !facts.some((f) => f.includes(route.difficulty))) {
    facts.unshift(`Difficulty: ${route.difficulty}`);
  }
  if (facts.length) parts.push(facts.join(' · '));

  if (route.book) parts.push(`Source: ${route.book}`);
  parts.push(
    'Route data © Schweizer Alpen-Club SAC. Conditions change — verify against ' +
      'the current route description before relying on this track.'
  );
  return parts.join('\n\n');
}

function trackName(route, segment) {
  const base = segment.title || route.title || `Segment ${segment.id}`;
  return segment.isVariant ? `${base} (variant)` : base;
}

function trackDescription(segment) {
  return segment.description || '';
}

function boundsOf(segments) {
  let minlat = Infinity, minlon = Infinity, maxlat = -Infinity, maxlon = -Infinity;
  let seen = false;
  for (const segment of segments) {
    for (const [easting, northing] of segment.coordinates) {
      const { lat, lon } = lv95ToWgs84(easting, northing);
      seen = true;
      if (lat < minlat) minlat = lat;
      if (lat > maxlat) maxlat = lat;
      if (lon < minlon) minlon = lon;
      if (lon > maxlon) maxlon = lon;
    }
  }
  return seen ? { minlat, minlon, maxlat, maxlon } : null;
}

function f(value) {
  return value.toFixed(7);
}

function round(value, places) {
  return Number.parseFloat(value.toFixed(places));
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
